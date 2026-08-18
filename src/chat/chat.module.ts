import { Module } from "@nestjs/common";
import { ChatService } from "./chat.service";
import { ChatController } from "./chat.controller";
import { LocationModule } from "../location/location.module";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [LocationModule, NotificationsModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
