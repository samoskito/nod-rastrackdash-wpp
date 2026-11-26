-- Leitor da XMAX CRM (xmax/automation-v1), EM OBSERVAÇÃO (observation_only).
--
-- Cada automação de etapa da oportunidade no CRM da XMAX chama a URL de uma
-- regra "Etapa no CRM da XMAX" (uma URL por evento). O leitor ainda não foi
-- validado com uma chamada real da XMAX à URL da regra (no SaaS só os
-- formatos dos corpos foram vistos). Por isso ele NÃO nasce certificado:
-- as regras da XMAX mostram o que seria enviado e nada vai para a Meta. A
-- certificação virá numa atualização futura (migration própria), depois do
-- teste real, como aconteceu com o GoHighLevel (20261117120100 →
-- 20261120120000).
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
) VALUES (
  'inbound_parser_xmax_automation_v1',
  'xmax',
  'automation-v1',
  'observation_only',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("provider", "version") DO NOTHING;
