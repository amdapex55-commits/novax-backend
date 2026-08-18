import { BadRequestException, ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { haversineKm } from "../trips/fare.util";

/**
 * The pilot's operating rules, enforced server-side.
 *
 * WHY THIS EXISTS
 *
 * All of these rules already existed — in `js/launch.config.js`, in the
 * frontend. That makes them presentation, not policy: the API happily accepted
 * a CAR booking, a BID fare, a pickup in Hyderabad, and a 3am request, because
 * nothing on this side had ever been told the pilot is bike-only, fixed-fare,
 * one-zone and daytime. Anyone with curl, a modified client, or a stale cached
 * bundle could book one, and the first you'd hear of it is a driver being
 * dispatched to a job the business cannot service.
 *
 * The frontend config stays — it's what makes the UI honest. This is what makes
 * it true.
 *
 * Every value is env-overridable so widening the pilot is a Railway variable
 * change and a restart, not a deploy.
 */

export type ParkedService = "RIDES" | "FOOD" | "DELIVERY" | "ERRANDS";

const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
};

const parseNum = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

@Injectable()
export class LaunchPolicyService {
  private readonly logger = new Logger(LaunchPolicyService.name);

  /** Which services take real orders. Defaults mirror the pilot: rides only. */
  private readonly enabled: Record<ParkedService, boolean> = {
    RIDES: parseBool(process.env.ENABLE_RIDES, true),
    // Parcels and errands are live. Defaulted here rather than set as Railway
    // variables so the code is the source of truth — a fresh environment
    // behaves the same without anyone remembering to set two env vars. Either
    // can still be switched off from Railway in seconds if an operational
    // problem shows up mid-pilot.
    DELIVERY: parseBool(process.env.ENABLE_DELIVERY, true),
    ERRANDS: parseBool(process.env.ENABLE_ERRANDS, true),

    // Food stays off: it needs restaurants onboarded and kitchens actually
    // accepting orders — a supply problem the other two don't have.
    FOOD: parseBool(process.env.ENABLE_FOOD, false),
  };

  private readonly allowedVehicleTypes = (process.env.LAUNCH_VEHICLE_TYPES ?? "BIKE")
    .split(",")
    .map((v) => v.trim().toUpperCase())
    .filter(Boolean);

  // Bidding needs enough drivers online that a rejected bid finds someone
  // else. At 30-50 riders it mostly produces unmatched requests.
  private readonly allowBidFare = parseBool(process.env.LAUNCH_ALLOW_BID_FARE, false);

  /* NOVA GO RUNS ACROSS ALL OF KARACHI, AND THESE DEFAULTS SAY SO.

     These used to default to a 6km circle centred on Clifton, with the fence
     switched OFF. Both halves were wrong, in opposite directions:

       - off meant the API accepted a booking from Hyderabad or from a GPS
         glitch in the Arabian Sea, and the customer waited for a rider who
         could never come
       - the 6km values meant that anyone who switched it on — following the
         old runbook, which said exactly that — instantly cut off Malir,
         Gulshan, Baldia and North Karachi, contradicting the landing page's
         "if you're in Karachi, you can book"

     Now it is on, and drawn wide enough to cover the city end to end. It is
     a sanity boundary, not a service area: it rejects another city, and
     nothing else. Supply is managed by where you recruit riders, not by
     fencing customers out.

     These mirror ZONE in the frontend's js/launch.config.js. If you change
     one, change the other — the frontend copy is what makes the UI honest
     before a request is sent; this is what makes it true. */
  private readonly zone = {
    enabled: parseBool(process.env.LAUNCH_ZONE_ENABLED, true),
    name: process.env.LAUNCH_ZONE_NAME ?? "Karachi",
    // Geographic centre of the city, not Clifton — a southern centre pushes
    // the radius out to sea and cuts off the north.
    lat: parseNum(process.env.LAUNCH_ZONE_LAT, 24.92),
    lng: parseNum(process.env.LAUNCH_ZONE_LNG, 67.1),
    radiusKm: parseNum(process.env.LAUNCH_ZONE_RADIUS_KM, 45),
  };

