-- Ops-mediated password recovery.
--
-- Additive only: one new table, no columns touched, no backfill. Safe on
-- live data.
--
-- There is no self-serve reset because there is no delivery channel yet —
-- no email provider and no SMS sender. Rather than ship a reset flow that
-- silently cannot deliver, the request is recorded here and ops actions it
-- with POST /api/v1/admin/users/:id/reset-password. When an email provider
-- exists this table stays; the request simply gets answered automatically
-- instead of by a person.

CREATE TABLE "password_reset_requests" (
    "id" TEXT NOT NULL,
    "contact" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "password_reset_requests_status_createdAt_idx"
    ON "password_reset_requests"("status", "createdAt");
