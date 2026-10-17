-- Manual lead qualification (Dashboard Leads parity): the lead screen lets an
-- operator change the lead status. Records who made the last change and when;
-- the Meta event itself is a regular ConversionEventLog (sourceTrigger
-- "manual_status").
ALTER TABLE "Lead" ADD COLUMN "statusChangedAt" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN "statusChangedByUserId" TEXT;
