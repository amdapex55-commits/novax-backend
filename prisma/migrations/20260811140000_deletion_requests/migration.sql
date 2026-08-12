-- CreateTable
CREATE TABLE "deletion_requests" (
    "id" TEXT NOT NULL,
    "contact" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deletion_requests_status_createdAt_idx" ON "deletion_requests"("status", "createdAt");

