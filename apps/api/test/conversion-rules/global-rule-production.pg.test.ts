import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPhoneIdentity } from "../../src/common/phone/phone-identity";
import { ProviderConversionDecisionEngine } from "../../src/conversion-rules/provider-conversion-decision.engine";
import { ProviderConversionDecisionRepository } from "../../src/conversion-rules/provider-conversion-decision.repository";
import { ProviderConversionOrchestrator } from "../../src/conversion-rules/provider-conversion-orchestrator.service";
import { ProviderConversionPaidLeadResolver } from "../../src/conversion-rules/provider-conversion-paid-lead-resolver.service";
import { ProviderConversionRulesService } from "../../src/conversion-rules/provider-conversion-rules.service";
import { GlobalRuleAutoActivationService } from "../../src/conversion-rules/provider-rule-global-auto-activation.service";
import { applyInboundWebhookChannelStatus, applyInboundWebhookConnectionStatus } from "../../src/inbound-webhooks/inbound-webhook-production-activation";
import { ProviderRuleBlockedReprocessService } from "../../src/inbound-webhooks/provider-rule-blocked-reprocess.service";
import { UazapiConversionBridgeService } from "../../src/inbound-webhooks/uazapi-conversion-bridge.service";
import { UazapiProviderConversionService } from "../../src/inbound-webhooks/uazapi-provider-conversion.service";

/**
 * "Todos os números" (porte do SaaS #152) on a real, disposable PostgreSQL 16
 * with the CURRENT schema (all migrations applied). Same opt-in as the other
 * .pg suites: NOD_META_DISPATCH_PG_OPT_IN=disposable-local-only and a
 * loopback NOD_META_DISPATCH_TEST_PG_URL whose database is
 * nod_meta_dispatch_test_*. Never reads DATABASE_URL, synthetic data only.
 *
 * Real services end to end: the QR bridge, the rules service (cascade and
 * "Ativar envio neste número"), the automatic activation (advisory lock),
 * the UAZAPI team-message path (decision, orchestrator, gates) and
 * "Reprocessar bloqueadas" (recoverDecision). Only the BullMQ queue is a
 * recorder: "envia" here means an `eligible` execution handed to the
 * production queue, exactly what the Meta sender consumes.
 */
const optedIn =
  process.env.NOD_META_DISPATCH_PG_OPT_IN === "disposable-local-only";
function disposableUrl(): string {
  const raw = process.env.NOD_META_DISPATCH_TEST_PG_URL;
  if (!raw) throw new Error("Dedicated disposable PG test URL required");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid disposable PG test URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/nod_meta_dispatch_test_[a-z0-9_]+$/.test(url.pathname) ||
    [...url.searchParams.keys()].some(
      (k) => !["schema", "connection_limit", "pool_timeout"].includes(k),
    ) ||
    (url.searchParams.get("schema") ?? "public") !== "public"
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
  INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 61).toString("base64"),
};
const day = 24 * 60 * 60 * 1_000;
const phrase = "pagamento confirmado";

