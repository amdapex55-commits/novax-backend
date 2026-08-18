-- A completed cash trip only ever credited the driver, for money they were
-- already holding. Nothing recorded what they owe, so no balance could go
-- negative and the credit limit could never fire.
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'TRIP_CASH_COLLECTED';
