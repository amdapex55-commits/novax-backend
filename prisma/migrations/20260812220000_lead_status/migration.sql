-- AlterTable
ALTER TABLE "business_leads" ADD COLUMN     "handledAt" TIMESTAMP(3),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'NEW';

