import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Nova Go — push delivery.
 *
 * The only place in the codebase that knows how a message reaches a phone.
 * Everything else calls NotificationsService.notify() and does not care.
 *
 * WHY THIS EXISTS
 *
 * Nothing did. Notifications were written to a database table and read only
 * if the user happened to open the app and find the screen. For a customer
 * that means "your rider has arrived" is invisible while their phone is in
 * their pocket — which is the exact moment it matters. For a driver it means
 * a job offer with a 15-second timeout is delivered to an app they are not
 * looking at, and the offer cascades away before they see it.
 *
 * WHY REST AND NOT firebase-admin
 *
 * Same reasoning as SmsService's Twilio integration: this is a signed JWT and
 * an HTTPS POST. The firebase-admin package pulls in a large dependency tree
 * to do that, and every dependency is something to audit and keep updated.
 *
 * PROVIDERS
 *
 *   console  development. Logs and returns. config.validation refuses to boot
 *            production with this set, exactly like SMS_PROVIDER.
 *   fcm      Firebase Cloud Messaging HTTP v1. Handles Android natively and
 *            iOS via an APNs key uploaded to the Firebase console, so one
 *            provider covers both stores and there is no second code path.
 *
 * NOTHING HERE THROWS AT THE CALL SITE. A failed push must never fail the
 * thing it was reporting on — a trip does not stop completing because Google
 * returned a 503.
 */

export interface PushMessage {
  title: string;
  body: string;
  /** Small string map delivered alongside. Used for deep links and routing. */
  data?: Record<string, string>;
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  /** Cached OAuth token for FCM. Google issues these for an hour. */
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {}

  private get provider(): string {
    return this.config.get<string>("PUSH_PROVIDER", "console");
  }

  /** True when push can actually reach a device. Callers use this to decide
   *  whether to fall back to something else (an SMS, a socket event). */
  get isConfigured(): boolean {
    return this.provider === "fcm" && !!this.config.get<string>("FCM_SERVICE_ACCOUNT_JSON");
  }

  /**
   * Send to every device this user has registered for one app.
   *
   * `app` is not optional on purpose. A phone with both Nova Go apps installed
   * has two tokens for the same person, and delivering "you have a new job" to
   * the customer build is the kind of bug that is obvious in hindsight and
   * invisible in code that defaults it.
   */
  async sendToUser(userId: string, app: string, message: PushMessage): Promise<void> {
    try {
      const devices = await this.prisma.deviceToken.findMany({
        where: { userId, app },
        select: { token: true, platform: true },
      });
      if (devices.length === 0) return;
      await Promise.all(devices.map((d) => this.sendToToken(d.token, message)));
    } catch (err) {
      // Deliberately swallowed — see the header.
      this.logger.warn(`Push to user ${userId} failed: ${(err as Error).message}`);
    }
  }

  async sendToToken(token: string, message: PushMessage): Promise<void> {
    switch (this.provider) {
      case "console":
        this.logger.log(`[DEV PUSH] ${message.title} — ${message.body} → ${token.slice(0, 12)}…`);
        return;
      case "fcm":
        return this.sendViaFcm(token, message);
      default:
        this.logger.error(`PUSH_PROVIDER "${this.provider}" is not supported. Use "fcm" or "console".`);
    }
  }

  /* ------------------------------------------------------------- FCM ---- */

  private async sendViaFcm(token: string, message: PushMessage): Promise<void> {
    const raw = this.config.get<string>("FCM_SERVICE_ACCOUNT_JSON");
    if (!raw) {
      this.logger.error("PUSH_PROVIDER=fcm but FCM_SERVICE_ACCOUNT_JSON is not set");
      return;
    }
    let account: { client_email: string; private_key: string; project_id: string };
    try {
      account = JSON.parse(raw);
    } catch {
      this.logger.error("FCM_SERVICE_ACCOUNT_JSON is not valid JSON");
      return;
    }

    const accessToken = await this.getAccessToken(account);
    if (!accessToken) return;

    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: message.title, body: message.body },
            // FCM requires every data value to be a string. Numbers silently
            // break the send, so callers are given a Record<string,string>
            // type and this coerces anyway.
            data: Object.fromEntries(
              Object.entries(message.data ?? {}).map(([k, v]) => [k, String(v)]),
            ),
            android: { priority: "HIGH", notification: { sound: "default" } },
            apns: { payload: { aps: { sound: "default" } } },
          },
        }),
      },
    );

    if (res.ok) return;

    const bodyText = await res.text().catch(() => "");
    // A token belonging to an uninstalled app is permanently dead. Deleting it
    // is not housekeeping — a fleet of dead tokens means every send does N
    // pointless HTTPS round trips on the critical path of a job offer.
    if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/i.test(bodyText)) {
      await this.prisma.deviceToken.deleteMany({ where: { token } }).catch(() => undefined);
      this.logger.log(`Pruned dead device token ${token.slice(0, 12)}…`);
      return;
    }
    this.logger.warn(`FCM send failed (${res.status}): ${bodyText.slice(0, 200)}`);
  }

  /**
   * Service-account OAuth2, signed locally.
   *
   * Google wants a JWT signed with the service account's RSA key, exchanged
   * for a bearer token valid one hour. Cached with a 5-minute safety margin
   * so a token does not expire mid-flight on a slow request — re-fetching per
   * send would add a full round trip to every notification.
   */
  private async getAccessToken(account: { client_email: string; private_key: string }): Promise<string | null> {
    if (this.accessToken && Date.now() < this.accessToken.expiresAt) return this.accessToken.value;

    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const claims = {
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    };
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b64(header)}.${b64(claims)}`;

    let signature: string;
    try {
      signature = crypto
        .createSign("RSA-SHA256")
        .update(unsigned)
        .sign(account.private_key.replace(/\\n/g, "\n"), "base64url");
    } catch (err) {
      // Almost always the escaped newlines in the env var — the private key
      // arrives as one line with literal \n and must be restored above.
      this.logger.error(`Could not sign FCM JWT: ${(err as Error).message}`);
      return null;
    }

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
    });
    if (!res.ok) {
      this.logger.error(`FCM token exchange failed (${res.status})`);
      return null;
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = {
      value: json.access_token,
      expiresAt: Date.now() + (json.expires_in - 300) * 1000,
    };
    return json.access_token;
  }

  /* -------------------------------------------------------- registry ---- */

  /**
   * Register (or re-home) a device token.
   *
   * Upsert on the TOKEN, not on the user — see the schema comment. A shared
   * phone changing hands must move the token to the new owner, not create a
   * second row that delivers a driver's job offers to the previous driver.
   */
  async registerDevice(userId: string, token: string, platform: string, app: string) {
    return this.prisma.deviceToken.upsert({
      where: { token },
      create: { token, userId, platform, app },
      update: { userId, platform, app, lastSeenAt: new Date() },
    });
  }

  /** Called on sign-out. Without it, the next person to use this phone
   *  receives the previous user's notifications until they happen to
   *  re-register. */
  async unregisterDevice(token: string) {
    await this.prisma.deviceToken.deleteMany({ where: { token } });
    return { message: "Device unregistered" };
  }
}
