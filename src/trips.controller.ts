import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { RolesGuard } from "./roles.guard";
import { Roles } from "./roles.decorator";
import { CurrentUser } from "./current-user.decorator";
import { TripsService } from "./trips.service";
import { CreateTripDto } from "./create-trip.dto";
import { RateDto } from "./rate.dto";

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

  @Post(":id/cancel")
  cancel(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.tripsService.cancelTrip(id, user.userId);
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
