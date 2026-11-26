import { describe, expect, it, vi } from "vitest";
import { hashPhoneIdentity } from "../../src/common/phone/phone-identity";
import { ProviderConversionDecisionEngine } from "../../src/conversion-rules/provider-conversion-decision.engine";
import { ProviderConversionObservationService } from "../../src/conversion-rules/provider-conversion-observation.service";
import { parseXmaxForRule } from "../../src/inbound-webhooks/providers/xmax/xmax-automation-v1.parser";

/**
 * XMAX CRM (URL per rule, one per event) in the real observation service,
 * routing and decision engine (storage is a fake). Same model as Webhook /
 * n8n: the XMAX creates no lead; the conversion lands on the number the PAID
 * lead's current click came through, whatever the student's WhatsApp
 * connection. The reader is born observation_only: nothing is sent. Harness
 * copied from webhook-observation.test.ts. Fictitious data only.
 */

const workspaceId = "workspace_xmax";
const activatedAt = new Date("2026-10-01T00:00:00.000Z");
const receivedAt = new Date("2026-11-05T15:00:00.000Z");
const entryAt = new Date("2026-11-04T12:00:00.000Z");
const env = {
  NODE_ENV: "test",
  API_PUBLIC_URL: "http://localhost:3333",
  INBOUND_WEBHOOKS_ENABLED: "true",
  INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
  INBOUND_CONVERSION_RULES_ENABLED: "true",
  INBOUND_CONVERSION_PRODUCTION_ENABLED: "true",
  INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
};
const phone = "5511900000001";
const phoneHash = hashPhoneIdentity(phone)!;

type Number = {
  channelId: string;
  connectionId: string;
  provider: string;
  /** Meta Cloud: phone_number_id; others: their own channel id. */
  providerChannelId: string;
  connectedPhone: string;
  /** Uazapi/WAHA of the student (bridged WhatsappInstance) only. */
  instanceId?: string;
};
const number = (
  provider: string,
  suffix: string,
  extra: Partial<Number> = {},
): Number => ({
  channelId: `ch_${provider}_${suffix}`,
  connectionId: `conn_${provider}_${suffix}`,
  provider,
  providerChannelId: `pcid_${provider}_${suffix}`,
  connectedPhone: `55119888800${suffix}`,
  ...extra,
});
// Two numbers of the SAME Meta app (each its own Meta Cloud connection).
const cloudA = number("meta_cloud", "01", { providerChannelId: "100000000000001" });
const cloudB = number("meta_cloud", "02", { providerChannelId: "100000000000002" });
// The student's own Uazapi and WAHA (URL + token): bridged instances.
const uazapi = number("uazapi", "03", { instanceId: "instance_uazapi_03" });
const uazapi2 = number("uazapi", "04", { instanceId: "instance_uazapi_04" });
const waha = number("waha", "08", { instanceId: "instance_waha_08" });
const umbler = number("umbler", "05");
const unnichat = number("unnichat", "06");
const roichat = number("roichat", "07");
const datacrazy = number("data_crazy", "09");
const gupshup = number("gupshup", "10");
const numbers = [
  cloudA,
  cloudB,
  uazapi,
  uazapi2,
  waha,
  umbler,
  unnichat,
  roichat,
  datacrazy,
  gupshup,
];

const connection = (n: Number) => ({
  id: n.connectionId,
  provider: n.provider,
  status: "production",
  removedAt: null,
  parserReleaseId: `release_${n.provider}_v1`,
  parserRelease: {
    id: `release_${n.provider}_v1`,
    provider: n.provider,
    version: "v1",
    status: "certified",
  },
  productionActivatedAt: activatedAt,
});

type EventName = "QualifiedLead" | "Purchase";
function ruleFor(
  eventName: EventName,
  mode = "observation",
  value: { source: "received" | "fixed"; cents: number | null } = {
    source: "fixed",
    cents: 99000,
  },
  parserStatus: "observation_only" | "certified" = "observation_only",
) {
  return {
    id: `xmax_${eventName}`,
    workspaceId,
    // Anchor: the first Meta Cloud connection (it only stores the deliveries).
    connectionId: cloudA.connectionId,
    parserReleaseId: "inbound_parser_xmax_automation_v1",
    scope: "all_numbers",
    crossConnectionScope: null,
    mode,
    productionActivatedAt: mode === "production" ? activatedAt : null,
    removedAt: null,
    unifiedIntoProviderRuleId: null,
    createdAt: activatedAt,
    updatedAt: activatedAt,
    conversionRuleId: `conversion_${eventName}`,
    messageTriggerPhrases: [],
    messageAuthorScope: null,
    productFilterCodes: [],
    conversionRule: {
      id: `conversion_${eventName}`,
      active: true,
      triggerType: "provider_automation",
      eventName,
      defaultValueCents: eventName === "Purchase" ? value.cents : null,
      defaultCurrency: null,
      defaultContentName: null,
      // XMAX CRM: always the rule's fixed value.
      defaultItems: { webhookValueSource: "fixed" },
      updatedAt: activatedAt,
    },
    connection: connection(cloudA),
    parserRelease: {
      id: "inbound_parser_xmax_automation_v1",
      provider: "xmax",
      version: "automation-v1",
      status: parserStatus,
    },
    channels: [],
    catalog: null,
  };
}

