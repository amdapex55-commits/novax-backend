import { LocationService } from "./location.service";
import type { RedisService } from "../redis/redis.service";
import type { PrismaService } from "../prisma/prisma.service";

// A driver whose phone died stays in the Redis geo set at their last known
// corner. Matching would pick them as "nearest" and burn the full 15s accept
// window on a phone that isn't listening. These tests pin down that they're
// skipped, and that skipping them also evicts them.

const NOW = 1_700_000_000_000;

type GeoHit = [string, string];

function makeService(opts: {
  geoHits: GeoHit[];
  lastSeen: (string | null)[];
  eligibleIds?: string[];
  ledgerSums?: { userId: string; _sum: { netAmount: number } }[];
}) {
  const zrem = jest.fn().mockResolvedValue(1);
  const del = jest.fn().mockResolvedValue(1);
  const mget = jest.fn().mockResolvedValue(opts.lastSeen);
  const call = jest.fn().mockResolvedValue(opts.geoHits);

  const redis = {
    client: { call, mget, zrem, del, geoadd: jest.fn(), set: jest.fn() },
  } as unknown as RedisService;

  // Default: every driver the freshness filter lets through is DB-eligible,
  // so these tests isolate freshness rather than re-testing the KYC gate.
  const findMany = jest.fn().mockImplementation(({ where }: any) => {
    const ids: string[] = where.id.in;
    const allow = opts.eligibleIds ?? ids;
    return Promise.resolve(ids.filter((id) => allow.includes(id)).map((id) => ({ id })));
  });

  // filterEligible also sums each candidate's ledger to enforce the credit
  // limit. Default to no entries = zero balance = nobody blocked, so these
  // tests stay about GPS freshness.
  const groupBy = jest.fn().mockResolvedValue(opts.ledgerSums ?? []);
  // findNearbyDriversForMode narrows by activeMode after the eligibility
  // filter. Default to "every candidate is in this mode" so mode tests are
  // about the segregation flag being forwarded, not about mode filtering.
  const profileFindMany = jest.fn().mockImplementation(({ where }: any) =>
    Promise.resolve((where.userId?.in ?? []).map((userId: string) => ({ userId }))),
  );

  /* Every job table the busy-driver check reads. Default to "nobody is on a
     job", so these tests keep testing what they are about (freshness,
     segregation, credit) rather than accidentally testing availability —
     while still exercising the real code path. A test that needs a busy
     driver overrides jobFindMany. */
  const jobFindMany = jest.fn().mockResolvedValue([]);
  const prisma = {
    user: { findMany },
    driverProfile: { findMany: profileFindMany },
    ledgerEntry: { groupBy },
    trip: { findMany: jobFindMany },
    delivery: { findMany: jobFindMany },
    foodOrder: { findMany: jobFindMany },
    errand: { findMany: jobFindMany },
  } as unknown as PrismaService;

  return { service: new LocationService(redis, prisma), zrem, del, mget, findMany, groupBy, profileFindMany, jobFindMany };
}

