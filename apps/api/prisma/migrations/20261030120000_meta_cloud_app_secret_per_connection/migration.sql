-- Meta Cloud: App ID e App Secret próprios por conexão (agências com um app
-- Meta por BM de cliente). O segredo fica cifrado (AES-256-GCM com a
-- INBOUND_WEBHOOK_ENCRYPTION_KEY); NULL = usa o META_APP_SECRET do ambiente
-- da API, como antes. Aditiva e idempotente (IF NOT EXISTS): nenhuma conexão
-- existente muda de comportamento.
ALTER TABLE "InboundWebhookConnection" ADD COLUMN IF NOT EXISTS "metaAppId" TEXT;
ALTER TABLE "InboundWebhookConnection" ADD COLUMN IF NOT EXISTS "metaAppSecretEncrypted" TEXT;
ALTER TABLE "InboundWebhookConnection" ADD COLUMN IF NOT EXISTS "metaAppSecretUpdatedAt" TIMESTAMP(3);
