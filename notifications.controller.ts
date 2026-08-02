import { Controller, Get, Param, Patch, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { CurrentUser } from "./current-user.decorator";
import { NotificationsService } from "./notifications.service";

@ApiTags("notifications")
@ApiBearerAuth()
@Controller("api/v1/notifications")
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private notificationsService: NotificationsService) {}

  @Get("me")
  listMine(@CurrentUser() user: { userId: string }) {
    return this.notificationsService.listMine(user.userId);
  }

  @Patch(":id/read")
  markRead(@CurrentUser() user: { userId: string }, @Param("id") id: string) {
    return this.notificationsService.markRead(user.userId, id);
  }
}
