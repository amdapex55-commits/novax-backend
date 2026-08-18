import { Injectable, Logger } from "@nestjs/common";
import { RedisService } from "../redis/redis.service";
import { PrismaService } from "../prisma/prisma.service";

export interface NearbyDriver {
  driverId: string;
  distanceKm: number;
}

// A heartbeat every 20s means three missed beats before we stop believing
// the app is alive — tolerant of one bad tunnel, not of a killed process.
const HEARTBEAT_STALE_MS = 60_000;
const GEO_KEY = "drivers:geo"; // single-city MVP; shard per-city (drivers:geo:<city>) once you have more than one

/**
 * How old a driver's last GPS fix may be before we stop offering them work.
 *
 * The failure this prevents: a driver's app is killed or their phone dies, but
 * GEOADD left them sitting in the geo set at their last known corner. Matching
 * picks them as "nearest", burns the full 15-second accept window waiting for a
 * phone that isn't listening, then cascades to the next driver. The passenger
 * pays for that in wall-clock time, and it compounds — three dead phones ahead
 * of a live one is a 45-second wait before anyone's screen even lights up.
 *
 * 3 minutes is deliberately loose: drivers ping every 3-5s, so a live driver is
 * never near this, and the slack absorbs a tunnel or a moment of bad signal
 * without dropping someone who is genuinely working.
 */
const MAX_FIX_AGE_MS = 3 * 60 * 1000;

/**
 * The last-seen key has to outlive MAX_FIX_AGE_MS by a wide margin. If it
 * expired at the threshold, "stale" and "never sent a ping" would be the same
 * missing key, and there'd be no way to log how stale a pruned driver was.
 */
const LASTSEEN_TTL_SECONDS = 15 * 60;

const lastSeenKey = (driverId: string) => `driver:lastseen:${driverId}`;

/**
 * How far a driver's wallet may go negative before they stop being offered work.
 *
 * This is cash-collect, so the money flows the "wrong" way: the customer hands
 * the driver the full fare, and the driver owes us 15% of it. Their ledger
 * balance therefore goes negative by design, and keeps going.
 *
 * Without a floor, a driver can ride indefinitely owing an unbounded amount and
 * nothing in the system objects. At 40 trips a week on Rs 200 fares that's about
 * Rs 1,200 owed by Monday — the exposure is real and it compounds silently.
 *
 * -2000 PKR is roughly a week and a half of unsettled commission: loose enough
 * that a working driver never trips it between Monday settlements, tight enough
 * that the loss is bounded if someone stops paying and disappears.
 *
 * Set DRIVER_CREDIT_LIMIT_PKR=0 to disable the cap entirely.
 */
