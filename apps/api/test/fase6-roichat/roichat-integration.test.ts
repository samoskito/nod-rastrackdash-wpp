import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ProviderConversionDecisionInput } from "../../src/conversion-rules/provider-conversion-decision.types";
import { roichatPurchaseDedupePolicy } from "../../src/conversion-rules/roichat-purchase-dedupe";
import { isLeadLifetimeEvent } from "../../src/conversion-events/lead-lifetime-conversion-guard";
import { InboundConversionAutomationIngestionService } from "../../src/inbound-webhooks/inbound-conversion-automation-ingestion.service";
import { InboundWebhookIngestionService } from "../../src/inbound-webhooks/inbound-webhook-ingestion.service";
import { InboundWebhookPayloadEncryptionService } from "../../src/inbound-webhooks/inbound-webhook-payload-encryption.service";
import { InboundWebhookConnectionsService } from "../../src/inbound-webhooks/inbound-webhook-connections.service";
import { RoichatPurchaseIngressService } from "../../src/inbound-webhooks/roichat-purchase-ingress.service";
import { providerRuleOrigin } from "../../src/conversion-rules/provider-rule-scope";
import type { PrismaService } from "../../src/common/prisma/prisma.service";

/**
 * Fase 6.8 (porte do #183): ROI Chat, uma URL por número recebe a entrada e a
 * compra. No nod não há gate de integração privada nem vagas pagas: o card e
 * a URL existem para todo workspace (licença bloqueada = 423 nas escritas,
 * coberto em roichat-license-lock.http.test.ts) e a conexão nasce em
 * produção (produção direta). Dados fictícios: telefones +55 47 9999-0000 /
 * +55 11 9000-0001.
 */

const WORKSPACE = "workspace_roichat_ficticio";
const secret = "roichat-connection-secret-ficticio";
const secretHash = createHash("sha256").update(secret).digest("hex");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(__dirname, "../fixtures/roichat", name), "utf8"),
  ) as Record<string, unknown>;
}

function env() {
  return {
    NODE_ENV: "test",
    API_PUBLIC_URL: "http://localhost:3333",
    INBOUND_WEBHOOKS_ENABLED: "true",
    INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
    INBOUND_CONVERSION_RULES_ENABLED: "true",
    INBOUND_CONVERSION_PRODUCTION_ENABLED: "false",
    INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 41).toString("base64"),
  };
}


// ---------------------------------------------------------------------------
// Dedupe: recompra permitida, mesma compra em 12h = duplicata, trava #153
// ---------------------------------------------------------------------------

function decisionInput(overrides: {
  provider?: string;
  valueCents?: number;
  currency?: "BRL" | "USD";
  channelId?: string;
}): ProviderConversionDecisionInput {
  return {
    parserVersion: "automation-v1",
    rule: { eventName: "Purchase" } as never,
    catalog: null,
    leadResolution: {
      status: "resolved",
      reasonCode: "paid_lead_resolved",
      lead: {
        id: "lead_ficticio",
        phoneHash: "hash",
        campaignId: null,
        adSetId: null,
        adId: "120200000000000001",
        ctwaClid: "AfjX-clique-ficticio-0001",
      },
    } as never,
    contactIdentityHash: "hash",
    occurrence: {
      source: "automation",
      provider: overrides.provider ?? "roichat",
      workspaceId: WORKSPACE,
      connectionId: "connection_a",
      channelId: overrides.channelId ?? "channel_a",
      externalDeliveryId: "delivery",
      externalEventId: "event",
      externalMessageId: null,
      occurrenceKey: "occurrence",
      eventName: "Purchase",
      occurredAt: "2026-10-25T15:00:00.000Z",
      authorType: null,
      automation: "purchase",
      observedValueCents: overrides.valueCents ?? 2_000,
      observedCurrency: overrides.currency ?? "BRL",
    } as never,
  };
}

