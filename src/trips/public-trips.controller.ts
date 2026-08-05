import { Controller, Get, Param } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { TripsService } from "./trips.service";

// Separate controller because TripsController puts JwtAuthGuard on the whole
// class — and the entire point of a share link is that the person opening it
// (a parent, a friend) does NOT have an account. Access control here is the
// unguessable token itself, and the response is a deliberately thin
// projection (see TripsService.getSharedTrip).
@ApiTags("trips")
@Controller("api/v1/public/trips")
export class PublicTripsController {
  constructor(private tripsService: TripsService) {}

  @Get("shared/:shareToken")
  @ApiOperation({ summary: "Public live view of a shared trip — no auth, token only" })
  // Tight limit: this is an unauthenticated endpoint keyed on a secret, so
  // rate-limiting is what stops someone from grinding through guesses.
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  getShared(@Param("shareToken") shareToken: string) {
    return this.tripsService.getSharedTrip(shareToken);
  }
}
