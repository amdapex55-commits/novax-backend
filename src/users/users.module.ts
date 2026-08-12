import { Module } from "@nestjs/common";
import { UsersService } from "./users.service";
import { UsersController } from "./users.controller";
import { PublicUsersController } from "./public-users.controller";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [NotificationsModule],
  controllers: [UsersController, PublicUsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
