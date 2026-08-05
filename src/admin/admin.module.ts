import { Module } from "@nestjs/common";
import { AdminService } from "./admin.service";
import { AdminController } from "./admin.controller";
import { NotificationsModule } from "../notifications/notifications.module";
import { LocationModule } from "../location/location.module";

@Module({
  imports: [NotificationsModule, LocationModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
