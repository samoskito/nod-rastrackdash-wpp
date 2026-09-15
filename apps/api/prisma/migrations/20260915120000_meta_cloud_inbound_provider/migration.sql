-- Register the Meta Cloud provider separately so PostgreSQL commits the enum
-- value before the parser release seed uses it.
ALTER TYPE "InboundWebhookProvider" ADD VALUE IF NOT EXISTS 'meta_cloud';
