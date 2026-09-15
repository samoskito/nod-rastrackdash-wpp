-- F1 provisions Meta Cloud callback verification only. POST parsing begins in
-- F2, so this release remains observation-only.
INSERT INTO "InboundWebhookParserRelease" (
  "id",
  "provider",
  "version",
  "status",
  "createdAt",
  "updatedAt"
) VALUES (
  'inbound_parser_meta_cloud_v1',
  'meta_cloud',
  'v1',
  'observation_only',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("provider", "version") DO NOTHING;
