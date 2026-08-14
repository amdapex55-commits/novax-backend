import { LaunchPolicyService } from "./launch-policy.service";

// These rules previously lived only in the frontend, which meant curl could
// book a car at 3am in a city we don't operate in. Each test below is one of
// those bookings being refused.

function withEnv(vars: Record<string, string>): LaunchPolicyService {
  const saved = { ...process.env };
  Object.assign(process.env, vars);
  try {
    // Config is read in the constructor, so the instance must be built while
    // the env is patched.
    return new LaunchPolicyService();
  } finally {
    process.env = saved;
  }
}

const KARACHI_PICKUP = { pickupLat: 24.8138, pickupLng: 67.03 };
const OPEN_ALL_HOURS = { LAUNCH_HOURS_ENABLED: "false" };

describe("LaunchPolicyService", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe("vehicle + fare rules", () => {
    it("accepts a fixed-fare bike ride", () => {
      const policy = withEnv(OPEN_ALL_HOURS);
      expect(() =>
        policy.assertRideAllowed({ vehicleType: "BIKE", fareType: "FIXED", ...KARACHI_PICKUP }),
      ).not.toThrow();
    });

    it("rejects a car ride even though the DTO enum still allows CAR", () => {
      const policy = withEnv(OPEN_ALL_HOURS);
      expect(() =>
        policy.assertRideAllowed({ vehicleType: "CAR", fareType: "FIXED", ...KARACHI_PICKUP }),
      ).toThrow(/only bike/i);
    });

    it("rejects a BID fare while bidding is off", () => {
      const policy = withEnv(OPEN_ALL_HOURS);
      expect(() =>
        policy.assertRideAllowed({ vehicleType: "BIKE", fareType: "BID", ...KARACHI_PICKUP }),
      ).toThrow(/fare shown is the fare/i);
    });

    it("allows what the env opens up, so widening the pilot needs no deploy", () => {
      const policy = withEnv({
        ...OPEN_ALL_HOURS,
        LAUNCH_VEHICLE_TYPES: "BIKE,CAR",
        LAUNCH_ALLOW_BID_FARE: "true",
      });
      expect(() =>
        policy.assertRideAllowed({ vehicleType: "CAR", fareType: "BID", ...KARACHI_PICKUP }),
      ).not.toThrow();
    });
  });

  describe("zone", () => {
    const zoned = {
      ...OPEN_ALL_HOURS,
      LAUNCH_ZONE_ENABLED: "true",
      LAUNCH_ZONE_LAT: "24.8138",
      LAUNCH_ZONE_LNG: "67.0300",
      LAUNCH_ZONE_RADIUS_KM: "6",
    };

    it("accepts a pickup inside the radius", () => {
      const policy = withEnv(zoned);
      expect(() =>
        policy.assertRideAllowed({ vehicleType: "BIKE", pickupLat: 24.82, pickupLng: 67.035 }),
      ).not.toThrow();
    });

    it("rejects a pickup outside the radius", () => {
      const policy = withEnv(zoned);
      // Gulshan-e-Iqbal, ~15km from Clifton.
      expect(() =>
        policy.assertRideAllowed({ vehicleType: "BIKE", pickupLat: 24.92, pickupLng: 67.09 }),
      ).toThrow(/outside the service area/i);
    });

    /* THE DEFAULTS ARE THE PRODUCT PROMISE, SO THEY GET THEIR OWN TESTS.

       The landing page says "if you're in Karachi, you can book" and lists
       Saddar, Malir, Gulshan and Baldia by name. The defaults used to be a
       6km circle centred on Clifton, switched off — so anyone who followed
       the old runbook and switched it on cut off most of the city the
       marketing had already promised.

       These assert the two things that must both stay true: the whole city
       is inside, and another city is not. Widening or narrowing the default
       should break a test, not drift in with an unrelated change. */
    describe("the shipped default covers all of Karachi", () => {
      const KARACHI_NEIGHBOURHOODS: Array<[string, number, number]> = [
        ["Clifton / Sea View", 24.79, 67.03],
        ["Saddar", 24.8607, 67.0011],
        ["Gulshan-e-Iqbal", 24.92, 67.09],
        ["Malir", 24.8935, 67.205],
        ["Baldia", 24.92, 66.98],
        ["North Karachi", 25.01, 67.06],
      ];

      it.each(KARACHI_NEIGHBOURHOODS)("accepts a pickup in %s", (_name, lat, lng) => {
        const policy = withEnv(OPEN_ALL_HOURS);
        expect(() =>
          policy.assertRideAllowed({ vehicleType: "BIKE", pickupLat: lat, pickupLng: lng }),
        ).not.toThrow();
      });

      it("still rejects another city", () => {
        const policy = withEnv(OPEN_ALL_HOURS);
        // Hyderabad, ~140km east — a real booking from there could never be
        // served, and is far more likely to be a typo or a bad GPS fix.
        expect(() =>
          policy.assertRideAllowed({ vehicleType: "BIKE", pickupLat: 25.396, pickupLng: 68.3578 }),
        ).toThrow(/outside the service area/i);
        // Lahore.
        expect(() =>
          policy.assertRideAllowed({ vehicleType: "BIKE", pickupLat: 31.52, pickupLng: 74.35 }),
        ).toThrow(/outside the service area/i);
      });

      it("is on by default — an unfenced API accepts bookings it cannot serve", () => {
        const policy = withEnv(OPEN_ALL_HOURS);
        expect(() =>
          policy.assertRideAllowed({ vehicleType: "BIKE", pickupLat: 31.52, pickupLng: 74.35 }),
        ).toThrow();
      });
    });

    it("accepts anywhere when the geofence is off", () => {
      const policy = withEnv({ ...OPEN_ALL_HOURS, LAUNCH_ZONE_ENABLED: "false" });
      // Lahore.
      expect(() =>
        policy.assertRideAllowed({ vehicleType: "BIKE", pickupLat: 31.52, pickupLng: 74.35 }),
      ).not.toThrow();
    });
  });

  describe("operating hours", () => {
    // 2026-08-11T05:00:00Z is 10:00 in Karachi (UTC+5) — open.
    const openUtc = new Date("2026-08-11T05:00:00Z");
    // 2026-08-11T22:00:00Z is 03:00 next day in Karachi — closed.
    const closedUtc = new Date("2026-08-11T22:00:00Z");

    it("uses the configured timezone, not the server's UTC clock", () => {
      const policy = withEnv({
        LAUNCH_HOURS_ENABLED: "true",
        LAUNCH_OPEN_HOUR: "8",
        LAUNCH_CLOSE_HOUR: "22",
        LAUNCH_TIMEZONE: "Asia/Karachi",
      });
      // Naive UTC reading of openUtc is 05:00, which would be "closed".
      // Karachi time is 10:00, which is open — this asserts the conversion.
      expect(policy.isOpenNow(openUtc)).toBe(true);
      expect(policy.isOpenNow(closedUtc)).toBe(false);
    });

    it("handles a window that wraps midnight", () => {
      const policy = withEnv({
        LAUNCH_HOURS_ENABLED: "true",
        LAUNCH_OPEN_HOUR: "22",
        LAUNCH_CLOSE_HOUR: "2",
        LAUNCH_TIMEZONE: "Asia/Karachi",
      });
      // 03:00 Karachi — outside a 22:00-02:00 window.
      expect(policy.isOpenNow(closedUtc)).toBe(false);
      // 23:00 Karachi (18:00Z) — inside it.
      expect(policy.isOpenNow(new Date("2026-08-11T18:00:00Z"))).toBe(true);
    });

    it("stays open when hours are disabled", () => {
      const policy = withEnv({ LAUNCH_HOURS_ENABLED: "false" });
      expect(policy.isOpenNow(closedUtc)).toBe(true);
    });
  });

  describe("parked services", () => {
    it("defaults to rides, parcels and errands on — food off", () => {
      const policy = withEnv({});
      expect(policy.isServiceEnabled("RIDES")).toBe(true);
      expect(policy.isServiceEnabled("DELIVERY")).toBe(true);
      expect(policy.isServiceEnabled("ERRANDS")).toBe(true);
      // Food stays off until kitchens are actually onboarded. This assertion
      // is the guard: turning it on should be a deliberate act that breaks a
      // test, not something that drifts in with an unrelated change.
      expect(policy.isServiceEnabled("FOOD")).toBe(false);
    });

    it("can still be switched off from the environment", () => {
      // The kill switch matters more now that these are live: if COD or
      // errand cash-fronting causes a problem mid-pilot, it has to be a
      // Railway variable and a restart, not a deploy.
      const policy = withEnv({ ENABLE_DELIVERY: "false", ENABLE_ERRANDS: "false" });
      expect(policy.isServiceEnabled("DELIVERY")).toBe(false);
      expect(policy.isServiceEnabled("ERRANDS")).toBe(false);
      expect(policy.isServiceEnabled("RIDES")).toBe(true);
    });

    it("throws a 403-shaped error naming the parked service", () => {
      const policy = withEnv({});
      expect(() => policy.assertServiceEnabled("FOOD")).toThrow(/food is not available yet/i);
    });

    it("can be switched on by env", () => {
      const policy = withEnv({ ENABLE_FOOD: "true" });
      expect(() => policy.assertServiceEnabled("FOOD")).not.toThrow();
    });
  });
});