describe.skipIf(!optedIn)("Todos os números on disposable PostgreSQL", () => {
  let db: PrismaClient;
  let userId: string;
  let rules: ProviderConversionRulesService;
  let bridge: UazapiConversionBridgeService;
  let uazapi: UazapiProviderConversionService;
  let reprocess: ProviderRuleBlockedReprocessService;
  const queue = { enqueueProviderConversion: vi.fn(async () => undefined) };
  let phoneSeq = 0;

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: disposableUrl() } } });
    try {
      await db.$connect();
      if ((await db.workspace.count()) || (await db.user.count()))
        throw new Error("nonempty");
    } catch {
      throw new Error(
        "Disposable DB unavailable, nonempty, or current Prisma schema missing; URL withheld",
      );
    }
    userId = (
      await db.user.create({
        data: { email: `synthetic-${randomUUID()}@example.invalid` },
      })
    ).id;
    rules = new ProviderConversionRulesService(db as never, env);
    bridge = new UazapiConversionBridgeService(db as never);
    uazapi = new UazapiProviderConversionService(
      db as never,
      env,
      bridge,
      new ProviderConversionDecisionEngine(),
      new ProviderConversionDecisionRepository(db as never),
      new ProviderConversionOrchestrator(db as never),
      new ProviderConversionPaidLeadResolver(db as never),
      queue as never,
      {} as never,
      {} as never,
    );
    reprocess = new ProviderRuleBlockedReprocessService(db as never, env, uazapi);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  beforeEach(() => {
    queue.enqueueProviderConversion.mockClear();
  });

  async function workspace(name: string) {
    const id = randomUUID();
    return (
      await db.workspace.create({ data: { name, slug: `fgr-${id}` } })
    ).id;
  }

  /** A QR number: its WhatsApp connection and the bridge (observation). */
  async function qrNumber(
    workspaceId: string,
    key: string,
    status: "active" | "suspended" = "active",
  ) {
    const instance = await db.whatsappInstance.create({
      data: {
        workspaceId,
        name: `QR ${key}`,
        provider: "uazapi_byo",
        providerInstanceId: `prov_${key}_${randomUUID().slice(0, 8)}`,
        status,
      },
    });
    const bridged = await bridge.ensureBridge({
      id: instance.id,
      workspaceId,
      name: instance.name,
      providerInstanceId: instance.providerInstanceId,
      connectedPhone: `55119${String(++phoneSeq).padStart(8, "0")}`,
    });
    return { instance, ...bridged };
  }

  /** A lead from an ad: the paid lead the phrase converts. */
  async function adLead(workspaceId: string) {
    const phone = `55219${String(++phoneSeq).padStart(8, "0")}`;
    await db.lead.create({
      data: {
        workspaceId,
        name: "Lead do anúncio",
        phoneHash: hashPhoneIdentity(phone)!,
        adId: `ad_${phoneSeq}`,
        ctwaClid: `clid_${phoneSeq}`,
      },
    });
    return phone;
  }

  async function globalRule(
    workspaceId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const result = (await rules.createRule(
      workspaceId,
      {
        name: "Frase do QR code",
        triggerType: "message_phrase",
        triggerPhrases: [phrase],
        messageAuthorScope: "team",
        eventName: "QualifiedLead",
        valueMode: "fixed",
        scope: "all_numbers",
        channelIds: [],
        mode: "production",
        ...overrides,
      } as never,
      userId,
    )) as { rule: { id: string; pendingNumbers?: unknown[] } };
    return result.rule;
  }

  async function send(
    workspaceId: string,
    number: Awaited<ReturnType<typeof qrNumber>>,
    phone: string,
    occurredAt = new Date(),
  ) {
    return uazapi.evaluateTeamMessage({
      workspaceId,
      instance: {
        id: number.instance.id,
        workspaceId,
        name: number.instance.name,
        providerInstanceId: number.instance.providerInstanceId,
      },
      phone,
      messageText: `Olá! ${phrase}, obrigado.`,
      externalMessageId: `msg_${randomUUID()}`,
      occurredAt,
    });
  }

  async function executionsOf(providerRuleId: string) {
    return db.providerConversionRuleExecution.findMany({
      where: { providerRuleId },
      orderBy: { occurredAt: "asc" },
    });
  }

  async function live(number: { connectionId: string; channelId: string }) {
    const [connection, channel] = await Promise.all([
      db.inboundWebhookConnection.findUniqueOrThrow({ where: { id: number.connectionId } }),
      db.inboundWebhookChannel.findUniqueOrThrow({ where: { id: number.channelId } }),
    ]);
    return { connection: connection.status, channel: channel.status };
  }

  it("1 número QR com regra global: a regra ativa o número e a frase envia", async () => {
    const ws = await workspace("1 número");
    const qr = await qrNumber(ws, "unico");
    const lead = await adLead(ws);

    const rule = await globalRule(ws);

    expect(rule.pendingNumbers).toEqual([]);
    expect(await live(qr)).toEqual({ connection: "production", channel: "active" });
    const result = await send(ws, qr, lead);
    expect(result.eligibleExecutionId).toBeTruthy();
    expect(queue.enqueueProviderConversion).toHaveBeenCalledWith({
      providerConversionExecutionId: result.eligibleExecutionId,
      workspaceId: ws,
    });
    expect((await executionsOf(rule.id)).map((row) => row.status)).toEqual(["eligible"]);
  });

  it("N números QR: todos passam a enviar", async () => {
    const ws = await workspace("N números");
    const numbers = [
      await qrNumber(ws, "a"),
      await qrNumber(ws, "b"),
      await qrNumber(ws, "c"),
    ];
    const rule = await globalRule(ws);

    for (const qr of numbers) {
      expect(await live(qr)).toEqual({ connection: "production", channel: "active" });
      const result = await send(ws, qr, await adLead(ws));
      expect(result.eligibleExecutionId).toBeTruthy();
    }
    expect(queue.enqueueProviderConversion).toHaveBeenCalledTimes(3);
    expect((await executionsOf(rule.id)).every((row) => row.status === "eligible")).toBe(true);
  });

  it("número conectado depois: a ativação automática o liga e a frase envia", async () => {
    const ws = await workspace("conectado depois");
    const first = await qrNumber(ws, "primeiro");
    const rule = await globalRule(ws);
    expect(await live(first)).toEqual({ connection: "production", channel: "active" });

    const later = await qrNumber(ws, "depois");
    expect(await live(later)).toEqual({ connection: "observation", channel: "discovered" });
    // The bridge wrote its durable event; the automatic activation runs.
    const auto = new GlobalRuleAutoActivationService(db as never, env, rules, {
      getLockState: async () => ({ locked: false }),
    } as never);
    const handled = await auto.tick(new Date());
    expect(handled).toContain(ws);
    expect(await live(later)).toEqual({ connection: "production", channel: "active" });
    expect(
      await db.auditLog.findFirst({
        where: {
          workspaceId: ws,
          action: "provider_conversion_rule.global_number_auto_activated",
          targetId: later.channelId,
        },
      }),
    ).toMatchObject({ actorType: "system", actorUserId: null, resultStatus: "promoted" });

    const result = await send(ws, later, await adLead(ws));
    expect(result.eligibleExecutionId).toBeTruthy();
    expect((await executionsOf(rule.id)).map((row) => row.status)).toEqual(["eligible"]);
  });

  it("específica: só os números dela enviam", async () => {
    const ws = await workspace("específica");
    const a = await qrNumber(ws, "a");
    const b = await qrNumber(ws, "b");
    const rule = await globalRule(ws, {
      scope: "specific_numbers",
      channelIds: [a.channelId],
    });

    expect(await live(a)).toEqual({ connection: "production", channel: "active" });
    expect(await live(b)).toEqual({ connection: "observation", channel: "discovered" });
    expect((await send(ws, a, await adLead(ws))).eligibleExecutionId).toBeTruthy();
    expect(await send(ws, b, await adLead(ws))).toEqual({
      evaluated: false,
      eligibleExecutionId: null,
    });
    expect(await executionsOf(rule.id)).toHaveLength(1);
  });

  it("global + específica no mesmo número: uma conversão só, pela específica", async () => {
    const ws = await workspace("global + específica");
    const a = await qrNumber(ws, "a");
    const b = await qrNumber(ws, "b");
    const specific = await globalRule(ws, {
      name: "Específica A",
      scope: "specific_numbers",
      channelIds: [a.channelId],
    });
    const global = await globalRule(ws, { name: "Global" });

    const onA = await send(ws, a, await adLead(ws));
    expect(onA.eligibleExecutionId).toBeTruthy();
    expect(queue.enqueueProviderConversion).toHaveBeenCalledTimes(1);
    expect(await executionsOf(specific.id)).toHaveLength(1);
    expect(await executionsOf(global.id)).toHaveLength(0);

    const onB = await send(ws, b, await adLead(ws));
    expect(onB.eligibleExecutionId).toBeTruthy();
    expect(await executionsOf(global.id)).toHaveLength(1);
  });

  it("incidente: conversa bloqueada antes de o número enviar é recuperada pelo Reprocessar bloqueadas, uma vez só, só nesse workspace e só dentro de 7 dias", async () => {
    const ws = await workspace("reprocessar");
    const other = await workspace("outro workspace");
    const qr = await qrNumber(ws, "incidente");
    const rule = await globalRule(ws);
    // Data of the previous version: the global rule existed in production but
    // its number had never been promoted (no promotion audit either).
    await db.inboundWebhookConnection.update({
      where: { id: qr.connectionId },
      data: { status: "observation", productionActivatedAt: null },
    });
    await db.inboundWebhookChannel.update({
      where: { id: qr.channelId },
      data: { status: "discovered", productionActivatedAt: null },
    });
    await db.auditLog.deleteMany({
      where: { workspaceId: ws, targetId: { in: [qr.connectionId, qr.channelId] } },
    });

    // Conversations arrive while the number does not send yet.
    const blocked = await send(ws, qr, await adLead(ws));
    expect(blocked.eligibleExecutionId).toBeNull();
    const old = await send(ws, qr, await adLead(ws), new Date(Date.now() - 8 * day));
    expect(old.eligibleExecutionId).toBeNull();
    expect((await executionsOf(rule.id)).map((row) => [row.status, row.reasonCode])).toEqual([
      ["blocked", "connection_not_production"],
      ["blocked", "connection_not_production"],
    ]);
    expect(queue.enqueueProviderConversion).not.toHaveBeenCalled();

    // After the update: "Ativar envio neste número".
    const activated = await rules.activateGlobalRuleNumber(ws, rule.id, qr.channelId, userId);
    expect(activated.outcome).toBe("promoted");

    await expect(reprocess.reprocess(other, rule.id, userId)).rejects.toMatchObject({
      status: 404,
    });

    const first = await reprocess.reprocess(ws, rule.id, userId);
    expect(first).toMatchObject({ reprocessed: 1, expired: 1, stillBlocked: 0 });
    expect(queue.enqueueProviderConversion).toHaveBeenCalledTimes(1);
    const rows = await executionsOf(rule.id);
    expect(rows.map((row) => row.status)).toEqual(["blocked", "eligible"]);

    // Idempotent: a later run sends nothing again.
    const again = await reprocess.reprocess(
      ws,
      rule.id,
      userId,
      new Date(Date.now() + 60_000),
    );
    expect(again).toMatchObject({ reprocessed: 0, expired: 1 });
    expect(queue.enqueueProviderConversion).toHaveBeenCalledTimes(1);
  });

  it("conexão ou canal pausados pelo operador continuam bloqueando, e o Reprocessar não reenvia o período da pausa", async () => {
    const ws = await workspace("pausados");
    const pausedConnection = await qrNumber(ws, "conexao-pausada");
    const pausedChannel = await qrNumber(ws, "canal-pausado");
    await db.$transaction((tx) =>
      applyInboundWebhookConnectionStatus(tx, {
        workspaceId: ws,
        connectionId: pausedConnection.connectionId,
        status: "paused",
        actorUserId: userId,
        requireValidMetaRoute: false,
        seats: { enforcementEnabled: () => false, activateSeat: async () => null },
      }),
    );
    await db.$transaction((tx) =>
      applyInboundWebhookChannelStatus(tx, {
        workspaceId: ws,
        channelId: pausedChannel.channelId,
        status: "paused",
        actorUserId: userId,
        requireValidMetaRoute: false,
        seats: { enforcementEnabled: () => false, activateSeat: async () => null },
      }),
    );

    const rule = await globalRule(ws);
    expect(await live(pausedConnection)).toEqual({ connection: "paused", channel: "discovered" });
    expect((await live(pausedChannel)).channel).toBe("paused");
    // Neither the automatic activation touches them.
    const auto = new GlobalRuleAutoActivationService(db as never, env, rules, undefined);
    await auto.tick(new Date());
    expect((await live(pausedConnection)).connection).toBe("paused");
    expect((await live(pausedChannel)).channel).toBe("paused");

    // Conversations during the pause: blocked.
    expect((await send(ws, pausedConnection, await adLead(ws))).eligibleExecutionId).toBeNull();
    expect((await send(ws, pausedChannel, await adLead(ws))).eligibleExecutionId).toBeNull();
    expect(queue.enqueueProviderConversion).not.toHaveBeenCalled();

    // The operator resumes both in Integrações.
    await db.$transaction(async (tx) => {
      await applyInboundWebhookChannelStatus(tx, {
        workspaceId: ws,
        channelId: pausedConnection.channelId,
        status: "active",
        actorUserId: userId,
        requireValidMetaRoute: false,
        seats: { enforcementEnabled: () => false, activateSeat: async () => null },
      });
      await applyInboundWebhookConnectionStatus(tx, {
        workspaceId: ws,
        connectionId: pausedConnection.connectionId,
        status: "production",
        actorUserId: userId,
        requireValidMetaRoute: false,
        seats: { enforcementEnabled: () => false, activateSeat: async () => null },
        env,
      });
    });
    const resumed = await rules.activateGlobalRuleNumber(ws, rule.id, pausedChannel.channelId, userId);
    expect(resumed.outcome).toBe("promoted");

    const result = await reprocess.reprocess(ws, rule.id, userId);
    expect(result).toMatchObject({ reprocessed: 0, stillBlocked: 2 });
    expect(queue.enqueueProviderConversion).not.toHaveBeenCalled();

    // New conversations after the resume send normally.
    expect((await send(ws, pausedConnection, await adLead(ws))).eligibleExecutionId).toBeTruthy();
    expect((await send(ws, pausedChannel, await adLead(ws))).eligibleExecutionId).toBeTruthy();
  });

  it("conexão WhatsApp suspensa em Integrações fica fora da regra e volta a enviar ao ser reativada", async () => {
    const ws = await workspace("suspensa");
    const qr = await qrNumber(ws, "suspensa", "suspended");
    const rule = await globalRule(ws);
    expect(rule.pendingNumbers).toEqual([]);
    expect(await live(qr)).toEqual({ connection: "observation", channel: "discovered" });

    await db.whatsappInstance.update({ where: { id: qr.instance.id }, data: { status: "active" } });
    const auto = new GlobalRuleAutoActivationService(db as never, env, rules, undefined);
    await auto.tick(new Date()); // first pass of an instance is a reconciliation
    expect(await live(qr)).toEqual({ connection: "production", channel: "active" });
    expect((await send(ws, qr, await adLead(ws))).eligibleExecutionId).toBeTruthy();
  });

  it("o índice novo existe e o painel conta as bloqueadas pela regra", async () => {
    const indexes = await db.$queryRaw<Array<{ indexname: string }>>`
      SELECT c.relname AS indexname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = 'ProviderConversionRuleExecution_rule_status_occurredAt_idx'
        AND i.indisvalid AND i.indisready`;
    expect(indexes).toHaveLength(1);
  });
});
