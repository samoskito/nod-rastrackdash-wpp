-- Fase 6.9 (PR #91 do nod; no PR era 20261017100000_meta_lead_forms, renomeada
-- para depois de 20261027140100_braip_parser_release, a maior da integracao).
-- Formularios instantaneos da Meta (Lead Ads): conexao por Pagina, com os
-- tokens Graph e do dataset do CRM cifrados (META_TOKEN_ENCRYPTION_KEY), e um
-- registro por envio de formulario (o evento de CRM usa o lead_id da Meta).
-- Aditiva: cria duas tabelas novas; nenhuma tabela, coluna, indice ou
-- constraint existente e alterada ou removida, e nada e enviado ou assinado por
-- esta migration. FKs do Workspace em ON DELETE CASCADE, e
-- apps/api/scripts/delete-workspace.js apaga as duas tabelas antes do Lead.
-- Idempotente (IF NOT EXISTS e blocos DO) para reexecucao segura.

-- CreateTable
CREATE TABLE IF NOT EXISTS "MetaLeadFormConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "formIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "crmDatasetId" TEXT,
    "qualifiedEventName" TEXT NOT NULL DEFAULT 'LeadQualificado',
    "graphTokenEncrypted" TEXT NOT NULL,
    "graphTokenIv" TEXT NOT NULL,
    "graphTokenTag" TEXT NOT NULL,
    "graphTokenLast4" TEXT NOT NULL,
    "capiTokenEncrypted" TEXT,
    "capiTokenIv" TEXT,
    "capiTokenTag" TEXT,
    "capiTokenLast4" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "pageSubscribedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaLeadFormConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MetaLeadSubmission" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "leadId" TEXT,
    "metaLeadId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "formId" TEXT,
    "campaignId" TEXT,
    "adSetId" TEXT,
    "adId" TEXT,
    "fullName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "fieldData" JSONB,
    "metaCreatedAt" TIMESTAMP(3),
    "fetchStatus" TEXT NOT NULL,
    "fetchError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaLeadSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MetaLeadFormConnection_pageId_active_idx" ON "MetaLeadFormConnection"("pageId", "active");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MetaLeadFormConnection_workspaceId_pageId_key" ON "MetaLeadFormConnection"("workspaceId", "pageId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MetaLeadSubmission_metaLeadId_key" ON "MetaLeadSubmission"("metaLeadId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MetaLeadSubmission_workspaceId_leadId_metaCreatedAt_idx" ON "MetaLeadSubmission"("workspaceId", "leadId", "metaCreatedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MetaLeadSubmission_workspaceId_createdAt_idx" ON "MetaLeadSubmission"("workspaceId", "createdAt");

-- AddForeignKey (PostgreSQL nao tem ADD CONSTRAINT IF NOT EXISTS)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MetaLeadFormConnection_workspaceId_fkey'
  ) THEN
    ALTER TABLE "MetaLeadFormConnection" ADD CONSTRAINT "MetaLeadFormConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MetaLeadSubmission_workspaceId_fkey'
  ) THEN
    ALTER TABLE "MetaLeadSubmission" ADD CONSTRAINT "MetaLeadSubmission_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MetaLeadSubmission_connectionId_fkey'
  ) THEN
    ALTER TABLE "MetaLeadSubmission" ADD CONSTRAINT "MetaLeadSubmission_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "MetaLeadFormConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MetaLeadSubmission_leadId_fkey'
  ) THEN
    ALTER TABLE "MetaLeadSubmission" ADD CONSTRAINT "MetaLeadSubmission_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
