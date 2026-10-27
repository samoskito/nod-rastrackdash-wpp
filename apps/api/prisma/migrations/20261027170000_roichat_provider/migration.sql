-- Fase 6.8 — ROI Chat (WhatsApp API Oficial, uma URL por número): só valores de enum.
-- Porte do SaaS 20261025150000_roichat_provider (#183, f4f74673), SEM o
-- ADD VALUE no enum WhatsappSeatProvider (vagas pagas não
-- existem no nod; o enum do nod não tem esse uso).
-- IMPORTANTE: nenhuma linha que use 'roichat' entra nesta mesma migration.
-- O PostgreSQL não deixa usar um valor de enum recém-criado antes do commit,
-- e o Prisma envolve cada migration numa transação (ADD VALUE + INSERT = P3009).
-- Os releases dos leitores ficam na migration seguinte (20261027170100).
-- Aditiva e idempotente (IF NOT EXISTS).
ALTER TYPE "InboundWebhookProvider" ADD VALUE IF NOT EXISTS 'roichat';
ALTER TYPE "DiagnosticSource" ADD VALUE IF NOT EXISTS 'roichat';
