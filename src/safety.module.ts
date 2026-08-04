import { Module } from "@nestjs/common";
import { SafetyService } from "./safety.service";
import { SafetyController } from "./safety.controller";
import { NotificationsModule } from "./notifications.module";
import { LocationModule } from "./location.module";
import { AnalyticsModule } from "./analytics.module";

@Module({
  imports: [NotificationsModule, LocationModule, AnalyticsModule],
  controllers: [SafetyController],
  providers: [SafetyService],
  exports: [SafetyService],
})
export class SafetyModule {}
