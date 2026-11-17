-- Leitores do GoHighLevel, EM OBSERVAÇÃO (observation_only).
--   v1            = entrada do lead: o Workflow da localização chama a URL da
--                   conexão com o contato (ctwa_clid do anúncio);
--   automation-v1 = etapa do Workflow: a ação Webhook (POST) chama a URL da
--                   regra "Etapa no GoHighLevel" (Lead, QualifiedLead, Purchase).
--
-- Porte do SaaS 20261003190100_gohighlevel_v1_parser_release (057d6e08) e
-- 20261026180000_gohighlevel_automation_v1_parser_release (e279af76). No SaaS
-- os dois continuam observation_only: ainda não foram validados com eventos
-- reais. Por isso, diferente do ROI Chat, da Braip ou do Webhook / n8n
-- (certificados porque já foram validados ou porque o contrato é nosso), aqui
-- eles NÃO nascem certificados: conexões e regras do GoHighLevel mostram o
-- que seria enviado e nada vai para a Meta. A certificação virá numa
-- atualização futura (migration própria), depois da validação com eventos
-- reais, como aconteceu com a DataCrazy (20260929120100 → 20261016090300).
--
-- Só dados; nenhuma tabela, coluna ou índice. Aditiva e idempotente: uma
-- release que já exista não é alterada.
INSERT INTO "InboundWebhookParserRelease" (
  "id",
  "provider",
  "version",
  "status",
  "createdAt",
  "updatedAt"
) VALUES
  (
    'inbound_parser_gohighlevel_v1',
    'gohighlevel',
    'v1',
    'observation_only',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'inbound_parser_gohighlevel_automation_v1',
    'gohighlevel',
    'automation-v1',
    'observation_only',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
ON CONFLICT ("provider", "version") DO NOTHING;
