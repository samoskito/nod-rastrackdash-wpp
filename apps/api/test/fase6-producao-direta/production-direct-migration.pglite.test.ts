import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * A migration 20261027125000 (produção direta) rodando de verdade, num
 * PostgreSQL em processo (PGlite) com o schema real: todas as migrations
 * anteriores aplicadas, dados sintéticos (telefones fictícios 5511999990xxx),
 * depois a 125000 duas vezes (idempotência) e os scripts de recuperação de
 * scripts/rollback/. Nada toca o banco do projeto.
 */
const migrationsDir = resolve(__dirname, "../../prisma/migrations");
const rollbackDir = resolve(__dirname, "../../../../scripts/rollback");
const target = "20261027125000_production_direct_validated_integrations";

function migrationSql(name: string): string {
  return readFileSync(resolve(migrationsDir, name, "migration.sql"), "utf8");
}

async function migrateUpTo(db: PGlite, until: string, inclusive: boolean) {
  const all = readdirSync(migrationsDir)
    .filter((entry) => /^\d{14}_/u.test(entry))
    .sort();
  for (const name of all) {
    if (inclusive ? name > until : name >= until) break;
    await db.exec(migrationSql(name));
  }
}

const seed = `
INSERT INTO "Workspace" (id, name, slug, "updatedAt") VALUES ('w1','W1','w1',now());
INSERT INTO "InboundWebhookConnection" (id,"workspaceId",provider,"displayName","parserReleaseId",status,"updatedAt")
VALUES ('c1','w1','umbler','Umbler','inbound_parser_umbler_v1','observation',now());
-- A1: o número 0101 foi pausado pelo operador; a identidade irmã (descoberta)
-- do mesmo telefone é mais recente e nunca foi ativada.
INSERT INTO "InboundWebhookChannel" (id,"workspaceId","connectionId","organizationId","providerChannelId","connectedPhone",status,"lastSeenAt","updatedAt") VALUES
 ('ch_paused','w1','c1','org','pc1','5511999990101','paused', now() - interval '2 day', now()),
 ('ch_sibling','w1','c1','org','pc2','5511999990101','discovered', now() - interval '1 day', now()),
 ('ch_new','w1','c1','org','pc3','5511999990102','discovered', now(), now());
INSERT INTO "ConversionRule" (id,"workspaceId",name,"triggerType","triggerValue","eventName",active,"updatedAt") VALUES
 ('cr_q','w1','Qualificado','message_phrase','x','QualifiedLead',true,now()),
 ('cr_l','w1','Lead recebido','message_phrase','x','LeadSubmitted',true,now()),
 ('cr_q2','w1','Qualificado 2','message_phrase','y','QualifiedLead',true,now());
INSERT INTO "ProviderConversionRuleConfig" (id,"workspaceId","conversionRuleId","connectionId","parserReleaseId",mode,"updatedAt") VALUES
 ('p_q','w1','cr_q','c1','inbound_parser_umbler_v1','observation',now()),
 ('p_l','w1','cr_l','c1','inbound_parser_umbler_v1','observation',now()),
 ('p_q2','w1','cr_q2','c1','inbound_parser_umbler_v1','observation',now());
INSERT INTO "KommoConnection" (id,"workspaceId","displayName","accountOrigin","accessTokenEncrypted","accessTokenIv","accessTokenTag","webhookSecretHash","updatedAt")
VALUES ('k1','w1','Kommo','https://x.kommo.com','e','i','t','hash_k1',now());
INSERT INTO "KommoConversionRule" (id,"workspaceId","connectionId",name,"pipelineId","statusId","eventName",mode,active,"updatedAt") VALUES
 ('kr1','w1','k1','Proposta','p','s','QualifiedLead','observation',true,now()),
 ('kr_off','w1','k1','Inativa','p','s2','QualifiedLead','observation',false,now());
-- Ativos Meta e uma rota válida do número ch_new (promovido no passo 3).
INSERT INTO "MetaCredential" (id,"workspaceId",source,label,"encryptedAccessToken","tokenIv","tokenTag",fingerprint,"tokenLast4",scopes,status,"updatedAt")
VALUES ('mc1','w1','manual','Token','e','i','t','fp','abcd',ARRAY[]::text[],'active',now());
INSERT INTO "MetaBusinessConnection" (id,"workspaceId","credentialId","businessManagerId","businessManagerName",status,"updatedAt")
VALUES ('mb1','w1','mc1','bm1','BM','active',now());
INSERT INTO "MetaReportingAccount" (id,"workspaceId","businessId","businessName","adAccountId","adAccountName","businessConnectionId",active,"updatedAt")
VALUES ('ra1','w1','bm1','BM','act_1','Conta','mb1',true,now());
INSERT INTO "MetaConversionDestination" (id,"workspaceId","pixelId","pixelName","pageId","pageName",status,"updatedAt")
VALUES ('md1','w1','px1','Pixel','pg1','Página','configured',now());
INSERT INTO "InboundWebhookChannelRoute" (id,"workspaceId","channelId","routeKey","metaBusinessConnectionWorkspaceId","metaBusinessConnectionId","metaReportingAccountWorkspaceId","metaReportingAccountId","metaConversionDestinationWorkspaceId","metaConversionDestinationId",active,"validationStatus","updatedAt")
VALUES ('route_new','w1','ch_new','rk1','w1','mb1','w1','ra1','w1','md1',true,'valid',now());
INSERT INTO "PipedriveConnection" (id,"workspaceId","displayName","accountOrigin","accessTokenEncrypted","accessTokenIv","accessTokenTag",status,"credentialHealthy","webhookSecretHash","allowedChannelRouteIds","webhookIssuedAt","updatedAt") VALUES
 ('pd_ok','w1','Pipedrive ok','https://x.pipedrive.com','e','i','t','active',true,md5('a')||md5('b'),ARRAY['route_new'],now(),now()),
 ('pd_channel','w1','Número por canal','https://t.pipedrive.com','e','i','t','active',true,md5('i')||md5('j'),ARRAY['ch_new'],now(),now()),
 ('pd_sick','w1','Sem credencial','https://y.pipedrive.com','e','i','t','active',false,md5('c')||md5('d'),ARRAY['route_new'],now(),now()),
 ('pd_no_webhook','w1','Sem webhook','https://v.pipedrive.com','e','i','t','active',true,NULL,ARRAY['route_new'],NULL,now()),
 ('pd_no_number','w1','Sem número','https://u.pipedrive.com','e','i','t','active',true,md5('g')||md5('h'),ARRAY[]::text[],now(),now()),
 ('pd_paused_number','w1','Número pausado','https://z.pipedrive.com','e','i','t','active',true,md5('e')||md5('f'),ARRAY['ch_paused'],now(),now());
INSERT INTO "PipedriveConversionRule" (id,"workspaceId","connectionId",name,"pipelineId","stageId","eventName",mode,active,"updatedAt") VALUES
 ('pr_ok','w1','pd_ok','Ganho','1','2','Purchase','observation',true,now()),
 ('pr_channel','w1','pd_channel','Ganho','1','2','Purchase','observation',true,now()),
 ('pr_sick','w1','pd_sick','Ganho','1','2','Purchase','observation',true,now()),
 ('pr_no_webhook','w1','pd_no_webhook','Ganho','1','2','Purchase','observation',true,now()),
 ('pr_no_number','w1','pd_no_number','Ganho','1','2','Purchase','observation',true,now()),
 ('pr_pn','w1','pd_paused_number','Ganho','1','2','Purchase','observation',true,now());
`;

