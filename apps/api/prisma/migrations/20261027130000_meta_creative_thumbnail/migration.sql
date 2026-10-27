-- Fase 6.4 (porte do SaaS 918a0837; no SaaS: 20261013200000_meta_creative_thumbnail).
-- Miniaturas de criativos Meta guardadas no proprio banco (aditiva).
-- Cria uma tabela nova; nenhuma tabela, coluna, indice ou constraint existente
-- e alterada ou removida. A FK do Workspace e ON DELETE CASCADE, e
-- apps/api/scripts/delete-workspace.js apaga a tabela antes do Workspace.
-- Idempotente (IF NOT EXISTS) para reexecucao segura.

-- CreateTable
CREATE TABLE IF NOT EXISTS "MetaCreativeThumbnail" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "creativeId" TEXT NOT NULL,
    "source" TEXT,
    "status" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "sourceUrlExpiresAt" TIMESTAMP(3),
    "contentType" TEXT,
    "imageBytes" BYTEA,
    "byteSize" INTEGER,
    "version" TEXT,
    "fetchedAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaCreativeThumbnail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MetaCreativeThumbnail_workspaceId_creativeId_key" ON "MetaCreativeThumbnail"("workspaceId", "creativeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MetaCreativeThumbnail_workspaceId_status_nextAttemptAt_idx" ON "MetaCreativeThumbnail"("workspaceId", "status", "nextAttemptAt");

-- AddForeignKey (PostgreSQL nao tem ADD CONSTRAINT IF NOT EXISTS)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MetaCreativeThumbnail_workspaceId_fkey'
  ) THEN
    ALTER TABLE "MetaCreativeThumbnail" ADD CONSTRAINT "MetaCreativeThumbnail_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
