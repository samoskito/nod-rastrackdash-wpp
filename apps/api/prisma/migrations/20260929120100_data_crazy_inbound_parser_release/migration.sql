-- Seed the observation-only Data Crazy parser. Production still requires a
-- platform admin to certify it after a real CTWA delivery is processed.
INSERT INTO "InboundWebhookParserRelease" (
  "id",
  "provider",
  "version",
  "status",
  "createdAt",
  "updatedAt"
) VALUES (
  'inbound_parser_data_crazy_v1',
  'data_crazy',
  'v1',
  'observation_only',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("provider", "version") DO NOTHING;
