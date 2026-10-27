-- Desfaz scripts/rollback/antes-de-voltar-para-1.2.sql depois que a API já
-- está de novo na versão com ROI Chat, Braip e Yampi (nunca com a 1.2.0 no
-- ar: ela voltaria a falhar ao listar Integrações e Conversões).
--
-- Traz de volta SOMENTE o que aquela limpeza removeu (auditorias
-- rollback_1_2:<tipo>:<id>); o que você removeu pelo painel continua
-- removido. Depois, reative o webhook na Braip, na Yampi e no ROI Chat.
--
--   psql "<url do banco da API>" -v ON_ERROR_STOP=1 -f scripts/rollback/reativar-depois-de-atualizar.sql
--
-- Desde a 1.3.1 devolve também o provedor dos recebimentos, das URLs, das
-- conexões e dos leitores (tabela de apoio rollback_1_2_provider).
--
-- Rode uma vez, logo depois de atualizar: rodado mais tarde, ele também traria
-- de volta algo da limpeza que você tenha removido de novo pelo painel.
-- Tudo numa transação.

BEGIN;

-- 1.3.1: primeiro devolve o provedor (e a versão e o status dos leitores)
-- guardados por antes-de-voltar-para-1.2.sql. Tem de vir antes de trazer as
-- URLs de volta: uma URL Braip ainda marcada como payt colidiria com a URL
-- Payt ativa (uma URL ativa por plataforma). A tabela de apoio é apagada no fim.
CREATE TABLE IF NOT EXISTS "rollback_1_2_provider" (
  "tableName" text NOT NULL,
  "rowId" text NOT NULL,
  "provider" text NOT NULL,
  "version" text,
  "status" text,
  PRIMARY KEY ("tableName", "rowId")
);

UPDATE "IntegrationEndpointEvent" AS x
SET "provider" = b."provider"::"InboundWebhookProvider"
FROM "rollback_1_2_provider" AS b
WHERE b."tableName" = 'IntegrationEndpointEvent'
  AND b."rowId" = x."id"
  AND x."provider"::text IN ('payt', 'meta_cloud');

UPDATE "InboundWebhookDelivery" AS x
SET "provider" = b."provider"::"InboundWebhookProvider"
FROM "rollback_1_2_provider" AS b
WHERE b."tableName" = 'InboundWebhookDelivery'
  AND b."rowId" = x."id"
  AND x."provider"::text IN ('payt', 'meta_cloud');

UPDATE "InboundWebhookEvent" AS x
SET "provider" = b."provider"::"InboundWebhookProvider"
FROM "rollback_1_2_provider" AS b
WHERE b."tableName" = 'InboundWebhookEvent'
  AND b."rowId" = x."id"
  AND x."provider"::text IN ('payt', 'meta_cloud');

UPDATE "IntegrationEndpoint" AS x
SET "provider" = b."provider"::"InboundWebhookProvider"
FROM "rollback_1_2_provider" AS b
WHERE b."tableName" = 'IntegrationEndpoint'
  AND b."rowId" = x."id"
  AND x."provider"::text IN ('payt', 'meta_cloud');

UPDATE "InboundWebhookConnection" AS x
SET "provider" = b."provider"::"InboundWebhookProvider"
FROM "rollback_1_2_provider" AS b
WHERE b."tableName" = 'InboundWebhookConnection'
  AND b."rowId" = x."id"
  AND x."provider"::text IN ('payt', 'meta_cloud');

UPDATE "InboundWebhookParserRelease" AS x
SET "provider" = b."provider"::"InboundWebhookProvider",
    "version" = b."version",
    "status" = b."status"::"InboundWebhookParserReleaseStatus",
    "updatedAt" = now()
FROM "rollback_1_2_provider" AS b
WHERE b."tableName" = 'InboundWebhookParserRelease'
  AND b."rowId" = x."id"
  AND x."version" = 'rollback_1_2:' || x."id";

UPDATE "IntegrationEndpoint" AS e
SET "removedAt" = NULL, "updatedAt" = now()
FROM "AuditLog" AS a
WHERE a."id" = 'rollback_1_2:endpoint:' || e."id"
  AND e."removedAt" IS NOT NULL;

UPDATE "InboundWebhookConnection" AS c
SET "removedAt" = NULL, "updatedAt" = now()
FROM "AuditLog" AS a
WHERE a."id" = 'rollback_1_2:connection:' || c."id"
  AND c."removedAt" IS NOT NULL;

UPDATE "ProviderConversionRuleConfig" AS p
SET "removedAt" = NULL, "updatedAt" = now()
FROM "AuditLog" AS a
WHERE a."id" = 'rollback_1_2:rule:' || p."id"
  AND p."removedAt" IS NOT NULL;

-- Devolve a origem dos registros de diagnóstico e apaga a tabela de apoio.
CREATE TABLE IF NOT EXISTS "rollback_1_2_diagnostic_source" (
  "tableName" text NOT NULL,
  "rowId" text NOT NULL,
  "source" text NOT NULL,
  PRIMARY KEY ("tableName", "rowId")
);

UPDATE "WebhookLog" AS x
SET "source" = b."source"::"DiagnosticSource"
FROM "rollback_1_2_diagnostic_source" AS b
WHERE b."tableName" = 'WebhookLog'
  AND b."rowId" = x."id"
  AND x."source" = 'internal';

UPDATE "IntegrationLog" AS x
SET "source" = b."source"::"DiagnosticSource"
FROM "rollback_1_2_diagnostic_source" AS b
WHERE b."tableName" = 'IntegrationLog'
  AND b."rowId" = x."id"
  AND x."source" = 'internal';

UPDATE "JobAttempt" AS x
SET "source" = b."source"::"DiagnosticSource"
FROM "rollback_1_2_diagnostic_source" AS b
WHERE b."tableName" = 'JobAttempt'
  AND b."rowId" = x."id"
  AND x."source" = 'internal';

UPDATE "DiagnosticEvent" AS x
SET "source" = b."source"::"DiagnosticSource"
FROM "rollback_1_2_diagnostic_source" AS b
WHERE b."tableName" = 'DiagnosticEvent'
  AND b."rowId" = x."id"
  AND x."source" = 'internal';

DROP TABLE "rollback_1_2_diagnostic_source";
DROP TABLE "rollback_1_2_provider";

COMMIT;
