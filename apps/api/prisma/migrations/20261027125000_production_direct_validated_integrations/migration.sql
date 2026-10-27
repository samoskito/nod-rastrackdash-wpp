-- Fase 6.1c — produção direta (regra de produto do nod).
--
-- O que foi validado no SaaS chega ao aluno em produção: a mesma plataforma
-- manda o mesmo payload, então o aluno não retesta, não certifica e não libera
-- nada. Esta migration promove, uma única vez, o que ficou em observação nas
-- instalações que já existem. Só dados mudam; nenhuma tabela, coluna ou índice
-- é criado, alterado ou removido.
--
-- Segurança:
--  - nada é enviado retroativamente: a data de ativação é a desta migration, e
--    o envio só vale para o que chegar depois dela;
--  - o que o operador pausou continua pausado (conexão "paused", número
--    "paused", regra pausada, unificada ou removida);
--  - conexão que o operador voltou para observação (auditoria
--    inbound_webhook.connection_observation) e regra que já esteve em produção
--    e foi tirada do envio (auditoria com resultStatus "production") ficam como
--    estão: foram decisões explícitas;
--  - conexão com recuperação (replay) em andamento fica como está;
--  - conexão Meta Cloud fica como está: em produção a API exige a assinatura
--    da Meta (META_APP_SECRET), que esta migration não consegue conferir; sem
--    o segredo as entregas seriam recusadas. O aluno ativa pela tela, que
--    confere o segredo (conexões novas com o segredo já nascem em produção);
--  - número de Uazapi/WAHA só é promovido com a conexão WhatsApp ativa;
--  - regra "Lead recebido" (LeadSubmitted) em observação fica como está: o
--    aluno decide quando ligá-la (ligada, o Lead recebido sai pela regra);
--  - toda promoção grava uma auditoria production_direct_6_1c:<tipo>:<id>,
--    que é por onde a promoção é desfeita (scripts/rollback/);
--  - as travas do envio continuam: licença utilizável, rota Meta válida e
--    destino com pixel e página. Sem rota, nada é enviado.
-- Idempotente: cada passo só toca linhas ainda em observação, e as auditorias
-- têm id determinístico (ON CONFLICT DO NOTHING).

-- 1) Leitor nativo do Meta Cloud v1: o código já o tratava como certificado
-- (inboundParserProductionEligible); a linha do banco passa a dizer o mesmo.
-- Release retirada continua retirada.
UPDATE "InboundWebhookParserRelease"
SET
  "status" = 'certified',
  "certifiedAt" = COALESCE("certifiedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "provider" = 'meta_cloud'
  AND "version" = 'v1'
  AND "status" = 'observation_only';

-- 2) Conexões em observação de integrações validadas (leitor certificado do
-- próprio provedor) passam para produção. Meta Cloud fica de fora (veja acima).
WITH promoted AS (
  UPDATE "InboundWebhookConnection" AS c
  SET
    "status" = 'production',
    "productionActivatedAt" = CURRENT_TIMESTAMP,
    "updatedAt" = CURRENT_TIMESTAMP
  FROM "InboundWebhookParserRelease" AS r
  WHERE c."parserReleaseId" = r."id"
    AND r."status" = 'certified'
    AND r."provider" = c."provider"
    AND c."status" = 'observation'
    AND c."removedAt" IS NULL
    AND c."provider" <> 'meta_cloud'
    AND NOT EXISTS (
      SELECT 1
      FROM "AuditLog" AS a
      WHERE a."targetType" = 'InboundWebhookConnection'
        AND a."targetId" = c."id"
        AND a."action" = 'inbound_webhook.connection_observation'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "InboundWebhookReplayBatch" AS b
      WHERE b."workspaceId" = c."workspaceId"
        AND b."connectionId" = c."id"
        AND b."status" IN ('queued', 'processing')
    )
  RETURNING c."id", c."workspaceId", c."provider"
)
INSERT INTO "AuditLog" (
  "id", "workspaceId", "actorUserId", "actorType", "action", "targetType",
  "targetId", "resultStatus", "beforeSummary", "afterSummary", "createdAt"
)
SELECT
  'production_direct_6_1c:connection:' || promoted."id",
  promoted."workspaceId",
  NULL,
  'system',
  'inbound_webhook.connection_production_direct',
  'InboundWebhookConnection',
  promoted."id",
  'production',
  jsonb_build_object('status', 'observation'),
  jsonb_build_object(
    'status', 'production',
    'provider', promoted."provider",
    'reason', 'production_direct_validated_integration'
  ),
  CURRENT_TIMESTAMP
