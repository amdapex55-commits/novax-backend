import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { ConfigService } from "@nestjs/config";
import { TokenDenylistService } from "./token-denylist.service";

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
    return { userId: payload.sub, role: payload.role };
  }
}
