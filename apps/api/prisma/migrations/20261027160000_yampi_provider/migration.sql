-- Fase 6.7 — Yampi (plataforma de venda na URL única): só valores de enum.
-- Porte do SaaS 20261026120000_yampi_provider (1889af48, #186).
-- IMPORTANTE: nenhuma linha que use 'yampi' entra nesta mesma migration.
-- O PostgreSQL não deixa usar um valor de enum recém-criado antes do commit,
-- e o Prisma envolve cada migration numa transação (ADD VALUE + INSERT = P3009).
-- O release do leitor fica na migration seguinte (20261027160100).
-- No nod a Yampi é liberada para todos os workspaces (sem integração privada).
-- Aditiva e idempotente (IF NOT EXISTS).
ALTER TYPE "InboundWebhookProvider" ADD VALUE IF NOT EXISTS 'yampi';
ALTER TYPE "DiagnosticSource" ADD VALUE IF NOT EXISTS 'yampi';
