import { Controller, Get, Query, BadRequestException } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { LocationService } from "./location.service";

/**
 * Public supply visibility.
 *
 * WHY THIS EXISTS: the customer home shows "4 riders near you" and plots
 * them on the map. Most ride apps fake this with randomly scattered
 * vehicles; we show the real online riders, because a true number builds
 * trust and a fake one is a lie the customer eventually catches.
 *
 * PRIVACY — this is the important part. A rider's live position is personal
 * data, and this endpoint is reachable without an account (a guest browsing
 * before signup still needs to see whether Nova Go can serve them). So:
 *
 *   - No identifiers leave the server. No id, no name, no phone, no plate.
 *     The response is nothing but coordinates.
 *   - Coordinates are JITTERED by up to ~150m and rounded. You can see that
 *     supply exists nearby; you cannot follow an individual, and you cannot
 *     poll this to watch one rider move down a street.
 *   - Capped at 12 results, so it can't be used to enumerate the fleet.
 *   - Rate limited.
 *
 * The precise positions are still used server-side for matching — that's a
 * different question from what a stranger's browser is allowed to see.
 */
@ApiTags("location")
@Controller("location")
export class LocationController {
  constructor(private locationService: LocationService) {}

  @Get("nearby")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: "Anonymised nearby rider positions for the supply indicator" })
  async nearby(@Query("lat") lat: string, @Query("lng") lng: string) {
    const latNum = Number(lat);
    const lngNum = Number(lng);
    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      throw new BadRequestException("lat and lng are required");
    }
    if (latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
      throw new BadRequestException("lat/lng out of range");
    }

    // 5km — the same neighbourhood the matcher searches, so the number the
    // customer sees corresponds to the riders who could actually reach them.
    // findNearbyDrivers already filters out anyone unapproved, suspended or
    // offline, so a suspended rider never appears as available supply.
    const riders = await this.locationService.findNearbyDrivers(latNum, lngNum, 5);

    const positions = await this.locationService.getDriverLocations(
      riders.slice(0, 12).map((r) => r.driverId),
    );

    // ~0.0013° ≈ 150m. Enough to break individual tracking while keeping the
    // dots in the right part of the map.
    const jitter = () => (Math.random() - 0.5) * 0.0026;

    return Array.from(positions.values()).map((p) => ({
      lat: Math.round((p.lat + jitter()) * 10000) / 10000,
      lng: Math.round((p.lng + jitter()) * 10000) / 10000,
    }));
  }
}
