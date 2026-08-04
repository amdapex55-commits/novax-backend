import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { RolesGuard } from "./roles.guard";
import { Roles } from "./roles.decorator";
import { CurrentUser } from "./current-user.decorator";
import { FoodOrdersService } from "./food-orders.service";
import { CreateFoodOrderDto } from "./create-food-order.dto";
import { RateDto } from "./rate.dto";

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
  getOne(@Param("id") id: string) {
    return this.foodOrdersService.getOrder(id);
  }

  @Get()
  listMine(@CurrentUser() user: ReqUser) {
    return this.foodOrdersService.listMine(user.userId);
  }
}
