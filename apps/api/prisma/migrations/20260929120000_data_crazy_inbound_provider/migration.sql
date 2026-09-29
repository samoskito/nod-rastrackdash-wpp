-- Register the Data Crazy enum values in their own committed migration.
-- PostgreSQL does not allow a new enum value to be used before commit, so the
-- parser release seed lives in the next migration. Additive only: no existing
-- Umbler/Gupshup/UAZAPI/Meta Cloud connection, route, event or replay changes.
ALTER TYPE "InboundWebhookProvider" ADD VALUE IF NOT EXISTS 'data_crazy';
ALTER TYPE "DiagnosticSource" ADD VALUE IF NOT EXISTS 'data_crazy';
