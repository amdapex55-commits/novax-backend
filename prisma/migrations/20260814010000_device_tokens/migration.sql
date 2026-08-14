-- Device tokens for push delivery.
--
-- Additive only: a new table, no changes to existing ones, safe on a live
-- database with no backfill.
--
-- token is UNIQUE rather than (userId, token). FCM tokens move between users
-- — a shared phone changes hands, the previous driver signs out, the next
-- signs in, and the same token now belongs to somebody else. Uniqueness on
-- the token is what lets register() re-home it instead of leaving a stale row
-- that keeps delivering the previous owner's job offers to this handset.

CREATE TABLE "device_tokens" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "app" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "device_tokens_token_key" ON "device_tokens"("token");

-- Every send is "this user, in this app", which is exactly this index.
CREATE INDEX "device_tokens_userId_app_idx" ON "device_tokens"("userId", "app");

-- Cascade: deleting a user must take their device tokens with them, or a
-- deleted account keeps receiving notifications on a phone that still has the
-- app installed.
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
