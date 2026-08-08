import { Injectable, Logger } from "@nestjs/common";
import { RedisService } from "../redis/redis.service";
import { PrismaService } from "../prisma/prisma.service";

export interface NearbyDriver {
  driverId: string;
  distanceKm: number;
}

const GEO_KEY = "drivers:geo"; // single-city MVP; shard per-city (drivers:geo:<city>) once you have more than one

@Injectable()
export class LocationService {
  private readonly logger = new Logger(LocationService.name);

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

    const candidates = results.map(([driverId, distance]) => ({
      driverId,
      distanceKm: parseFloat(distance),
    }));

    // ---- ELIGIBILITY GATE (launch blocker: "driver approval can be
    // bypassed") -------------------------------------------------------
    //
    // The gateway blocks an unapproved driver from GOING online, which
    // covers the common case. It does not cover the dangerous one: a driver
    // who was approved, went online (and so is in the Redis geo set), and is
    // THEN suspended or has their KYC revoked by ops. Their Redis entry
    // survives until they disconnect — so until this filter existed, ops
    // could suspend a driver for a safety incident and that same driver
    // could still be handed the next passenger.
    //
    // Redis is a location cache. The database is the authority on whether
    // someone is allowed to carry a person. Checking it costs one indexed
    // query per match attempt, which is nothing next to the alternative.
    return this.filterEligible(candidates);
  }

  /**
   * Keep only drivers the database says may currently take a passenger.
   * Anyone rejected here is also evicted from the geo set, so a suspended
   * driver stops costing us a query on every subsequent search.
   */
  private async filterEligible(candidates: NearbyDriver[]): Promise<NearbyDriver[]> {
    if (candidates.length === 0) return [];

    const ids = candidates.map((c) => c.driverId);
    const allowed = await this.prisma.user.findMany({
      where: {
        id: { in: ids },
        role: "DRIVER",
        isActive: true,           // not suspended by ops
        kycStatus: "APPROVED",    // documents verified by a person
        driverProfile: { isOnline: true },
      },
      select: { id: true },
    });

    const allowedIds = new Set(allowed.map((u) => u.id));
    const rejected = ids.filter((id) => !allowedIds.has(id));

    if (rejected.length) {
      this.logger.warn(
        `Excluded ${rejected.length} ineligible driver(s) from matching: ${rejected.join(", ")}`,
      );
      // Evict them so they stop appearing in future searches.
      await Promise.all(rejected.map((id) => this.removeDriver(id).catch(() => {})));
    }

    return candidates.filter((c) => allowedIds.has(c.driverId));
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

  /**
   * Positions for many drivers in ONE round trip.
   *
   * The ops fleet map needs every online driver's location at once, and it
   * refreshes every 15 seconds. Calling getDriverLocation() in a loop would
   * mean 200 sequential Redis round trips per refresh — GEOPOS already takes
   * a variadic member list, so this is one call regardless of fleet size.
   *
   * Drivers with no stored position (online but never sent a ping) are simply
   * absent from the returned map rather than appearing at 0,0 in the Atlantic.
   */
  async getDriverLocations(driverIds: string[]): Promise<Map<string, { lat: number; lng: number }>> {
    const out = new Map<string, { lat: number; lng: number }>();
    if (!driverIds.length) return out;

    const positions = await this.redis.client.geopos(GEO_KEY, ...driverIds);
    driverIds.forEach((id, i) => {
      const p = positions?.[i];
      if (!p) return;
      const [lng, lat] = p;
      const latNum = parseFloat(lat);
      const lngNum = parseFloat(lng);
      if (Number.isFinite(latNum) && Number.isFinite(lngNum)) {
        out.set(id, { lat: latNum, lng: lngNum });
      }
    });
    return out;
  }
}
