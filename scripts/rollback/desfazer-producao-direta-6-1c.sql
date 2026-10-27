-- Desfaz a promoção feita pela migration
-- 20261027125000_production_direct_validated_integrations (produção direta).
--
-- Quando usar: só se você decidiu voltar a ter em observação (sem envio) o que
-- essa migration ligou. Não é preciso para voltar o código; para parar um envio
-- específico, pausar a regra ou a conexão no painel já basta.
--
-- Como rodar (com o backup do PostgreSQL feito antes):
--   psql "<url do banco da API>" -v ON_ERROR_STOP=1 -f scripts/rollback/desfazer-producao-direta-6-1c.sql
-- Nunca cole a URL do banco em chat; use o terminal do servidor.
--
-- O que faz: volta para observação SOMENTE o que a migration promoveu, pelas
-- auditorias que ela gravou (ids production_direct_6_1c:<tipo>:<id>), e só se
-- ainda estiver no estado em que a migration deixou: a data de ativação (ou,
-- na Kommo, a da última alteração) tem de ser a da própria auditoria. O que
-- você mudou depois (pausou e retomou, ativou de novo, editou a regra da
-- Kommo, voltou para observação, removeu) fica como está.
--
-- O que NÃO desfaz (não há auditoria para isso):
--  - o passo 4 (data de ativação dada a números que já estavam ativos): é só a
--    cerca de "nada retroativo" e não liga envio de nada;
--  - o leitor meta_cloud/v1 marcado como certificado (passo 1): o código já o
--    tratava como certificado antes.
-- Eventos já enviados à Meta não voltam.
--
-- Idempotente: rodar de novo não muda nada. Tudo numa transação.

BEGIN;

-- Regras por provedor (Umbler, Unnichat, Payt, Braip, Uazapi, WAHA...).
UPDATE "ProviderConversionRuleConfig" AS p
SET "mode" = 'observation', "productionActivatedAt" = NULL, "updatedAt" = now()
FROM "AuditLog" AS a
WHERE a."id" = 'production_direct_6_1c:rule:' || p."id"
  AND p."mode" = 'production'
  AND p."productionActivatedAt" = a."createdAt";

-- Regras da Kommo.
UPDATE "KommoConversionRule" AS kr
SET "mode" = 'observation', "updatedAt" = now()
FROM "AuditLog" AS a
WHERE a."id" = 'production_direct_6_1c:kommo:' || kr."id"
  AND kr."mode" = 'production'
  AND kr."updatedAt" = a."createdAt";

-- Regras do Pipedrive (em observação a data de ativação fica vazia).
UPDATE "PipedriveConversionRule" AS pr
SET "mode" = 'observation', "productionActivatedAt" = NULL, "updatedAt" = now()
FROM "AuditLog" AS a
WHERE a."id" = 'production_direct_6_1c:pipedrive:' || pr."id"
  AND pr."mode" = 'production'
  AND pr."productionActivatedAt" = a."createdAt";

-- Números (canais) ativados pela migration.
UPDATE "InboundWebhookChannel" AS ch
SET "status" = 'discovered', "productionActivatedAt" = NULL, "updatedAt" = now()
FROM "AuditLog" AS a
WHERE a."id" = 'production_direct_6_1c:channel:' || ch."id"
  AND ch."status" = 'active'
  AND ch."productionActivatedAt" = a."createdAt";

-- Conexões promovidas pela migration.
UPDATE "InboundWebhookConnection" AS c
SET "status" = 'observation', "productionActivatedAt" = NULL, "updatedAt" = now()
FROM "AuditLog" AS a
WHERE a."id" = 'production_direct_6_1c:connection:' || c."id"
  AND c."status" = 'production'
  AND c."productionActivatedAt" = a."createdAt";

COMMIT;
