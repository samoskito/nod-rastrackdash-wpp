-- Fase 6.5 — Braip (plataforma de venda na URL única): só valores de enum.
-- Porte do SaaS 20261015200000_braip_provider (09d7303a).
-- IMPORTANTE: nenhuma linha que use 'braip' entra nesta mesma migration.
-- O PostgreSQL não deixa usar um valor de enum recém-criado antes do commit,
-- e o Prisma envolve cada migration numa transação (ADD VALUE + INSERT = P3009).
-- O release do leitor fica na migration seguinte (20261027140100).
-- Aditiva e idempotente (IF NOT EXISTS).
ALTER TYPE "InboundWebhookProvider" ADD VALUE IF NOT EXISTS 'braip';
ALTER TYPE "DiagnosticSource" ADD VALUE IF NOT EXISTS 'braip';