describe("ROI Chat — deduplicação da compra", () => {
  it("dedupes only the same lead, number, value and currency within 12 hours", () => {
    const first = roichatPurchaseDedupePolicy(decisionInput({}));
    expect(first).toEqual({
      mode: "rolling_window",
      scopeKey: expect.stringContaining("value:2000:currency:BRL"),
      windowSeconds: 12 * 60 * 60,
    });
    // Same purchase again (resend) -> same scope (production marks duplicate).
    expect(roichatPurchaseDedupePolicy(decisionInput({}))?.scopeKey).toBe(
      first?.scopeKey,
    );
  });

  it("allows a repurchase with another value, another currency or on another number", () => {
    const first = roichatPurchaseDedupePolicy(decisionInput({}))!.scopeKey;
    expect(roichatPurchaseDedupePolicy(decisionInput({ valueCents: 4_000 }))!.scopeKey).not.toBe(first);
    expect(roichatPurchaseDedupePolicy(decisionInput({ currency: "USD" }))!.scopeKey).not.toBe(first);
    expect(roichatPurchaseDedupePolicy(decisionInput({ channelId: "channel_b" }))!.scopeKey).not.toBe(first);
  });

  it("does not change the other providers (Unnichat keeps its 24h policy)", () => {
    expect(roichatPurchaseDedupePolicy(decisionInput({ provider: "unnichat" }))).toBeNull();
  });

  it("the once-per-lead-per-pixel guard (#153) never covers Purchase", () => {
    expect(isLeadLifetimeEvent("Purchase")).toBe(false);
    expect(isLeadLifetimeEvent("LeadSubmitted")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// URL do numero: workspace liberado, compra x entrada
// ---------------------------------------------------------------------------

function numberUrlHarness(options: { purchaseHandled?: boolean } = {}) {
  const deliveries: Array<Record<string, any>> = [];
  const connection = {
    id: "connection_a",
    workspaceId: WORKSPACE,
    provider: "roichat",
    displayName: "ROI Chat comercial",
    parserReleaseId: "inbound_parser_roichat_v1",
    secretHash,
    status: "production",
    removedAt: null,
    parserRelease: { id: "inbound_parser_roichat_v1", provider: "roichat", version: "v1", status: "certified" },
  };
  const prisma = {
    inboundWebhookConnection: {
      findUnique: vi.fn(async () => connection),
      findFirst: vi.fn(async () => ({ id: connection.id })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    inboundWebhookDelivery: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }) => {
        deliveries.push(data);
        return data;
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: vi.fn(async (operation: (client: unknown) => unknown) =>
      operation(prisma),
    ),
  };
  const runtime = env();
  const handler = {
    ingestPurchase: vi.fn(async () =>
      options.purchaseHandled === false
        ? null
        : {
            status: "accepted" as const,
            deliveryId: "automation_delivery_1",
            duplicate: false,
            observationStatus: "observed",
            providerRuleId: "rule_a",
          },
    ),
  };
  const service = new InboundWebhookIngestionService(
    prisma as unknown as PrismaService,
    runtime,
    new InboundWebhookPayloadEncryptionService(runtime),
    { enqueueDelivery: vi.fn(async () => ({ jobId: "job", status: "queued" })) } as never,
    handler,
  );
  const ingest = (body: unknown) =>
    service.ingest({
      connectionId: connection.id,
      token: secret,
      contentType: "application/json",
      providerAttempt: undefined,
      rawBody: Buffer.from(JSON.stringify(body)),
    });
  return { deliveries, handler, ingest, prisma };
}

describe("ROI Chat — URL do número", () => {
  it("hands a purchase to the rule pipeline instead of storing it as an entry", async () => {
    const harness = numberUrlHarness();
    const result = await harness.ingest(fixture("purchase.synthetic.json"));
    expect(result).toMatchObject({ deliveryId: "automation_delivery_1", duplicate: false });
    expect(harness.handler.ingestPurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: { id: "connection_a", workspaceId: WORKSPACE },
      }),
    );
    expect(harness.deliveries).toHaveLength(0);
  });

  it("stores an entry (and an unrouted purchase) as a delivery of the number", async () => {
    const harness = numberUrlHarness({ purchaseHandled: false });
    await harness.ingest(fixture("entry.synthetic.json"));
    await harness.ingest(fixture("purchase.synthetic.json"));
    expect(harness.deliveries).toHaveLength(2);
    expect(harness.deliveries.every((delivery) => delivery.connectionId === "connection_a")).toBe(true);
    // The payload is stored encrypted only.
    expect(JSON.stringify(harness.deliveries)).not.toContain("47999990000");
  });
});

// ---------------------------------------------------------------------------
// Roteamento: a URL de um numero nunca atribui a outro
// ---------------------------------------------------------------------------

function ruleRow(input: {
  id: string;
  connectionId: string;
  channelIds: string[];
  scope?: "specific_numbers" | "all_numbers";
  crossConnectionScope?: boolean;
  createdAt?: Date;
}) {
  return {
    id: input.id,
    scope: input.scope ?? "specific_numbers",
    crossConnectionScope: input.crossConnectionScope ?? null,
    connectionId: input.connectionId,
    removedAt: null,
    createdAt: input.createdAt ?? new Date("2026-10-25T10:00:00.000Z"),
    productFilterCodes: [],
    conversionRule: { triggerType: "provider_automation", eventName: "Purchase", active: true },
    parserRelease: { provider: "roichat" },
    connection: { provider: "roichat" },
    channels: input.channelIds.map((channelId) => ({ channelId })),
  };
}

function routerHarness(rules: ReturnType<typeof ruleRow>[]) {
  const channels = [
    { id: "channel_a", connectionId: "connection_a", connectedPhone: "+5511900000001" },
    { id: "channel_b", connectionId: "connection_b", connectedPhone: "+5511900000002" },
  ].map((channel) => ({
    ...channel,
    status: "active",
    createdAt: new Date("2026-10-25T09:00:00.000Z"),
    connection: { provider: "roichat" },
    whatsappSeats: [],
    whatsappInstance: null,
  }));
  const prisma = {
    inboundWebhookChannel: { findMany: vi.fn(async () => channels) },
    providerConversionRuleConfig: { findMany: vi.fn(async () => rules) },
  };
  const automation = {
    ingestFromConnection: vi.fn(async () => ({
      status: "accepted" as const,
      deliveryId: "automation_delivery_1",
      duplicate: false,
      observationStatus: "observed" as const,
    })),
  };
  const service = new RoichatPurchaseIngressService(
    prisma as unknown as PrismaService,
    automation as never,
  );
  const route = (connectionId: string) =>
    service.ingestPurchase({
      connection: { id: connectionId, workspaceId: WORKSPACE },
      rawBody: Buffer.from(JSON.stringify(fixture("purchase.synthetic.json"))),
      providerAttempt: null,
    });
  return { automation, route };
}

describe("ROI Chat — roteamento da compra pelo número da URL", () => {
  it("routes number A's purchase to A's rule with A as the origin, never to B", async () => {
    const harness = routerHarness([
      ruleRow({ id: "rule_b", connectionId: "connection_b", channelIds: ["channel_b"] }),
      ruleRow({ id: "rule_a", connectionId: "connection_a", channelIds: ["channel_a"] }),
    ]);
    const result = await harness.route("connection_a");
    expect(result?.providerRuleId).toBe("rule_a");
    expect(harness.automation.ingestFromConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        providerRuleId: "rule_a",
        origin: { connectionId: "connection_a", channelId: "channel_a" },
      }),
    );
  });

  it("does not attribute number B's purchase to the rule of number A", async () => {
    const harness = routerHarness([
      ruleRow({ id: "rule_a", connectionId: "connection_a", channelIds: ["channel_a"] }),
    ]);
    expect(await harness.route("connection_b")).toBeNull();
    expect(harness.automation.ingestFromConnection).not.toHaveBeenCalled();
  });

  it("a rule for every ROI Chat number takes B's purchase with B as the origin", async () => {
    const harness = routerHarness([
      ruleRow({
        id: "rule_all",
        connectionId: "connection_a",
        channelIds: [],
        scope: "all_numbers",
        crossConnectionScope: true,
      }),
    ]);
    const result = await harness.route("connection_b");
    expect(result?.providerRuleId).toBe("rule_all");
    expect(harness.automation.ingestFromConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: { connectionId: "connection_b", channelId: "channel_b" },
      }),
    );
  });

  it("ignores an entry (not a purchase)", async () => {
    const harness = routerHarness([
      ruleRow({ id: "rule_a", connectionId: "connection_a", channelIds: ["channel_a"] }),
    ]);
    const service = new RoichatPurchaseIngressService(
      { inboundWebhookChannel: { findMany: vi.fn() }, providerConversionRuleConfig: { findMany: vi.fn() } } as never,
      harness.automation as never,
    );
    expect(
      await service.ingestPurchase({
        connection: { id: "connection_a", workspaceId: WORKSPACE },
        rawBody: Buffer.from(JSON.stringify(fixture("entry.synthetic.json"))),
        providerAttempt: null,
      }),
    ).toBeNull();
  });

  it("names the origin automation_roichat", () => {
    expect(
      providerRuleOrigin({
        conversionRule: { triggerType: "provider_automation", eventName: "Purchase" },
        parserRelease: { provider: "roichat" },
        connection: { provider: "roichat" },
      } as never),
    ).toBe("automation_roichat");
  });
});

