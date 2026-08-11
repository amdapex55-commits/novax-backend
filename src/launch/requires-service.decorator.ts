import { CanActivate, ExecutionContext, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { LaunchPolicyService, ParkedService } from "./launch-policy.service";

export const REQUIRES_SERVICE = "requiresService";

/**
 * Marks a controller (or a single route) as belonging to a service that can be
 * switched off for the pilot.
 *
 * Applied at the controller level so a new endpoint added to food/delivery/
 * errands later is covered by default. Forgetting to annotate a new route is
 * exactly how a parked service quietly comes back online.
 */
export const RequiresService = (service: ParkedService) => SetMetadata(REQUIRES_SERVICE, service);

@Injectable()
export class ServiceEnabledGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private launchPolicy: LaunchPolicyService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const service = this.reflector.getAllAndOverride<ParkedService>(REQUIRES_SERVICE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!service) return true;
    // Throws a 403 with a message the app can show as-is.
    this.launchPolicy.assertServiceEnabled(service);
    return true;
  }
}
