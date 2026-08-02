import { Injectable } from "@nestjs/common";
import { RedisService } from "../redis/redis.service";
import { PrismaService } from "../prisma/prisma.service";

export interface NearbyDriver {
  driverId: string;
  distanceKm: number;
}

const GEO_KEY = "drivers:geo"; // single-city MVP; shard per-city (drivers:geo:<city>) once you have more than one

@Injectable()
export class LocationService {
  constructor(
    private redis: RedisService,
    private prisma: PrismaService,
  ) {}

  /** Driver app calls this (via the WS gateway) every 3-5s while online. */
  async updateDriverLocation(driverId: string, lat: number, lng: number) {
    // GEOADD stores members on a sphere internally — no separate lat/lng columns needed
    // for the "who's nearby" query, that's the whole point of using Redis here.
    await this.redis.client.geoadd(GEO_KEY, lng, lat, driverId);
    // Track last-seen so a stale ping (app killed, phone died) can be pruned later
    // by a cron job rather than lingering forever in the geo index.
    await this.redis.client.set(`driver:lastseen:${driverId}`, Date.now().toString(), "EX", 120);
  }

  async removeDriver(driverId: string) {
    await this.redis.client.zrem(GEO_KEY, driverId);
  }

  /** Trips module calls this to find match candidates, closest first. */
  async findNearbyDrivers(lat: number, lng: number, radiusKm: number): Promise<NearbyDriver[]> {
    // GEOSEARCH ... WITHCOORD WITHDIST ASC — Redis does the distance sort for us,
    // no need to pull every driver into app code and sort in JS.
    const results = (await this.redis.client.call(
      "GEOSEARCH",
      GEO_KEY,
      "FROMLONLAT",
      lng.toString(),
      lat.toString(),
      "BYRADIUS",
      radiusKm.toString(),
      "km",
      "ASC",
      "WITHDIST",
    )) as [string, string][];

    return results.map(([driverId, distance]) => ({
      driverId,
      distanceKm: parseFloat(distance),
    }));
  }

  /** Food/errand matching needs the same geo search as ride matching, but
   * filtered down to drivers who've toggled into FOOD_ERRAND mode — a
   * driver only ever sits in one queue at a time (see DriverProfile.activeMode).
   * Widens the geo candidate set a bit before filtering since most nearby
   * drivers will typically be in RIDE mode and get filtered out. */
  async findNearbyDriversForMode(lat: number, lng: number, radiusKm: number, mode: "RIDE" | "FOOD_ERRAND"): Promise<NearbyDriver[]> {
    const candidates = await this.findNearbyDrivers(lat, lng, radiusKm);
    if (candidates.length === 0) return [];
    const profiles = await this.prisma.driverProfile.findMany({
      where: { userId: { in: candidates.map((c) => c.driverId) }, activeMode: mode, isOnline: true },
      select: { userId: true },
    });
    const eligible = new Set(profiles.map((p) => p.userId));
    return candidates.filter((c) => eligible.has(c.driverId));
  }

  async getDriverLocation(driverId: string): Promise<{ lat: number; lng: number } | null> {
    const pos = await this.redis.client.geopos(GEO_KEY, driverId);
    if (!pos || !pos[0]) return null;
    const [lng, lat] = pos[0];
    return { lat: parseFloat(lat), lng: parseFloat(lng) };
  }
}