// ---------------------------------------------------------------------------
// Pipeline da regra: duplicata em 12h ignorada, recompra permitida
// ---------------------------------------------------------------------------

function rulePipelineHarness() {
  let clock = new Date("2026-10-25T15:00:00.000Z");
  const deliveries: Array<Record<string, any>> = [];
  const endpoint = {
    id: "endpoint_rule_a",
    workspaceId: WORKSPACE,
    providerRuleId: "rule_a",
    secretHash: "rule-hash",
    removedAt: null,
    publicUrlDisabledAt: new Date("2026-10-25T10:00:00.000Z"),
    providerRule: {
      id: "rule_a",
      workspaceId: WORKSPACE,
      connectionId: "connection_a",
      removedAt: null,
      scope: "all_numbers",
      crossConnectionScope: true,
      conversionRule: { id: "cr_a", triggerType: "provider_automation", eventName: "Purchase", active: true },
      connection: {
        id: "connection_a",
        provider: "roichat",
        status: "production",
        removedAt: null,
        parserRelease: { provider: "roichat", version: "v1", status: "certified" },
      },
      parserRelease: { id: "inbound_parser_roichat_automation_v1", provider: "roichat", version: "automation-v1", status: "certified" },
      channels: [],
    },
  };
  const getPath = (value: any, path: string[]) =>
    path.reduce((current, key) => (current == null ? current : current[key]), value);
  const prisma = {
    providerConversionRuleEndpoint: {
      findFirst: vi.fn(async () => endpoint),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    inboundWebhookConnection: { updateMany: vi.fn(async () => ({ count: 1 })) },
    inboundWebhookDelivery: {
      findUnique: vi.fn(async ({ where }) =>
        deliveries.find(
          (delivery) =>
            delivery.connectionId === where.connectionId_ingressKey.connectionId &&
            delivery.ingressKey === where.connectionId_ingressKey.ingressKey,
        ) ?? null,
      ),
      findFirst: vi.fn(async ({ where }) => {
        if (where.AND) {
          const matches = deliveries.filter(
            (delivery) =>
              delivery.workspaceId === where.workspaceId &&
              delivery.provider === where.provider &&
              delivery.purpose === where.purpose &&
              delivery.firstReceivedAt >= where.firstReceivedAt.gte &&
              delivery.firstReceivedAt <= where.firstReceivedAt.lte &&
              where.AND.every((condition: any) =>
                getPath(delivery.normalizedSummary, condition.normalizedSummary.path) ===
                condition.normalizedSummary.equals,
              ),
          );
          return matches.at(-1) ?? null;
        }
        return deliveries.find((delivery) => delivery.id === where.id) ?? null;
      }),
      create: vi.fn(async ({ data }) => {
        deliveries.push({ ...data, attemptCount: 1 });
        return data;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const delivery = deliveries.find((candidate) => candidate.id === where.id);
        if (!delivery) return { count: 0 };
        if (data.attemptCount?.increment) delivery.attemptCount += data.attemptCount.increment;
        if (data.normalizedSummary) delivery.normalizedSummary = data.normalizedSummary;
        return { count: 1 };
      }),
    },
    $transaction: vi.fn(async (operation: (client: unknown) => unknown) =>
      operation(prisma),
    ),
  };
  const observeAutomation = vi.fn(async (input: any) => ({
    decisionId: `decision_${input.deliveryId}`,
    decisionCode: "eligible" as const,
    reasonCode: "automation_matched",
    disposition: "observed" as const,
    executionId: `execution_${input.deliveryId}`,
    eligibleExecutionId: null,
    reviewId: null,
    channelId: input.origin?.channelId ?? null,
    leadResolved: true,
  }));
  const runtime = env();
  vi.useFakeTimers();
  const service = new InboundConversionAutomationIngestionService(
    prisma as unknown as PrismaService,
    runtime,
    new InboundWebhookPayloadEncryptionService(runtime),
    { enqueueProviderConversion: vi.fn() } as never,
    { observeAutomation } as never,
  );
  const purchase = async (
    body: Record<string, unknown>,
    channel: "a" | "b" = "a",
  ) => {
    vi.setSystemTime(clock);
    const result = await service.ingestFromConnection({
      workspaceId: WORKSPACE,
      providerRuleId: "rule_a",
      rawBody: Buffer.from(JSON.stringify(body)),
      providerAttempt: null,
      origin: { connectionId: `connection_${channel}`, channelId: `channel_${channel}` },
    });
    if (!result) throw new Error("rule endpoint unavailable");
    return result;
  };
  return {
    deliveries,
    observeAutomation,
    purchase,
    advance(hours: number) {
      clock = new Date(clock.getTime() + hours * 3_600_000);
    },
  };
}

describe("ROI Chat — compra na regra (observação)", () => {
  const withoutTime = () => {
    const { event_time: _omit, ...body } = fixture("purchase.synthetic.json");
    return body;
  };

  it("ignores the same purchase repeated within 12 hours (counted on the first delivery)", async () => {
    const harness = rulePipelineHarness();
    const first = await harness.purchase(withoutTime());
    harness.advance(3);
    const repeated = await harness.purchase(withoutTime());
    expect(first.duplicate).toBe(false);
    expect(repeated).toMatchObject({ duplicate: true, observationStatus: "duplicate", deliveryId: first.deliveryId });
    expect(harness.deliveries).toHaveLength(1);
    expect(harness.deliveries[0]!.attemptCount).toBe(2);
    expect(harness.observeAutomation).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("allows the same value again after 12 hours (repurchase)", async () => {
    const harness = rulePipelineHarness();
    await harness.purchase(withoutTime());
    harness.advance(13);
    const later = await harness.purchase(withoutTime());
    expect(later.duplicate).toBe(false);
    expect(harness.deliveries).toHaveLength(2);
    vi.useRealTimers();
  });

  it("allows a repurchase with another value within 12 hours", async () => {
    const harness = rulePipelineHarness();
    await harness.purchase(withoutTime());
    harness.advance(1);
    const other = await harness.purchase({ ...withoutTime(), valor_venda: "35,00" });
    expect(other.duplicate).toBe(false);
    expect(harness.deliveries).toHaveLength(2);
    vi.useRealTimers();
  });

  it("does not treat the same purchase on another number as a repeat", async () => {
    const harness = rulePipelineHarness();
    await harness.purchase(withoutTime(), "a");
    harness.advance(1);
    const otherNumber = await harness.purchase(withoutTime(), "b");
    expect(otherNumber.duplicate).toBe(false);
    expect(harness.deliveries).toHaveLength(2);
    vi.useRealTimers();
  });

  it("stores the origin number, value, currency and no PII in the delivery summary", async () => {
    const harness = rulePipelineHarness();
    await harness.purchase(fixture("purchase.synthetic.json"));
    const summary = harness.deliveries[0]!.normalizedSummary;
    expect(summary).toMatchObject({
      eventName: "Purchase",
      valueCents: 2_000,
      currency: "BRL",
      callbackOrigin: { connectionId: "connection_a", channelId: "channel_a" },
      eventTimeSource: "payload",
      purchaseFingerprint: expect.stringMatching(/^roichat-purchase-fp:[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(harness.deliveries[0])).not.toContain("47999990000");
    expect(JSON.stringify(harness.deliveries[0])).not.toContain("Fulana");
    expect(harness.observeAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: { connectionId: "connection_a", channelId: "channel_a" },
        automation: expect.objectContaining({ provider: "roichat", valueCents: 2_000 }),
      }),
    );
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Conexão: card sempre no hub; um número = uma URL; nasce em produção
// ---------------------------------------------------------------------------

describe("ROI Chat — conexão (produção direta, sem gate)", () => {
  function connectionsHarness() {
    const now = new Date("2026-10-25T12:00:00.000Z");
    const release = {
      id: "inbound_parser_roichat_v1",
      provider: "roichat",
      version: "v1",
      status: "certified",
      certifiedByUserId: null,
      certifiedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const channels: Array<Record<string, unknown>> = [];
    const prisma = {
      inboundWebhookParserRelease: {
        findMany: vi.fn(async () => [release]),
        findFirst: vi.fn(async () => release),
      },
      inboundWebhookConnection: {
        create: vi.fn(async ({ data }) => ({
          ...data,
          id: "connection_roichat_1",
          lastDeliveryAt: null,
          lastSuccessfulParseAt: null,
          removedAt: null,
          createdAt: now,
          updatedAt: now,
          parserRelease: release,
        })),
      },
      inboundWebhookChannel: {
        create: vi.fn(async ({ data }) => {
          channels.push(data);
          return data;
        }),
      },
      auditLog: { create: vi.fn(async () => ({})) },
      $transaction: vi.fn(async (operation: (client: unknown) => unknown) =>
        operation(prisma),
      ),
    };
    const service = new InboundWebhookConnectionsService(
      prisma as unknown as PrismaService,
      env() as never,
    );
    return { channels, prisma, service };
  }

  it("offers ROI Chat in the hub to every workspace (no private-integration gate)", async () => {
    const capabilities = await connectionsHarness().service.getCapabilities();
    expect(capabilities.providers).toContainEqual(
      expect.objectContaining({
        provider: "roichat",
        creationEnabled: true,
        parserReleaseStatus: "certified",
      }),
    );
  });

  it("creates one connection = one number = one URL, born in production with the number sending", async () => {
    const harness = connectionsHarness();
    const created = await harness.service.createConnection(
      WORKSPACE,
      { provider: "roichat", displayName: "ROI Chat comercial", connectedPhone: "+5511900000001" },
      "user_ficticio",
    );
    expect(created.webhookUrl).toMatch(
      /^http:\/\/localhost:3333\/webhooks\/inbound\/connection_roichat_1\?token=/u,
    );
    expect(harness.prisma.inboundWebhookConnection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ provider: "roichat", status: "production" }),
      }),
    );
    expect(harness.channels).toEqual([
      expect.objectContaining({
        connectionId: "connection_roichat_1",
        providerChannelId: "5511900000001",
        connectedPhone: "5511900000001",
        status: "active",
      }),
    ]);
    // Like the generic providers (route by the ad), never the Unnichat
    // "inherit the workspace" mode.
    expect(harness.channels[0]).not.toHaveProperty("metaRoutingMode");
  });

  it("refuses a ROI Chat connection without the client's number", async () => {
    const harness = connectionsHarness();
    await expect(
      harness.service.createConnection(
        WORKSPACE,
        { provider: "roichat", displayName: "ROI Chat comercial" } as never,
        "user_ficticio",
      ),
    ).rejects.toThrow("Conexões ROI Chat exigem o número de WhatsApp do cliente");
    expect(harness.prisma.inboundWebhookConnection.create).not.toHaveBeenCalled();
  });
});
