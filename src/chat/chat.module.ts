import { Module } from "@nestjs/common";
import { ChatService } from "./chat.service";
import { ChatController } from "./chat.controller";
import { LocationModule } from "../location/location.module";

@Module({
  imports: [LocationModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
