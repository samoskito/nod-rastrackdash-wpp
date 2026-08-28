-- Per-workspace WhatsApp BYO connection configuration. All added fields are
-- nullable so existing instances keep their legacy environment fallback.
ALTER TABLE "WhatsappInstance"
  ADD COLUMN "configEncrypted" TEXT,
  ADD COLUMN "configIv" TEXT,
  ADD COLUMN "configTag" TEXT,
  ADD COLUMN "displayName" TEXT,
  ADD COLUMN "lastHealthCheckedAt" TIMESTAMP(3),
  ADD COLUMN "lastHealthStatus" TEXT,
  ADD COLUMN "webhookUrl" TEXT;

ALTER TABLE "WhatsappInstance"
  ALTER COLUMN "status" SET DEFAULT 'active';

CREATE INDEX "WhatsappInstance_workspaceId_provider_idx"
  ON "WhatsappInstance"("workspaceId", "provider");
