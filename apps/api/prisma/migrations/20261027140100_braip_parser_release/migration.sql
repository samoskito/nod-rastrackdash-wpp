-- Fase 6.5 — leitor da Braip (braip/automation-v1), CERTIFICADO.
--
-- Produção direta (regra fixa do nod): o que foi validado no SaaS chega ao
-- aluno em produção. O aluno não retesta, não certifica e não libera nada.
-- Evidência da validação no SaaS (dash-com-ia):
--  - #168 (8af225f4): o leitor foi conferido com o exemplo OFICIAL do
--    postback da Braip (área de membros: aguardando pagamento, aprovado,
--    aprovado com order bump, cancelada e afiliado), com fixtures sanitizados
--    e o teste braip-official-sample;
--  - docs/plans/2026-10-15-braip-integration-design.md (campos confirmados).
-- No SaaS a release nasceu observation_only; aqui nasce certificada, como o
-- waha v2 (20261022130100) e a Payt/Unnichat.
--
-- Nada é criado nem ativado além da release: as regras da Braip nascem
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
  'inbound_parser_braip_automation_v1',
  'braip',
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
