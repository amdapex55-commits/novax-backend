import { Global, Module } from "@nestjs/common";
import { LaunchPolicyService } from "./launch-policy.service";
import { ServiceEnabledGuard } from "./requires-service.decorator";

// @Global so trips, food, delivery and errands can all enforce the same
// policy without each importing this module.
@Global()
@Module({
  providers: [LaunchPolicyService, ServiceEnabledGuard],
  exports: [LaunchPolicyService, ServiceEnabledGuard],
})
export class LaunchModule {}
