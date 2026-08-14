-- Review/test account segregation.
--
-- Additive, defaulted false: every existing user and trip is real, which is
-- correct — nothing was a test before this existed.
--
-- These two flags are a SAFETY mechanism, not a feature flag. They exist so a
-- store reviewer can complete a trip, and their entire job is to guarantee
-- that a reviewer's ride can never touch a real driver and a real customer can
-- never be matched to the test fleet.

ALTER TABLE "users" ADD COLUMN "isTestAccount" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "trips" ADD COLUMN "isTest" BOOLEAN NOT NULL DEFAULT false;

-- Matching filters on this every time it searches, alongside role/isActive.
CREATE INDEX "users_isTestAccount_idx" ON "users"("isTestAccount");