export const DRIVER_CREDIT_LIMIT_PKR = (() => {
  const raw = Number(process.env.DRIVER_CREDIT_LIMIT_PKR);
  return Number.isFinite(raw) ? Math.abs(raw) : 2000;
})();

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
    // Track last-seen so a stale ping (app killed, phone died) can be pruned.
    // This is read on every match attempt by filterEligible() — there is no
    // cron job, and there doesn't need to be: matching prunes as it goes.
    await this.redis.client.set(
      lastSeenKey(driverId),
      Date.now().toString(),
      "EX",
      LASTSEEN_TTL_SECONDS,
    );
  }

  /**
   * The driver app says "I am still here" every 20 seconds while online.
   *
   * WHY A CLAIM THAT EXPIRES BEATS A BOOLEAN
   *
   * driverProfile.isOnline is set by the app when the driver taps Go Online.
   * Nothing ever unsets it if the app dies — and on the Xiaomi, Oppo and Vivo
   * hardware most of this market carries, the battery manager killing a
   * backgrounded app is routine, not exceptional. The driver believes they
   * are working. The matcher ranks them. Every offer burns its full
   * fifteen-second window on a phone that is not listening, and the customer
   * waits through it.
   *
   * A heartbeat inverts that: liveness is something the app must keep
   * asserting, so stopping is indistinguishable from never having started and
   * the server needs no cooperation from a dead process to notice.
   *
   * The device fields ride along because ops otherwise diagnoses "I'm not
   * getting jobs" by asking a rider on the phone whether their GPS is on.
   */
  async recordHeartbeat(
    driverId: string,
    device: { appVersion?: string; batteryLevel?: number; networkType?: string } = {},
  ) {
    await this.prisma.driverProfile.updateMany({
      where: { userId: driverId },
      data: {
        lastHeartbeatAt: new Date(),
        ...(device.appVersion ? { appVersion: device.appVersion.slice(0, 32) } : {}),
        ...(Number.isFinite(device.batteryLevel)
          ? { batteryLevel: Math.max(0, Math.min(100, Math.round(device.batteryLevel!))) }
          : {}),
        ...(device.networkType ? { networkType: device.networkType.slice(0, 16) } : {}),
      },
    });
    return { ok: true };
  }

  /**
   * The authoritative answer to "am I actually receiving jobs, and if not,
   * why?" — computed from the same conditions matching uses, so the driver
   * can never be told they are fine while the matcher is skipping them.
   *
   * Returning REASONS rather than a boolean is the point. "You are offline"
   * sends a driver to the toggle they already switched on; "your GPS has not
   * updated in four minutes" tells them what to actually fix.
   */
  async getDriverStatus(driverId: string) {
    const [user, profile, lastFix] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: driverId },
        select: { isActive: true, kycStatus: true },
      }),
      this.prisma.driverProfile.findUnique({
        where: { userId: driverId },
        select: {
          isOnline: true, lastHeartbeatAt: true, activeMode: true,
          appVersion: true, batteryLevel: true, networkType: true,
        },
      }),
      this.getLastFixTimes([driverId]),
    ]);

    const now = Date.now();
    const fixAt = lastFix.get(driverId) ?? null;
    const heartbeatAt = profile?.lastHeartbeatAt ? new Date(profile.lastHeartbeatAt).getTime() : null;

    const blockers: string[] = [];
    if (!user?.isActive) blockers.push("Your account is suspended — contact the ops desk.");
    if (user?.kycStatus !== "APPROVED") blockers.push("Your documents are still being reviewed.");
    if (!profile?.isOnline) blockers.push("You are offline. Tap Go Online to start receiving jobs.");
    if (!fixAt || now - fixAt > MAX_FIX_AGE_MS) {
      blockers.push("Your location hasn't reached us recently — check GPS is on and keep the app open.");
    }
    if (!heartbeatAt || now - heartbeatAt > HEARTBEAT_STALE_MS) {
      blockers.push("The app hasn't checked in recently. If your phone restricts background apps, allow Nova Go to run.");
    }
    const overLimit = await this.driversOverCreditLimit([driverId]);
    if (overLimit.includes(driverId)) {
      blockers.push("You've reached the commission limit. Settle to start receiving jobs again.");
    }

    return {
      receivingJobs: blockers.length === 0,
      blockers,
      device: {
        appVersion: profile?.appVersion ?? null,
        batteryLevel: profile?.batteryLevel ?? null,
        networkType: profile?.networkType ?? null,
        lastFixSecondsAgo: fixAt ? Math.round((now - fixAt) / 1000) : null,
        lastHeartbeatSecondsAgo: heartbeatAt ? Math.round((now - heartbeatAt) / 1000) : null,
      },
    };
  }

  async removeDriver(driverId: string) {
    // Drop the position AND the last-seen marker together — leaving the marker
    // behind would make a driver who went offline cleanly look merely stale.
    await Promise.all([
      this.redis.client.zrem(GEO_KEY, driverId),
      this.redis.client.del(lastSeenKey(driverId)),
    ]);
  }

  /** Trips module calls this to find match candidates, closest first. */
  async findNearbyDrivers(lat: number, lng: number, radiusKm: number, wantTestFleet = false): Promise<NearbyDriver[]> {
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
    return this.filterEligible(candidates, wantTestFleet);
  }

  /**
   * Keep only drivers the database says may currently take a passenger.
   * Anyone rejected here is also evicted from the geo set, so a suspended
   * driver stops costing us a query on every subsequent search.
   */
  /**
   * @param wantTestFleet true when the job belongs to a review/test account.
   *
   * SEGREGATION IS THE WHOLE POINT, AND IT RUNS IN BOTH DIRECTIONS.
   *
   *   real job  -> real drivers only  (a reviewer's simulated rider must
   *               never be dispatched to a paying customer)
   *   test job  -> test drivers only  (a reviewer's ride must never be sent
   *               to a real person on a real bike in Karachi)
   *
   * Enforced here rather than in trips/delivery/food/errands because every
   * one of those matches through this function — for the same reason the
   * credit-limit check lives here. A per-service check is four places to
   * forget it, and forgetting this one dispatches a real rider to nobody.
   */
  private async filterEligible(
    candidates: NearbyDriver[],
    wantTestFleet = false,
  ): Promise<NearbyDriver[]> {
    if (candidates.length === 0) return [];

    // Freshness first, deliberately: a dead phone is the cheapest thing to
    // rule out (one MGET for the whole candidate list) and doing it here
    // means the database query below only asks about drivers who could
    // actually answer.
    const fresh = await this.filterFreshFixes(candidates);
    if (fresh.length === 0) return [];

    const ids = fresh.map((c) => c.driverId);
    const allowed = await this.prisma.user.findMany({
      where: {
        id: { in: ids },
        role: "DRIVER",
        isActive: true,           // not suspended by ops
        kycStatus: "APPROVED",    // documents verified by a person
        driverProfile: { isOnline: true },
        // The segregation gate. Never `{ in: [...] }` and never omitted —
        // an exact match in both directions is what makes it a guarantee
        // rather than a preference.
        isTestAccount: wantTestFleet,
      },
      select: { id: true },
    });

    const allowedIds = new Set(allowed.map((u) => u.id));

    // Drivers who owe us more than the credit limit stop receiving work until
    // they settle. Checked here rather than in each of trips/delivery/food/
    // errands, because every one of those matches through this function — a
    // per-service check is four places to forget it.
    const overLimit = await this.driversOverCreditLimit(ids);
    for (const id of overLimit) allowedIds.delete(id);

    /* A DRIVER CARRYING SOMEONE IS NOT AVAILABLE.
       Nothing checked this. A driver mid-trip stays in the Redis geo set,
       stays isOnline, stays APPROVED — so they were a candidate for the next
       job, and were routinely offered one. The driver never saw it (their
       app leaves the home screen, and with it the offer listener) so the
       offer sat unanswered for its full fifteen seconds and only then
       cascaded to the next driver.

       That is the customer's wait, not the driver's: with a handful of riders
       online, a parcel could burn a minute being offered to three people who
       were all already busy. It also reads to ops as "no drivers available"
       when there were plenty.

       Checked here for the same reason the credit limit is: trips,
       deliveries, food orders and errands all match through this one
       function, and a per-service check is four places to forget it. */
    const busy = await this.driversOnAJob(ids);
    for (const id of busy) allowedIds.delete(id);

    const rejected = ids.filter((id) => !allowedIds.has(id));

    if (rejected.length) {
      this.logger.warn(
        `Excluded ${rejected.length} ineligible driver(s) from matching: ${rejected.join(", ")}`,
      );
      // Evict the permanently ineligible (suspended, KYC revoked, offline) so
      // they stop costing a query on every search.
      //
      // Over-limit drivers are deliberately NOT evicted: they're still online
      // and physically present, and the moment their payment lands they should
      // be matchable again without having to toggle offline and back on.
      // Over-limit and busy drivers are deliberately NOT evicted: both are
      // online and physically present, and both become matchable again on
      // their own — one when payment lands, the other when they finish the
      // job. Evicting them would take them off the map until they toggled
      // offline and back on, which is a worse bug than the one being fixed.
      const keepInGeoSet = new Set([...overLimit, ...busy]);
      await Promise.all(
        rejected
          .filter((id) => !keepInGeoSet.has(id))
          .map((id) => this.removeDriver(id).catch(() => {})),
      );
    }

    return fresh.filter((c) => allowedIds.has(c.driverId));
  }

  /**
   * Which of these drivers owe more than the credit limit.
   *
   * One groupBy for the whole candidate list rather than a balance lookup per
   * driver. Sums netAmount, which is the same figure LedgerService.getBalance()
   * reports — so what blocks a driver here is exactly the number their wallet
   * screen shows them, and nobody has to reconcile two different truths.
   */
  /**
   * Which of these drivers are already on a job.
   *
   * One query per job type rather than a per-driver lookup, and only the
   * statuses that actually occupy a rider:
   *
   *   MATCHING  — they are being offered something right now. Offering them a
   *               second thing in the same fifteen-second window means one of
   *               the two is guaranteed to expire unanswered.
   *   MATCHED / IN_PROGRESS / PICKED_UP / IN_TRANSIT — they are carrying it.
   *
   * REQUESTED is not here: that is a job with no driver attached yet.
   */
  private async driversOnAJob(driverIds: string[]): Promise<string[]> {
    if (driverIds.length === 0) return [];
    const driverId = { in: driverIds };

    const [trips, deliveries, foodOrders, errands] = await Promise.all([
      this.prisma.trip.findMany({
        where: { driverId, status: { in: ["MATCHING", "MATCHED", "IN_PROGRESS"] } },
        select: { driverId: true },
      }),
      this.prisma.delivery.findMany({
        where: { driverId, status: { in: ["MATCHING", "MATCHED", "PICKED_UP", "IN_TRANSIT"] } },
        select: { driverId: true },
      }),
      this.prisma.foodOrder.findMany({
        where: { driverId, status: { in: ["MATCHING", "ASSIGNED", "PICKED_UP"] } },
        select: { driverId: true },
      }).catch(() => []),
      this.prisma.errand.findMany({
        where: { driverId, status: { in: ["MATCHING", "ACCEPTED", "SHOPPING", "ON_THE_WAY"] } },
        select: { driverId: true },
      }).catch(() => []),
    ]);

    const busy = new Set<string>();
    for (const row of [...trips, ...deliveries, ...foodOrders, ...errands]) {
      if (row.driverId) busy.add(row.driverId);
    }
    if (busy.size) {
      this.logger.debug(`Skipping ${busy.size} driver(s) already on a job.`);
    }
    return [...busy];
  }

  private async driversOverCreditLimit(driverIds: string[]): Promise<string[]> {
    if (DRIVER_CREDIT_LIMIT_PKR === 0 || driverIds.length === 0) return [];

    const sums = await this.prisma.ledgerEntry.groupBy({
      by: ["userId"],
      where: { userId: { in: driverIds } },
      _sum: { netAmount: true },
    });

    const blocked: string[] = [];
    for (const row of sums) {
      const balance = row._sum.netAmount ? Number(row._sum.netAmount) : 0;
      if (balance <= -DRIVER_CREDIT_LIMIT_PKR) {
        blocked.push(row.userId);
        this.logger.warn(
          `Driver ${row.userId} is over the credit limit (balance ${balance.toFixed(2)}, limit -${DRIVER_CREDIT_LIMIT_PKR}) — not being offered work until they settle.`,
        );
      }
    }
    return blocked;
  }

  /**
   * Drop candidates whose last GPS fix is older than MAX_FIX_AGE_MS, and evict
   * them from the geo set so they stop being candidates at all.
   *
   * One MGET covers the whole candidate list, so this costs a single Redis
   * round trip regardless of how many drivers the search returned.
   */
  private async filterFreshFixes(candidates: NearbyDriver[]): Promise<NearbyDriver[]> {
    const timestamps = await this.redis.client.mget(
      ...candidates.map((c) => lastSeenKey(c.driverId)),
    );

    const now = Date.now();
    const fresh: NearbyDriver[] = [];
    const stale: { driverId: string; ageMs: number | null }[] = [];

    candidates.forEach((candidate, i) => {
      const raw = timestamps[i];
      // A missing key means the driver is in the geo set but hasn't pinged
      // within LASTSEEN_TTL_SECONDS — far past stale. Treat as dead.
      if (raw === null || raw === undefined) {
        stale.push({ driverId: candidate.driverId, ageMs: null });
        return;
      }
      const ageMs = now - Number(raw);
      // NaN (corrupt value) fails this comparison and lands in `stale`, which
      // is the right side to fail towards.
      if (ageMs <= MAX_FIX_AGE_MS) {
        fresh.push(candidate);
      } else {
        stale.push({ driverId: candidate.driverId, ageMs });
      }
    });

    if (stale.length) {
      this.logger.warn(
        `Skipped ${stale.length} driver(s) with stale GPS: ` +
          stale
            .map((s) => `${s.driverId}(${s.ageMs === null ? "no fix" : `${Math.round(s.ageMs / 1000)}s`})`)
            .join(", "),
      );
      await Promise.all(stale.map((s) => this.removeDriver(s.driverId).catch(() => {})));
    }

    return fresh;
  }

  /** Food/errand matching needs the same geo search as ride matching, but
   * filtered down to drivers who've toggled into FOOD_ERRAND mode — a
   * driver only ever sits in one queue at a time (see DriverProfile.activeMode).
   * Widens the geo candidate set a bit before filtering since most nearby
   * drivers will typically be in RIDE mode and get filtered out. */
  async findNearbyDriversForMode(lat: number, lng: number, radiusKm: number, mode: "RIDE" | "FOOD_ERRAND", wantTestFleet = false): Promise<NearbyDriver[]> {
    const candidates = await this.findNearbyDrivers(lat, lng, radiusKm, wantTestFleet);
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

  /**
   * When each driver's position was last updated, for the whole fleet in one
   * round trip.
   *
   * GEOPOS returns a coordinate with no indication of its age, so the ops
   * fleet map cannot tell a driver moving through traffic from one whose
   * phone died twenty minutes ago at a junction — both render as a confident
   * dot. Ops then dispatches to the dot. This is the missing half of that
   * data: a position plus how much to trust it.
   *
   * Drivers with no recorded fix are absent from the map rather than present
   * with a zero timestamp, so callers can distinguish "never pinged" from
   * "pinged at the epoch".
   */
  async getLastFixTimes(driverIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!driverIds.length) return out;

    const raw = await this.redis.client.mget(...driverIds.map(lastSeenKey));
    driverIds.forEach((id, i) => {
      const value = raw[i];
      if (value === null || value === undefined) return;
      const ts = Number(value);
      if (Number.isFinite(ts)) out.set(id, ts);
    });
    return out;
  }
}
