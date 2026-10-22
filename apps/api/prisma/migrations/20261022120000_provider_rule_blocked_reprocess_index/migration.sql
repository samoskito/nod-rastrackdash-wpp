-- Regra "Todos os números" + "Reprocessar bloqueadas": só acrescenta um
-- índice em ProviderConversionRuleExecution para o painel das execuções
-- (contagem das conversas bloqueadas antes do envio) e para a varredura do
-- reprocessamento, que filtram por workspace, regra, situação e data dentro
-- da janela de 7 dias da Meta.
-- Nenhuma tabela, coluna, constraint ou linha existente é alterada ou
-- removida. Reexecutável (IF NOT EXISTS).
-- Reverter: DROP INDEX IF EXISTS "ProviderConversionRuleExecution_rule_status_occurredAt_idx";
-- (o código desta versão continua funcionando sem o índice, só mais lento).
CREATE INDEX IF NOT EXISTS "ProviderConversionRuleExecution_rule_status_occurredAt_idx"
  ON "ProviderConversionRuleExecution" ("workspaceId", "providerRuleId", "status", "occurredAt");
