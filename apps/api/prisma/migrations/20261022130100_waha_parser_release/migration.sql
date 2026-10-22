-- WAHA (GoWS): seed the waha v2 parser release, certified. v2 reads the raw
-- GoWS event (payload._data.Info / payload._data.Message) with the rules
-- validated in production in the Rastrackapp: phone from SenderAlt /
-- RecipientAlt with the LID kept apart, groups and Status discarded,
-- message.any only for team messages, ctwa_clid only from externalAdReply.
-- The per-connection WhatsApp receiver (POST /webhooks/whatsapp/:id) uses v2
-- only while this release is certified; otherwise it keeps the v1 parser.
-- No connection, channel or rule is created or activated here. A release
-- that already exists is only certified while still observation_only
-- (retired stays retired).
INSERT INTO "InboundWebhookParserRelease" (
  "id",
  "provider",
  "version",
  "status",
  "certifiedAt",
  "createdAt",
  "updatedAt"
) VALUES (
  'inbound_parser_waha_v2',
  'waha',
  'v2',
  'certified',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("provider", "version") DO UPDATE
SET
  "status" = 'certified',
  "certifiedAt" = COALESCE("InboundWebhookParserRelease"."certifiedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "InboundWebhookParserRelease"."status" = 'observation_only';
