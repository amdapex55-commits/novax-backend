import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { ConfigService } from "@nestjs/config";
import { TokenDenylistService } from "./token-denylist.service";
import { PrismaService } from "../prisma/prisma.service";

export interface JwtPayload {
  sub: string; // user id
  // Must mirror the Prisma `Role` enum exactly. RESTAURANT was missing here
  // while being fully supported everywhere else (signup DTO, guards, 10
  // @Roles("RESTAURANT") routes) — the runtime was fine because validate()
  // passes payload.role straight through, but the type lied, which is how
  // someone later "fixes" a false type error by breaking real behaviour.
  role: "RIDER" | "DRIVER" | "ADMIN" | "RESTAURANT";
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private denylist: TokenDenylistService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>("JWT_ACCESS_SECRET"),
    });
  }

  // Whatever this returns becomes `request.user` in every controller.
  async validate(payload: JwtPayload) {
    // A valid signature only proves the token was issued by us, not that the
    // account still exists or is still allowed in. Deleted and suspended
    // accounts are held here until their tokens age out.
    if (await this.denylist.isRevoked(payload.sub)) {
      throw new UnauthorizedException("This session is no longer valid. Please sign in again.");
    }

    /* THE DENYLIST IS NOT THE ONLY THING THAT CAN BE TRUE.
       Revocation is written to Redis, and both the write and the read are
       allowed to fail soft so an outage cannot sign out every driver
       mid-trip. The consequence is that a deleted or suspended account keeps
       working for up to the token's lifetime whenever that write did not
       land. The database is the authority on whether the account still
       exists and is still allowed in, so ask it.

       One primary-key lookup per request. At pilot volume that is cheaper
       than the class of bug it removes: an account ops believes they closed
       continuing to take jobs and move money. */
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { isActive: true, role: true },
    });
    if (!user) {
      throw new UnauthorizedException("This account no longer exists.");
    }
    if (!user.isActive) {
      throw new UnauthorizedException("This account has been suspended. Contact support.");
    }

    // The role comes from the database, not the token. A role changed by ops
    // after the token was issued must take effect immediately, and a token is
    // the last place to trust for an authorisation decision.
    return { userId: payload.sub, role: user.role };
  }
}
