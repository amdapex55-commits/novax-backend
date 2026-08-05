import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { FoodOrdersService } from "./food-orders.service";
import { CreateFoodOrderDto } from "./dto/create-food-order.dto";
import { RateDto } from "../ratings/dto/rate.dto";

type ReqUser = { userId: string; role: string };

@ApiTags("food-orders")
@ApiBearerAuth()
@Controller("api/v1/food-orders")
@UseGuards(JwtAuthGuard, RolesGuard)
export class FoodOrdersController {
  constructor(private foodOrdersService: FoodOrdersService) {}

  @Post()
  @Roles("RIDER")
  create(@CurrentUser() user: ReqUser, @Body() dto: CreateFoodOrderDto) {
    return this.foodOrdersService.createOrder(user.userId, dto);
  }

  // ---- Restaurant side ----

  @Get("restaurant/mine")
  @Roles("RESTAURANT")
  listRestaurantOrders(@CurrentUser() user: ReqUser) {
    return this.foodOrdersService.listRestaurantOrders(user.userId);
  }

  @Post(":id/restaurant-accept")
  @Roles("RESTAURANT")
  restaurantAccept(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.foodOrdersService.acceptOrder(user.userId, id);
  }

  @Post(":id/mark-ready")
  @Roles("RESTAURANT")
  markReady(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.foodOrdersService.markReady(user.userId, id);
  }

  // ---- Driver side ----

  @Post(":id/accept")
  @Roles("DRIVER")
  acceptOffer(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.foodOrdersService.acceptOffer(user.userId, id);
  }

  @Post(":id/decline")
  @Roles("DRIVER")
  declineOffer(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.foodOrdersService.declineOffer(user.userId, id);
  }

  @Post(":id/picked-up")
  @Roles("DRIVER")
  pickedUp(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.foodOrdersService.markPickedUp(user.userId, id);
  }

  @Post(":id/delivered")
  @Roles("DRIVER")
  delivered(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.foodOrdersService.markDelivered(user.userId, id);
  }

  // ---- Shared ----

  @Post(":id/cancel")
  cancel(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.foodOrdersService.cancelOrder(id, user.userId);
  }

  @Post(":id/rate")
  @Roles("RIDER")
  rate(@CurrentUser() user: ReqUser, @Param("id") id: string, @Body() dto: RateDto) {
    return this.foodOrdersService.rateOrder(id, user.userId, dto.score, dto.comment);
  }

  @Get(":id")
  getOne(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.foodOrdersService.getOrder(id, user.userId, user.role);
  }

  @Get()
  listMine(@CurrentUser() user: ReqUser) {
    return this.foodOrdersService.listMine(user.userId);
  }
}