type Row = Record<string, unknown>;

async function rows(db: PGlite, sql: string): Promise<Row[]> {
  return (await db.query<Row>(sql)).rows;
}

async function byId(db: PGlite, table: string, column: string) {
  const result = await rows(
    db,
    `SELECT id, "${column}" AS value FROM "${table}" ORDER BY id`,
  );
  return Object.fromEntries(result.map((row) => [row.id, row.value]));
}

async function snapshot(db: PGlite) {
  return {
    connections: await byId(db, "InboundWebhookConnection", "status"),
    channels: await byId(db, "InboundWebhookChannel", "status"),
    rules: await byId(db, "ProviderConversionRuleConfig", "mode"),
    kommo: await byId(db, "KommoConversionRule", "mode"),
    pipedrive: await byId(db, "PipedriveConversionRule", "mode"),
    audits: (
      await rows(
        db,
        `SELECT id FROM "AuditLog" WHERE id LIKE 'production_direct_6_1c:%' ORDER BY id`,
      )
    ).map((row) => row.id),
  };
}

describe("migration 125000 num PostgreSQL real (PGlite)", () => {
  let db: PGlite;
  let first: Awaited<ReturnType<typeof snapshot>>;

  beforeAll(async () => {
    db = new PGlite();
    await migrateUpTo(db, target, false);
    await db.exec(seed);
    await db.exec(migrationSql(target));
    first = await snapshot(db);
  }, 120_000);

  it("A1: número pausado não volta a enviar pela identidade irmã do mesmo telefone", () => {
    expect(first.channels).toMatchObject({
      ch_paused: "paused",
      ch_sibling: "discovered",
      ch_new: "active",
    });
    expect(first.audits).not.toContain(
      "production_direct_6_1c:channel:ch_sibling",
    );
  });

  it("D1: a regra Lead recebido em observação continua igual; as outras são promovidas", async () => {
    expect(first.connections).toEqual({ c1: "production" });
    expect(first.rules).toEqual({
      p_l: "observation",
      p_q: "production",
      p_q2: "production",
    });
    const [leadRule] = await rows(
      db,
      `SELECT "productionActivatedAt" FROM "ProviderConversionRuleConfig" WHERE id = 'p_l'`,
    );
    expect(leadRule?.productionActivatedAt).toBeNull();
    expect(first.audits).not.toContain("production_direct_6_1c:rule:p_l");
  });

  it("D2: Kommo e Pipedrive promovidos com auditoria; Pipedrive só com as checagens da criação", () => {
    expect(first.kommo).toEqual({ kr1: "production", kr_off: "observation" });
    expect(first.pipedrive).toEqual({
      pr_ok: "production",
      // Número autorizado pelo próprio canal: o destino herdado depende do
      // roteamento Meta do workspace; fica para "Ativar envio".
      pr_channel: "observation",
      pr_sick: "observation",
      pr_no_webhook: "observation",
      pr_no_number: "observation",
      pr_pn: "observation",
    });
    expect(first.audits).toEqual([
      "production_direct_6_1c:channel:ch_new",
      "production_direct_6_1c:connection:c1",
      "production_direct_6_1c:kommo:kr1",
      "production_direct_6_1c:pipedrive:pr_ok",
      "production_direct_6_1c:rule:p_q",
      "production_direct_6_1c:rule:p_q2",
    ]);
  });

  it("é idempotente: rodar de novo não muda nada", async () => {
    await db.exec(migrationSql(target));
    expect(await snapshot(db)).toEqual(first);
  });

  it("scripts/rollback/desfazer-producao-direta-6-1c.sql volta só o que a migration promoveu", async () => {
    const sql = readFileSync(
      resolve(rollbackDir, "desfazer-producao-direta-6-1c.sql"),
      "utf8",
    );
    // Depois da atualização o aluno pausou e retomou a p_q2 (nova data de
    // ativação): ela é decisão dele e não volta para observação.
    await db.exec(
      `UPDATE "ProviderConversionRuleConfig" SET "productionActivatedAt" = "productionActivatedAt" + interval '1 hour' WHERE id = 'p_q2'`,
    );
    await db.exec(sql);
    const after = await snapshot(db);
    expect(after.connections).toEqual({ c1: "observation" });
    expect(after.channels).toMatchObject({
      ch_paused: "paused",
      ch_sibling: "discovered",
      ch_new: "discovered",
    });
    expect(after.rules).toEqual({
      p_l: "observation",
      p_q: "observation",
      p_q2: "production",
    });
    expect(after.kommo).toEqual({ kr1: "observation", kr_off: "observation" });
    expect(Object.values(after.pipedrive)).toEqual(
      Array(6).fill("observation"),
    );
    const [pipedrive] = await rows(
      db,
      `SELECT "productionActivatedAt" FROM "PipedriveConversionRule" WHERE id = 'pr_ok'`,
    );
    expect(pipedrive?.productionActivatedAt).toBeNull();
    // Rodar de novo não muda nada.
    await db.exec(sql);
    expect(await snapshot(db)).toEqual(after);
  });
});

