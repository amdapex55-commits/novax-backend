import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ROLES_KEY } from "./roles.decorator";

// Pair with JwtAuthGuard: JwtAuthGuard confirms *who* you are, this confirms
// you're *allowed* to be here. A driver hitting an admin route gets a 403,
// not a silently-wrong response — this is enforced server-side, not just hidden in the UI.
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const { user } = context.switchToHttp().getRequest();
    if (!user || !requiredRoles.includes(user.role)) {
      throw new ForbiddenException(`Requires one of roles: ${requiredRoles.join(", ")}`);
    }
    return true;
  }
}
