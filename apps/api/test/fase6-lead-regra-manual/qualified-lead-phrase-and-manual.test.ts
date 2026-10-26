import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ConversionEventsService } from "../../src/conversion-events/conversion-events.service";
import {
  findPriorLeadLifetimeConversion,
  leadLifetimeMetaEventId,
  resolveLeadConversionIdentity,
} from "../../src/conversion-events/lead-lifetime-conversion-guard";
import { ProviderConversionProductionService } from "../../src/inbound-webhook-production/provider-conversion-production.service";
import { ManualConversionService } from "../../src/leads/manual-conversion.service";

/**
 * Fase 6.2a (nod, item novo do plano): uma regra de frase "Lead qualificado"
 * e a conversão manual do mesmo lead resultam em UM evento na Meta.
 *
 * - O event_id da conversão manual é exatamente o que a regra do lead envia
 *   (leadLifetimeMetaEventId): mesmo que os dois chegassem à Meta, ela
 *   deduplicaria.
 * - Regra primeiro: a conversão manual é recusada (409) e nada novo é gravado.
 * - Manual primeiro: o guard de conversão única por lead da regra encontra a
 *   conversão manual (a regra não envia de novo).
 *
 * Isso substitui o PR #90 do nod (QualifiedLead manual com outro event_id,
 * que mandaria dois eventos). Dados sintéticos.
 */

const WS = "workspace_sintetico";

function readPath(value: any, path: string[]) {
  return path.reduce((current, key) => current?.[key], value);
}

function matchCondition(value: any, condition: any): boolean {
  if (condition === null || typeof condition !== "object" || condition instanceof Date)
    return condition instanceof Date
      ? value?.getTime?.() === condition.getTime()
      : value === condition;
  if ("path" in condition)
    return "equals" in condition
      ? readPath(value, condition.path) === condition.equals
      : readPath(value, condition.path) != null;
  return Object.entries(condition).every(([op, expected]: [string, any]) => {
    switch (op) {
      case "in":
        return expected.includes(value);
      case "notIn":
        return !expected.includes(value);
      case "not":
        return expected !== null && typeof expected === "object"
          ? !matchCondition(value, expected)
          : value !== expected;
      case "equals":
        return value === expected;
      case "startsWith":
        return typeof value === "string" && value.startsWith(expected);
      case "endsWith":
        return typeof value === "string" && value.endsWith(expected);
      case "gte":
        return value >= expected;
      case "lt":
        return value < expected;
      case "lte":
        return value <= expected;
      default:
        throw new Error(`unsupported operator ${op}`);
    }
  });
}

function matches(row: any, where: any = {}): boolean {
  return Object.entries(where).every(([key, condition]: [string, any]) => {
    if (key === "OR") return condition.some((sub: any) => matches(row, sub));
    if (key === "AND") return condition.every((sub: any) => matches(row, sub));
    if (key === "NOT")
      return !(Array.isArray(condition) ? condition : [condition]).some((sub: any) =>
        matches(row, sub),
      );
    return matchCondition(row[key], condition);
  });
}