describe("scripts/rollback/antes-de-voltar-para-1.2.sql (PGlite, schema atual)", () => {
  it("remove (sem apagar) regras, conexões ROI Chat e URLs Braip/Yampi; reativar traz de volta", async () => {
    const db = new PGlite();
    await migrateUpTo(db, "99999999999999", true);
    await db.exec(`
      INSERT INTO "Workspace" (id, name, slug, "updatedAt") VALUES ('w1','W1','w1',now());
      INSERT INTO "InboundWebhookConnection" (id,"workspaceId",provider,"displayName","parserReleaseId",status,"updatedAt") VALUES
       ('c1','w1','umbler','Umbler','inbound_parser_umbler_v1','production',now()),
       ('c_roi','w1','roichat','ROI Chat','inbound_parser_roichat_v1','production',now());
      INSERT INTO "IntegrationEndpoint" (id,"workspaceId",provider,kind,"parserReleaseId","secretHash","secretCiphertext","secretIv","secretTag","secretKeyVersion","updatedAt") VALUES
       ('e_braip','w1','braip','sales_platform','inbound_parser_braip_automation_v1','h1','c','i','t',1,now()),
       ('e_yampi','w1','yampi','sales_platform','inbound_parser_yampi_automation_v1','h2','c','i','t',1,now()),
       ('e_payt','w1','payt','sales_platform','inbound_parser_payt_automation_v1','h3','c','i','t',1,now());
      INSERT INTO "ConversionRule" (id,"workspaceId",name,"triggerType","triggerValue","eventName",active,"updatedAt") VALUES
       ('cr_braip','w1','Compra Braip','provider_automation','x','Purchase',true,now()),
       ('cr_roi','w1','Compra ROI','provider_automation','x','Purchase',true,now()),
       ('cr_q','w1','Qualificado','message_phrase','x','QualifiedLead',true,now());
      INSERT INTO "ProviderConversionRuleConfig" (id,"workspaceId","conversionRuleId","connectionId","parserReleaseId",mode,"updatedAt") VALUES
       ('p_braip','w1','cr_braip','c1','inbound_parser_braip_automation_v1','production',now()),
       ('p_roi','w1','cr_roi','c_roi','inbound_parser_roichat_automation_v1','production',now()),
       ('p_q','w1','cr_q','c1','inbound_parser_umbler_v1','production',now());
      INSERT INTO "WebhookLog" (id,"workspaceId",source,"eventType",status) VALUES
       ('wl_roi','w1','roichat','roichat.webhook','received'),
       ('wl_umbler','w1','umbler','umbler.webhook','received');
      INSERT INTO "DiagnosticEvent" (id,"workspaceId",source,"eventType",severity,status,title,message) VALUES
       ('de_braip','w1','braip','x','info','received','t','m');
      -- 1.3.1: recebimentos com os valores novos (a 1.2.0 lê sem filtrar).
      INSERT INTO "InboundWebhookChannel" (id,"workspaceId","connectionId","organizationId","providerChannelId","connectedPhone",status,"lastSeenAt","updatedAt") VALUES
       ('ch_roi','w1','c_roi','org','pc_roi','5511999990201','active',now(),now());
      INSERT INTO "InboundWebhookDelivery" (id,"workspaceId","connectionId",provider,"ingressKey","parserVersion","payloadExpiresAt","updatedAt") VALUES
       ('d_roi','w1','c_roi','roichat','k1','v1',now(),now()),
       ('d_umbler','w1','c1','umbler','k2','v1',now(),now());
      INSERT INTO "InboundWebhookEvent" (id,"workspaceId","connectionId","deliveryId","channelId",provider,"dedupeKey","occurredAt",classification,"normalizedSummary","updatedAt") VALUES
       ('ev_roi','w1','c_roi','d_roi','ch_roi','roichat','dk1',now(),'eligible_route_resolved','{}',now());
      INSERT INTO "IntegrationEndpointEvent" (id,"workspaceId","integrationEndpointId",provider,"ingressKey",status,"payloadExpiresAt","updatedAt") VALUES
       ('iee_braip','w1','e_braip','braip','i1','unattributed',now(),now()),
       ('iee_yampi','w1','e_yampi','yampi','i2','pending',now(),now()),
       ('iee_payt','w1','e_payt','payt','i3','unattributed',now(),now());
    `);
    const providers = async () =>
      Object.fromEntries(
        (
          await rows(
            db,
            `SELECT id, provider::text AS provider FROM "InboundWebhookDelivery"
             UNION ALL SELECT id, provider::text FROM "InboundWebhookEvent"
             UNION ALL SELECT id, provider::text FROM "IntegrationEndpointEvent"
             UNION ALL SELECT id, provider::text FROM "IntegrationEndpoint"
             UNION ALL SELECT id, provider::text FROM "InboundWebhookConnection"
             ORDER BY 1`,
          )
        ).map((row) => [row.id, row.provider]),
      );
    const releases = async () =>
      rows(
        db,
        `SELECT id, provider::text AS provider, version, status::text AS status
         FROM "InboundWebhookParserRelease" ORDER BY id`,
      );
    const providersBefore = await providers();
    const releasesBefore = await releases();
    const removed = async () => ({
      endpoints: await byIdRemoved(db, "IntegrationEndpoint"),
      connections: await byIdRemoved(db, "InboundWebhookConnection"),
      rules: await byIdRemoved(db, "ProviderConversionRuleConfig"),
    });
    const cleanup = readFileSync(
      resolve(rollbackDir, "antes-de-voltar-para-1.2.sql"),
      "utf8",
    );
    await db.exec(cleanup);
    const after = await removed();
    expect(after).toEqual({
      endpoints: { e_braip: true, e_payt: false, e_yampi: true },
      connections: { c1: false, c_roi: true },
      rules: { p_braip: true, p_q: false, p_roi: true },
    });
    // Nada com os valores novos fica visível para as listas da 1.2.0, que
    // filtram removedAt.
    const visible = await rows(
      db,
      `SELECT provider::text FROM "InboundWebhookConnection" WHERE "removedAt" IS NULL
       UNION ALL SELECT provider::text FROM "IntegrationEndpoint" WHERE "removedAt" IS NULL
       UNION ALL SELECT r.provider::text FROM "ProviderConversionRuleConfig" p
         JOIN "InboundWebhookParserRelease" r ON r.id = p."parserReleaseId"
         WHERE p."removedAt" IS NULL`,
    );
    expect(
      visible.map((row) => row.provider).filter((p) =>
        ["roichat", "braip", "yampi"].includes(String(p)),
      ),
    ).toEqual([]);
    // 1.3.1: nenhuma linha fica com roichat, braip ou yampi.
    const newValues = await rows(
      db,
      `SELECT provider::text AS provider FROM "InboundWebhookDelivery"
       UNION ALL SELECT provider::text FROM "InboundWebhookEvent"
       UNION ALL SELECT provider::text FROM "IntegrationEndpointEvent"
       UNION ALL SELECT provider::text FROM "IntegrationEndpoint"
       UNION ALL SELECT provider::text FROM "InboundWebhookConnection"
       UNION ALL SELECT provider::text FROM "InboundWebhookParserRelease"`,
    );
    expect(
      newValues.filter((row) =>
        ["roichat", "braip", "yampi"].includes(String(row.provider)),
      ),
    ).toEqual([]);
    expect(await providers()).toMatchObject({
      d_roi: "meta_cloud",
      d_umbler: "umbler",
      ev_roi: "meta_cloud",
      iee_braip: "payt",
      iee_yampi: "payt",
      iee_payt: "payt",
      e_braip: "payt",
      c_roi: "meta_cloud",
    });
    const swapped = (await releases()).filter((row) =>
      String(row.version).startsWith("rollback_1_2:"),
    );
    expect(swapped.length).toBeGreaterThan(0);
    for (const row of swapped) expect(row.status).toBe("retired");
    const snapshotAfterCleanup = {
      providers: await providers(),
      releases: await releases(),
    };
    await db.exec(cleanup);
    expect(await removed()).toEqual(after);
    expect({ providers: await providers(), releases: await releases() }).toEqual(
      snapshotAfterCleanup,
    );
    // Diagnóstico: a 1.2.0 lê essas tabelas sem filtrar a origem.
    const sources = async () =>
      Object.fromEntries(
        (
          await rows(
            db,
            `SELECT id, source::text AS source FROM "WebhookLog" UNION ALL SELECT id, source::text FROM "DiagnosticEvent" ORDER BY 1`,
          )
        ).map((row) => [row.id, row.source]),
      );
    expect(await sources()).toEqual({
      de_braip: "internal",
      wl_roi: "internal",
      wl_umbler: "umbler",
    });

    await db.exec(
      readFileSync(
        resolve(rollbackDir, "reativar-depois-de-atualizar.sql"),
        "utf8",
      ),
    );
    const restored = await removed();
    for (const group of Object.values(restored)) {
      expect(Object.values(group).every((value) => value === false)).toBe(true);
    }
    expect(await sources()).toEqual({
      de_braip: "braip",
      wl_roi: "roichat",
      wl_umbler: "umbler",
    });
    const [backup] = await rows(
      db,
      `SELECT to_regclass('rollback_1_2_diagnostic_source') AS name`,
    );
    expect(backup?.name).toBeNull();
    // 1.3.1: provedores, versões e status dos leitores voltam ao original.
    expect(await providers()).toEqual(providersBefore);
    expect(
      (await releases()).map(({ id, provider, version, status }) => ({
        id,
        provider,
        version,
        status,
      })),
    ).toEqual(
      releasesBefore.map(({ id, provider, version, status }) => ({
        id,
        provider,
        version,
        status,
      })),
    );
    const [providerBackup] = await rows(
      db,
      `SELECT to_regclass('rollback_1_2_provider') AS name`,
    );
    expect(providerBackup?.name).toBeNull();
  }, 120_000);
});

async function byIdRemoved(db: PGlite, table: string) {
  const result = await rows(
    db,
    `SELECT id, "removedAt" IS NOT NULL AS removed FROM "${table}" ORDER BY id`,
  );
  return Object.fromEntries(result.map((row) => [row.id, row.removed]));
}
