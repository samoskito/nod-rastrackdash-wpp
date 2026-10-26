-- Fase 6.1a (porte do SaaS 42ccbc7c, #159; no SaaS: 20261021120000).
-- Regra Unnichat/Umbler "Todos os numeros da <plataforma> (todas as conexoes)".
-- Aditiva e opcional: NULL/false = alcance historico (numeros da conexao da
-- regra). So regras criadas/editadas com a opcao nova ou geradas pelo
-- "Unificar" de automacoes ficam com true. Nenhum dado existente e reescrito.

-- AlterTable
ALTER TABLE "ProviderConversionRuleConfig" ADD COLUMN IF NOT EXISTS "crossConnectionScope" BOOLEAN;