describe("LocationService.findNearbyDrivers — GPS freshness", () => {
  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it("keeps a driver whose fix is recent", async () => {
    const { service } = makeService({
      geoHits: [["driver-fresh", "0.4"]],
      lastSeen: [String(NOW - 5_000)], // 5s ago — a normal ping cadence
    });

    const result = await service.findNearbyDrivers(24.81, 67.03, 3);

    expect(result).toEqual([{ driverId: "driver-fresh", distanceKm: 0.4 }]);
  });

  it("skips and evicts a driver whose fix is older than 3 minutes", async () => {
    const { service, zrem, del } = makeService({
      geoHits: [["driver-dead", "0.1"]],
      lastSeen: [String(NOW - 4 * 60 * 1000)], // 4 minutes ago
    });

    const result = await service.findNearbyDrivers(24.81, 67.03, 3);

    expect(result).toEqual([]);
    // Evicting matters as much as skipping: otherwise this driver is
    // re-examined on every single match attempt forever.
    expect(zrem).toHaveBeenCalledWith("drivers:geo", "driver-dead");
    expect(del).toHaveBeenCalledWith("driver:lastseen:driver-dead");
  });

  it("treats a missing last-seen key as dead, not as fresh", async () => {
    const { service, zrem } = makeService({
      geoHits: [["driver-ghost", "0.2"]],
      lastSeen: [null],
    });

    expect(await service.findNearbyDrivers(24.81, 67.03, 3)).toEqual([]);
    expect(zrem).toHaveBeenCalledWith("drivers:geo", "driver-ghost");
  });

  it("treats a corrupt last-seen value as dead rather than infinitely fresh", async () => {
    const { service } = makeService({
      geoHits: [["driver-corrupt", "0.2"]],
      lastSeen: ["not-a-timestamp"], // Number() -> NaN
    });

    // NaN comparisons are false, so this must land on the "stale" side.
    expect(await service.findNearbyDrivers(24.81, 67.03, 3)).toEqual([]);
  });

  it("keeps the fresh drivers and drops the stale ones from a mixed set", async () => {
    const { service, findMany } = makeService({
      geoHits: [
        ["driver-dead", "0.1"],
        ["driver-live", "0.9"],
      ],
      lastSeen: [String(NOW - 10 * 60 * 1000), String(NOW - 2_000)],
    });

    const result = await service.findNearbyDrivers(24.81, 67.03, 3);

    expect(result).toEqual([{ driverId: "driver-live", distanceKm: 0.9 }]);
    // The eligibility query should only ask about the survivor — freshness
    // runs first specifically so the database does less work.
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.id.in).toEqual(["driver-live"]);
  });

  it("does not hit the database at all when every candidate is stale", async () => {
    const { service, findMany } = makeService({
      geoHits: [["a", "0.1"], ["b", "0.2"]],
      lastSeen: [null, null],
    });

    expect(await service.findNearbyDrivers(24.81, 67.03, 3)).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

/* ===================================================================
   REVIEW / TEST FLEET SEGREGATION
   ===================================================================

   This is a safety mechanism, not a feature, and its correctness is entirely
   about what must NEVER happen:

     - a store reviewer's simulated ride must never be dispatched to a real
       person on a real bike in Karachi
     - a paying customer must never be matched to the simulated test fleet

   Both directions are enforced in one place (filterEligible) because every
   service — trips, delivery, food, errands — matches through it. These tests
   assert the query that gate produces, since a wrong value here is invisible
   until the day a real rider is sent to nobody.                          */

describe("LocationService — test fleet segregation", () => {
  const FRESH = [String(NOW - 5_000), String(NOW - 5_000)];

  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("searches ONLY real drivers by default", async () => {
    // The default must be the safe one: any caller that forgets the flag gets
    // the real fleet, never the test fleet.
    const { service, findMany } = makeService({
      geoHits: [["d1", "0.5"], ["d2", "0.9"]],
      lastSeen: FRESH,
    });
    await service.findNearbyDrivers(24.81, 67.03, 3);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isTestAccount: false }),
      }),
    );
  });

  it("searches ONLY test drivers for a test trip", async () => {
    const { service, findMany } = makeService({
      geoHits: [["d1", "0.5"], ["d2", "0.9"]],
      lastSeen: FRESH,
    });
    await service.findNearbyDrivers(24.81, 67.03, 3, true);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isTestAccount: true }),
      }),
    );
  });

  it("uses an exact match, never a set — segregation is a guarantee, not a preference", async () => {
    // `{ in: [true, false] }` or an omitted key would both "work" in casual
    // testing and silently mix the fleets in production.
    const { service, findMany } = makeService({
      geoHits: [["d1", "0.5"]],
      lastSeen: [String(NOW - 5_000)],
    });
    await service.findNearbyDrivers(24.81, 67.03, 3, false);
    const where = findMany.mock.calls[0][0].where;
    expect(where.isTestAccount).toBe(false);
    expect(typeof where.isTestAccount).toBe("boolean");
  });

  it("keeps segregation when matching by mode (food and errands)", async () => {
    // findNearbyDriversForMode delegates to findNearbyDrivers; if it failed to
    // forward the flag, food and errand matching would lose the gate while
    // rides kept it — the worst kind of partial safety.
    const { service, findMany } = makeService({
      geoHits: [["d1", "0.5"]],
      lastSeen: [String(NOW - 5_000)],
    });
    await service.findNearbyDriversForMode(24.81, 67.03, 3, "RIDE", true);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isTestAccount: true }),
      }),
    );
  });

  it("still applies every other eligibility rule to the test fleet", async () => {
    // A test driver is still a driver: suspended, unapproved or offline must
    // all still exclude them. Segregation adds a condition, it does not
    // replace the others.
    const { service, findMany } = makeService({
      geoHits: [["d1", "0.5"]],
      lastSeen: [String(NOW - 5_000)],
    });
    await service.findNearbyDrivers(24.81, 67.03, 3, true);
    const where = findMany.mock.calls[0][0].where;
    expect(where.role).toBe("DRIVER");
    expect(where.isActive).toBe(true);
    expect(where.kycStatus).toBe("APPROVED");
    expect(where.driverProfile).toEqual({ isOnline: true });
  });
});
