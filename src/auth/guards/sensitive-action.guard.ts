import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { SENSITIVE_ACTION } from "../sensitive-action.decorator";
import { TokenDenylistService } from "../token-denylist.service";

/**
 * Enforces @SensitiveAction. Runs after JwtAuthGuard, so request.user is set.
 * Unmarked routes pass straight through and keep the fail-open behaviour.
 */
@Injectable()
export class SensitiveActionGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private denylist: TokenDenylistService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.getAllAndOverride<string | undefined>(SENSITIVE_ACTION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!action) return true;

    const req = context.switchToHttp().getRequest();
    const userId = req.user?.userId;
    // No authenticated user means JwtAuthGuard has already refused, or the
    // route is public — either way there is no session to check.
    if (!userId) return true;

    await this.denylist.assertNotRevokedForSensitiveAction(userId, action);
    return true;
  }
}
