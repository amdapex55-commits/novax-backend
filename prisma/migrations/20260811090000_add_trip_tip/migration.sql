-- AlterEnum
ALTER TYPE "LedgerEntryType" ADD VALUE 'TRIP_TIP';

-- AlterTable
ALTER TABLE "trips" ADD COLUMN     "tipAmount" DECIMAL(10,2);

