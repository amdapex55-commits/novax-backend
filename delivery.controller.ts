import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { RolesGuard } from "./roles.guard";
import { Roles } from "./roles.decorator";
import { CurrentUser } from "./current-user.decorator";
import { DeliveryService } from "./delivery.service";
import { CreateDeliveryDto } from "./create-delivery.dto";
import { MarkDeliveredDto } from "./mark-delivered.dto";
import { RateDto } from "./rate.dto";

type ReqUser = { userId: string; role: string };

@ApiTags("delivery")
@ApiBearerAuth()
@Controller("api/v1/deliveries")
@UseGuards(JwtAuthGuard, RolesGuard)
export class DeliveryController {
  constructor(private deliveryService: DeliveryService) {}

  @Post()
  @Roles("RIDER")
  @ApiOperation({ summary: "Send a parcel — triggers async driver matching, same as trips" })
  create(@CurrentUser() user: ReqUser, @Body() dto: CreateDeliveryDto) {
    return this.deliveryService.createDelivery(user.userId, dto);
  }

  @Post(":id/accept")
  @Roles("DRIVER")
  accept(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.deliveryService.acceptDelivery(id, user.userId);
  }

  @Post(":id/decline")
  @Roles("DRIVER")
  decline(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.deliveryService.declineDelivery(id, user.userId);
  }

  @Post(":id/pickup")
  @Roles("DRIVER")
  pickup(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.deliveryService.markPickedUp(id, user.userId);
  }

  @Post(":id/in-transit")
  @Roles("DRIVER")
  inTransit(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.deliveryService.markInTransit(id, user.userId);
  }

  @Post(":id/deliver")
  @Roles("DRIVER")
  deliver(@CurrentUser() user: ReqUser, @Param("id") id: string, @Body() dto: MarkDeliveredDto) {
    return this.deliveryService.markDelivered(id, user.userId, dto.proofOfDeliveryUrl);
  }

  @Post(":id/cancel")
  cancel(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.deliveryService.cancelDelivery(id, user.userId);
  }

  @Post(":id/rate")
  @Roles("RIDER")
  rate(@CurrentUser() user: ReqUser, @Param("id") id: string, @Body() dto: RateDto) {
    return this.deliveryService.rateDelivery(id, user.userId, dto.score, dto.comment);
  }

  @Get(":id")
  getOne(@Param("id") id: string) {
    return this.deliveryService.getDelivery(id);
  }

  @Get()
  listMine(@CurrentUser() user: ReqUser) {
    return this.deliveryService.listMyDeliveries(user.userId);
  }
}
