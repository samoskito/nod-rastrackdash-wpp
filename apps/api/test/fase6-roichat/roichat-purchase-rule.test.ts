import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProviderConversionDecisionEngine } from "../../src/conversion-rules/provider-conversion-decision.engine";
import { ProviderConversionObservationService } from "../../src/conversion-rules/provider-conversion-observation.service";
import { parseRoichatAutomationV1 } from "../../src/inbound-webhooks/providers/roichat/roichat-automation-v1.parser";

/**
 * Fase 6.8 (porte do #183): a compra do ROI Chat pela regra "Compra no ROI
 * Chat". Real observation service + decision engine (canonical, as the
 * channels born in the nod); storage is a fake. The purchase arrives on ONE
 * number's own URL: that number is always the origin (never the lead's most
 * recent conversation on another number). Production direct: the rule and
 * the connection are in production and the releases are certified.
 * Dados fictícios.
 */

const workspaceId = "workspace_roichat_ficticio";
const activatedAt = new Date("2026-10-01T00:00:00.000Z");
const receivedAt = new Date("2026-10-25T15:00:00.000Z");
const env = {
  NODE_ENV: "test",
  API_PUBLIC_URL: "http://localhost:3333",
  INBOUND_WEBHOOKS_ENABLED: "true",
  INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
  INBOUND_CONVERSION_RULES_ENABLED: "true",
  INBOUND_CONVERSION_PRODUCTION_ENABLED: "true",
  INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
};

const entryRelease = {
  id: "inbound_parser_roichat_v1",
  provider: "roichat",
  version: "v1",
  status: "certified",
};
const automationRelease = {
  id: "inbound_parser_roichat_automation_v1",
  provider: "roichat",
  version: "automation-v1",
  status: "certified",
};

type RoiNumber = { channelId: string; connectionId: string; phone: string };
const numberA: RoiNumber = {
  channelId: "ch_a",
  connectionId: "conn_a",
  phone: "5511900000001",
};
const numberB: RoiNumber = {
  channelId: "ch_b",
  connectionId: "conn_b",
  phone: "5511900000002",
};
const numbers = [numberA, numberB];

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(__dirname, "../fixtures/roichat", name), "utf8"),
  ) as Record<string, unknown>;
}

function connectionOf(number: RoiNumber) {
  return {
    id: number.connectionId,
    provider: "roichat",
    status: "production",
    removedAt: null,
    parserReleaseId: entryRelease.id,
    parserRelease: entryRelease,
    productionActivatedAt: activatedAt,
  };
}

function rule(input: {
  id: string;
  anchor: RoiNumber;
  scope: "all_numbers" | "specific_numbers";
  channelIds?: string[];
  crossConnectionScope?: boolean;
  defaultValueCents?: number | null;
}) {
  return {
    id: input.id,
    workspaceId,
    connectionId: input.anchor.connectionId,
    parserReleaseId: automationRelease.id,
    scope: input.scope,
    crossConnectionScope: input.crossConnectionScope ?? null,
    mode: "production",
    productionActivatedAt: activatedAt,
    removedAt: null,
    unifiedIntoProviderRuleId: null,
    createdAt: activatedAt,
    updatedAt: activatedAt,
    conversionRuleId: `conversion_${input.id}`,
    messageTriggerPhrases: [],
    messageAuthorScope: null,
    productFilterCodes: [],
    conversionRule: {
      id: `conversion_${input.id}`,
      active: true,
      triggerType: "provider_automation",
      eventName: "Purchase",
      defaultValueCents: input.defaultValueCents ?? null,
      defaultCurrency: null,
      defaultContentName: null,
      defaultItems: null,
      updatedAt: activatedAt,
    },
    connection: connectionOf(input.anchor),
    parserRelease: automationRelease,
    channels: (input.channelIds ?? []).map((channelId) => ({
      channelId,
      channel: {
        id: channelId,
        status: "active",
        productionActivatedAt: activatedAt,
        conversionEngineMode: "canonical",
      },
    })),
    catalog: null,
  };
}

