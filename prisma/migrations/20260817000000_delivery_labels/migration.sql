-- The sender types a real address; only the coordinates were ever stored, so
-- the driver's screen could not name either end of the job.
ALTER TABLE "deliveries" ADD COLUMN "pickupLabel" TEXT;
ALTER TABLE "deliveries" ADD COLUMN "dropoffLabel" TEXT;
