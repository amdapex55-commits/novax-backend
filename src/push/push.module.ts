import { Global, Module } from "@nestjs/common";
import { PushService } from "./push.service";

/**
 * Global because notifications are raised from almost every domain module
 * (trips, deliveries, errands, safety, ledger) and importing a PushModule
 * into each of them is boilerplate that gets forgotten — and a forgotten
 * import surfaces as a missing notification, not a compile error.
 */
@Global()
@Module({
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