  private readonly hours = {
    /* OFF by default: Nova Go takes bookings around the clock. The window is
       kept rather than deleted because it is the right control to have — set
       LAUNCH_HOURS_ENABLED=true and the guard, the log line and the refusal
       message all come back. */
    enabled: parseBool(process.env.LAUNCH_HOURS_ENABLED, false),
    openHour: parseNum(process.env.LAUNCH_OPEN_HOUR, 8),
    closeHour: parseNum(process.env.LAUNCH_CLOSE_HOUR, 22),
    timeZone: process.env.LAUNCH_TIMEZONE ?? "Asia/Karachi",
  };

  constructor() {
    this.logger.log(
      `Launch policy — services: ${Object.entries(this.enabled)
        .map(([k, v]) => `${k}=${v ? "on" : "off"}`)
        .join(" ")}; vehicles: ${this.allowedVehicleTypes.join(",")}; ` +
        `bidding: ${this.allowBidFare ? "on" : "off"}; ` +
        `zone: ${this.zone.enabled ? `${this.zone.name} ${this.zone.radiusKm}km` : "off"}; ` +
        `hours: ${this.hours.enabled ? `${this.hours.openHour}:00-${this.hours.closeHour}:00 ${this.hours.timeZone}` : "24h"}`,
    );
  }

  isServiceEnabled(service: ParkedService): boolean {
    return this.enabled[service] === true;
  }

  /**
   * 403 rather than 404: the endpoint exists and will work later. A client
   * hitting this should show "coming soon", not treat it as a broken route.
   */
  assertServiceEnabled(service: ParkedService): void {
    if (this.isServiceEnabled(service)) return;
    throw new ForbiddenException(
      `${service.toLowerCase()} is not available yet — Nova Go is running a bike-ride pilot. Rides are live.`,
    );
  }

  /** Everything that has to be true for a ride request to be accepted. */
  assertRideAllowed(input: {
    vehicleType?: string;
    fareType?: string;
    pickupLat: number;
    pickupLng: number;
  }): void {
    this.assertServiceEnabled("RIDES");

    const vehicle = String(input.vehicleType ?? "").toUpperCase();
    if (!this.allowedVehicleTypes.includes(vehicle)) {
      throw new BadRequestException(
        `Only ${this.allowedVehicleTypes.join(", ").toLowerCase()} rides are available during the pilot.`,
      );
    }

    if (!this.allowBidFare && String(input.fareType ?? "FIXED").toUpperCase() === "BID") {
      throw new BadRequestException(
        "Name-your-own-fare isn't available yet. The fare shown is the fare you pay.",
      );
    }

    this.assertWithinZone(input.pickupLat, input.pickupLng);
    this.assertWithinHours();
  }

  assertWithinZone(lat: number, lng: number): void {
    if (!this.zone.enabled) return;
    const distanceKm = haversineKm(lat, lng, this.zone.lat, this.zone.lng);
    if (distanceKm > this.zone.radiusKm) {
      throw new BadRequestException(
        `Nova Go is only running in ${this.zone.name} right now. Your pickup is outside the service area.`,
      );
    }
  }

  assertWithinHours(): void {
    if (!this.hours.enabled) return;
    if (this.isOpenNow()) return;
    throw new BadRequestException(
      `Nova Go runs ${this.hours.openHour}:00–${this.hours.closeHour}:00. ` +
        "Every ride is covered by a person on the support desk, so we don't take bookings outside those hours.",
    );
  }

  isOpenNow(now: Date = new Date()): boolean {
    if (!this.hours.enabled) return true;
    const hour = this.hourIn(this.hours.timeZone, now);
    const { openHour, closeHour } = this.hours;
    // A window that wraps midnight (e.g. 22:00–02:00) is two ranges, not one.
    return openHour <= closeHour
      ? hour >= openHour && hour < closeHour
      : hour >= openHour || hour < closeHour;
  }

  /**
   * The server's clock is almost certainly UTC; the pilot's hours are Karachi
   * time. Comparing the two directly would close the service five hours early.
   */
  private hourIn(timeZone: string, now: Date): number {
    try {
      return Number(
        new Intl.DateTimeFormat("en-GB", {
          timeZone,
          hour: "2-digit",
          hourCycle: "h23",
        }).format(now),
      );
    } catch {
      // An invalid LAUNCH_TIMEZONE must not take bookings down — fall back to
      // server local time and say so loudly.
      this.logger.error(`Invalid LAUNCH_TIMEZONE "${timeZone}" — using server local time.`);
      return now.getHours();
    }
  }
}