const channelRow = (n: Number) => ({
  id: n.channelId,
  connectionId: n.connectionId,
  organizationId: workspaceId,
  providerChannelId: n.providerChannelId,
  status: "active",
  productionActivatedAt: activatedAt,
  conversionEngineMode: "canonical",
});

function idsOf(where: any): string[] | null {
  if (!where?.id) return null;
  if (typeof where.id === "string") return [where.id];
  return where.id.in ?? null;
}

function harness(input: {
  rule: ReturnType<typeof ruleFor>;
  /** Numbers with an entry receipt of the lead's CURRENT click. */
  entries: Number[];
  /** Lead with its own ad attribution (lead pago). */
  lead?: "paid" | "organic" | "ambiguous";
  body?: Record<string, unknown>;
}) {
  const lead = input.lead ?? "paid";
  const inboundEntries = input.entries.filter((n) => !n.instanceId);
  const bridgedEntries = input.entries.filter((n) => n.instanceId);
  const prisma = {
    providerConversionRuleConfig: {
      findFirst: vi.fn(async () => input.rule),
      findMany: vi.fn(async () => []),
    },
    inboundWebhookChannel: {
      findMany: vi.fn(async ({ where }: any) => {
        const scoped = (list: Number[]) => {
          const ids = idsOf(where);
          return ids ? list.filter((n) => ids.includes(n.channelId)) : list;
        };
        // nod: the workspace scope scan also has an OR (suspended
        // instances); only the phone_number_id lookup names a number.
        if (
          where?.OR?.some(
            (clause: any) => "providerChannelId" in clause || "connectedPhone" in clause,
          )
        ) {
          // Number named by phone_number_id (or by the number itself).
          const named = where.OR.map(
            (clause: any) => clause.providerChannelId ?? clause.connectedPhone,
          );
          return scoped(
            numbers.filter(
              (n) =>
                named.includes(n.providerChannelId) ||
                named.includes(n.connectedPhone),
            ),
          ).map(channelRow);
        }
        if (where?.whatsappInstanceId) {
          const wanted =
            typeof where.whatsappInstanceId === "string"
              ? [where.whatsappInstanceId]
              : where.whatsappInstanceId.in;
          return scoped(
            numbers.filter((n) => n.instanceId && wanted.includes(n.instanceId)),
          ).map(channelRow);
        }
        if (idsOf(where)) return scoped(numbers).map(channelRow);
        // Workspace scope listing (every live number).
        return numbers.map((n, index) => ({
          id: n.channelId,
          connectionId: n.connectionId,
          status: "active",
          createdAt: new Date(activatedAt.getTime() + index * 1000),
          connectedPhone: n.connectedPhone,
          connection: { provider: n.provider },
          whatsappSeats: [],
          whatsappInstance: null,
        }));
      }),
      findFirst: vi.fn(async () => null),
    },
    inboundWebhookConnection: {
      findFirst: vi.fn(async ({ where }: any) => {
        const n = numbers.find((c) => c.connectionId === where.id);
        return n ? connection(n) : null;
      }),
    },
    conversionEventLog: {
      findMany: vi.fn(async ({ where }: any) => {
        // Uazapi/WAHA entry (auto_lead): one per lead + ad.
        if (where.sourceTrigger === "auto_lead") {
          return bridgedEntries.length > 0 ? [{ createdAt: entryAt }] : [];
        }
        // CTWA entry of every other connection (inbound_webhook:<provider>).
        return inboundEntries.map((n, index) => ({
          id: `entry_log_${index}`,
          sourcePayload: {
            inboundEventId: `entry_event_${index}`,
            channelId: n.channelId,
            connectionId: n.connectionId,
          },
        }));
      }),
    },
    inboundWebhookEvent: {
      findMany: vi.fn(async ({ where }: any) => {
        const proven = (where.OR ?? []).map((proof: any) => proof.channelId);
        return inboundEntries
          .filter(
            (n) =>
              where.channelId.in.includes(n.channelId) &&
              proven.includes(n.channelId),
          )
          .slice(0, 2)
          .map((n) => ({ channel: channelRow(n) }));
      }),
      findFirst: vi.fn(async () => null),
    },
    webhookLog: {
      findMany: vi.fn(async ({ where }: any) =>
        bridgedEntries
          // WebhookLog.source of the bridged numbers ("uazapi" | "waha").
          .filter((n) => where.source.in.includes(n.provider))
          .map((n) => ({ whatsappInstanceId: n.instanceId })),
      ),
    },
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
  const paidLeads = {
    resolve: vi.fn(async () =>
      lead === "paid"
        ? {
            status: "resolved",
            reasonCode: "paid_lead_resolved",
            lead: {
              id: "lead_1",
              phoneHash,
              campaignId: "campaign_1",
              adSetId: "adset_1",
              adId: "ad_1",
              ctwaClid: "click_current",
            },
          }
        : lead === "ambiguous"
          ? { status: "ambiguous", reasonCode: "buyer_ambiguous" }
          : {
              status: "not_found",
              reasonCode: "paid_attribution_missing",
              candidateLeadId: "lead_1",
            },
    ),
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
  const parsed = parseXmaxForRule(
    input.body ?? {
      ID_oportunidade: "90001",
      Etapa_oportunidade: "3 Negociação",
      Telefone_oportunidade: phone,
      Queue_id_v2: "12",
      Contatos_oportunidade: "[]",
    },
    receivedAt,
    input.rule.conversionRule,
  );
  if (!parsed.ok) throw new Error(`fixture: ${parsed.errorCode}`);
  const observe = () =>
    service.observeAutomation({
      workspaceId,
      connectionId: cloudA.connectionId,
      origin: null,
      deliveryId: "delivery_1",
      externalDeliveryId: null,
      deliveryReceivedAt: receivedAt,
      providerRuleId: input.rule.id,
      automation: parsed.value,
    } as never);
  const decision = () =>
    (decisions.recordInitial.mock.calls[0] as any)?.[0].decision;
  return { observe, paidLeads, decisions, decision, parsed: parsed.value };
}

describe("XMAX CRM: only the paid lead converts, on its own number, from ANY connection", () => {
  it.each([
    ["Meta Cloud (API Oficial)", cloudA],
    ["Uazapi do aluno (URL + token)", uazapi],
    ["WAHA do aluno (URL + token)", waha],
    ["Umbler", umbler],
    ["Unnichat", unnichat],
  ])("lead que entrou por %s: observado, nunca enviado (leitor em observação)", async (_label, origin) => {
    const h = harness({ rule: ruleFor("QualifiedLead"), entries: [origin] });
    const result = await h.observe();
    expect(result).toMatchObject({
      disposition: "observed",
      channelId: origin.channelId,
      leadResolved: true,
      eligibleExecutionId: null,
    });
    expect(h.decision().occurrence).toMatchObject({
      provider: "xmax",
      source: "automation",
      eventName: "QualifiedLead",
      channelId: origin.channelId,
      occurrenceKey: h.parsed.externalExecutionKey,
    });
    // Lifetime event: once per lead (lifetime lock), whatever the opportunity.
    expect(h.decision().occurrence.businessDedupePolicy.mode).toBe("lifetime");
  });

  it("even a rule set to production is never sent while the reader is observation_only", async () => {
    const h = harness({
      rule: ruleFor("QualifiedLead", "production"),
      entries: [cloudA],
    });
    const result = await h.observe();
    expect(result.disposition).not.toBe("eligible");
    expect(result.eligibleExecutionId).toBeNull();
  });

  it("contact_not_paid_lead: an organic contact is ignored with a visible reason, never a decision", async () => {
    const h = harness({
      rule: ruleFor("QualifiedLead"),
      entries: [],
      lead: "organic",
    });
    expect(await h.observe()).toMatchObject({
      disposition: "ignored",
      reasonCode: "contact_not_paid_lead",
      decisionId: null,
    });
    expect(h.decisions.recordInitial).not.toHaveBeenCalled();
  });

  it("Purchase: the rule's fixed value and the opportunity + event as the occurrence", async () => {
    const h = harness({ rule: ruleFor("Purchase"), entries: [cloudA] });
    await h.observe();
    expect(h.decision().conversion).toMatchObject({ valueCents: 99000 });
    const occurrence = h.decision().occurrence;
    expect(occurrence.occurrenceKey).toMatch(/^xmax-opportunity:/u);
    expect(occurrence.businessDedupePolicy).toMatchObject({
      mode: "rolling_window",
      windowSeconds: 30 * 24 * 60 * 60,
    });
    expect(occurrence.businessDedupePolicy.scopeKey).toContain(
      occurrence.occurrenceKey,
    );
  });
});