function harness(input: {
  rule: ReturnType<typeof rule>;
  /** Contact's ad conversations, most recent LAST. */
  events?: RoiNumber[];
}) {
  const channelRow = (number: RoiNumber) => ({
    id: number.channelId,
    connectionId: number.connectionId,
    organizationId: workspaceId,
    providerChannelId: number.phone,
    status: "active",
    productionActivatedAt: activatedAt,
    conversionEngineMode: "canonical",
  });
  const events = [...(input.events ?? [])].reverse();
  const prisma = {
    providerConversionRuleConfig: {
      findFirst: vi.fn(async () => input.rule),
      findMany: vi.fn(async () => []),
    },
    inboundWebhookChannel: {
      findMany: vi.fn(async () =>
        numbers.map((number, index) => ({
          id: number.channelId,
          connectionId: number.connectionId,
          status: "active",
          createdAt: new Date(activatedAt.getTime() + index * 1000),
          connectedPhone: number.phone,
          connection: { provider: "roichat" },
          whatsappSeats: [],
          whatsappInstance: null,
        })),
      ),
      findFirst: vi.fn(async ({ where }: any) => {
        const number = numbers.find(
          (candidate) =>
            candidate.channelId === where.id &&
            (where.connectionId === undefined ||
              candidate.connectionId === where.connectionId),
        );
        return number ? channelRow(number) : null;
      }),
    },
    inboundWebhookConnection: {
      findFirst: vi.fn(async ({ where }: any) => {
        const number = numbers.find(
          (candidate) => candidate.connectionId === where.id,
        );
        return number ? connectionOf(number) : null;
      }),
    },
    inboundWebhookEvent: {
      findFirst: vi.fn(async ({ where }: any) => {
        const event = events.find(
          (number) =>
            (where.connectionId === undefined ||
              number.connectionId === where.connectionId) &&
            where.channelId.in.includes(number.channelId),
        );
        return event ? { channel: channelRow(event) } : null;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        events
          .filter((number) => where.channelId.in.includes(number.channelId))
          .map((number) => ({
            channel: {
              ...channelRow(number),
              connection: { status: "production", removedAt: null },
            },
          })),
      ),
    },
    workspace: { findUnique: vi.fn(async () => ({ conversionCurrency: "BRL" })) },
  };
  const decisions = {
    findLatestByOccurrence: vi.fn(async () => null),
    recordInitial: vi.fn(async ({ decision }: any) => ({
      id: "decision_1",
      workspaceId,
      providerRuleId: decision.rule.providerRuleId,
      decision,
      decisionCode: decision.decisionCode,
      reasonCode: decision.reasonCode,
      occurrenceKey: decision.occurrence.occurrenceKey,
      created: true,
    })),
  };
  const engine = new ProviderConversionDecisionEngine();
  const orchestrator = {
    orchestrate: vi.fn(async ({ disposition }: any) => ({
      executionId: "execution_1",
      eligibleExecutionId:
        disposition.state === "eligible" ? "execution_1" : null,
      reviewId: null,
    })),
  };
  // The lead of an ad (source_id): resolved with its own ad attribution.
  const paidLeads = {
    resolve: vi.fn(async () => ({
      status: "resolved",
      reasonCode: "paid_lead_resolved",
      lead: {
        id: "lead_1",
        phoneHash: "phone_hash_1",
        campaignId: "campaign_1",
        adSetId: "adset_1",
        adId: "120200000000000001",
        ctwaClid: "AfjX-clique-ficticio-0001",
      },
    })),
  };
  const service = new ProviderConversionObservationService(
    prisma as never,
    {
      evaluate: vi.fn(async ({ decisionInput }: any) =>
        engine.evaluate(decisionInput),
      ),
    } as never,
    decisions as never,
    paidLeads as never,
    orchestrator as never,
    env,
  );
  const observe = (
    origin: RoiNumber,
    body: Record<string, unknown> = fixture("purchase.synthetic.json"),
  ) => {
    const parsed = parseRoichatAutomationV1(body, receivedAt);
    if (!parsed.ok) throw new Error(parsed.errorCode);
    return service.observeAutomation({
      workspaceId,
      connectionId: input.rule.connectionId,
      origin: { connectionId: origin.connectionId, channelId: origin.channelId },
      deliveryId: "delivery_1",
      externalDeliveryId: null,
      deliveryReceivedAt: receivedAt,
      providerRuleId: input.rule.id,
      automation: parsed.value,
    });
  };
  return { decisions, paidLeads, observe, orchestrator };
}

describe("ROI Chat — Compra pela regra (envia Purchase)", () => {
  it("a purchase on number A is eligible as Purchase with the sale value and currency, on A", async () => {
    const h = harness({
      rule: rule({ id: "rule_a", anchor: numberA, scope: "specific_numbers", channelIds: [numberA.channelId] }),
    });
    const result = await h.observe(numberA);
    expect(result.disposition).toBe("eligible");
    expect(result.channelId).toBe(numberA.channelId);
    const decision = h.decisions.recordInitial.mock.calls[0]![0].decision;
    expect(decision.rule.eventName).toBe("Purchase");
    expect(decision.conversion).toMatchObject({
      valueCents: 2_000,
      currency: "BRL",
    });
    expect(decision.occurrence).toMatchObject({
      provider: "roichat",
      connectionId: numberA.connectionId,
      channelId: numberA.channelId,
      businessDedupePolicy: {
        mode: "rolling_window",
        windowSeconds: 12 * 60 * 60,
        scopeKey: expect.stringContaining("value:2000:currency:BRL"),
      },
    });
    // ROI Chat leads come from an ad: no CTWA page/pixel proof path.
    expect(h.paidLeads.resolve).toHaveBeenCalledWith(
      expect.not.objectContaining({ ctwaProofAnyChannel: true }),
    );
  });

  it("a rule for every ROI Chat number takes B's purchase on B, even when the lead talked later on A", async () => {
    const h = harness({
      rule: rule({
        id: "rule_all",
        anchor: numberA,
        scope: "all_numbers",
        crossConnectionScope: true,
      }),
      events: [numberB, numberA],
    });
    const result = await h.observe(numberB);
    expect(result.disposition).toBe("eligible");
    expect(result.channelId).toBe(numberB.channelId);
    const decision = h.decisions.recordInitial.mock.calls[0]![0].decision;
    expect(decision.occurrence.connectionId).toBe(numberB.connectionId);
  });

  it("without valor_venda, the rule's fallback value is sent", async () => {
    const h = harness({
      rule: rule({
        id: "rule_a",
        anchor: numberA,
        scope: "specific_numbers",
        channelIds: [numberA.channelId],
        defaultValueCents: 4_990,
      }),
    });
    const { valor_venda: _value, moeda: _currency, ...body } = fixture(
      "purchase.synthetic.json",
    );
    const result = await h.observe(numberA, body);
    expect(result.disposition).toBe("eligible");
    const decision = h.decisions.recordInitial.mock.calls[0]![0].decision;
    expect(decision.conversion.valueCents).toBe(4_990);
  });

  it("never attributes a purchase to a number outside the rule (no channel, nothing eligible)", async () => {
    const h = harness({
      rule: rule({ id: "rule_a", anchor: numberA, scope: "specific_numbers", channelIds: [numberA.channelId] }),
    });
    const result = await h.observe(numberB);
    expect(result.disposition).not.toBe("eligible");
    expect(result.eligibleExecutionId).toBeNull();
  });
});
