import { scoreDriver, ratesFromCounters, idleMinutesSince, MIN_OFFERS_FOR_RATE } from "./dispatch.util";

// Ranking logic that can only be observed in production is ranking logic
// nobody changes with confidence. Each test below is a dispatch decision
// somebody would otherwise have to guess at.

const neutral = {
  distanceKm: 2,
  acceptanceRate: null,
  cancellationRate: null,
  rating: null,
  idleMinutes: null,
};

describe("scoreDriver", () => {
  it("always returns 0..1", () => {
    const extremes = [
      { distanceKm: 0, acceptanceRate: 1, cancellationRate: 0, rating: 5, idleMinutes: 600 },
      { distanceKm: 999, acceptanceRate: 0, cancellationRate: 1, rating: 1, idleMinutes: 0 },
      neutral,
    ];
    for (const e of extremes) {
      const s = scoreDriver(e);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it("prefers the closer driver, all else equal", () => {
    expect(scoreDriver({ ...neutral, distanceKm: 0.5 }))
      .toBeGreaterThan(scoreDriver({ ...neutral, distanceKm: 4 }));
  });

  it("keeps distance dominant — reputation cannot buy two extra kilometres", () => {
    // The whole product is a four-minute pickup. A perfect record 2.5km away
    // must not outrank an unproven driver 300m away.
    const perfectButFar = scoreDriver({
      distanceKm: 2.8, acceptanceRate: 1, cancellationRate: 0, rating: 5, idleMinutes: 45,
    });
    const unprovenButClose = scoreDriver({ ...neutral, distanceKm: 0.3 });
    expect(unprovenButClose).toBeGreaterThan(perfectButFar);
  });

  it("breaks a tie between equally close drivers on acceptance", () => {
    const reliable = scoreDriver({ ...neutral, distanceKm: 1, acceptanceRate: 0.95 });
    const flaky = scoreDriver({ ...neutral, distanceKm: 1, acceptanceRate: 0.2 });
    expect(reliable).toBeGreaterThan(flaky);
  });

  it("penalises cancelling after accepting more than it rewards nothing", () => {
    const clean = scoreDriver({ ...neutral, distanceKm: 1, cancellationRate: 0 });
    const cancels = scoreDriver({ ...neutral, distanceKm: 1, cancellationRate: 0.5 });
    expect(clean).toBeGreaterThan(cancels);
  });

  it("gives the idle driver the job when everything else matches", () => {
    // Otherwise the rider parked by the busiest junction takes every job and
    // everyone else logs out — which looks like a supply problem and is a
    // ranking problem.
    const waiting = scoreDriver({ ...neutral, distanceKm: 1, idleMinutes: 40 });
    const justDropped = scoreDriver({ ...neutral, distanceKm: 1, idleMinutes: 0 });
    expect(waiting).toBeGreaterThan(justDropped);
  });

  it("scores a brand-new driver neutrally, not badly", () => {
    // If no-history scored as zero, nobody new would ever get a first job and
    // the fleet could not grow.
    const brandNew = scoreDriver({ ...neutral, distanceKm: 1 });
    const terrible = scoreDriver({
      distanceKm: 1, acceptanceRate: 0, cancellationRate: 1, rating: 1, idleMinutes: 0,
    });
    const excellent = scoreDriver({
      distanceKm: 1, acceptanceRate: 1, cancellationRate: 0, rating: 5, idleMinutes: 45,
    });
    expect(brandNew).toBeGreaterThan(terrible);
    expect(brandNew).toBeLessThan(excellent);
  });

  it("does not crash on absurd input", () => {
    expect(() => scoreDriver({ ...neutral, distanceKm: -5, rating: 99, idleMinutes: -1 })).not.toThrow();
    const s = scoreDriver({ ...neutral, distanceKm: -5, rating: 99, idleMinutes: -1 });
    expect(Number.isFinite(s)).toBe(true);
  });
});

describe("ratesFromCounters", () => {
  it("withholds a rate until there is enough history to mean anything", () => {
    // One decline out of two offers is a 50% acceptance rate and tells you
    // nothing. Judging on it would bury a new driver permanently.
    const r = ratesFromCounters({ offersSent: 2, offersAccepted: 1, offersDeclined: 1, tripsCancelled: 0 });
    expect(r.acceptanceRate).toBeNull();
  });

  it("reports a rate once there is", () => {
    const r = ratesFromCounters({
      offersSent: MIN_OFFERS_FOR_RATE, offersAccepted: 6, offersDeclined: 2, tripsCancelled: 0,
    });
    expect(r.acceptanceRate).toBeCloseTo(6 / MIN_OFFERS_FOR_RATE);
  });

  it("never divides by zero", () => {
    const r = ratesFromCounters({ offersSent: 0, offersAccepted: 0, offersDeclined: 0, tripsCancelled: 0 });
    expect(r.acceptanceRate).toBeNull();
    expect(r.cancellationRate).toBeNull();
  });
});

describe("idleMinutesSince", () => {
  it("is null for a driver who has never completed a job", () => {
    expect(idleMinutesSince(null)).toBeNull();
  });

  it("measures forward from the last completion", () => {
    const now = new Date("2026-08-14T10:00:00Z");
    expect(idleMinutesSince(new Date("2026-08-14T09:30:00Z"), now)).toBeCloseTo(30);
  });

  it("never goes negative on a clock skew", () => {
    const now = new Date("2026-08-14T10:00:00Z");
    expect(idleMinutesSince(new Date("2026-08-14T10:05:00Z"), now)).toBe(0);
  });
});
