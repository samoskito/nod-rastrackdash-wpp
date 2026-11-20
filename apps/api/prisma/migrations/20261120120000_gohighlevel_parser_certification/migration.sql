-- Certifica os leitores do GoHighLevel (entrada v1 e etapa automation-v1),
-- semeados em observação em 20261117120100. Decisão do Samuel de 20/11/2026:
-- liberar o envio automático do GoHighLevel para os alunos.
--
-- Certificar só torna o GoHighLevel elegível, como a DataCrazy em
-- 20261016090300:
--  - conexões e regras criadas depois desta migration nascem em produção
--    (bornConnectionStatus / bornRuleMode);
--  - conexões e regras que já existem continuam em observação até o aluno
--    clicar em ativar na tela; nada é enviado retroativamente;
--  - as travas do envio continuam: licença utilizável, rota Meta válida e
--    destino com pixel e página.
--
-- Só dados; nenhuma tabela, coluna ou índice. Só muda uma release ainda em
-- observation_only (retirada continua retirada). Idempotente.
UPDATE "InboundWebhookParserRelease"
SET
  "status" = 'certified',
  "certifiedAt" = COALESCE("certifiedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "provider" = 'gohighlevel'
  AND "version" IN ('v1', 'automation-v1')
  AND "status" = 'observation_only';