function harness() {
  const state = { leads: [] as any[], logs: [] as any[], audits: [] as any[] };
  let sequence = 0;
  const table = (rows: () => any[]) => ({
    findFirst: vi.fn(async ({ where }: any = {}) =>
      rows().find((row) => matches(row, where)) ?? null,
    ),
    findMany: vi.fn(async ({ where }: any = {}) =>
      rows().filter((row) => matches(row, where)),
    ),
    count: vi.fn(async ({ where }: any = {}) =>
      rows().filter((row) => matches(row, where)).length,
    ),
  });
  const prisma: any = {
    lead: table(() => state.leads),
    inboundWebhookChannel: table(() => []),
    whatsappInstance: table(() => []),
    conversionEventLog: {
      ...table(() => state.logs),
      findUnique: vi.fn(async ({ where }: any) =>
        state.logs.find((log) =>
          where.dedupeKey !== undefined ? log.dedupeKey === where.dedupeKey : log.id === where.id,
        ) ?? null,
      ),
      create: vi.fn(async ({ data }: any) => {
        const log = {
          id: `log_${++sequence}`,
          createdAt: new Date(),
          ...data,
          sourcePayload:
            data.sourcePayload && typeof data.sourcePayload === "object"
              ? structuredClone(data.sourcePayload)
              : null,
        };
        state.logs.push(log);
        return log;
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    auditLog: {
      ...table(() => state.audits),
      create: vi.fn(async ({ data }: any) => {
        const audit = { id: `audit_${++sequence}`, ...data };
        state.audits.push(audit);
        return audit;
      }),
    },
    metaConversionDestination: {
      findFirst: vi.fn(async () => ({ label: null, pixelName: "Pixel", pixelId: "pixel_1" })),
    },
    metaCampaign: { findFirst: vi.fn(async () => ({ name: "Campanha" })) },
    metaAd: { findFirst: vi.fn(async () => ({ name: "Anúncio" })) },
    workspace: { findUnique: vi.fn(async () => ({ conversionCurrency: "BRL" })) },
    $queryRaw: vi.fn(async () => [{ locked: "" }]),
  };
  prisma.$transaction = vi.fn(async (operation: any) => operation(prisma));
  state.leads.push({
    id: "lead_1",
    workspaceId: WS,
    phoneHash: "hash_sintetico",
    campaignId: "campaign_1",
    adSetId: "adset_1",
    adId: "ad_1",
    ctwaClid: "clid_sintetico",
    whatsappInstanceId: null,
  });
  const conversions = new ConversionEventsService(
    prisma,
    {} as never,
    {} as never,
    undefined,
    undefined as never,
    {},
  );
  const routes = {
    previewRoute: vi.fn(async () => ({
      status: "resolved",
      reason: "route_resolved",
      reportingAccountId: "reporting_1",
      adAccountId: "act_1",
      businessConnectionId: "business_1",
      conversionDestinationId: "destination_1",
      pixelId: "pixel_1",
      pageId: "page_1",
    })),
  };
  const queue = { enqueueSend: vi.fn(async () => ({ status: "queued" })) };
  const service = new ManualConversionService(
    prisma,
    conversions,
    routes as never,
    queue as never,
    {},
  );
  return { prisma, state, service, queue };
}

const actor = { userId: "user_sintetico", name: "Pessoa Dona" };
let key = 0;
const input = () => {
  key += 1;
  return {
    eventName: "QualifiedLead",
    occurredAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    valueCents: null,
    currency: null,
    orderRef: null,
    contentName: null,
    note: null,
    sendToMeta: true,
    idempotencyKey: `00000000-0000-4000-8000-${String(key).padStart(12, "0")}`,
    confirmDuplicate: false,
  } as any;
};

/** The id the phrase rule of this lead sends (provider production service). */
function ruleEventId(lockIdentity: string): string {
  return (
    ProviderConversionProductionService.prototype as unknown as {
      leadLifetimeMetaEventId(ws: string, identity: string, event: string): string;
    }
  ).leadLifetimeMetaEventId.call({}, WS, lockIdentity, "QualifiedLead");
}

describe("Lead qualificado: regra de frase + conversão manual = 1 evento", () => {
  it("o event_id da conversão manual é o mesmo da regra de frase do lead", async () => {
    const h = harness();
    const identity = await resolveLeadConversionIdentity(h.prisma, WS, "lead_1");
    await h.service.create(WS, "lead_1", input(), actor);
    expect(h.state.logs).toHaveLength(1);
    expect(h.state.logs[0].eventId).toBe(ruleEventId(identity.lockIdentity));
    expect(h.state.logs[0].eventId).toBe(
      leadLifetimeMetaEventId(WS, identity.lockIdentity, "QualifiedLead"),
    );
  });

  it("regra primeiro: a conversão manual é recusada (409) e nada novo é gravado", async () => {
    const h = harness();
    const identity = await resolveLeadConversionIdentity(h.prisma, WS, "lead_1");
    h.state.logs.push({
      id: "phrase_log",
      workspaceId: WS,
      leadId: "lead_1",
      eventName: "QualifiedLead",
      eventId: ruleEventId(identity.lockIdentity),
      sourceTrigger: "inbound_webhook:waha:message_phrase",
      status: "sent",
      dedupeKey: "provider-conversion:sintetico",
      metaConversionDestinationId: "destination_1",
      sourcePayload: { channelId: "channel_waha" },
      eventOccurredAt: new Date(Date.now() - 2 * 60 * 60_000),
      createdAt: new Date(Date.now() - 2 * 60 * 60_000),
    });

    const preview = await h.service.preview(WS, "lead_1", input());
    expect(preview).toMatchObject({
      willSendToMeta: false,
      duplicate: { kind: "lead_already_converted", conversionEventLogId: "phrase_log" },
    });
    await expect(h.service.create(WS, "lead_1", input(), actor)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(h.state.logs).toHaveLength(1);
    expect(h.queue.enqueueSend).not.toHaveBeenCalled();
  });

  it("manual primeiro: a regra de frase encontra a conversão manual e não envia de novo", async () => {
    const h = harness();
    await h.service.create(WS, "lead_1", input(), actor);
    const manual = h.state.logs[0];
    expect(manual).toMatchObject({ sourceTrigger: "manual_conversion", status: "ready_to_send" });
    manual.status = "sent";
    const identity = await resolveLeadConversionIdentity(h.prisma, WS, "lead_1");
    const prior = await findPriorLeadLifetimeConversion(h.prisma, {
      workspaceId: WS,
      identity,
      eventName: "QualifiedLead",
      conversionDestinationId: "destination_1",
      channelId: "channel_waha",
      pipeline: "provider_rule",
      ownDedupeKey: "provider-conversion:sintetico",
      includeAutoLead: true,
    });
    expect(prior).toMatchObject({ conversionEventLogId: manual.id });
    // Even if both had left, Meta would see the same event_id once.
    expect(manual.eventId).toBe(ruleEventId(identity.lockIdentity));
  });
});
