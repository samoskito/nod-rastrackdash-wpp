-- Fase 6.8 — leitores do ROI Chat, CERTIFICADOS.
--   v1            = entrada do lead (CTWA) na URL de cada número;
--   automation-v1 = compra (event_name "Purchase") na MESMA URL do número,
--                   levada para a regra "Compra no ROI Chat".
--
-- Produção direta (regra fixa do nod; decisão do Samuel de 27/10/2026): o
-- ROI Chat foi validado com payloads reais recebidos no SaaS (dash-com-ia) e
-- lidos corretamente pelo leitor:
--  - #183 (f4f74673): leitor roichat/v1 e roichat/automation-v1;
--  - #185 (37bee70d): o leitor foi corrigido a partir do formato real
--    ({ nome, telefone, anuncio: { source_id, ctwa_clid, ... } }), com a
--    fixture real sanitizada (entrada-real-anuncio-aninhado.json).
-- No SaaS as releases nasceram observation_only; aqui nascem certificadas,
-- como a Braip (20261027140100) e o waha v2 (20261022130100). O aluno não
-- retesta, não certifica e não libera nada.
--
-- Nada é criado nem ativado além das releases: as conexões ROI Chat nascem
-- em produção e as regras nascem enviando pela própria API
-- (bornConnectionStatus / bornRuleMode), sempre sujeitas às travas reais
-- (licença utilizável, rota Meta válida, destino com pixel e página).
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
) VALUES
  (
    'inbound_parser_roichat_v1',
    'roichat',
    'v1',
    'certified',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'inbound_parser_roichat_automation_v1',
    'roichat',
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
