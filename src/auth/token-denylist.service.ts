import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RedisService } from "../redis/redis.service";

const ACCESS_TTL_DEFAULT = "30d";
const KEY = (userId: string) => `auth:revoked:${userId}`;

/**
 * Access tokens are stateless and long-lived (30 days), so nothing that
 * happens to an account after a token is issued reaches the token. Deleting
 * an account cleared its refresh tokens but left the *access* token working
 * for its full remaining life — verified against production 2026-08-13:
 * `POST /auth/login` correctly refused, while `GET /users/me` on the
 * already-issued token kept returning 200. Ops suspension had the same gap:
 * `isActive` is re-checked on socket connect and on every match, but not on
 * the HTTP path, so a suspended user kept ordinary API access.
 *
 * This is the missing check. A revoked user id sits in Redis until the
 * longest-lived token that could still exist has expired, and JwtStrategy
 * refuses anything it finds here.
 *
 * FAIL-OPEN on a Redis outage, deliberately. Failing closed would sign out
 * every user on the platform — including drivers mid-trip — the moment Redis
 * blinked, which is a far larger incident than the one this guards against
 * (a revoked session on a device the person already holds). The failure is
 * logged at error level so it is never silent.
 */
@Injectable()
export class TokenDenylistService {
  private readonly logger = new Logger(TokenDenylistService.name);
  private readonly ttlSeconds: number;

  constructor(
    private redis: RedisService,
    config: ConfigService,
  ) {
    // The entry only has to outlive the longest token that could still be in
    // circulation, which is the access TTL at the moment of revocation.
    this.ttlSeconds = parseTtlSeconds(config.get<string>("JWT_ACCESS_TTL", ACCESS_TTL_DEFAULT));
  }

  /** Called on account deletion and on ops suspension. */
  async revoke(userId: string, reason: string) {
    try {
      await this.redis.client.set(KEY(userId), reason, "EX", this.ttlSeconds);
      this.logger.warn(`Revoked live sessions for ${userId} (${reason}), for ${this.ttlSeconds}s.`);
    } catch (err) {
      // Loud: the account is anonymised/suspended either way, but its existing
      // token is still live and now nothing is going to stop it.
      this.logger.error(
        `FAILED to revoke sessions for ${userId} (${reason}) — existing access tokens stay valid until they expire: ${err}`,
      );
    }
  }

  /** Reactivation, so an unsuspended user does not have to sign in again. */
  async restore(userId: string) {
    try {
      await this.redis.client.del(KEY(userId));
    } catch (err) {
      // Fail-open means a stale entry keeps rejecting a now-valid user, so
      // this one is worth seeing too.
      this.logger.error(`FAILED to clear revocation for ${userId} — they may need to sign in again: ${err}`);
    }
  }

  async isRevoked(userId: string): Promise<boolean> {
    try {
      const revoked = (await this.redis.client.exists(KEY(userId))) === 1;
      this.degraded = false;
      return revoked;
    } catch (err) {
      this.degraded = true;
      this.logger.error(`Redis unreachable checking revocation for ${userId} — allowing the request: ${err}`);
      return false;
    }
  }

  /* TWO LEVELS OF CERTAINTY, NOT ONE.

     Failing open is the right call for ordinary traffic: failing closed would
     sign out every driver on the platform the moment Redis blinked, which is
     a far larger incident than one revoked session on a device the person is
     already holding.

     But "allow everything" is the wrong answer for the operations that
     revocation actually exists to stop. A suspended driver browsing their
     earnings during a Redis outage is tolerable. That same driver withdrawing
     money, changing their payout account, or an admin action running under a
     revoked session, is not — those are exactly the things ops was trying to
     halt when they suspended the account.

     So sensitive routes ask this instead, and are refused while we cannot
     tell. The blast radius is a short window in which a handful of
     money-and-access operations are unavailable, against a Redis outage in
     which everything else keeps working. */
  private degraded = false;

  /** True when Redis last failed us, so revocation status is unknown. */
  isDegraded(): boolean {
    return this.degraded;
  }

  /**
   * Revocation check for operations that move money or change access.
   * Throws rather than returning a boolean, because every caller's correct
   * response to "we cannot tell" is identical: refuse.
   */
  async assertNotRevokedForSensitiveAction(userId: string, action: string): Promise<void> {
    let revoked: boolean;
    try {
      revoked = (await this.redis.client.exists(KEY(userId))) === 1;
      this.degraded = false;
    } catch (err) {
      this.degraded = true;
      this.logger.error(
        `Redis unreachable checking revocation for ${userId} — REFUSING sensitive action "${action}": ${err}`,
      );
      throw new ServiceUnavailableException(
        "We can't verify your session right now. Please try again in a few minutes.",
      );
    }
    if (revoked) {
      throw new UnauthorizedException("This session is no longer valid. Please sign in again.");
    }
  }
}

/** Accepts the same "30d" / "15m" / "3600" forms jsonwebtoken takes. */
export function parseTtlSeconds(ttl: string): number {
  const match = /^(\d+)\s*([smhd])?$/.exec(String(ttl).trim());
  // An unparseable TTL must not shorten the window — fall back to the longest
  // sane value rather than silently revoking for 0 seconds.
  if (!match) return 30 * 86400;
  const value = Number(match[1]);
  const unit = match[2] ?? "s";
  return value * { s: 1, m: 60, h: 3600, d: 86400 }[unit]!;
}
