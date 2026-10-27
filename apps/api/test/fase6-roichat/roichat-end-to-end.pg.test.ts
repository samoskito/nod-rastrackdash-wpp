import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPhoneIdentity } from "../../src/common/phone/phone-identity";
import { ProviderConversionDecisionEngine } from "../../src/conversion-rules/provider-conversion-decision.engine";
import { ProviderConversionDecisionRepository } from "../../src/conversion-rules/provider-conversion-decision.repository";
import { ProviderConversionObservationService } from "../../src/conversion-rules/provider-conversion-observation.service";
import { ProviderConversionOrchestrator } from "../../src/conversion-rules/provider-conversion-orchestrator.service";
import { ProviderConversionPaidLeadResolver } from "../../src/conversion-rules/provider-conversion-paid-lead-resolver.service";
import { ProviderConversionRulesService } from "../../src/conversion-rules/provider-conversion-rules.service";
import { InboundConversionAutomationIngestionService } from "../../src/inbound-webhooks/inbound-conversion-automation-ingestion.service";
import { InboundWebhookConnectionsService } from "../../src/inbound-webhooks/inbound-webhook-connections.service";
import { InboundWebhookIngestionService } from "../../src/inbound-webhooks/inbound-webhook-ingestion.service";
import { InboundWebhookPayloadEncryptionService } from "../../src/inbound-webhooks/inbound-webhook-payload-encryption.service";
import { RoichatPurchaseIngressService } from "../../src/inbound-webhooks/roichat-purchase-ingress.service";

/**
 * Fase 6.8 — ROI Chat de ponta a ponta num PostgreSQL 16 descartável com o
 * schema ATUAL (todas as migrations, inclusive as duas do ROI Chat). Mesmo
 * opt-in das outras suítes .pg: NOD_META_DISPATCH_PG_OPT_IN=disposable-local-only
 * e uma NOD_META_DISPATCH_TEST_PG_URL em loopback cujo banco é
 * nod_meta_dispatch_test_*. Nunca lê DATABASE_URL; só dados fictícios.
 *
 * Serviços reais: criação da conexão (número preso, produção direta), criação
 * da regra "Compra no ROI Chat", URL do número desviando a compra para a
 * regra, observação, decisão e orquestrador. Só as filas são gravadores:
 * "envia" aqui é uma execução `eligible` entregue à fila de produção,
 * exatamente o que o envio à Meta consome.
 */
const optedIn =
  process.env.NOD_META_DISPATCH_PG_OPT_IN === "disposable-local-only";
function disposableUrl(): string {
  const raw = process.env.NOD_META_DISPATCH_TEST_PG_URL;
  if (!raw) throw new Error("Dedicated disposable PG test URL required");
  const url = new URL(raw);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/nod_meta_dispatch_test_[a-z0-9_]+$/.test(url.pathname)
  )
    throw new Error(
      "PG harness requires a loopback disposable nod_meta_dispatch_test_* database",
    );
  return raw;
}

const env = {
  NODE_ENV: "test",
  API_PUBLIC_URL: "https://api.example.invalid",
  INBOUND_WEBHOOKS_ENABLED: "true",
  INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
  INBOUND_CONVERSION_RULES_ENABLED: "true",
  INBOUND_CONVERSION_PRODUCTION_ENABLED: "true",
  INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 68).toString("base64"),
};

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(__dirname, "../fixtures/roichat", name), "utf8"),
  ) as Record<string, unknown>;
}

/** The purchase without event_time (each arrival is its own occurrence). */
function purchase(overrides: Record<string, unknown> = {}) {
  const { event_time: _omit, ...body } = fixture("purchase.synthetic.json");
  return { ...body, ...overrides };
}

