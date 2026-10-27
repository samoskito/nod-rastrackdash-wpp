-- Fase 6.7 — leitor da Yampi (yampi/automation-v1), CERTIFICADO.
--
-- Produção direta (regra fixa do nod; decisão do Samuel de 27/10/2026): o
-- que foi validado no SaaS chega ao aluno em produção. O aluno não retesta,
-- não certifica e não libera nada.
-- Evidência da validação no SaaS (dash-com-ia): payloads REAIS da Yampi
-- (order.paid e cart.reminder) foram recebidos e lidos corretamente pelo
-- leitor; o #187 (087df11b: produto principal pelo maior valor, tokens de
-- login ocultos) e o #188 (bce48c6c: itens reais do pedido, com order bump,
-- na Compra enviada à Meta) foram feitos a partir desse formato real.
-- No SaaS a release nasceu observation_only (#186, 1889af48); aqui nasce
-- certificada, como a Braip (20261027140100).
--
-- Nada é criado nem ativado além da release: as regras da Yampi nascem
-- enviando pela própria API (bornRuleMode) e continuam sujeitas às travas
-- reais (licença utilizável, rota Meta válida, destino com pixel e página).
-- Uma release que já exista só é certificada enquanto ainda estiver
-- observation_only (retirada continua retirada). Idempotente.
INSERT INTO "InboundWebhookParserRelease" (
  "id",
  "provider",
  "version",
  "status",
  "certifiedAt",
  "createdAt",
  "updatedAt"
) VALUES (
  'inbound_parser_yampi_automation_v1',
  'yampi',
  'automation-v1',
  'certified',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("provider", "version") DO UPDATE
SET
  "status" = 'certified',
  "certifiedAt" = COALESCE("InboundWebhookParserRelease"."certifiedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "InboundWebhookParserRelease"."status" = 'observation_only';
