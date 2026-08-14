-- Trip audit trail, driver heartbeat, cancellation fee.
-- Additive only: one new table plus nullable columns. Safe on live data,
-- no backfill. Historical trips simply have no event history, which is
-- honest — we were not recording it.

CREATE TABLE "trip_events" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorId" TEXT,
    "actorRole" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_events_pkey" PRIMARY KEY ("id")
);

-- Reading a trip's history is always "this trip, in order".
CREATE INDEX "trip_events_tripId_createdAt_idx" ON "trip_events"("tripId", "createdAt");

ALTER TABLE "trip_events" ADD CONSTRAINT "trip_events_tripId_fkey"
    FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Server-authoritative liveness + remote device health.
ALTER TABLE "driver_profiles" ADD COLUMN     "lastHeartbeatAt" TIMESTAMP(3),
ADD COLUMN     "appVersion" TEXT,
ADD COLUMN     "batteryLevel" INTEGER,
ADD COLUMN     "networkType" TEXT;

ALTER TABLE "trips" ADD COLUMN "cancellationFee" DECIMAL(10,2);
