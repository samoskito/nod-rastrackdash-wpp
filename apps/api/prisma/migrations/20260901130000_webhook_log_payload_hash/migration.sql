-- Additive: nullable payload fingerprint used to harden WAHA/Z-API
-- idempotency. The WAHA/Z-API receiver computes a canonical SHA-256 of the
-- inbound payload and compares it against this column when the same
-- idempotencyKey is replayed, so a genuine replay (same hash) can be
-- distinguished from a divergent payload reusing the same external event id
-- (conflict/quarantine). Nullable and unused by any other provider, so
-- existing rows and other providers are unaffected.
ALTER TABLE "WebhookLog"
ADD COLUMN "payloadHash" TEXT;