FROM promoted
ON CONFLICT ("id") DO NOTHING;

-- 3) Números (canais) nunca ativados de conexões em produção passam a enviar.
-- Fica de fora: número pausado; número de Uazapi/WAHA cuja conexão WhatsApp
-- não está ativa; identidade antiga redescoberta de um número que já tem outro
-- canal ativo ou pausado na mesma conexão (porte do #86: o número pausado
-- continua pausado, também pela identidade irmã); e, entre duas identidades
-- descobertas do mesmo número, só a vista por último é ativada.
WITH promoted AS (
  UPDATE "InboundWebhookChannel" AS ch
  SET
    "status" = 'active',
    "productionActivatedAt" = CURRENT_TIMESTAMP,
    "updatedAt" = CURRENT_TIMESTAMP
  FROM "InboundWebhookConnection" AS c
  JOIN "InboundWebhookParserRelease" AS r ON r."id" = c."parserReleaseId"
  WHERE ch."connectionId" = c."id"
    AND ch."workspaceId" = c."workspaceId"
    AND ch."status" = 'discovered'
    AND c."status" = 'production'
    AND c."removedAt" IS NULL
    AND r."status" = 'certified'
    AND r."provider" = c."provider"
    AND (
      ch."whatsappInstanceId" IS NULL
      OR EXISTS (
        SELECT 1
        FROM "WhatsappInstance" AS w
        WHERE w."id" = ch."whatsappInstanceId"
          AND w."workspaceId" = ch."workspaceId"
          AND w."status" = 'active'
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "InboundWebhookChannel" AS sibling
      WHERE sibling."workspaceId" = ch."workspaceId"
        AND sibling."connectionId" = ch."connectionId"
        AND sibling."id" <> ch."id"
        AND sibling."connectedPhone" = ch."connectedPhone"
        AND (
          -- Ativo ou pausado: um número pausado pelo operador não volta a
          -- enviar por outra identidade (descoberta) do mesmo telefone.
          sibling."status" IN ('active', 'paused')
          OR (
            sibling."status" = 'discovered'
            AND (
              sibling."lastSeenAt" > ch."lastSeenAt"
              OR (
                sibling."lastSeenAt" = ch."lastSeenAt"
                AND sibling."id" > ch."id"
              )
            )
          )
        )
    )
  RETURNING ch."id", ch."workspaceId", ch."connectionId"
)
INSERT INTO "AuditLog" (
  "id", "workspaceId", "actorUserId", "actorType", "action", "targetType",
  "targetId", "resultStatus", "beforeSummary", "afterSummary", "createdAt"
)
SELECT
  'production_direct_6_1c:channel:' || promoted."id",
  promoted."workspaceId",
  NULL,
  'system',
  'inbound_webhook.channel_production_direct',
  'InboundWebhookChannel',
  promoted."id",
  'active',
  jsonb_build_object('status', 'discovered'),
  jsonb_build_object(
    'status', 'active',
    'connectionId', promoted."connectionId",
    'reason', 'production_direct_validated_integration'
  ),
  CURRENT_TIMESTAMP
FROM promoted
ON CONFLICT ("id") DO NOTHING;

-- 4) Número já ativo numa conexão em produção sem data de ativação (a conexão
-- acabou de ser promovida, ou linha antiga): recebe a data desta migration,
-- como faz a promoção da conexão pelo painel.
UPDATE "InboundWebhookChannel" AS ch
SET
  "productionActivatedAt" = CURRENT_TIMESTAMP,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "InboundWebhookConnection" AS c
WHERE ch."connectionId" = c."id"
  AND ch."workspaceId" = c."workspaceId"
  AND ch."status" = 'active'
  AND ch."productionActivatedAt" IS NULL
  AND c."status" = 'production'
  AND c."removedAt" IS NULL;

