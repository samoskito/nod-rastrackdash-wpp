-- GoHighLevel (entrada do lead pelo Workflow + conversões das etapas): só
-- valores de enum. Porte do SaaS 20261003190000_gohighlevel_inbound_observation
-- (057d6e08, #130), com timestamp novo, posterior às migrations do nod.
-- IMPORTANTE: nenhuma linha que use 'gohighlevel' entra nesta mesma migration.
-- O PostgreSQL não deixa usar um valor de enum recém-criado antes do commit,
-- e o Prisma envolve cada migration numa transação (ADD VALUE + INSERT = P3009).
-- Os leitores ficam na migration seguinte (20261117120100).
-- Sem WhatsappSeatProvider: vagas/assinatura são só do SaaS.
-- Aditiva e idempotente (IF NOT EXISTS).
ALTER TYPE "InboundWebhookProvider" ADD VALUE IF NOT EXISTS 'gohighlevel';
ALTER TYPE "DiagnosticSource" ADD VALUE IF NOT EXISTS 'gohighlevel';
