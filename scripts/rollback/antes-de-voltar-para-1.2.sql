-- Limpeza obrigatória ANTES de voltar o código para a 1.2.0 (ou anterior),
-- quando esta instalação usou ROI Chat, Braip ou Yampi.
--
-- Por quê: o código da 1.2.0 não conhece os valores roichat, braip e yampi.
-- Se o banco tiver uma conexão ROI Chat, uma URL única Braip/Yampi ou uma
-- regra dessas plataformas ainda ativa, a 1.2.0 falha ao listar Integrações e
-- Conversões ("Value 'roichat' not found in enum").
--
-- O que faz: o mesmo que "Remover" no painel, sem apagar nada. Marca como
-- removidas (removedAt) as regras dessas plataformas, as conexões ROI Chat e
-- as URLs únicas Braip/Yampi/ROI Chat, e grava uma auditoria
-- rollback_1_2:<tipo>:<id> para cada uma. Os registros de diagnóstico dessas
-- plataformas passam a mostrar a origem "internal" (a original fica guardada
-- na tabela de apoio rollback_1_2_diagnostic_source). Recebimentos, leads e eventos ficam
-- no banco. Os valores novos dos enums e os leitores ficam (não apague).
-- Depois disso a Braip, a Yampi e o ROI Chat deixam de ser atendidos (404):
-- desative o webhook nessas plataformas antes, para elas não insistirem.
--
-- Como rodar (com o backup do PostgreSQL feito antes, e ANTES de voltar o
-- código):
--   psql "<url do banco da API>" -v ON_ERROR_STOP=1 -f scripts/rollback/antes-de-voltar-para-1.2.sql
-- Para voltar a usar depois de atualizar de novo, rode
-- scripts/rollback/reativar-depois-de-atualizar.sql (só com o código novo).
--
-- Idempotente: rodar de novo não muda nada. Tudo numa transação.

BEGIN;

WITH removed AS (
  UPDATE "ProviderConversionRuleConfig" AS p
  SET "removedAt" = now(), "updatedAt" = now()
  WHERE p."removedAt" IS NULL
    AND (
      EXISTS (
        SELECT 1 FROM "InboundWebhookParserRelease" AS r
        WHERE r."id" = p."parserReleaseId"
          AND r."provider"::text IN ('roichat', 'braip', 'yampi')
      )
      OR EXISTS (
        SELECT 1 FROM "InboundWebhookConnection" AS c
        WHERE c."id" = p."connectionId"
          AND c."provider"::text IN ('roichat', 'braip', 'yampi')
      )
    )
  RETURNING p."id", p."workspaceId"
)
INSERT INTO "AuditLog" ("id", "workspaceId", "actorType", "action", "targetType", "targetId", "resultStatus", "createdAt")
SELECT 'rollback_1_2:rule:' || removed."id", removed."workspaceId", 'system',
  'provider_conversion_rule.removed_for_rollback', 'ProviderConversionRuleConfig',
  removed."id", 'removed', now()
FROM removed
ON CONFLICT ("id") DO NOTHING;

WITH removed AS (
  UPDATE "InboundWebhookConnection" AS c
  SET "removedAt" = now(), "updatedAt" = now()
  WHERE c."removedAt" IS NULL
    AND c."provider"::text IN ('roichat', 'braip', 'yampi')
  RETURNING c."id", c."workspaceId"
)
INSERT INTO "AuditLog" ("id", "workspaceId", "actorType", "action", "targetType", "targetId", "resultStatus", "createdAt")
SELECT 'rollback_1_2:connection:' || removed."id", removed."workspaceId", 'system',
  'inbound_webhook.connection_removed_for_rollback', 'InboundWebhookConnection',
  removed."id", 'removed', now()
FROM removed
ON CONFLICT ("id") DO NOTHING;

WITH removed AS (
  UPDATE "IntegrationEndpoint" AS e
  SET "removedAt" = now(), "updatedAt" = now()
  WHERE e."removedAt" IS NULL
    AND e."provider"::text IN ('roichat', 'braip', 'yampi')
  RETURNING e."id", e."workspaceId"
)
INSERT INTO "AuditLog" ("id", "workspaceId", "actorType", "action", "targetType", "targetId", "resultStatus", "createdAt")
SELECT 'rollback_1_2:endpoint:' || removed."id", removed."workspaceId", 'system',
  'integration_endpoint.removed_for_rollback', 'IntegrationEndpoint',
  removed."id", 'removed', now()
FROM removed
ON CONFLICT ("id") DO NOTHING;

-- Registros de diagnóstico (Diagnóstico, logs de webhook e de integração,
-- tentativas de job) com a origem roichat, braip ou yampi: a 1.2.0 lê essas
-- tabelas sem filtrar a origem. A origem real fica guardada na tabela de apoio
-- "rollback_1_2_diagnostic_source" e o registro passa a mostrar a origem
-- "internal"; reativar-depois-de-atualizar.sql devolve a origem e apaga a
-- tabela de apoio.
CREATE TABLE IF NOT EXISTS "rollback_1_2_diagnostic_source" (
  "tableName" text NOT NULL,
  "rowId" text NOT NULL,
  "source" text NOT NULL,
  PRIMARY KEY ("tableName", "rowId")
);

INSERT INTO "rollback_1_2_diagnostic_source" ("tableName", "rowId", "source")
SELECT 'WebhookLog', x."id", x."source"::text
FROM "WebhookLog" AS x
WHERE x."source"::text IN ('roichat', 'braip', 'yampi')
ON CONFLICT DO NOTHING;
UPDATE "WebhookLog" SET "source" = 'internal'
WHERE "source"::text IN ('roichat', 'braip', 'yampi');

INSERT INTO "rollback_1_2_diagnostic_source" ("tableName", "rowId", "source")
SELECT 'IntegrationLog', x."id", x."source"::text
FROM "IntegrationLog" AS x
WHERE x."source"::text IN ('roichat', 'braip', 'yampi')
ON CONFLICT DO NOTHING;
UPDATE "IntegrationLog" SET "source" = 'internal'
WHERE "source"::text IN ('roichat', 'braip', 'yampi');

INSERT INTO "rollback_1_2_diagnostic_source" ("tableName", "rowId", "source")
SELECT 'JobAttempt', x."id", x."source"::text
FROM "JobAttempt" AS x
WHERE x."source"::text IN ('roichat', 'braip', 'yampi')
ON CONFLICT DO NOTHING;
UPDATE "JobAttempt" SET "source" = 'internal'
WHERE "source"::text IN ('roichat', 'braip', 'yampi');

INSERT INTO "rollback_1_2_diagnostic_source" ("tableName", "rowId", "source")
SELECT 'DiagnosticEvent', x."id", x."source"::text
FROM "DiagnosticEvent" AS x
WHERE x."source"::text IN ('roichat', 'braip', 'yampi')
ON CONFLICT DO NOTHING;
UPDATE "DiagnosticEvent" SET "source" = 'internal'
WHERE "source"::text IN ('roichat', 'braip', 'yampi');

COMMIT;