-- 5) Regras de conversão ativas em observação de integrações validadas passam
-- a enviar. Fica de fora: regra pausada, unificada ou removida; regra cuja
-- conexão foi removida ou ficou fora de produção nesta migration (voltada para
-- observação pelo operador, Meta Cloud, replay em curso); regra com leitor
-- próprio não certificado; e regra que já esteve em produção e foi tirada do
-- envio (decisão explícita).
-- Decisão do Samuel (D1, 27/10/2026): regra "Lead recebido" (LeadSubmitted)
-- em observação NÃO é promovida. Ligada, ela passa a ser a única a enviar o
-- Lead recebido dos números que cobre (no lugar da entrada da conversa); essa
-- troca é escolha do aluno, que liga a regra na tela ("Ligar esta regra").
-- Até lá o Lead recebido continua saindo na entrada, como antes.
WITH promoted AS (
  UPDATE "ProviderConversionRuleConfig" AS p
  SET
    "mode" = 'production',
    "productionActivatedAt" = CURRENT_TIMESTAMP,
    "updatedAt" = CURRENT_TIMESTAMP
  FROM "ConversionRule" AS cr
  WHERE p."conversionRuleId" = cr."id"
    AND p."workspaceId" = cr."workspaceId"
    AND cr."active" = true
    AND cr."eventName" <> 'LeadSubmitted'
    AND p."mode" = 'observation'
    AND p."removedAt" IS NULL
    AND p."unifiedIntoProviderRuleId" IS NULL
    AND (
      p."parserReleaseId" IS NULL
      OR EXISTS (
        SELECT 1
        FROM "InboundWebhookParserRelease" AS r
        WHERE r."id" = p."parserReleaseId"
          AND r."status" = 'certified'
      )
    )
    AND (
      p."connectionId" IS NULL
      OR EXISTS (
        SELECT 1
        FROM "InboundWebhookConnection" AS c
        WHERE c."id" = p."connectionId"
          AND c."workspaceId" = p."workspaceId"
          AND c."removedAt" IS NULL
          AND c."status" IN ('production', 'paused')
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "AuditLog" AS a
      WHERE a."targetType" = 'ProviderConversionRuleConfig'
        AND a."targetId" = p."id"
        AND a."resultStatus" = 'production'
    )
  RETURNING p."id", p."workspaceId"
)
INSERT INTO "AuditLog" (
  "id", "workspaceId", "actorUserId", "actorType", "action", "targetType",
  "targetId", "resultStatus", "beforeSummary", "afterSummary", "createdAt"
)
SELECT
  'production_direct_6_1c:rule:' || promoted."id",
  promoted."workspaceId",
  NULL,
  'system',
  'provider_conversion_rule.production_direct',
  'ProviderConversionRuleConfig',
  promoted."id",
  'production',
  jsonb_build_object('mode', 'observation'),
  jsonb_build_object(
    'mode', 'production',
    'reason', 'production_direct_validated_integration'
  ),
  CURRENT_TIMESTAMP
FROM promoted
ON CONFLICT ("id") DO NOTHING;

-- 6) Regras de CRM (Kommo e Pipedrive, validados no SaaS) ativas em
-- observação passam a enviar (decisão do Samuel, D2, 27/10/2026: ligar com
-- registro). Cada promoção grava auditoria com id fixo
-- (production_direct_6_1c:kommo:<id> / :pipedrive:<id>), que é por onde a
-- promoção é desfeita. Regras inativas ficam como estão. O envio das duas
-- continua obedecendo INBOUND_CONVERSION_PRODUCTION_ENABLED=false
-- (interruptor do servidor).
--
-- Kommo: não tem data de ativação; uma regra só é promovida quando a conexão
-- dela não tem evento ainda na fila (sem estado final), para nada recebido
-- antes desta migration ser enviado. As outras ficam para "Ativar envio".
WITH promoted AS (
  UPDATE "KommoConversionRule" AS kr
  SET
    "mode" = 'production',
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE kr."mode" = 'observation'
    AND kr."active" = true
    AND NOT EXISTS (
      SELECT 1
      FROM "KommoWebhookEvent" AS e
      WHERE e."workspaceId" = kr."workspaceId"
        AND e."connectionId" = kr."connectionId"
        AND e."status" NOT IN ('observed', 'duplicate', 'blocked', 'sent', 'processed', 'dead')
    )
  RETURNING kr."id", kr."workspaceId", kr."connectionId"
)
INSERT INTO "AuditLog" (
  "id", "workspaceId", "actorUserId", "actorType", "action", "targetType",
  "targetId", "resultStatus", "beforeSummary", "afterSummary", "createdAt"
)
SELECT
  'production_direct_6_1c:kommo:' || promoted."id",
  promoted."workspaceId",
  NULL,
  'system',
  'kommo_conversion_rule.production_direct',
  'KommoConversionRule',
  promoted."id",
  'production',
  jsonb_build_object('mode', 'observation'),
  jsonb_build_object(
    'mode', 'production',
    'connectionId', promoted."connectionId",
    'reason', 'production_direct_validated_integration'
  ),
  CURRENT_TIMESTAMP
FROM promoted
ON CONFLICT ("id") DO NOTHING;

