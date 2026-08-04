import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { CurrentUser } from "./current-user.decorator";
import { ChatService } from "./chat.service";
import { SendMessageDto } from "./send-message.dto";

type ReqUser = { userId: string; role: string };

// Deliberately no @Roles guard — a thread's two allowed participants are
// whichever two ids the underlying Trip/Delivery/FoodOrder/Errand record
// names (rider+driver, customer+driver, ...), checked in ChatService against
// the real record, not against a fixed role list.
@ApiTags("chat")
@ApiBearerAuth()
@Controller("api/v1/chat")
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private chatService: ChatService) {}

  @Get(":contextType/:contextId")
  @ApiOperation({ summary: "List messages for a trip/delivery/food-order/errand thread" })
  list(@CurrentUser() user: ReqUser, @Param("contextType") contextType: string, @Param("contextId") contextId: string) {
    return this.chatService.listMessages(contextType, contextId, user.userId);
  }

  @Post(":contextType/:contextId")
  @ApiOperation({ summary: "Send a message on a trip/delivery/food-order/errand thread" })
  send(
    @CurrentUser() user: ReqUser,
    @Param("contextType") contextType: string,
    @Param("contextId") contextId: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.chatService.sendMessage(contextType, contextId, user.userId, dto.body);
  }
}
