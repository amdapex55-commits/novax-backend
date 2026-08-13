import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { TripsService } from "./trips.service";
import { CreateTripDto } from "./dto/create-trip.dto";
import { RateDto } from "../ratings/dto/rate.dto";
import { CancelTripDto } from "./dto/cancel-trip.dto";

type ReqUser = { userId: string; role: string };

@ApiTags("trips")
@ApiBearerAuth()
@Controller("api/v1/trips")
@UseGuards(JwtAuthGuard, RolesGuard)
export class TripsController {
  constructor(private tripsService: TripsService) {}

  @Post()
  @Roles("RIDER")
  @ApiOperation({ summary: "Request a ride/delivery — triggers async driver matching" })
  create(@CurrentUser() user: ReqUser, @Body() dto: CreateTripDto) {
    return this.tripsService.createTrip(user.userId, dto);
  }

  @Post(":id/accept")
  @Roles("DRIVER")
  accept(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.tripsService.acceptTrip(id, user.userId);
  }

  @Post(":id/decline")
  @Roles("DRIVER")
  decline(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.tripsService.declineTrip(id, user.userId);
  }

  @Post(":id/arrive")
  @Roles("DRIVER")
  arrive(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.tripsService.markArrived(id, user.userId);
  }

  @Post(":id/start")
  @Roles("DRIVER")
  start(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.tripsService.startTrip(id, user.userId);
  }

  @Post(":id/complete")
  @Roles("DRIVER")
  complete(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.tripsService.completeTrip(id, user.userId);
  }

  // The body is optional so an older client (or a cached bundle) can still
  // cancel — a customer must never be trapped in a booking because their app
  // predates a field. A cancellation with no reason is still better than one
  // that fails.
  @Post(":id/cancel")
  cancel(
    @CurrentUser() user: ReqUser,
    @Param("id") id: string,
    @Body() dto?: CancelTripDto,
  ) {
    return this.tripsService.cancelTrip(id, user.userId, dto);
  }

  @Post(":id/rate")
  @Roles("RIDER")
  rate(@CurrentUser() user: ReqUser, @Param("id") id: string, @Body() dto: RateDto) {
    return this.tripsService.rateTrip(id, user.userId, dto.score, dto.comment);
  }

  // Registered before ":id" on purpose — Nest matches routes in declaration
  // order, so a literal path after a ":id" route would never be reached
  // (it'd get swallowed as an id lookup instead).
  @Get("incentive-progress")
  @Roles("DRIVER")
  incentiveProgress(@CurrentUser() user: ReqUser) {
    return this.tripsService.getWeeklyIncentiveProgress(user.userId);
  }

  @Post(":id/share")
  @ApiOperation({ summary: "Create a public live-tracking link for this trip" })
  share(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.tripsService.createShareLink(id, user.userId);
  }

  @Get(":id")
  getOne(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.tripsService.getTrip(id, user.userId, user.role);
  }

  @Get()
  listMine(@CurrentUser() user: ReqUser) {
    return this.tripsService.listMyTrips(user.userId);
  }
}