-- 7) Pipedrive: as checagens da criação de uma regra enviando
-- (requireProduction): conexão ativa, credencial saudável, webhook emitido e
-- ao menos um número autorizado, todos prontos para o envio. Aqui só é
-- promovida a conexão cujos números autorizados são todos rotas explícitas
-- válidas: rota ativa e validada, ativos Meta (conexão de negócio e credencial
-- ativas, conta de anúncios ativa da mesma conexão, destino configurado), o
-- número ativo e em produção, com a conexão em produção, o leitor certificado
-- e, na Uazapi/WAHA, a conexão WhatsApp ativa. Um número autorizado pelo
-- próprio canal (destino herdado da página/pixel do workspace) depende do
-- roteamento Meta do workspace, que o SQL não confere com segurança: essa
-- regra fica para "Ativar envio", que faz a checagem completa e diz o motivo.
-- A data de ativação desta migration é a cerca: nada recebido antes é enviado.
WITH promoted AS (
  UPDATE "PipedriveConversionRule" AS pr
  SET
    "mode" = 'production',
    "productionActivatedAt" = CURRENT_TIMESTAMP,
    "updatedAt" = CURRENT_TIMESTAMP
  FROM "PipedriveConnection" AS pc
  WHERE pr."connectionId" = pc."id"
    AND pr."workspaceId" = pc."workspaceId"
    AND pr."mode" = 'observation'
    AND pr."active" = true
    AND pc."status" = 'active'
    AND pc."credentialHealthy" = true
    AND pc."webhookSecretHash" IS NOT NULL
    AND cardinality(pc."allowedChannelRouteIds") > 0
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(pc."allowedChannelRouteIds") AS binding("id")
      WHERE NOT (
        EXISTS (
          SELECT 1
          FROM "InboundWebhookChannelRoute" AS rt
          JOIN "InboundWebhookChannel" AS ch
            ON ch."id" = rt."channelId" AND ch."workspaceId" = rt."workspaceId"
          JOIN "InboundWebhookConnection" AS ic
            ON ic."id" = ch."connectionId" AND ic."workspaceId" = ch."workspaceId"
          JOIN "InboundWebhookParserRelease" AS rel
            ON rel."id" = ic."parserReleaseId"
          JOIN "MetaBusinessConnection" AS mb
            ON mb."id" = rt."metaBusinessConnectionId"
          JOIN "MetaCredential" AS mc
            ON mc."id" = mb."credentialId"
          JOIN "MetaReportingAccount" AS ra
            ON ra."id" = rt."metaReportingAccountId"
          JOIN "MetaConversionDestination" AS md
            ON md."id" = rt."metaConversionDestinationId"
          WHERE rt."id" = binding."id"
            AND rt."workspaceId" = pc."workspaceId"
            AND rt."active" = true
            AND rt."validationStatus" = 'valid'
            AND ch."status" = 'active'
            AND ch."productionActivatedAt" IS NOT NULL
            AND ic."status" = 'production'
            AND ic."productionActivatedAt" IS NOT NULL
            AND ic."removedAt" IS NULL
            AND rel."status" = 'certified'
            AND (
              (ic."provider" <> 'uazapi' AND ch."whatsappInstanceId" IS NULL)
              OR EXISTS (
                SELECT 1
                FROM "WhatsappInstance" AS w
                WHERE w."id" = ch."whatsappInstanceId"
                  AND w."workspaceId" = ch."workspaceId"
                  AND w."status" = 'active'
              )
            )
            AND mb."workspaceId" = pc."workspaceId"
            AND mb."status" = 'active'
            AND mc."workspaceId" = pc."workspaceId"
            AND mc."status" = 'active'
            AND ra."workspaceId" = pc."workspaceId"
            AND ra."active" = true
            AND ra."businessConnectionId" = mb."id"
            AND md."workspaceId" = pc."workspaceId"
            AND md."status" = 'configured'
        )
      )
    )
  RETURNING pr."id", pr."workspaceId", pr."connectionId"
)
INSERT INTO "AuditLog" (
  "id", "workspaceId", "actorUserId", "actorType", "action", "targetType",
  "targetId", "resultStatus", "beforeSummary", "afterSummary", "createdAt"
)
SELECT
  'production_direct_6_1c:pipedrive:' || promoted."id",
  promoted."workspaceId",
  NULL,
  'system',
  'pipedrive_conversion_rule.production_direct',
  'PipedriveConversionRule',
  promoted."id",
  'production',
  jsonb_build_object('mode', 'observation'),
  jsonb_build_object(
    'mode', 'production',
    'connectionId', promoted."connectionId",
    'reason', 'production_direct_validated_integration'
  ),
  CURRENT_TIMESTAMP
FROM promoted
ON CONFLICT ("id") DO NOTHING;
