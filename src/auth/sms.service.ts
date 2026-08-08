import { Injectable, Logger, InternalServerErrorException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * OTP delivery.
 *
 * This is the only place in the codebase that knows how a code reaches a
 * phone. Everything in the auth flow calls sendOtp() and doesn't care.
 *
 * ⚠️ WHY THIS MATTERED FOR LAUNCH: until now the only implemented provider
 * was "console", which writes the OTP to the server log and returns. That's
 * correct for development and completely unusable in production — no real
 * customer can log in, because the code goes to Railway's log stream instead
 * of their phone. A pilot with no working OTP has no users.
 *
 * Twilio is implemented below via its plain REST API (a form POST with basic
 * auth), deliberately WITHOUT adding the twilio npm package — one less
 * dependency to install, audit and keep updated for what is a single HTTP
 * call. Swap in a local Pakistani aggregator later by adding a branch here;
 * nothing else changes.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(private config: ConfigService) {}

  async sendOtp(phone: string, code: string): Promise<void> {
    const provider = this.config.get<string>("SMS_PROVIDER", "console");

    switch (provider) {
      case "console":
        // Development only. config.validation.ts refuses to boot in
        // production with this set, so it can't reach real users by accident.
        this.logger.warn(`[DEV MODE] OTP for ${phone}: ${code} (no real SMS sent)`);
        return;

      case "twilio":
        return this.sendViaTwilio(phone, code);

      default:
        throw new InternalServerErrorException(
          `SMS_PROVIDER "${provider}" is not supported. Use "twilio" or "console".`,
        );
    }
  }

  /**
   * Twilio REST: POST /2010-04-01/Accounts/{sid}/Messages.json
   * Body is form-encoded; auth is HTTP Basic with the account SID + token.
   */
  private async sendViaTwilio(phone: string, code: string): Promise<void> {
    const sid = this.config.get<string>("TWILIO_ACCOUNT_SID");
    const token = this.config.get<string>("TWILIO_AUTH_TOKEN");
    const from = this.config.get<string>("TWILIO_FROM_NUMBER");

    if (!sid || !token || !from) {
      throw new InternalServerErrorException(
        "SMS_PROVIDER=twilio but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER are not all set",
      );
    }

    // Keep the message short and unambiguous. Including the app name means a
    // customer with several OTPs on screen knows which is which, and stating
    // "never share" is the cheapest defence against the phone-call scam where
    // someone rings a rider pretending to be support and asks for their code.
    //
    // THE LAST LINE IS LOAD-BEARING. `@domain #code` is the WebOTP format:
    // Chrome on Android reads it and offers to fill the code automatically,
    // so the customer never leaves the app to go and read their messages.
    // Without this exact final line the browser ignores the SMS and the
    // autofill in auth.js silently never fires.
    //
    // The domain must match the origin the app is served from. Set
    // OTP_DOMAIN to your GitHub Pages host (e.g. "amdapex55-commits.github.io")
    // or your custom domain — it is NOT the API's domain.
    const domain = this.config.get<string>("OTP_DOMAIN");
    const webOtpLine = domain ? `\n\n@${domain} #${code}` : "";

    const body =
      `${code} is your Nova X code. Never share it with anyone, ` +
      `including Nova X staff.${webOtpLine}`;

    const params = new URLSearchParams({ To: phone, From: from, Body: body });
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");

    // 10s ceiling: a hung SMS request must not hold the login endpoint open.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params.toString(),
          signal: controller.signal,
        },
      );

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        // Log the provider's reason for us; never leak it to the caller,
        // since it can contain account identifiers.
        this.logger.error(`Twilio rejected SMS to ${this.mask(phone)}: ${res.status} ${detail}`);
        throw new InternalServerErrorException("Couldn't send the code. Please try again.");
      }

      this.logger.log(`OTP sent to ${this.mask(phone)}`);
    } catch (err: any) {
      if (err instanceof InternalServerErrorException) throw err;
      const reason = err?.name === "AbortError" ? "timed out" : err?.message;
      this.logger.error(`SMS delivery failed for ${this.mask(phone)}: ${reason}`);
      throw new InternalServerErrorException("Couldn't send the code. Please try again.");
    } finally {
      clearTimeout(timer);
    }
  }

  /** Never write a full phone number to the logs. */
  private mask(phone: string): string {
    return phone.length > 4 ? `${phone.slice(0, 4)}****${phone.slice(-2)}` : "****";
  }
}
