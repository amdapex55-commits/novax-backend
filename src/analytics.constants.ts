// The funnel. Every name the app is allowed to emit lives here, so the
// dashboard query and the client emit sites can't silently drift apart
// (the classic analytics failure: half the events named "ride_complete",
// half "rideCompleted", and a funnel that reads as 50% drop-off).
export const ANALYTICS_EVENTS = [
  // Acquisition / auth
  "app_opened",
  "welcome_role_selected",
  "otp_requested",
  "otp_verified",
  "signup_completed",

  // Ride funnel
  "ride_route_set",
  "ride_fare_viewed",
  "ride_requested",
  "ride_driver_matched",
  "ride_accepted",
  "ride_started",
  "ride_completed",
  "ride_cancelled",
  "ride_no_driver_found",

  // Parcel funnel
  "parcel_requested",
  "parcel_delivered",
  "parcel_cancelled",

  // Food funnel
  "food_restaurant_viewed",
  "food_item_added",
  "food_checkout_started",
  "food_order_placed",
  "food_restaurant_accepted",
  "food_order_ready",
  "food_driver_matched",
  "food_delivered",
  "food_order_cancelled",

  // Errand funnel
  "errand_requested",
  "errand_delivered",

  // Driver side
  "driver_went_online",
  "driver_went_offline",
  "driver_offer_received",
  "driver_offer_accepted",
  "driver_offer_declined",

  // Safety / support
  "sos_pressed",
  "trip_shared",
  "support_ticket_created",
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

export const ANALYTICS_EVENT_SET: ReadonlySet<string> = new Set(ANALYTICS_EVENTS);
