import { Injectable, UnauthorizedException, ConflictException, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { randomInt } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { SmsService } from "./sms.service";
import { LoyaltyService } from "../loyalty/loyalty.service";
import { NotificationsService } from "../notifications/notifications.service";
import { RegisterDto } from "./dto/register.dto";

const OTP_TTL_MINUTES = 5;
const OTP_LENGTH = 6;

/**
 * SESSION LENGTH — deliberately long.
 *
 * A 15-minute access token is the right default for a bank. It is the wrong
 * default here: a driver mid-shift on patchy Karachi signal, or a customer
 * standing at a kerb, being bounced to a login screen is a lost ride and a
 * support call. Nobody re-authenticates gracefully one-handed on a bike.
 *
 * The tradeoff is real and worth stating: a stolen token is usable for
 * longer. What bounds it is that ops can suspend an account at any time —
 * `isActive` is re-checked on every socket connect and on every match, so a
 * suspension takes effect immediately regardless of how long the token lives.
 * Revocation doesn't wait for expiry.
 *
 * Shorten both if that calculus changes; they're env-overridable.
 */
const ACCESS_TTL_DEFAULT = "30d";
const REFRESH_TTL_DEFAULT = "365d";

const BCRYPT_ROUNDS = 10;

/**
 * A real bcrypt hash of a value nobody can log in with. Compared against when
 * an account doesn't exist, so a wrong password and an unknown account cost
 * the same amount of time.
 */
const DUMMY_HASH = "$2b$10$CwTycUXWue0Thq9StjUM0uJ8i5jJ3Kk2rJ0kQ0zP3wOaZ6JmQ3vTS";

/**
 * Pakistani mobile numbers get typed as 0300…, 92300…, +92300… and 300….
 * Storing them unnormalised means the same person can register three times
 * and then fail to log in with the form they didn't use.
 */
function normalisePhone(input: string): string {
  const digits = (input || "").replace(/[^0-9]/g, "");
  if (digits.startsWith("92")) return `+${digits}`;
  if (digits.startsWith("0")) return `+92${digits.slice(1)}`;
  if (digits.length === 10) return `+92${digits}`;
  return input.trim();
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

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

  /**
   * Password signup.
   *
   * A CUSTOMER is usable immediately — kycStatus APPROVED at creation. There
   * is nothing to verify about someone who wants to book a ride, and making
   * them wait for a human is how you lose them on day one.
   *
   * A DRIVER is created PENDING and stays unable to go online until ops
   * approves them in the dashboard. That gate is not a formality: a driver
   * carries a passenger, and their licence is checked by a person against the
   * original document (see LAUNCH.md, day 3). The uploads collected here are
   * what that person looks at.
   */
  async register(dto: RegisterDto) {
    const phone = normalisePhone(dto.phone);
    const email = dto.email.trim().toLowerCase();
    const role = dto.role === "DRIVER" ? "DRIVER" : "RIDER";

    // Checked explicitly rather than relying on the unique constraint, so the
    // person gets "that number is already registered" instead of a 500 from a
    // raw Prisma error.
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ phone }, { email }] },
      select: { id: true, phone: true, email: true, passwordHash: true },
    });
    if (existing) {
      // An account created by the OTP flow has no password. Rather than
      // refusing, let them set one — otherwise anyone who used OTP before
      // this shipped is permanently locked out of the new login.
      if (!existing.passwordHash) {
        const upgraded = await this.prisma.user.update({
          where: { id: existing.id },
          data: {
            passwordHash: await bcrypt.hash(dto.password, BCRYPT_ROUNDS),
            name: dto.firstName.trim(),
            lastName: dto.lastName.trim(),
            email,
            address: dto.address?.trim() || undefined,
          },
        });
        return this.issueTokens(upgraded.id, upgraded.role);
      }
      throw new ConflictException(
        existing.phone === phone
          ? "That phone number is already registered. Sign in instead."
          : "That email is already registered. Sign in instead.",
      );
    }

    const user = await this.prisma.user.create({
      data: {
        phone,
        email,
        name: dto.firstName.trim(),
        lastName: dto.lastName.trim(),
        address: dto.address?.trim() || undefined,
        passwordHash: await bcrypt.hash(dto.password, BCRYPT_ROUNDS),
        role: role as any,
        // The whole point of the split: customers in, drivers queued.
        kycStatus: role === "DRIVER" ? "PENDING" : "APPROVED",
        ...(role === "DRIVER"
          ? {
              driverProfile: {
                create: {
                  vehicleType: "bike",
                  licenseFrontUrl: dto.licenseFrontUrl,
                  licenseBackUrl: dto.licenseBackUrl,
                },
              },
            }
          : {}),
      },
    });

    this.logger.log(`Registered ${role} ${user.id} (${role === "DRIVER" ? "pending approval" : "active immediately"})`);
    return this.issueTokens(user.id, user.role);
  }

  /**
   * Password login by email OR phone.
   *
   * Both failure paths return the same message on purpose. Saying "no account
   * with that email" tells an attacker which addresses are registered, which
   * is a free user-enumeration oracle on a service where the identifier is
   * also a phone number.
   */
  async login(identifier: string, password: string) {
    const raw = identifier.trim();
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: raw.toLowerCase() }, { phone: normalisePhone(raw) }, { phone: raw }],
      },
    });

    const GENERIC = "Wrong email/phone or password";

    if (!user?.passwordHash) {
      // Compare against a dummy hash anyway so a missing account and a wrong
      // password take the same time. Without this, response timing alone
      // reveals which identifiers exist.
      await bcrypt.compare(password, DUMMY_HASH);
      throw new UnauthorizedException(GENERIC);
    }
    if (!user.isActive) {
      throw new UnauthorizedException("This account has been suspended. Contact support.");
    }
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException(GENERIC);
    }

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
        expiresIn: this.config.get<string>("JWT_ACCESS_TTL", ACCESS_TTL_DEFAULT),
      },
    );
    const refreshToken = this.jwt.sign(
      { sub: userId },
      {
        secret: this.config.get<string>("JWT_REFRESH_SECRET"),
        expiresIn: this.config.get<string>("JWT_REFRESH_TTL", REFRESH_TTL_DEFAULT),
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
