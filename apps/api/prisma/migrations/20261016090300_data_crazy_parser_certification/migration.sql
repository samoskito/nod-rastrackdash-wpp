-- Certify the Data Crazy v1 parser, the same contract validated with real CTWA
-- deliveries in production. Certification only makes the connection eligible:
-- each conversion rule still requires an explicit production activation.
-- A retired release stays retired.
UPDATE "InboundWebhookParserRelease"
SET
  "status" = 'certified',
  "certifiedAt" = COALESCE("certifiedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "provider" = 'data_crazy'
  AND "version" = 'v1'
  AND "status" <> 'retired';
