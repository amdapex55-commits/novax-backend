import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { RestaurantsService } from "./restaurants.service";
import { CreateRestaurantDto } from "./dto/create-restaurant.dto";
import { UpdateRestaurantDto } from "./dto/update-restaurant.dto";
import { UpsertMenuItemDto } from "./dto/upsert-menu-item.dto";

type ReqUser = { userId: string; role: string };

@ApiTags("restaurants")
@Controller("api/v1/restaurants")
export class RestaurantsController {
  constructor(private restaurantsService: RestaurantsService) {}

  @Post()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("RESTAURANT")
  create(@CurrentUser() user: ReqUser, @Body() dto: CreateRestaurantDto) {
    return this.restaurantsService.createRestaurant(user.userId, dto);
  }

  @Get("me")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("RESTAURANT")
  getMine(@CurrentUser() user: ReqUser) {
    return this.restaurantsService.getMyRestaurant(user.userId);
  }

  @Patch("me")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("RESTAURANT")
  updateMine(@CurrentUser() user: ReqUser, @Body() dto: UpdateRestaurantDto) {
    return this.restaurantsService.updateMyRestaurant(user.userId, dto);
  }

  @Patch("me/toggle-open")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("RESTAURANT")
  toggleOpen(@CurrentUser() user: ReqUser) {
    return this.restaurantsService.toggleOpen(user.userId);
  }

  @Post("me/menu")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("RESTAURANT")
  addMenuItem(@CurrentUser() user: ReqUser, @Body() dto: UpsertMenuItemDto) {
    return this.restaurantsService.addMenuItem(user.userId, dto);
  }

  @Patch("me/menu/:itemId")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("RESTAURANT")
  updateMenuItem(@CurrentUser() user: ReqUser, @Param("itemId") itemId: string, @Body() dto: UpsertMenuItemDto) {
    return this.restaurantsService.updateMenuItem(user.userId, itemId, dto);
  }

  @Patch("me/menu/:itemId/archive")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("RESTAURANT")
  archiveMenuItem(@CurrentUser() user: ReqUser, @Param("itemId") itemId: string) {
    return this.restaurantsService.archiveMenuItem(user.userId, itemId);
  }

  @Get("admin/pending")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("ADMIN")
  listPending() {
    return this.restaurantsService.listPending();
  }

  @Post("admin/:id/approve")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("ADMIN")
  approve(@Param("id") id: string) {
    return this.restaurantsService.approve(id);
  }

  @Post("admin/:id/suspend")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("ADMIN")
  suspend(@Param("id") id: string) {
    return this.restaurantsService.suspend(id);
  }

  // Public marketplace browse — registered after every literal "me"/"admin"
  // path above and before the trailing ":id" so nothing gets shadowed.
  @Get()
  browse(@Query("search") search?: string) {
    return this.restaurantsService.browse(search);
  }

  @Get(":id")
  getOne(@Param("id") id: string) {
    return this.restaurantsService.getPublicDetail(id);
  }
}
