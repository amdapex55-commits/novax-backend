/**
 * Nova Go — how the matcher chooses between available riders.
 *
 * WHAT THIS REPLACES
 *
 * `nearby.find(d => !excluded.has(d.driverId))` — the first driver returned
 * by the geo query, which is the nearest one and nothing else.
 *
 * Nearest-only is a defensible v1 and it breaks in three specific ways once
 * there is real supply:
 *
 *   1. A rider who declines everything still gets offered everything,
 *      because declining costs them nothing and they remain nearest. Every
 *      decline is 15 seconds added to a waiting customer.
 *   2. The rider parked closest to the busiest junction takes every job, and
 *      everyone else logs out — which looks like a supply problem and is
 *      actually a ranking problem.
 *   3. A rider with a history of cancelling AFTER accepting outranks a
 *      reliable one 200m further away, and the customer pays for it twice:
 *      once in the wait, once in the cancellation.
 *
 * WHY THESE WEIGHTS
 *
 * Distance still dominates, deliberately — a four-minute pickup is the
 * product, and no reputation signal is worth adding two kilometres to it.
 * The rest are tie-breakers between drivers who are all "close enough",
 * which is the situation the score actually exists to resolve.
 *
 * Everything is normalised to 0..1 before weighting, so the weights below
 * are directly comparable and can be reasoned about without knowing the
 * units of each input.
 *
 * NOT INCLUDED, ON PURPOSE
 *
 * Earnings-to-date. Ranking a driver down for having earned well today is
 * how you build a system drivers correctly perceive as punishing effort.
 * Idle time achieves the fairness goal without that.
 */

export interface DriverScoreInput {
  distanceKm: number;
  /** 0..1. Null when they have not been offered enough jobs to judge. */
  acceptanceRate: number | null;
  /** 0..1 of accepted jobs later cancelled by the driver. */
  cancellationRate: number | null;
  /** 1..5 stars. */
  rating: number | null;
  /** Minutes since their last completed job. Null = no history. */
  idleMinutes: number | null;
}

/* WHY DISTANCE IS 0.70 AND NOT 0.55.
 *
 * The first version of these weights was 0.55/0.18/0.12/0.08/0.07 against an
 * 8km cap, and a unit test caught what that actually meant: a driver with a
 * perfect record 2.8km away scored 0.807 and beat an unproven driver 300m
 * away at 0.770. Reputation was buying two and a half extra kilometres.
 *
 * In Karachi traffic that is roughly eight extra minutes on the pickup, paid
 * by a customer who gains nothing from it — the "better" driver is better at
 * accepting jobs, which is worth something to us and nothing to the person
 * standing on the road.
 *
 * Distance now carries 70%, and the cap is 5km rather than 8km so the term
 * discriminates hard across the range pickups actually fall in instead of
 * flattening 0.3km and 2.8km into nearly the same number. The remaining 30%
 * is still enough to separate drivers who are all genuinely close, which is
 * the only situation the score exists to resolve. */
export const DISPATCH_WEIGHTS = {
  distance: 0.70,
  acceptance: 0.12,
  reliability: 0.08, // inverse of cancellation rate
  rating: 0.05,
  idle: 0.05,
} as const;

/**
 * Below this many offers, a driver's rates are noise — one decline out of
 * two offers is a 50% acceptance rate and means nothing. New drivers are
 * scored NEUTRALLY rather than badly, or nobody new ever gets a first job
 * and the fleet cannot grow.
 */
export const MIN_OFFERS_FOR_RATE = 8;

/** Idle beyond this earns no further bonus — an eight-hour-idle driver and a
 *  one-hour-idle driver are both "waiting", and letting it grow unbounded
 *  would eventually outweigh distance. */
const IDLE_CAP_MINUTES = 45;

/* Past this, "nearby" stops being nearby and the distance term bottoms out.
   5km rather than 8km so the curve discriminates across the range real
   pickups fall in — see the note on DISPATCH_WEIGHTS. */
const DISTANCE_CAP_KM = 5;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * 0..1, higher is better. Deterministic and pure — it takes plain numbers so
 * it can be unit-tested without a database, which is the point: ranking
 * logic that can only be observed in production is ranking logic nobody
 * changes with confidence.
 */
export function scoreDriver(input: DriverScoreInput): number {
  // Linear falloff to the cap. Not exponential: the difference between 400m
  // and 900m matters to a waiting customer, and an exponential curve flattens
  // exactly that range.
  const distance = 1 - clamp01(input.distanceKm / DISTANCE_CAP_KM);

  // Neutral (not zero, not one) when there is not enough history to judge.
  const acceptance = input.acceptanceRate == null ? 0.5 : clamp01(input.acceptanceRate);
  const reliability = input.cancellationRate == null ? 0.5 : clamp01(1 - input.cancellationRate);

  // Ratings cluster at the top in every marketplace; 4.0 is a poor rider, not
  // an average one. Mapping 3.5..5 onto 0..1 makes the term discriminate
  // where the data actually varies instead of compressing everyone into 0.8+.
  const rating = input.rating == null ? 0.7 : clamp01((input.rating - 3.5) / 1.5);

  const idle = input.idleMinutes == null ? 0.5 : clamp01(input.idleMinutes / IDLE_CAP_MINUTES);

  return (
    DISPATCH_WEIGHTS.distance * distance +
    DISPATCH_WEIGHTS.acceptance * acceptance +
    DISPATCH_WEIGHTS.reliability * reliability +
    DISPATCH_WEIGHTS.rating * rating +
    DISPATCH_WEIGHTS.idle * idle
  );
}

/** Rates from raw counters, returning null below the confidence threshold. */
export function ratesFromCounters(p: {
  offersSent: number;
  offersAccepted: number;
  offersDeclined: number;
  tripsCancelled: number;
}) {
  const enough = p.offersSent >= MIN_OFFERS_FOR_RATE;
  return {
    acceptanceRate: enough ? p.offersAccepted / Math.max(1, p.offersSent) : null,
    cancellationRate:
      p.offersAccepted >= MIN_OFFERS_FOR_RATE
        ? p.tripsCancelled / Math.max(1, p.offersAccepted)
        : null,
  };
}

export function idleMinutesSince(lastCompletedAt: Date | null | undefined, now = new Date()) {
  if (!lastCompletedAt) return null;
  return Math.max(0, (now.getTime() - lastCompletedAt.getTime()) / 60_000);
}