describe.skipIf(!optedIn)("ROI Chat de ponta a ponta no PostgreSQL descartável", () => {
  let db: PrismaClient;
  let userId: string;
  let connections: InboundWebhookConnectionsService;
  let rules: ProviderConversionRulesService;
  let ingestion: InboundWebhookIngestionService;
  const productionQueue = {
    enqueueProviderConversion: vi.fn(async () => undefined),
  };
  const entryQueue = {
    enqueueDelivery: vi.fn(async () => ({ jobId: "job", status: "queued" })),
  };

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: disposableUrl() } } });
    await db.$connect();
    userId = (
      await db.user.create({
        data: { email: `synthetic-${randomUUID()}@example.invalid` },
      })
    ).id;
    const engine = new ProviderConversionDecisionEngine();
    const encryption = new InboundWebhookPayloadEncryptionService(env);
    const observation = new ProviderConversionObservationService(
      db as never,
      {
        evaluate: async ({ decisionInput }: any) =>
          engine.evaluate(decisionInput),
      } as never,
      new ProviderConversionDecisionRepository(db as never),
      new ProviderConversionPaidLeadResolver(db as never),
      new ProviderConversionOrchestrator(db as never),
      env,
    );
    const automation = new InboundConversionAutomationIngestionService(
      db as never,
      env,
      encryption,
      productionQueue as never,
      observation,
    );
    connections = new InboundWebhookConnectionsService(db as never, env);
    rules = new ProviderConversionRulesService(db as never, env);
    ingestion = new InboundWebhookIngestionService(
      db as never,
      env,
      encryption,
      entryQueue as never,
      new RoichatPurchaseIngressService(db as never, automation),
    );
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  beforeEach(() => {
    productionQueue.enqueueProviderConversion.mockClear();
    entryQueue.enqueueDelivery.mockClear();
  });

  async function workspace(name: string) {
    const id = randomUUID();
    return (
      await db.workspace.create({ data: { name, slug: `roichat-${id}` } })
    ).id;
  }

  async function roichatNumber(workspaceId: string, phone: string) {
    const created = await connections.createConnection(
      workspaceId,
      {
        provider: "roichat",
        displayName: `ROI Chat ${phone.slice(-4)}`,
        connectedPhone: phone,
      },
      userId,
    );
    const token = new URL(created.webhookUrl).searchParams.get("token")!;
    const channel = await db.inboundWebhookChannel.findFirstOrThrow({
      where: { connectionId: created.connection.id },
    });
    return { connectionId: created.connection.id, channelId: channel.id, token };
  }

  /** The lead of the fixture phone, from an ad (CTWA). */
  async function adLead(workspaceId: string) {
    return db.lead.create({
      data: {
        workspaceId,
        name: "Lead do anúncio",
        phoneHash: hashPhoneIdentity("5547999990000")!,
        adId: "120200000000000001",
        ctwaClid: "AfjX-clique-ficticio-0001",
      },
    });
  }

  async function purchaseRule(
    workspaceId: string,
    connectionId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const result = (await rules.createRule(
      workspaceId,
      {
        name: "Compra no ROI Chat",
        triggerType: "provider_automation",
        eventName: "Purchase",
        automationSource: "roichat",
        connectionId,
        scope: "all_numbers",
        crossConnectionScope: true,
        channelIds: [],
        perRuleUrl: false,
        ...overrides,
      } as never,
      userId,
    )) as { rule: { id: string } };
    return result.rule.id;
  }

  async function post(
    number: { connectionId: string; token: string },
    body: unknown,
  ) {
    return ingestion.ingest({
      connectionId: number.connectionId,
      token: number.token,
      contentType: "application/json",
      providerAttempt: undefined,
      rawBody: Buffer.from(JSON.stringify(body)),
    });
  }

  it("the ROI Chat readers are certified by the migration", async () => {
    const releases = await db.inboundWebhookParserRelease.findMany({
      where: { provider: "roichat" },
      orderBy: { version: "asc" },
    });
    expect(releases.map((release) => [release.version, release.status])).toEqual([
      ["automation-v1", "certified"],
      ["v1", "certified"],
    ]);
  });

  it("creates the number born in production and the purchase rule born sending, with no URL of its own", async () => {
    const ws = await workspace("criacao");
    const number = await roichatNumber(ws, "+5511900000001");
    const connection = await db.inboundWebhookConnection.findUniqueOrThrow({
      where: { id: number.connectionId },
    });
    const channel = await db.inboundWebhookChannel.findUniqueOrThrow({
      where: { id: number.channelId },
    });
    expect(connection).toMatchObject({ provider: "roichat", status: "production" });
    expect(channel).toMatchObject({
      status: "active",
      connectedPhone: "5511900000001",
    });

    const ruleId = await purchaseRule(ws, number.connectionId);
    const rule = await db.providerConversionRuleConfig.findUniqueOrThrow({
      where: { id: ruleId },
      include: { parserRelease: true, endpoint: true, conversionRule: true },
    });
    expect(rule).toMatchObject({
      mode: "production",
      scope: "all_numbers",
      crossConnectionScope: true,
      parserRelease: { provider: "roichat", version: "automation-v1" },
      conversionRule: { eventName: "Purchase", defaultValueCents: null },
    });
    expect(rule.endpoint?.publicUrlDisabledAt).not.toBeNull();
    // The rule's own address is never reopened (the number URL receives).
    await expect(
      rules.updateRule(ws, ruleId, { publicUrlDisabled: false } as never, userId),
    ).rejects.toThrow(/URL de cada número/u);
  });

  it("refuses another event or a ROI Chat rule on a connection that is not ROI Chat", async () => {
    const ws = await workspace("recusas");
    const number = await roichatNumber(ws, "+5511900000002");
    await expect(
      purchaseRule(ws, number.connectionId, { eventName: "QualifiedLead" }),
    ).rejects.toThrow(/somente compra/u);
    const umbler = await connections.createConnection(
      ws,
      { provider: "umbler", displayName: "Umbler fictícia" },
      userId,
    );
    await expect(
      purchaseRule(ws, umbler.connection.id, { crossConnectionScope: undefined, scope: "all_numbers" }),
    ).rejects.toThrow(/conexão ROI Chat/u);
  });

  it("the number URL sends the purchase to the rule: eligible Purchase with the sale value, a repeat within 12h is one purchase, another value is a new one", async () => {
    const ws = await workspace("compra");
    const number = await roichatNumber(ws, "+5511900000003");
    const lead = await adLead(ws);
    const ruleId = await purchaseRule(ws, number.connectionId);

    const first = await post(number, purchase());
    expect(first).toMatchObject({ status: "accepted", duplicate: false });
    const executions = () =>
      db.providerConversionRuleExecution.findMany({
        where: { providerRuleId: ruleId },
        include: { providerDecision: true },
        orderBy: { createdAt: "asc" },
      });
    let rows = await executions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "eligible",
      leadId: lead.id,
      channelId: number.channelId,
    });
    const decision = rows[0]!.providerDecision!.decisionJson as any;
    expect(decision.conversion).toMatchObject({ valueCents: 2_000, currency: "BRL" });
    expect(decision.occurrence.businessDedupePolicy).toMatchObject({
      mode: "rolling_window",
      windowSeconds: 12 * 60 * 60,
    });
    expect(productionQueue.enqueueProviderConversion).toHaveBeenCalledTimes(1);
    // Never an entry: nothing went to the entry pipeline.
    expect(entryQueue.enqueueDelivery).not.toHaveBeenCalled();

    // The same purchase again (resend): one purchase.
    const repeated = await post(number, purchase());
    expect(repeated).toMatchObject({ duplicate: true });
    expect(await executions()).toHaveLength(1);

    // Another value: a new purchase (repurchase allowed).
    await post(number, purchase({ valor_venda: "35,00" }));
    rows = await executions();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ status: "eligible" });
    expect((rows[1]!.providerDecision!.decisionJson as any).conversion.valueCents).toBe(3_500);

    // Nothing personal in the stored summaries.
    const deliveries = await db.inboundWebhookDelivery.findMany({
      where: { workspaceId: ws },
      select: { normalizedSummary: true },
    });
    expect(JSON.stringify(deliveries)).not.toContain("47999990000");
    expect(JSON.stringify(deliveries)).not.toContain("Fulana");
  });

  it("without a rule, the purchase is kept on the number and never becomes an entry", async () => {
    const ws = await workspace("sem-regra");
    const number = await roichatNumber(ws, "+5511900000004");
    await adLead(ws);
    const result = await post(number, purchase());
    expect(result).toMatchObject({ status: "accepted", duplicate: false });
    expect(
      await db.providerConversionRuleExecution.count({ where: { workspaceId: ws } }),
    ).toBe(0);
    expect(entryQueue.enqueueDelivery).toHaveBeenCalledTimes(1);
  });
});
