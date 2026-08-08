// Nova X — fare calculation.
//
// ⚠️ THESE NUMBERS MUST MATCH js/launch.config.js IN THE FRONTEND.
// The app shows a fare estimate before it has a server answer; if the two
// disagree, the customer sees one price and is charged another, which is the
// fastest way to lose trust in a cash marketplace. There's a consistency
// check in TESTING.md.
//
// PILOT PRICING (bike only): Rs 60 base + Rs 22/km of ROAD distance,
// minimum Rs 150, no per-minute component.
//
// Why no per-minute charge in the pilot: it's impossible to quote up front
// without predicting Karachi traffic, so either you quote a range (which
// feels evasive) or you quote a number and then charge a different one
// (which feels like a scam). A fixed distance-based fare quoted before the
// ride is the simplest honest thing, and simplicity is worth more than
// squeezing margin out of a 40-trip-a-day pilot.

export const FARE_CONFIG = {
  // ---- LIVE ----
  BIKE: { base: 60, perKm: 22, perMin: 0, minimum: 150 },

  // ---- PARKED (services not live in the pilot; see launch.config.js) ----
  // Left in place so nothing breaks when they're switched on, but no
  // customer can currently reach a flow that uses them.
  RICKSHAW: { base: 60, perKm: 7, perMin: 1.5, minimum: 100 },
  CAR: { base: 100, perKm: 12, perMin: 2, minimum: 200 },
  PARCEL: { base: 40, perKm: 6, perMin: 1, minimum: 100 },
  FOOD: { base: 50, perKm: 6, perMin: 1, minimum: 80 },
  ERRAND: { base: 80, perKm: 6, perMin: 1.5, minimum: 150 },
} as const;

const EARTH_RADIUS_KM = 6371;

/**
 * Straight-line ("as the crow flies") distance.
 *
 * NOT a fare input any more — see estimateFare below. Kept because matching
 * legitimately wants straight-line distance (a driver 2km away as the crow
 * flies is a reasonable candidate regardless of the road layout) and because
 * it's the fallback when road routing is unavailable.
 */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

/**
 * Straight-line → road distance correction.
 *
 * In a dense grid city the road you actually ride is roughly 1.4× the
 * straight line. This is ONLY used when real routing was unavailable — it
 * stops a fallback from systematically underpricing every trip and quietly
 * costing the rider money on each one.
 */
export const DETOUR_FACTOR = 1.4;

/**
 * Fare from ROAD distance.
 *
 * `distanceKm` must be road distance from the routing engine, not haversine.
 * The frontend gets this from js/routing.js (OSRM) and sends it with the
 * booking; when it's missing we fall back to haversine × DETOUR_FACTOR and
 * mark the trip as estimated.
 *
 * Previously this took straight-line distance and added an invented
 * "estimatedMinutes = distance / 25km/h" term. On a 4km straight line that
 * priced a 7km ride, so every single fare was too low — a rounding error at
 * demo scale and a structural loss at 40 trips a day.
 */
export function estimateFare(
  vehicleType: keyof typeof FARE_CONFIG,
  distanceKm: number,
  durationMinutes?: number,
): number {
  const cfg = FARE_CONFIG[vehicleType];
  if (!cfg) throw new Error(`Unknown vehicle type: ${vehicleType}`);

  const { base, perKm, perMin, minimum } = cfg;
  const timeComponent = perMin > 0 && durationMinutes ? durationMinutes * perMin : 0;
  const fare = base + distanceKm * perKm + timeComponent;

  // Round to the nearest Rs. 5. Cash means a rider needs change; asking
  // someone to produce Rs. 187 at the roadside is a small friction on every
  // single trip, and it makes the fare look computed rather than quoted.
  const rounded = Math.round(fare / 5) * 5;
  return Math.max(minimum, rounded);
}

/**
 * Convert a straight-line distance into a defensible road estimate.
 * Use only where a real route is unavailable.
 */
export function roadEstimateFromStraightLine(straightLineKm: number): number {
  return straightLineKm * DETOUR_FACTOR;
}
