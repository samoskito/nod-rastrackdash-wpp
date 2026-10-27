-- Fase 6.4 (porte do SaaS c0cec66c; no SaaS: 20261013210000_meta_reporting_sync_block).
-- Disjuntor so da sincronizacao de relatorios Meta. Aditiva e anulavel:
-- o envio CAPI e o roteamento CTWA nunca leem estas colunas. NULL = conta
-- sincroniza normalmente (comportamento atual).
-- Idempotente (IF NOT EXISTS) para reexecucao segura.

-- AlterTable
ALTER TABLE "MetaReportingAccount" ADD COLUMN IF NOT EXISTS "reportingSyncBlockedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "reportingSyncBlockReason" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MetaReportingAccount_workspaceId_reportingSyncBlockedAt_idx" ON "MetaReportingAccount"("workspaceId", "reportingSyncBlockedAt");
