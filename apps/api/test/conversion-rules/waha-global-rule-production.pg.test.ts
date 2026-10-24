import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
 * Regras de frase da equipe numa conexão WAHA (GoWS) com "Todos os números"
 * e regras específicas, num PostgreSQL 16 descartável com o schema ATUAL
 * (todas as migrations). Mesmo opt-in das outras suítes .pg:
 * NOD_META_DISPATCH_PG_OPT_IN=disposable-local-only e uma
 * NOD_META_DISPATCH_TEST_PG_URL em loopback cujo banco é
 * nod_meta_dispatch_test_*. Nunca lê DATABASE_URL; só dados sintéticos.
 *
 * Serviços reais de ponta a ponta: a ponte WAHA (provedor "waha", release
 * waha/v2 da migration), o serviço de regras (cascata e "Ativar envio neste
 * número"), a ativação automática (lock consultivo), o caminho da mensagem
 * do time (decisão, orquestrador, portões) e o "Reprocessar bloqueadas". Só a
 * fila BullMQ é um gravador: "envia" aqui é uma execução `eligible` entregue
 * à fila de produção, exatamente o que o envio à Meta consome.
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

type Example = {
  id: string;
  phrase: string | null;
  text: string | null;
  eventName: string | null;
  contactPhoneFormat: string;
};
const examples = (
  JSON.parse(
    readFileSync(
      resolve(__dirname, "../fixtures/waha-gows/team-phrase-examples.json"),
      "utf8",
    ),
  ) as { examples: Example[] }
).examples;

describe.skipIf(!optedIn)("WAHA: regras de frase da equipe no PostgreSQL descartável", () => {
  let db: PrismaClient;
  let userId: string;
  let rules: ProviderConversionRulesService;
  let bridge: UazapiConversionBridgeService;
  let teamMessages: UazapiProviderConversionService;
  let reprocess: ProviderRuleBlockedReprocessService;
  const queue = { enqueueProviderConversion: vi.fn(async () => undefined) };
  let seq = 0;

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
    teamMessages = new UazapiProviderConversionService(
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
    reprocess = new ProviderRuleBlockedReprocessService(
      db as never,
      env,
      teamMessages,
    );
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
      await db.workspace.create({ data: { name, slug: `wgr-${id}` } })
    ).id;
  }

  /** A WAHA connection (WhatsappInstance "waha") and its bridge. */
  async function wahaNumber(
    workspaceId: string,
    key: string,
    status: "active" | "suspended" = "active",
  ) {
    const instance = await db.whatsappInstance.create({
      data: {
        workspaceId,
        name: `WAHA ${key}`,
        provider: "waha",
        providerInstanceId: `sessao-${key}-${randomUUID().slice(0, 8)}`,
        status,
      },
    });
    const bridged = await bridge.ensureBridge(
      {
        id: instance.id,
        workspaceId,
        name: instance.name,
        providerInstanceId: instance.providerInstanceId,
      },
      "waha",
    );
    return { instance, ...bridged };
  }

  /** A Uazapi number (regression): same bridge, provider "uazapi". */
  async function uazapiNumber(workspaceId: string, key: string) {
    const instance = await db.whatsappInstance.create({
      data: {
        workspaceId,
        name: `Uazapi ${key}`,
        provider: "uazapi_byo",
        providerInstanceId: `prov_${key}_${randomUUID().slice(0, 8)}`,
        status: "active",
      },
    });
    const bridged = await bridge.ensureBridge({
      id: instance.id,
      workspaceId,
      name: instance.name,
      providerInstanceId: instance.providerInstanceId,
      connectedPhone: `55119${String(++seq).padStart(8, "0")}`,
    });
    return { instance, ...bridged };
  }

  /** A lead from an ad (13 digits, with the 9th digit). */
  async function adLead(workspaceId: string, phone?: string) {
    const value = phone ?? `55219${String(++seq).padStart(8, "0")}`;
    await db.lead.create({
      data: {
        workspaceId,
        name: "Lead do anúncio",
        phoneHash: hashPhoneIdentity(value)!,
        adId: `ad_${++seq}`,
        ctwaClid: `clid_${seq}`,
      },
    });
    return value;
  }

  async function createRule(
    workspaceId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const result = (await rules.createRule(
      workspaceId,
      {
        name: "Frase da WAHA",
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
    number: { instance: { id: string; name: string; providerInstanceId: string | null } },
    phone: string,
    options: {
      provider?: "waha" | "uazapi";
      occurredAt?: Date;
      text?: string;
      messageId?: string;
    } = {},
  ) {
    return teamMessages.evaluateTeamMessage({
      workspaceId,
      provider: options.provider ?? "waha",
      instance: {
        id: number.instance.id,
        workspaceId,
        name: number.instance.name,
        providerInstanceId: number.instance.providerInstanceId,
      },
      phone,
      messageText: options.text ?? `Olá! ${phrase}, obrigado.`,
      externalMessageId:
        options.messageId ?? `true_${phone}@c.us_3EB0${randomUUID()}`,
      occurredAt: options.occurredAt ?? new Date(),
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

  it("a ponte da WAHA é uma conexão \"waha\" na release waha/v2 certificada, com evento durável", async () => {
    const ws = await workspace("ponte");
    const waha = await wahaNumber(ws, "ponte");
    const connection = await db.inboundWebhookConnection.findUniqueOrThrow({
      where: { id: waha.connectionId },
      include: { parserRelease: true },
    });
    expect(connection).toMatchObject({ provider: "waha", status: "observation" });
    expect(connection.parserRelease).toMatchObject({
      provider: "waha",
      version: "v2",
      status: "certified",
    });
    expect(
      await db.auditLog.count({
        where: {
          workspaceId: ws,
          action: "inbound_webhook.waha_bridge_provisioned",
          targetId: waha.channelId,
        },
      }),
    ).toBe(1);
    // Idempotent; the store's real number replaces the session placeholder.
    const again = await bridge.ensureBridge(
      {
        id: waha.instance.id,
        workspaceId: ws,
        name: waha.instance.name,
        providerInstanceId: waha.instance.providerInstanceId,
        connectedPhone: "5500900009999",
      },
      "waha",
    );
    expect(again).toEqual({ connectionId: waha.connectionId, channelId: waha.channelId });
    expect(
      (await db.inboundWebhookChannel.findUniqueOrThrow({ where: { id: waha.channelId } }))
        .connectedPhone,
    ).toBe("5500900009999");
  });

  it("1 número WAHA com regra global: a regra ativa o número e a frase do time envia", async () => {
    const ws = await workspace("1 número");
    const waha = await wahaNumber(ws, "unico");
    const lead = await adLead(ws);

    const rule = await createRule(ws);

    expect(rule.pendingNumbers).toEqual([]);
    expect(await live(waha)).toEqual({ connection: "production", channel: "active" });
    const result = await send(ws, waha, lead);
    expect(result.eligibleExecutionId).toBeTruthy();
    expect(queue.enqueueProviderConversion).toHaveBeenCalledWith({
      providerConversionExecutionId: result.eligibleExecutionId,
      workspaceId: ws,
    });
    const rows = await executionsOf(rule.id);
    expect(rows.map((row) => row.status)).toEqual(["eligible"]);
    const decision = await db.providerConversionDecisionAudit.findFirstOrThrow({
      where: { providerRuleId: rule.id },
    });
    expect(decision.occurrenceKey).toMatch(new RegExp(`^waha:${waha.channelId}:`, "u"));
  });

  it("N números WAHA: todos passam a enviar", async () => {
    const ws = await workspace("N números");
    const numbers = [
      await wahaNumber(ws, "a"),
      await wahaNumber(ws, "b"),
      await wahaNumber(ws, "c"),
    ];
    const rule = await createRule(ws);

    for (const waha of numbers) {
      expect(await live(waha)).toEqual({ connection: "production", channel: "active" });
      expect((await send(ws, waha, await adLead(ws))).eligibleExecutionId).toBeTruthy();
    }
    expect(queue.enqueueProviderConversion).toHaveBeenCalledTimes(3);
    expect((await executionsOf(rule.id)).every((row) => row.status === "eligible")).toBe(true);
  });

  it("número WAHA conectado depois: a ativação automática o liga e a frase envia", async () => {
    const ws = await workspace("conectado depois");
    const first = await wahaNumber(ws, "primeiro");
    const rule = await createRule(ws);
    expect(await live(first)).toEqual({ connection: "production", channel: "active" });

    const later = await wahaNumber(ws, "depois");
    expect(await live(later)).toEqual({ connection: "observation", channel: "discovered" });
    const auto = new GlobalRuleAutoActivationService(db as never, env, rules, {
      getLockState: async () => ({ locked: false }),
    } as never);
    const handled = await auto.tick(new Date());
    expect(handled).toContain(ws);
    expect(await live(later)).toEqual({ connection: "production", channel: "active" });

    expect((await send(ws, later, await adLead(ws))).eligibleExecutionId).toBeTruthy();
    expect((await executionsOf(rule.id)).map((row) => row.status)).toEqual(["eligible"]);
  });

  it("específica: só o número WAHA dela envia", async () => {
    const ws = await workspace("específica");
    const a = await wahaNumber(ws, "a");
    const b = await wahaNumber(ws, "b");
    const rule = await createRule(ws, {
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

  it("global + específica no mesmo número WAHA: uma conversão só, pela específica", async () => {
    const ws = await workspace("global + específica");
    const a = await wahaNumber(ws, "a");
    const b = await wahaNumber(ws, "b");
    const specific = await createRule(ws, {
      name: "Específica A",
      scope: "specific_numbers",
      channelIds: [a.channelId],
    });
    const global = await createRule(ws, { name: "Global" });

    expect((await send(ws, a, await adLead(ws))).eligibleExecutionId).toBeTruthy();
    expect(queue.enqueueProviderConversion).toHaveBeenCalledTimes(1);
    expect(await executionsOf(specific.id)).toHaveLength(1);
    expect(await executionsOf(global.id)).toHaveLength(0);

    expect((await send(ws, b, await adLead(ws))).eligibleExecutionId).toBeTruthy();
    expect(await executionsOf(global.id)).toHaveLength(1);
  });

  it("a mesma mensagem reentregue nunca gera duas execuções", async () => {
    const ws = await workspace("sem duplicar");
    const waha = await wahaNumber(ws, "dup");
    const rule = await createRule(ws);
    const lead = await adLead(ws);
    const messageId = `true_${lead}@c.us_3EB0DUPLICADA`;

    const first = await send(ws, waha, lead, { messageId });
    const second = await send(ws, waha, lead, { messageId });

    expect(first.eligibleExecutionId).toBeTruthy();
    expect(second.eligibleExecutionId ?? first.eligibleExecutionId).toBe(
      first.eligibleExecutionId,
    );
    expect(await executionsOf(rule.id)).toHaveLength(1);
    expect(
      await db.providerConversionDecisionAudit.count({ where: { providerRuleId: rule.id } }),
    ).toBe(1);
  });

  it("telefone do contato com 12 dígitos (sem o nono) acha o lead de 13", async () => {
    const ws = await workspace("nono dígito");
    const waha = await wahaNumber(ws, "nono");
    const rule = await createRule(ws);
    await adLead(ws, "5511987650001");

    const result = await send(ws, waha, "551187650001");

    expect(result.eligibleExecutionId).toBeTruthy();
    expect((await executionsOf(rule.id)).map((row) => row.status)).toEqual(["eligible"]);
  });

  it("sem lead pago: mesmo comportamento da Uazapi (nada vai para a fila)", async () => {
    const ws = await workspace("sem lead");
    const waha = await wahaNumber(ws, "sem-lead");
    const rule = await createRule(ws);

    const result = await send(ws, waha, "5511900000999");

    expect(result.eligibleExecutionId).toBeNull();
    expect(queue.enqueueProviderConversion).not.toHaveBeenCalled();
    expect((await executionsOf(rule.id)).every((row) => row.status !== "eligible")).toBe(true);
  });

  it("texto sem a frase não gera execução", async () => {
    const ws = await workspace("sem frase");
    const waha = await wahaNumber(ws, "sem-frase");
    const rule = await createRule(ws);

    const result = await send(ws, waha, await adLead(ws), {
      text: "Oi! Já já te mando o link.",
    });

    expect(result).toEqual({ evaluated: false, eligibleExecutionId: null });
    expect(await executionsOf(rule.id)).toHaveLength(0);
  });

  it("textos reais anonimizados: a frase de cada exemplo casa e envia", async () => {
    const withPhrase = examples.filter(
      (example) =>
        example.phrase &&
        example.text &&
        example.contactPhoneFormat !== "lid_nao_resolvido",
    );
    expect(withPhrase.length).toBeGreaterThan(20);
    for (const example of withPhrase) {
      const ws = await workspace(`exemplo ${example.id}`);
      const waha = await wahaNumber(ws, example.id);
      const rule = await createRule(ws, {
        name: `Exemplo ${example.id}`,
        triggerPhrases: [example.phrase],
      });
      const result = await send(ws, waha, await adLead(ws), {
        text: `Oi! 😊\n${example.text}\nhttps://exemplo.invalid/x`,
      });
      expect(result.eligibleExecutionId, example.id).toBeTruthy();
      expect(await executionsOf(rule.id), example.id).toHaveLength(1);
    }
  });

  it("Reprocessar bloqueadas recupera a conversa da WAHA bloqueada antes de o número enviar, uma vez só e dentro de 7 dias", async () => {
    const ws = await workspace("reprocessar");
    const waha = await wahaNumber(ws, "incidente");
    const rule = await createRule(ws);
    await db.inboundWebhookConnection.update({
      where: { id: waha.connectionId },
      data: { status: "observation", productionActivatedAt: null },
    });
    await db.inboundWebhookChannel.update({
      where: { id: waha.channelId },
      data: { status: "discovered", productionActivatedAt: null },
    });
    await db.auditLog.deleteMany({
      where: { workspaceId: ws, targetId: { in: [waha.connectionId, waha.channelId] } },
    });

    expect((await send(ws, waha, await adLead(ws))).eligibleExecutionId).toBeNull();
    expect(
      (await send(ws, waha, await adLead(ws), { occurredAt: new Date(Date.now() - 8 * day) }))
        .eligibleExecutionId,
    ).toBeNull();
    expect((await executionsOf(rule.id)).map((row) => [row.status, row.reasonCode])).toEqual([
      ["blocked", "connection_not_production"],
      ["blocked", "connection_not_production"],
    ]);

    const activated = await rules.activateGlobalRuleNumber(ws, rule.id, waha.channelId, userId);
    expect(activated.outcome).toBe("promoted");

    const first = await reprocess.reprocess(ws, rule.id, userId);
    expect(first).toMatchObject({ reprocessed: 1, expired: 1, stillBlocked: 0 });
    expect(queue.enqueueProviderConversion).toHaveBeenCalledTimes(1);

    const again = await reprocess.reprocess(
      ws,
      rule.id,
      userId,
      new Date(Date.now() + 60_000),
    );
    expect(again).toMatchObject({ reprocessed: 0, expired: 1 });
    expect(queue.enqueueProviderConversion).toHaveBeenCalledTimes(1);
  });

  it("conexão WAHA pausada pelo operador continua bloqueando; a ativação automática não a retoma", async () => {
    const ws = await workspace("pausada");
    const paused = await wahaNumber(ws, "pausada");
    await db.$transaction((tx) =>
      applyInboundWebhookConnectionStatus(tx, {
        workspaceId: ws,
        connectionId: paused.connectionId,
        status: "paused",
        actorUserId: userId,
        requireValidMetaRoute: false,
        seats: { enforcementEnabled: () => false, activateSeat: async () => null },
      }),
    );
    const rule = await createRule(ws);
    expect((await live(paused)).connection).toBe("paused");
    await new GlobalRuleAutoActivationService(db as never, env, rules, undefined).tick(new Date());
    expect((await live(paused)).connection).toBe("paused");
    expect((await send(ws, paused, await adLead(ws))).eligibleExecutionId).toBeNull();
    expect(queue.enqueueProviderConversion).not.toHaveBeenCalled();

    await db.$transaction(async (tx) => {
      await applyInboundWebhookChannelStatus(tx, {
        workspaceId: ws,
        channelId: paused.channelId,
        status: "active",
        actorUserId: userId,
        requireValidMetaRoute: false,
        seats: { enforcementEnabled: () => false, activateSeat: async () => null },
      });
      await applyInboundWebhookConnectionStatus(tx, {
        workspaceId: ws,
        connectionId: paused.connectionId,
        status: "production",
        actorUserId: userId,
        requireValidMetaRoute: false,
        seats: { enforcementEnabled: () => false, activateSeat: async () => null },
        env,
      });
    });
    const result = await reprocess.reprocess(ws, rule.id, userId);
    expect(result).toMatchObject({ reprocessed: 0, stillBlocked: 1 });
    expect((await send(ws, paused, await adLead(ws))).eligibleExecutionId).toBeTruthy();
  });

  it("conexão WAHA suspensa em Integrações fica fora da regra e volta a enviar ao ser reativada", async () => {
    const ws = await workspace("suspensa");
    const waha = await wahaNumber(ws, "suspensa", "suspended");
    const rule = await createRule(ws);
    expect(rule.pendingNumbers).toEqual([]);
    expect(await live(waha)).toEqual({ connection: "observation", channel: "discovered" });

    await db.whatsappInstance.update({ where: { id: waha.instance.id }, data: { status: "active" } });
    await new GlobalRuleAutoActivationService(db as never, env, rules, undefined).tick(new Date());
    expect(await live(waha)).toEqual({ connection: "production", channel: "active" });
    expect((await send(ws, waha, await adLead(ws))).eligibleExecutionId).toBeTruthy();
  });

  async function samePhonePair(ws: string, live: "uazapi" | "waha") {
    const phone = `55119${String(++seq).padStart(8, "0")}`;
    const instance = await db.whatsappInstance.create({
      data: {
        workspaceId: ws,
        name: "Uazapi antiga",
        provider: "uazapi_byo",
        providerInstanceId: `prov_${randomUUID().slice(0, 8)}`,
        status: "active",
      },
    });
    const uazapi = {
      instance,
      ...(await bridge.ensureBridge({
        id: instance.id,
        workspaceId: ws,
        name: instance.name,
        providerInstanceId: instance.providerInstanceId,
        connectedPhone: phone,
      })),
    };
    const waha = await wahaNumber(ws, `mesmo-${seq}`);
    await bridge.ensureBridge(
      {
        id: waha.instance.id,
        workspaceId: ws,
        name: waha.instance.name,
        providerInstanceId: waha.instance.providerInstanceId,
        connectedPhone: phone,
      },
      "waha",
    );
    const stale = new Date(Date.now() - 2 * day);
    const fresh = new Date();
    // The Uazapi channel is the older one (it would win on age alone).
    await db.inboundWebhookChannel.update({
      where: { id: uazapi.channelId },
      data: {
        createdAt: new Date(Date.now() - 90 * day),
        lastSeenAt: live === "uazapi" ? fresh : stale,
      },
    });
    await db.inboundWebhookChannel.update({
      where: { id: waha.channelId },
      data: { lastSeenAt: live === "waha" ? fresh : stale },
    });
    return { uazapi, waha };
  }

  it("número migrado da Uazapi (parada, ainda ativa) para a WAHA: a regra global roda na WAHA", async () => {
    const ws = await workspace("mesmo telefone, WAHA viva");
    const { uazapi, waha } = await samePhonePair(ws, "waha");
    const rule = await createRule(ws);

    expect((await send(ws, waha, await adLead(ws))).eligibleExecutionId).toBeTruthy();
    expect(
      (await send(ws, uazapi, await adLead(ws), { provider: "uazapi" })).eligibleExecutionId,
    ).toBeNull();
    expect((await executionsOf(rule.id)).map((row) => row.channelId)).toEqual([
      waha.channelId,
    ]);
  });

  it("o inverso: WAHA parada e Uazapi viva, a regra global roda na Uazapi", async () => {
    const ws = await workspace("mesmo telefone, Uazapi viva");
    const { uazapi, waha } = await samePhonePair(ws, "uazapi");
    const rule = await createRule(ws);

    expect(
      (await send(ws, uazapi, await adLead(ws), { provider: "uazapi" })).eligibleExecutionId,
    ).toBeTruthy();
    expect((await send(ws, waha, await adLead(ws))).eligibleExecutionId).toBeNull();
    expect((await executionsOf(rule.id)).map((row) => row.channelId)).toEqual([
      uazapi.channelId,
    ]);
  });

  it("regressão: Uazapi e WAHA no mesmo workspace, uma regra global, cada uma envia a sua", async () => {
    const ws = await workspace("uazapi + waha");
    const uazapi = await uazapiNumber(ws, "u");
    const waha = await wahaNumber(ws, "w");
    const rule = await createRule(ws);

    expect(await live(uazapi)).toEqual({ connection: "production", channel: "active" });
    expect(await live(waha)).toEqual({ connection: "production", channel: "active" });
    expect(
      (await send(ws, uazapi, await adLead(ws), { provider: "uazapi" })).eligibleExecutionId,
    ).toBeTruthy();
    expect((await send(ws, waha, await adLead(ws))).eligibleExecutionId).toBeTruthy();

    const keys = (
      await db.providerConversionDecisionAudit.findMany({
        where: { providerRuleId: rule.id },
        select: { occurrenceKey: true },
      })
    ).map((row) => row.occurrenceKey.split(":")[0]);
    expect(keys.sort()).toEqual(["uazapi", "waha"]);
    expect(queue.enqueueProviderConversion).toHaveBeenCalledTimes(2);
  });
});
