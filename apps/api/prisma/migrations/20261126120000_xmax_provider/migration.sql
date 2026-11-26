-- XMAX CRM (conversões pelas etapas da oportunidade, URL por regra): só
-- valores de enum. Porte do SaaS (docs/integrations/xmax-crm-opportunity.md),
-- no modelo do Webhook / n8n da edição do aluno.
-- IMPORTANTE: nenhuma linha que use 'xmax' entra nesta mesma migration.
-- O PostgreSQL não deixa usar um valor de enum recém-criado antes do commit,
-- e o Prisma envolve cada migration numa transação (ADD VALUE + INSERT = P3009).
-- O release do leitor fica na migration seguinte (20261126120100).
-- Aditiva e idempotente (IF NOT EXISTS).
ALTER TYPE "InboundWebhookProvider" ADD VALUE IF NOT EXISTS 'xmax';
ALTER TYPE "DiagnosticSource" ADD VALUE IF NOT EXISTS 'xmax';
