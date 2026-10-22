-- WAHA (GoWS): register the enum value in its own committed migration.
-- PostgreSQL cannot use a newly added enum label before the transaction that
-- added it commits, so the parser release seed lives in the next migration.
-- DiagnosticSource already has 'waha' (20260901120000). Additive only: no
-- existing connection, rule, channel, event, lead or webhook log changes.
ALTER TYPE "InboundWebhookProvider" ADD VALUE IF NOT EXISTS 'waha';
