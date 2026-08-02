// Starting point only — mirrors the transparent-metered model Bykea uses
// (base + per-km + per-min), so it's easy to sanity-check against a known
// reference. Move these to the admin-configurable pricing table from the
// engineering roadmap (Section 15) once you're past single-city MVP.
export const FARE_CONFIG = {
  BIKE: { base: 30, perKm: 4, perMin: 1 },
  RICKSHAW: { base: 60, perKm: 7, perMin: 1.5 },
  CAR: { base: 100, perKm: 12, perMin: 2 },
  // Parcel delivery — always bike-based in v1, priced a little above a BIKE
  // ride per km since a delivery involves handling/handoff time a straight
  // ride doesn't. Shared here rather than duplicated in the delivery module
  // since it's the same base+per-km+per-min shape either way.
  PARCEL: { base: 40, perKm: 6, perMin: 1 },
  // Food-order delivery fee (restaurant → customer leg) and errand service
  // fee (store → requester leg) — same base+per-km+per-min shape, priced
  // close to PARCEL since both are a single driver carrying one handoff.
  FOOD: { base: 50, perKm: 6, perMin: 1 },
  ERRAND: { base: 80, perKm: 6, perMin: 1.5 }, // higher base: covers in-store shopping time, not just the ride
} as const;

const EARTH_RADIUS_KM = 6371;

/** Straight-line distance — good enough for an MVP fare estimate. Swap for a
 * real routing API (Google Directions/Mapbox) once you need road-accurate
 * distance and ETA instead of "as the crow flies". */
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

export function estimateFare(vehicleType: keyof typeof FARE_CONFIG, distanceKm: number): number {
  const { base, perKm } = FARE_CONFIG[vehicleType];
  // Rough time estimate (25 km/h average city speed) until a real routing API is wired in.
  const estimatedMinutes = (distanceKm / 25) * 60;
  const { perMin } = FARE_CONFIG[vehicleType];
  const fare = base + distanceKm * perKm + estimatedMinutes * perMin;
  return Math.round(fare);
}
