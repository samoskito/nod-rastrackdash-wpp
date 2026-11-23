-- GoHighLevel automation-v2 (aditiva): conversão pela etapa da oportunidade.
-- Porte do SaaS 20261120120000_gohighlevel_pipeline_stage_filter (#277).
-- 1) Filtro opcional "Pipeline + etapa" na regra: colunas NULLABLE, sem
--    default e sem backfill. NULL mantém o comportamento de hoje.
-- 2) Private Integration Token opcional e criptografado na conexão do GHL
--    (escopo de leitura), só para listar pipelines/etapas na tela da regra.
--    Mesmas colunas AES-GCM dos outros segredos da conexão.
-- 3) Leitor novo `automation-v2`, já CERTIFICADO: validado no SaaS com
--    payload real de mudança de etapa em 23/11/2026 (produção direta no aluno,
--    como a certificação dos leitores v1 e automation-v1 em 20261120120000).
--    Regras criadas com filtro de etapa nascem enviando; automation-v1 e as
--    regras ligadas a ele não mudam. Idempotente: release existente não muda.

ALTER TABLE "ProviderConversionRuleConfig"
  ADD COLUMN IF NOT EXISTS "ghlPipelineId" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "ghlPipelineName" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "ghlStageId" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "ghlStageName" VARCHAR(255);

ALTER TABLE "InboundWebhookConnection"
  ADD COLUMN IF NOT EXISTS "ghlTokenCiphertext" TEXT,
  ADD COLUMN IF NOT EXISTS "ghlTokenIv" TEXT,
  ADD COLUMN IF NOT EXISTS "ghlTokenTag" TEXT,
  ADD COLUMN IF NOT EXISTS "ghlTokenKeyVersion" INTEGER;

INSERT INTO "InboundWebhookParserRelease" (
  "id",
  "provider",
  "version",
  "status",
  "certifiedAt",
  "createdAt",
  "updatedAt"
) VALUES (
  'inbound_parser_gohighlevel_automation_v2',
  'gohighlevel',
  'automation-v2',
  'certified',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("provider", "version") DO NOTHING;
