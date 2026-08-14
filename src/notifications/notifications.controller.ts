import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { NotificationsService } from "./notifications.service";
import { PushService } from "../push/push.service";
import { RegisterDeviceDto } from "../push/dto/register-device.dto";

@ApiTags("notifications")
@ApiBearerAuth()
@Controller("api/v1/notifications")
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    private notificationsService: NotificationsService,
    private push: PushService,
  ) {}

  /**
   * Called on every cold start once signed in, not just the first time.
   *
   * FCM rotates tokens on reinstall, restore-from-backup, and occasionally on
   * its own schedule. Registering once at signup means a phone silently stops
   * receiving notifications weeks later with nothing to indicate why — so the
   * app re-registers every launch and this upserts.
   */
  @Post("devices")
  registerDevice(@CurrentUser() user: { userId: string }, @Body() dto: RegisterDeviceDto) {
    return this.push.registerDevice(user.userId, dto.token, dto.platform, dto.app);
  }

  /** Called on sign-out, so the next person to use this phone does not
   *  receive the previous user's notifications. */
  @Delete("devices/:token")
  unregisterDevice(@Param("token") token: string) {
    // No ownership check on purpose: possession of the token is the proof,
    // and refusing to unregister a token that has already been re-homed to
    // another user would strand notifications on a device that asked to stop.
    return this.push.unregisterDevice(token);
  }

  @Get("me")
  listMine(@CurrentUser() user: { userId: string }) {
    return this.notificationsService.listMine(user.userId);
  }

  @Patch(":id/read")
  markRead(@CurrentUser() user: { userId: string }, @Param("id") id: string) {
    return this.notificationsService.markRead(user.userId, id);
  }
}
