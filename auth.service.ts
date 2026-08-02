import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { randomInt } from "crypto";
import { PrismaService } from "./prisma.service";
import { SmsService } from "./sms.service";
import { LoyaltyService } from "./loyalty.service";
import { NotificationsService } from "./notifications.service";

const OTP_TTL_MINUTES = 5;
const OTP_LENGTH = 6;

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private sms: SmsService,
    private jwt: JwtService,
    private config: ConfigService,
    private loyaltyService: LoyaltyService,
    private notificationsService: NotificationsService,
  ) {}

  /** Step 1: rider/driver/restaurant enters their phone number, we text them a 6-digit code. */
  async requestOtp(phone: string, referralCode?: string, role?: "DRIVER" | "RESTAURANT") {
    // First login auto-creates the user — RIDER by default, or DRIVER/RESTAURANT
    // if they came in through that specific onboarding flow (role is only ever
    // read here, on brand-new accounts; see the DTO comment). KYC/approval still
    // gates what a DRIVER/RESTAURANT account can actually do (go online / accept
    // orders) — this only decides which app shell they land in.
    // Split into find-then-create (rather than one upsert) because we need
    // to know whether this was a brand-new account, to apply a referral
    // code exactly once and never on a repeat "resend code" tap.
    let user = await this.prisma.user.findUnique({ where: { phone } });
    const isNewUser = !user;
    if (!user) {
      user = await this.prisma.user.create({ data: { phone, role: role ?? "RIDER" } });
    }

    if (isNewUser && referralCode) {
      const result = await this.loyaltyService.applyReferral(user.id, referralCode);
      if (result) {
        await this.notificationsService.create(
          result.referrerId,
          "Referral bonus!",
          "Someone signed up with your referral code — 100 points added to your account.",
        );
      }
    }

    // Same reasoning as the refresh-token revocation in issueTokens(): mark any
    // still-unconsumed codes from a prior request as consumed so they can't be
    // guessed/replayed, and so this table doesn't accumulate a growing pile of
    // dead rows for users who tap "resend" a few times.
    await this.prisma.otpCode.updateMany({
      where: { userId: user.id, consumed: false },
      data: { consumed: true },
    });

    const code = randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, "0");
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000);

    await this.prisma.otpCode.create({
      data: { userId: user.id, codeHash, expiresAt },
    });

    await this.sms.sendOtp(phone, code);

    return { message: "OTP sent", expiresInMinutes: OTP_TTL_MINUTES };
  }

  /** Step 2: verify the code, issue an access + refresh token pair. */
  async verifyOtp(phone: string, code: string) {
    const user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) throw new UnauthorizedException("No OTP request found for this number");

    const latestOtp = await this.prisma.otpCode.findFirst({
      where: { userId: user.id, consumed: false },
      orderBy: { createdAt: "desc" },
    });
    if (!latestOtp) throw new UnauthorizedException("No active OTP — request a new one");
    if (latestOtp.expiresAt < new Date()) throw new UnauthorizedException("OTP expired");

    const isValid = await bcrypt.compare(code, latestOtp.codeHash);
    if (!isValid) throw new UnauthorizedException("Incorrect code");

    await this.prisma.otpCode.update({
      where: { id: latestOtp.id },
      data: { consumed: true },
    });

    return this.issueTokens(user.id, user.role);
  }

  async refresh(refreshToken: string) {
    let payload: { sub: string };
    try {
      payload = this.jwt.verify(refreshToken, {
        secret: this.config.get<string>("JWT_REFRESH_SECRET"),
      });
    } catch {
      throw new UnauthorizedException("Invalid or expired refresh token");
    }

    // Compare against every non-revoked, non-expired hash on file — refresh tokens
    // are stored hashed (like passwords) so a DB leak alone can't be replayed.
    const candidates = await this.prisma.refreshToken.findMany({
      where: { userId: payload.sub, revoked: false, expiresAt: { gt: new Date() } },
    });
    let matchedId: string | null = null;
    for (const candidate of candidates) {
      if (await bcrypt.compare(refreshToken, candidate.tokenHash)) {
        matchedId = candidate.id;
        break;
      }
    }
    if (!matchedId) throw new UnauthorizedException("Refresh token not recognized");

    // Rotate: revoke the used token, issue a fresh pair.
    await this.prisma.refreshToken.update({ where: { id: matchedId }, data: { revoked: true } });

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: payload.sub } });
    return this.issueTokens(user.id, user.role);
  }

  private async issueTokens(userId: string, role: string) {
    // Revoke this user's previous refresh tokens before issuing a new one.
    // Without this, every OTP login or refresh call adds a row that never
    // gets cleaned up — `refresh()` above has to bcrypt.compare against every
    // non-revoked, non-expired row for the user, so an account that logs in
    // often (common with mobile token expiry / app restarts) accumulates rows
    // and that comparison loop gets linearly slower over time. This trades
    // away true multi-device sessions for a single-session-per-user model,
    // which is the right default for v1 — add a `deviceId` column and scope
    // revocation to it instead of the whole user when multi-device matters.
    await this.prisma.refreshToken.updateMany({
      where: { userId, revoked: false },
      data: { revoked: true },
    });

    const accessToken = this.jwt.sign(
      { sub: userId, role },
      {
        secret: this.config.get<string>("JWT_ACCESS_SECRET"),
        expiresIn: this.config.get<string>("JWT_ACCESS_TTL", "15m"),
      },
    );
    const refreshToken = this.jwt.sign(
      { sub: userId },
      {
        secret: this.config.get<string>("JWT_REFRESH_SECRET"),
        expiresIn: this.config.get<string>("JWT_REFRESH_TTL", "30d"),
      },
    );

    const refreshTtlDays = 30;
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: await bcrypt.hash(refreshToken, 10),
        expiresAt: new Date(Date.now() + refreshTtlDays * 24 * 60 * 60_000),
      },
    });

    return { accessToken, refreshToken };
  }
}
