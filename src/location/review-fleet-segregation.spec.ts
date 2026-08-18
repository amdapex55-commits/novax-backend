/* ---------------------------------------------------------------------------
   Review-fleet segregation.

   Segregation runs in BOTH directions and must be exact:

     real job  -> real drivers only   (a reviewer's simulated ride must never
                                       be dispatched to a paying customer's
                                       rider)
     test job  -> test drivers only   (a reviewer's ride must never be sent to
                                       a real person on a real bike in
                                       Karachi)

   It held for trips and for nothing else: deliveries, food orders and errands
   all fell through to the default of `false`, and manual assignment bypassed
   eligibility entirely. These tests pin every path that can hand a driver a
   job.
   --------------------------------------------------------------------------- */

describe("segregation is passed by every matching service", () => {
  // Reading the source is the only way to assert on a call this deep inside
  // a retry-and-widen loop without standing up Redis, Prisma and a gateway.
  // It is also the failure mode that actually happened: the argument was
  // simply absent, and every type still checked.
  const read = (p: string) => require("fs").readFileSync(require("path").join(__dirname, "..", p), "utf8");

  it("trips pass the trip's own isTest flag", () => {
    expect(read("trips/trips.service.ts")).toMatch(/findNearbyDrivers\([^)]*trip\.isTest/s);
  });

  it("deliveries pass the sender's fleet", () => {
    expect(read("delivery/delivery.service.ts")).toMatch(/findNearbyDrivers\([^)]*isTestFleetJob\(delivery\.senderId\)/s);
  });

  it("food orders pass the customer's fleet", () => {
    expect(read("food-orders/food-orders.service.ts")).toMatch(
      /findNearbyDriversForMode\([^)]*isTestFleetJob\(order\.customerId\)/s,
    );
  });

  it("errands pass the requester's fleet", () => {
    expect(read("errands/errands.service.ts")).toMatch(
      /findNearbyDriversForMode\([^)]*isTestFleetJob\(errand\.requesterId\)/s,
    );
  });

  it("manual assignment compares the driver's fleet against the job's", () => {
    const src = read("admin/admin.service.ts");
    expect(src).toMatch(/jobBelongsToTestFleet/);
    expect(src).toMatch(/driver\.isTestAccount !== jobIsTest/);
  });
});

describe("LocationService.filterEligible — exact match, never a superset", () => {
  const { LocationService } = require("./location.service");

  const build = (users: any[]) => {
    const findMany = jest.fn().mockResolvedValue(users);
    const prisma = {
      user: { findMany },
      driverProfile: { findMany: jest.fn().mockResolvedValue([]) },
      ledgerEntry: { groupBy: jest.fn().mockResolvedValue([]) },
      trip: { findMany: jest.fn().mockResolvedValue([]) },
      delivery: { findMany: jest.fn().mockResolvedValue([]) },
      foodOrder: { findMany: jest.fn().mockResolvedValue([]) },
      errand: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    const redis = {
      client: {
        call: jest.fn().mockResolvedValue([["d-real", "1.0"], ["d-test", "1.2"]]),
        mget: jest.fn().mockResolvedValue([String(Date.now()), String(Date.now())]),
        zrem: jest.fn(),
        del: jest.fn(),
      },
    } as any;
    return { svc: new LocationService(redis, prisma), findMany };
  };

  it("asks for isTestAccount: false on a real job", async () => {
    const { svc, findMany } = build([{ id: "d-real" }]);
    await svc.findNearbyDrivers(24.86, 67.0, 3, false);
    expect(findMany.mock.calls[0][0].where.isTestAccount).toBe(false);
  });

  it("asks for isTestAccount: true on a review-fleet job", async () => {
    const { svc, findMany } = build([{ id: "d-test" }]);
    await svc.findNearbyDrivers(24.86, 67.0, 3, true);
    expect(findMany.mock.calls[0][0].where.isTestAccount).toBe(true);
  });

  it("never uses `in` — a preference is not a guarantee", async () => {
    const { svc, findMany } = build([{ id: "d-real" }]);
    await svc.findNearbyDrivers(24.86, 67.0, 3, false);
    const clause = findMany.mock.calls[0][0].where.isTestAccount;
    expect(typeof clause).toBe("boolean");
  });
});
