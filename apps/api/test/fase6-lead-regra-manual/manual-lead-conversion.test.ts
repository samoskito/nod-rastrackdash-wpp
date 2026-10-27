import {
  ConflictException,
  BadRequestException,
  HttpException,
} from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const proofMock = vi.hoisted(() => ({
  resolveCtwaLeadProof: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("../../src/conversion-rules/ctwa-lead-proof", () => proofMock);
vi.mock(
  "../../src/inbound-webhooks/authorized-ctwa-destination",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../src/inbound-webhooks/authorized-ctwa-destination")
    >()),
    ctwaIntentAuthorized: vi.fn(async () => true),
  }),
);

import { ConversionEventsService } from "../../src/conversion-events/conversion-events.service";
import {
  leadLifetimeMetaEventId,
  pickPriorLeadLifetimeConversion,
  resolveLeadConversionIdentity,
} from "../../src/conversion-events/lead-lifetime-conversion-guard";
import { ManualConversionService } from "../../src/leads/manual-conversion.service";
import { manualCtwaConversionAuthorized } from "../../src/leads/manual-conversion-ctwa-policy";
import {
  manualConversionSummary,
  manualDispatchingSince,
  manualOrderKey,
} from "../../src/leads/manual-conversion-payload";
import { findLegacyProviderPurchaseForOrder } from "../../src/leads/manual-conversion-purchase";
import { ManualConversionDispatchRecoveryService } from "../../src/leads/manual-conversion-dispatch-recovery.service";
import { dedupeLocalManualLifetimeEvents } from "../../src/reporting/manual-conversion-report-dedupe";
import {
  isRuleOriginatedTrigger,
  paidLeadSubmittedEventWhere,
} from "../../src/leads/lead-cohort";

const WS = "workspace_1";
const DAY = 24 * 60 * 60_000;
const ctwaProof = {
  kind: "authorized_ctwa_destination",
  workspaceId: WS,
  channelId: "channel_ctwa",
  connectionId: "connection_1",
  organizationId: "org_1",
  providerChannelId: "provider_channel_1",
  destinationId: "destination_ctwa",
  businessConnectionId: "business_ctwa",
  credentialId: "credential_1",
  credentialFingerprint: "fingerprint_1",
  deliveryKind: "page_pixel",
  pixelId: "pixel_ctwa",
  pageId: "page_1",
} as const;

// ---------------------------------------------------------------------------
// Minimal in-memory Prisma (only what the manual flow touches).
// ---------------------------------------------------------------------------
function readPath(value: any, path: string[]) {
  return path.reduce((current, key) => current?.[key], value);
}

function matchCondition(value: any, condition: any): boolean {
  if (
    condition === null ||
    typeof condition !== "object" ||
    condition instanceof Date
  )
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
      return !(Array.isArray(condition) ? condition : [condition]).some(
        (sub: any) => matches(row, sub),
      );
    return matchCondition(row[key], condition);
  });
}

function createDb() {
  const state = {
    leads: [] as any[],
    logs: [] as any[],
    audits: [] as any[],
    // nod: numbers (channels) and WhatsApp connections (Uazapi BYO / WAHA).
    channels: [] as any[],
    instances: [] as any[],
  };
  let sequence = 0;
  const table = (rows: () => any[]) => ({
    findFirst: vi.fn(async ({ where, orderBy }: any = {}) => {
      const found = rows().filter((row) => matches(row, where));
      if (orderBy?.eventOccurredAt === "desc")
        found.sort((a, b) => b.eventOccurredAt - a.eventOccurredAt);
      return found[0] ?? null;
    }),
    findMany: vi.fn(async ({ where }: any = {}) =>
      rows().filter((row) => matches(row, where)),
    ),
    count: vi.fn(
      async ({ where }: any = {}) =>
        rows().filter((row) => matches(row, where)).length,
    ),
  });
  const prisma: any = {
    lead: table(() => state.leads),
    inboundWebhookChannel: table(() => state.channels),
    whatsappInstance: table(() => state.instances),
    conversionEventLog: {
      ...table(() => state.logs),
      findUnique: vi.fn(
        async ({ where }: any) =>
          state.logs.find((log) =>
            where.dedupeKey !== undefined
              ? log.dedupeKey === where.dedupeKey
              : log.id === where.id,
          ) ?? null,
      ),
      create: vi.fn(async ({ data }: any) => {
        if (
          data.dedupeKey &&
          state.logs.some((log) => log.dedupeKey === data.dedupeKey)
        )
          throw Object.assign(new Error("unique"), { code: "P2002" });
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
      updateMany: vi.fn(async ({ where, data }: any) => {
        const rows = state.logs.filter((log) => matches(log, where));
        rows.forEach((log) => Object.assign(log, data));
        return { count: rows.length };
      }),
    },
    auditLog: {
      ...table(() => state.audits),
      create: vi.fn(async ({ data }: any) => {
        const audit = { id: `audit_${++sequence}`, createdAt: new Date(), ...data };
        state.audits.push(audit);
        return audit;
      }),
    },
    metaConversionDestination: {
      findFirst: vi.fn(async ({ where }: any) => ({
        label: null,
        pixelName: `Pixel ${where.id}`,
        pixelId: `pixel_of_${where.id}`,
      })),
    },
    metaCampaign: {
      findFirst: vi.fn(async () => ({ name: "Campanha Black Friday" })),
    },
    metaAd: { findFirst: vi.fn(async () => ({ name: "Anuncio 1" })) },
    workspace: {
      findUnique: vi.fn(async () => ({ conversionCurrency: "BRL" })),
    },
    $queryRaw: vi.fn(async () => [{ locked: "" }]),
  };
  prisma.$transaction = vi.fn(async (operation: any) => operation(prisma));
  return { prisma, state };
}

function adRoute(destination = "destination_ad") {
  return {
    status: "resolved",
    reason: "route_resolved",
    reportingAccountId: "reporting_1",
    adAccountId: "act_1",
    businessConnectionId: "business_1",
    conversionDestinationId: destination,
    pixelId: "pixel_ad",
    pageId: "page_ad",
  };
}

function harness(
  lead: Partial<Record<string, unknown>> = {},
  options: { route?: unknown } = {},
) {
  const { prisma, state } = createDb();
  state.leads.push({
    id: "lead_1",
    workspaceId: WS,
    phoneHash: "hash_1",
    phoneDisplay: "+55 11 99999-0001",
    campaignId: "campaign_1",
    adSetId: "adset_1",
    adId: "ad_1",
    ctwaClid: "clid_1",
    ...lead,
  });
  const conversions = new ConversionEventsService(
    prisma,
    {} as any,
    {} as any,
    undefined,
    undefined as never,
    {},
  );
  const routes = {
    previewRoute: vi.fn(async () => options.route ?? adRoute()),
  };
  const queue = { enqueueSend: vi.fn(async () => ({ status: "queued" })) };
  const service = new ManualConversionService(
    prisma,
    conversions,
    routes as any,
    queue as any,
    {},
  );
  return { prisma, state, service, routes, queue };
}

const actor = { userId: "user_1", name: "Ana Dona" };
let keySequence = 0;
function input(overrides: Record<string, unknown> = {}) {
  keySequence += 1;
  return {
    eventName: "QualifiedLead",
    occurredAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    valueCents: null,
    currency: null,
    orderRef: null,
    contentName: null,
    note: null,
    sendToMeta: true,
    idempotencyKey: `00000000-0000-4000-8000-${String(keySequence).padStart(12, "0")}`,
    ...overrides,
  } as any;
}

function purchase(overrides: Record<string, unknown> = {}) {
  return input({
    eventName: "Purchase",
    valueCents: 19_900,
    currency: "BRL",
    orderRef: "PED-100",
    ...overrides,
  });
}

beforeEach(() => {
  proofMock.resolveCtwaLeadProof.mockReset();
  proofMock.resolveCtwaLeadProof.mockResolvedValue(null);
});

describe("manual lead conversion: destination and delivery", () => {
  it("ad lead: records with the ad's Meta route, the lead lifetime event_id, audit, and enqueues", async () => {
    const h = harness();
    const result = await h.service.create(WS, "lead_1", input(), actor);

    expect(result).toMatchObject({ outcome: "queued", replayed: false });
    const log = h.state.logs[0];
    expect(log).toMatchObject({
      sourceTrigger: "manual_conversion",
      eventName: "QualifiedLead",
      status: "ready_to_send",
      metaAccountId: "act_1",
      metaBusinessConnectionId: "business_1",
      metaConversionDestinationId: "destination_ad",
      adId: "ad_1",
      ctwaClid: "clid_1",
      businessSource: "paid",
    });
    const identity = await resolveLeadConversionIdentity(
      h.prisma,
      WS,
      "lead_1",
    );
    // Same event_id a provider rule of this lead would send: Meta dedupes.
    expect(log.eventId).toBe(
      leadLifetimeMetaEventId(WS, identity.lockIdentity, "QualifiedLead"),
    );
    expect(log.sourcePayload).toMatchObject({
      processingMode: "manual_conversion",
      createdByUserId: "user_1",
      createdByName: "Ana Dona",
    });
    expect(h.state.audits).toEqual([
      expect.objectContaining({
        action: "manual_conversion.create",
        targetId: log.id,
        actorUserId: "user_1",
        resultStatus: "success",
      }),
    ]);
    // The free-text note never goes to the audit trail.
    expect(JSON.stringify(h.state.audits[0].afterSummary)).not.toContain(
      "note",
    );
    expect(h.queue.enqueueSend).toHaveBeenCalledWith(log.id, WS);
  });

  it("no-ad lead with a verified CTWA entry: CTWA destination, no ad hierarchy, connection checked on its number", async () => {
    proofMock.resolveCtwaLeadProof.mockResolvedValue(ctwaProof);
    const h = harness({ adId: null, campaignId: null, adSetId: null });
    await h.service.create(WS, "lead_1", input(), actor);

    const log = h.state.logs[0];
    expect(log).toMatchObject({
      status: "ready_to_send",
      metaConversionDestinationId: "destination_ctwa",
      metaAccountId: null,
      campaignId: null,
      adSetId: null,
      adId: null,
    });
    expect(log.sourcePayload.ctwaDestination).toEqual(ctwaProof);
    expect(log.sourcePayload.channelId).toBe("channel_ctwa");
    expect(h.prisma.inboundWebhookChannel.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "channel_ctwa", workspaceId: WS } }),
    );
    expect(h.queue.enqueueSend).toHaveBeenCalled();
  });

  it("organic lead without pixel: recorded not_eligible only in the panel, never enqueued", async () => {
    const h = harness({ adId: null, campaignId: null, adSetId: null });
    const result = await h.service.create(WS, "lead_1", input(), actor);

    expect(result.outcome).toBe("local_only");
    expect(h.state.logs[0]).toMatchObject({
      status: "not_eligible",
      errorCode: "ManualConversionNoDestination",
      businessSource: "organic",
    });
    expect(h.queue.enqueueSend).not.toHaveBeenCalled();
  });

  it("older than 7 days: kept only in the panel (Meta window)", async () => {
    const h = harness();
    await h.service.create(
      WS,
      "lead_1",
      input({ occurredAt: new Date(Date.now() - 8 * DAY).toISOString() }),
      actor,
    );
    expect(h.state.logs[0]).toMatchObject({
      status: "not_eligible",
      errorCode: "ManualConversionOutsideMetaWindow",
    });
    expect(h.queue.enqueueSend).not.toHaveBeenCalled();
  });

  it("older than 90 days or in the future: refused", async () => {
    const h = harness();
    await expect(
      h.service.create(
        WS,
        "lead_1",
        input({ occurredAt: new Date(Date.now() - 91 * DAY).toISOString() }),
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      h.service.create(
        WS,
        "lead_1",
        input({ occurredAt: new Date(Date.now() + DAY).toISOString() }),
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.state.logs).toHaveLength(0);
  });

  it("sendToMeta=false: recorded only in the panel", async () => {
    const h = harness();
    const result = await h.service.create(
      WS,
      "lead_1",
      input({ sendToMeta: false }),
      actor,
    );
    expect(result.outcome).toBe("local_only");
    expect(h.state.logs[0]).toMatchObject({
      status: "not_eligible",
      errorCode: "ManualConversionLocalOnly",
    });
    expect(h.queue.enqueueSend).not.toHaveBeenCalled();
  });

  it("nod: number whose WhatsApp connection (Uazapi BYO / WAHA) is not active: recorded only in the panel", async () => {
    for (const provider of ["uazapi", "waha"]) {
      const h = harness({ whatsappInstanceId: "instance_1" });
      h.state.channels.push({
        id: "channel_bridge",
        workspaceId: WS,
        whatsappInstanceId: "instance_1",
        createdAt: new Date(),
        connection: { provider, removedAt: null },
        whatsappInstance: { status: "suspended" },
      });
      const result = await h.service.create(WS, "lead_1", input(), actor);
      expect(result.outcome).toBe("local_only");
      expect(h.state.logs[0]).toMatchObject({
        status: "not_eligible",
        errorCode: "ManualConversionConnectionInactive",
      });
      expect(h.queue.enqueueSend).not.toHaveBeenCalled();
      const preview = await h.service.preview(WS, "lead_1", input());
      expect(preview).toMatchObject({
        willSendToMeta: false,
        notSentReason: "connection_inactive",
      });
    }
    // Active connection: sent as usual.
    const ok = harness({ whatsappInstanceId: "instance_1" });
    ok.state.channels.push({
      id: "channel_bridge",
      workspaceId: WS,
      whatsappInstanceId: "instance_1",
      createdAt: new Date(),
      connection: { provider: "waha", removedAt: null },
      whatsappInstance: { status: "active" },
    });
    await ok.service.create(WS, "lead_1", input(), actor);
    expect(ok.state.logs[0]).toMatchObject({ status: "ready_to_send" });
    // Lead of a WhatsApp connection without a bridged number yet: the
    // connection itself decides.
    const bare = harness({ whatsappInstanceId: "instance_2" });
    bare.state.instances.push({ id: "instance_2", workspaceId: WS, status: "suspended" });
    await bare.service.create(WS, "lead_1", input(), actor);
    expect(bare.state.logs[0]).toMatchObject({
      errorCode: "ManualConversionConnectionInactive",
    });
  });

  it("preview reports destination, attribution and why it will not be sent", async () => {
    const h = harness();
    const sending = await h.service.preview(WS, "lead_1", input());
    expect(sending).toMatchObject({
      eventLabel: "Lead qualificado",
      willSendToMeta: true,
      notSentReason: null,
      destination: {
        kind: "ad",
        pixelId: "pixel_ad",
        destinationName: "Pixel destination_ad",
      },
      attribution: { campaignName: "Campanha Black Friday", adName: "Anuncio 1" },
      duplicate: null,
    });
    const old = await h.service.preview(
      WS,
      "lead_1",
      input({ occurredAt: new Date(Date.now() - 10 * DAY).toISOString() }),
    );
    expect(old).toMatchObject({
      willSendToMeta: false,
      notSentReason: "outside_meta_window",
    });
    // Preview never writes.
    expect(h.state.logs).toHaveLength(0);
    expect(h.state.audits).toHaveLength(0);
  });
});

describe("manual lead conversion: idempotency and dedupe", () => {
  it("the same click twice records one conversion (replayed on the second)", async () => {
    const h = harness();
    const same = input();
    const first = await h.service.create(WS, "lead_1", same, actor);
    const second = await h.service.create(WS, "lead_1", same, actor);

    expect(h.state.logs).toHaveLength(1);
    expect(second).toMatchObject({
      conversionEventLogId: first.conversionEventLogId,
      replayed: true,
    });
    expect(h.queue.enqueueSend).toHaveBeenCalledTimes(1);
    expect(h.state.audits).toHaveLength(1);
  });

  it("once-per-lead: a lead already converted by a rule for this pixel is a 409 with date and origin", async () => {
    const h = harness();
    h.state.logs.push({
      id: "rule_log",
      workspaceId: WS,
      leadId: "lead_1",
      eventName: "QualifiedLead",
      sourceTrigger: "inbound_webhook:unnichat:provider_automation",
      status: "sent",
      dedupeKey: "provider-conversion:x",
      metaConversionDestinationId: "destination_ad",
      sourcePayload: { channelId: "channel_a" },
      eventOccurredAt: new Date("2026-10-01T15:00:00.000Z"),
      createdAt: new Date("2026-10-01T15:00:00.000Z"),
    });

    const preview = await h.service.preview(WS, "lead_1", input());
    expect(preview.duplicate).toMatchObject({
      kind: "lead_already_converted",
      conversionEventLogId: "rule_log",
    });
    await expect(
      h.service.create(WS, "lead_1", input(), actor),
    ).rejects.toThrow(
      // America/Sao_Paulo time; ICU versions differ on the comma.
      /^Lead já convertido em 01\/10\/2026,? 12:00 por automação Unnichat\.$/u,
    );
    expect(h.state.logs).toHaveLength(1);
  });

  it("once-per-lead without destination: a second manual registration is a 409", async () => {
    const h = harness({ adId: null, campaignId: null, adSetId: null });
    await h.service.create(WS, "lead_1", input(), actor);
    await expect(
      h.service.create(WS, "lead_1", input(), actor),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("Purchase: the same order (case/space-insensitive) twice is a 409", async () => {
    const h = harness();
    const first = await h.service.create(WS, "lead_1", purchase(), actor);
    expect(h.state.logs[0]).toMatchObject({
      eventName: "Purchase",
      valueCents: 19_900,
      currency: "BRL",
      valueSource: "manual",
      dedupeKey: `manual_purchase:${manualOrderKey(WS, "PED-100")}`,
      eventId: `manual_purchase_${manualOrderKey(WS, "PED-100")}`,
    });
    expect(first.outcome).toBe("queued");
    await expect(
      h.service.create(WS, "lead_1", purchase({ orderRef: " ped-100 " }), actor),
    ).rejects.toThrow(/já registrado .* por registro manual/u);
    expect(h.state.logs).toHaveLength(1);
  });

  it("Purchase: an order already recorded by Payt/Braip for the lead is a 409", async () => {
    const h = harness();
    h.state.logs.push({
      id: "payt_log",
      workspaceId: WS,
      leadId: "lead_1",
      eventName: "Purchase",
      sourceTrigger: "inbound_webhook:payt:provider_automation",
      status: "sent",
      dedupeKey: "purchase:abc",
      sourcePayload: { manualOrderKey: manualOrderKey(WS, "PED-100") },
      eventOccurredAt: new Date(),
      createdAt: new Date(),
    });
    await expect(
      h.service.create(WS, "lead_1", purchase(), actor),
    ).rejects.toThrow(/já registrado .* por Payt./u);
  });

  it("manual LeadSubmitted is sent even when the CTWA entry was deferred to a rule (PR #155)", async () => {
    proofMock.resolveCtwaLeadProof.mockResolvedValue(ctwaProof);
    const h = harness({ adId: null, campaignId: null, adSetId: null });
    h.state.logs.push({
      id: "entry_log",
      workspaceId: WS,
      leadId: "lead_1",
      phoneHash: "hash_1",
      ctwaClid: "clid_1",
      eventName: "LeadSubmitted",
      sourceTrigger: "inbound_webhook:unnichat",
      status: "not_eligible",
      errorCode: "lead_submitted_deferred_to_rule",
      dedupeKey: "entry",
      metaConversionDestinationId: "destination_ctwa",
      sourcePayload: {
        channelId: "channel_ctwa",
        connectionId: "connection_1",
        ctwaDestination: ctwaProof,
      },
      eventOccurredAt: new Date(),
      createdAt: new Date(),
    });
    const result = await h.service.create(
      WS,
      "lead_1",
      input({ eventName: "LeadSubmitted" }),
      actor,
    );
    expect(result.outcome).toBe("queued");
    expect(result.conversionEventLogId).not.toBe("entry_log");
    expect(h.state.logs).toHaveLength(2);
  });
});

describe("manual lead conversion: cancel and rate limit", () => {
  it("cancels before sending (skipped + audit) and frees the order for a new registration", async () => {
    const h = harness();
    const created = await h.service.create(WS, "lead_1", purchase(), actor);

    await expect(
      h.service.cancel(WS, "lead_1", created.conversionEventLogId, actor),
    ).resolves.toEqual({
      conversionEventLogId: created.conversionEventLogId,
      status: "skipped",
    });
    expect(h.state.logs[0]).toMatchObject({
      status: "skipped",
      errorCode: "ManualConversionCanceled",
    });
    expect(h.state.audits.map((audit) => audit.action)).toEqual([
      "manual_conversion.create",
      "manual_conversion.cancel",
    ]);
    await expect(
      h.service.create(WS, "lead_1", purchase(), actor),
    ).resolves.toMatchObject({ outcome: "queued" });
  });

  it("refuses to cancel a conversion already sent", async () => {
    const h = harness();
    const created = await h.service.create(WS, "lead_1", input(), actor);
    h.state.logs[0].status = "sent";
    await expect(
      h.service.cancel(WS, "lead_1", created.conversionEventLogId, actor),
    ).rejects.toThrow("Enviado — não pode ser desfeito");
    await expect(
      h.service.cancel(WS, "lead_1", "unknown", actor),
    ).rejects.toThrow("Conversão manual não encontrada");
  });

  it("limits each user to 30 manual conversions per hour", async () => {
    const h = harness();
    for (let index = 0; index < 30; index += 1)
      h.state.audits.push({
        workspaceId: WS,
        actorUserId: "user_1",
        action: "manual_conversion.create",
        createdAt: new Date(),
      });
    const error = await h.service
      .create(WS, "lead_1", input(), actor)
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(429);
    // Another user is not affected.
    await expect(
      h.service.create(WS, "lead_1", input(), { userId: "user_2", name: null }),
    ).resolves.toMatchObject({ outcome: "queued" });
  });
});

describe("once-per-lead guard with the manual pipeline", () => {
  const base = {
    conversionDestinationId: "destination_1",
    ownDedupeKey: null,
  };

  it("a manual conversion blocks a later rule (other source)", () => {
    expect(
      pickPriorLeadLifetimeConversion(
        [
          {
            id: "manual_log",
            dedupeKey: "manual:x",
            sourceTrigger: "manual_conversion",
            sourcePayload: { channelId: "channel_a" },
            metaConversionDestinationId: "destination_1",
          },
        ],
        { ...base, channelId: "channel_a", pipeline: "provider_rule" },
      ),
    ).toEqual({
      conversionEventLogId: "manual_log",
      reasonCode: "lead_already_converted_other_source",
    });
  });

  it("a rule conversion (any number) blocks a manual one", () => {
    expect(
      pickPriorLeadLifetimeConversion(
        [
          {
            id: "rule_log",
            dedupeKey: "provider-conversion:1",
            sourceTrigger: "inbound_webhook:umbler:message_phrase",
            sourcePayload: { channelId: "channel_b" },
            metaConversionDestinationId: "destination_1",
          },
        ],
        { ...base, channelId: null, pipeline: "manual" },
      ),
    ).toMatchObject({ conversionEventLogId: "rule_log" });
  });

  it("another pixel never blocks", () => {
    expect(
      pickPriorLeadLifetimeConversion(
        [
          {
            id: "manual_log",
            dedupeKey: "manual:x",
            sourceTrigger: "manual_conversion",
            sourcePayload: {},
            metaConversionDestinationId: "destination_2",
          },
        ],
        { ...base, channelId: null, pipeline: "provider_rule" },
      ),
    ).toBeNull();
  });
});

describe("manual CTWA send-time policy (ctwaConversionContextDenial branch)", () => {
  const log = {
    id: "log_1",
    workspaceId: WS,
    leadId: "lead_1",
    phoneHash: "hash_1",
    ctwaClid: "clid_1",
    adId: null,
    sourceTrigger: "manual_conversion",
    sourcePayload: {
      processingMode: "manual_conversion",
      createdByUserId: "user_1",
      idempotencyKey: "key",
      channelId: "channel_ctwa",
      ctwaDestination: ctwaProof,
    },
  };
  function tx(audit: unknown) {
    return { auditLog: { findFirst: vi.fn(async () => audit) } } as any;
  }

  it("authorizes when the lead still has the same proof and the audit record exists", async () => {
    proofMock.resolveCtwaLeadProof.mockResolvedValue({ ...ctwaProof });
    await expect(
      manualCtwaConversionAuthorized(tx({ id: "audit" }), log, ctwaProof as any),
    ).resolves.toBe(true);
  });

  it("refuses without the audit record, with a changed proof, or with an ad id", async () => {
    proofMock.resolveCtwaLeadProof.mockResolvedValue({ ...ctwaProof });
    await expect(
      manualCtwaConversionAuthorized(tx(null), log, ctwaProof as any),
    ).resolves.toBe(false);
    proofMock.resolveCtwaLeadProof.mockResolvedValue({
      ...ctwaProof,
      destinationId: "other",
    });
    await expect(
      manualCtwaConversionAuthorized(tx({ id: "audit" }), log, ctwaProof as any),
    ).resolves.toBe(false);
    proofMock.resolveCtwaLeadProof.mockResolvedValue({ ...ctwaProof });
    await expect(
      manualCtwaConversionAuthorized(
        tx({ id: "audit" }),
        { ...log, adId: "ad_1" },
        ctwaProof as any,
      ),
    ).resolves.toBe(false);
  });

  it("the sender routes processingMode manual_conversion to this policy", async () => {
    proofMock.resolveCtwaLeadProof.mockResolvedValue({ ...ctwaProof });
    const service = new ConversionEventsService(
      {} as any,
      {} as any,
      {} as any,
      undefined,
      undefined as never,
      {
        INBOUND_WEBHOOKS_ENABLED: "true",
        INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
        API_PUBLIC_URL: "https://api.example.test",
        INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      },
    );
    const denial = (service as any).ctwaConversionContextDenial.bind(service);
    const record = {
      ...log,
      metaAccountId: null,
      campaignId: null,
      adSetId: null,
    };
    await expect(denial(tx({ id: "audit" }), record, ctwaProof)).resolves.toBe(
      null,
    );
    await expect(denial(tx(null), record, ctwaProof)).resolves.toBe(
      "manual_ctwa_context_invalid",
    );
  });
});

describe("manual sends claim the event before the Meta call (cancel race)", () => {
  it("skips without calling Meta when the event left ready_to_send", async () => {
    const adapter = { sendEvent: vi.fn() };
    const prisma: any = {
      conversionEventLog: {
        findUnique: vi.fn(async () => ({
          id: "log_1",
          workspaceId: WS,
          externalConnectorId: null,
          sourceTrigger: "manual_conversion",
          status: "ready_to_send",
          eventId: "event_1",
          eventName: "QualifiedLead",
          eventOccurredAt: new Date(Date.now() - 60_000),
          sourcePayload: { processingMode: "manual_conversion" },
        })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    };
    const service = new ConversionEventsService(
      prisma,
      adapter as any,
      {} as any,
      undefined,
      undefined as never,
      {},
    );
    await expect(service.sendReadyEvent("log_1")).resolves.toMatchObject({
      status: "skipped",
    });
    expect(prisma.conversionEventLog.updateMany).toHaveBeenCalledWith({
      where: { id: "log_1", status: "ready_to_send", eventId: "event_1" },
      data: {
        status: "dispatching",
        errorCode: "MetaCapiDeliveryUnknown",
        errorMessage: expect.stringMatching(/^Envio à Meta em andamento desde /u),
      },
    });
    expect(adapter.sendEvent).not.toHaveBeenCalled();
  });

  it("a manual event that passed 7 days while queued expires (never sent)", async () => {
    const adapter = { sendEvent: vi.fn() };
    const prisma: any = {
      conversionEventLog: {
        findUnique: vi.fn(async () => ({
          id: "log_1",
          workspaceId: WS,
          externalConnectorId: null,
          sourceTrigger: "manual_conversion",
          status: "ready_to_send",
          eventId: "event_1",
          eventName: "Purchase",
          eventOccurredAt: new Date(Date.now() - 7 * DAY - 60_000),
          sourcePayload: { processingMode: "manual_conversion" },
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const service = new ConversionEventsService(
      prisma,
      adapter as any,
      {} as any,
      undefined,
      undefined as never,
      {},
    );
    await expect(service.sendReadyEvent("log_1")).resolves.toMatchObject({
      status: "skipped",
    });
    expect(prisma.conversionEventLog.updateMany).toHaveBeenCalledWith({
      where: { id: "log_1", status: "ready_to_send" },
      data: expect.objectContaining({
        status: "not_eligible",
        errorCode: "MetaEventTimeExpired",
        errorMessage: expect.stringContaining("Expirou antes do envio"),
      }),
    });
    expect(adapter.sendEvent).not.toHaveBeenCalled();
  });
});

describe("tarefa 21 review: +-24h duplicates, seats, expiry, orders", () => {
  function paytPurchaseLog(overrides: Record<string, unknown> = {}) {
    return {
      id: "payt_log",
      workspaceId: WS,
      leadId: "lead_1",
      eventName: "Purchase",
      sourceTrigger: "inbound_webhook:payt:provider_automation",
      status: "sent",
      dedupeKey: "purchase:other-order",
      metaConversionDestinationId: "destination_ad",
      sourcePayload: { manualOrderKey: manualOrderKey(WS, "OUTRO-1") },
      eventOccurredAt: new Date(Date.now() - 2 * 60 * 60_000),
      createdAt: new Date(),
      ...overrides,
    };
  }

  it("same +-24h event from Payt: preview warns, create needs the explicit confirmation", async () => {
    const h = harness();
    h.state.logs.push(paytPurchaseLog());

    const preview = await h.service.preview(WS, "lead_1", purchase());
    expect(preview.duplicate).toBeNull();
    expect(preview.recentDuplicate).toMatchObject({
      kind: "recent_same_event",
      conversionEventLogId: "payt_log",
    });
    expect(preview.recentDuplicate?.message).toMatch(
      /^Já existe Compra realizada deste lead em .+ por Payt\. Registrar mesmo assim\?$/u,
    );

    const error = await h.service
      .create(WS, "lead_1", purchase(), actor)
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({
      code: "manual_conversion_recent_duplicate",
      duplicate: { conversionEventLogId: "payt_log" },
    });
    expect(h.state.logs).toHaveLength(1);

    await expect(
      h.service.create(
        WS,
        "lead_1",
        purchase({ confirmDuplicate: true }),
        actor,
      ),
    ).resolves.toMatchObject({ outcome: "queued" });
    expect(h.state.audits[0].afterSummary.confirmedDuplicateOf).toBe(
      "payt_log",
    );
  });

  it("no warning outside +-24h, for another pixel, or for a log only in the panel", async () => {
    const h = harness();
    h.state.logs.push(
      paytPurchaseLog({
        id: "old",
        eventOccurredAt: new Date(Date.now() - 30 * 60 * 60_000),
      }),
      paytPurchaseLog({ id: "other_pixel", metaConversionDestinationId: "x" }),
      paytPurchaseLog({ id: "local", status: "not_eligible" }),
    );
    const preview = await h.service.preview(WS, "lead_1", purchase());
    expect(preview.recentDuplicate).toBeNull();
  });

  it("the same order typed differently (#, spaces, hyphens, case) is the same order", async () => {
    expect(manualOrderKey(WS, " #ped 100 ")).toBe(manualOrderKey(WS, "PED-100"));
    expect(manualOrderKey(WS, "Ped100")).toBe(manualOrderKey(WS, "ped-100"));
    const h = harness();
    await h.service.create(WS, "lead_1", purchase({ orderRef: "#PED-100" }), actor);
    await expect(
      h.service.create(WS, "lead_1", purchase({ orderRef: "ped 100" }), actor),
    ).rejects.toThrow(/já registrado/u);
  });

  it("a Payt purchase recorded before this release (no order key) matches by its order field", async () => {
    const h = harness();
    h.state.logs.push(
      paytPurchaseLog({
        id: "legacy",
        sourcePayload: { orderRef: "ped-100" },
        eventOccurredAt: new Date(Date.now() - 5 * DAY),
      }),
    );
    await expect(
      h.service.create(WS, "lead_1", purchase(), actor),
    ).rejects.toThrow(/Pedido PED-100 já registrado .* por Payt\./u);
  });

  it("legacy Payt purchase: reads the order number of the preserved callback", async () => {
    const { prisma, state } = createDb();
    state.logs.push(
      paytPurchaseLog({
        id: "legacy",
        sourcePayload: { providerConversionExecutionId: "execution_1" },
      }),
      paytPurchaseLog({
        id: "too_old",
        sourcePayload: { providerConversionExecutionId: "execution_2" },
        eventOccurredAt: new Date(Date.now() - 91 * DAY),
      }),
    );
    const reader = vi.fn(async () => "PED-100");
    await expect(
      findLegacyProviderPurchaseForOrder(
        prisma,
        {
          workspaceId: WS,
          leadIds: ["lead_1"],
          normalizedOrderRef: "PED100",
        },
        reader,
      ),
    ).resolves.toMatchObject({ id: "legacy" });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith({
      workspaceId: WS,
      executionId: "execution_1",
    });
  });

  it("nod: uses the channel of the lead's latest conversation; an unknown number is not a blocker (no seats)", async () => {
    const known = harness();
    known.state.logs.push({
      id: "any_log",
      workspaceId: WS,
      leadId: "lead_1",
      eventName: "AddToCart",
      sourceTrigger: "inbound_webhook:umbler:message_phrase",
      status: "not_eligible",
      sourcePayload: { channelId: "channel_latest" },
      eventOccurredAt: new Date(),
      createdAt: new Date(),
    });
    await known.service.create(WS, "lead_1", input(), actor);
    expect(known.prisma.inboundWebhookChannel.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "channel_latest", workspaceId: WS } }),
    );

    const unknown = harness();
    await unknown.service.create(WS, "lead_1", input(), actor);
    expect(unknown.state.logs[0]).toMatchObject({ status: "ready_to_send" });
    expect(unknown.queue.enqueueSend).toHaveBeenCalled();
  });

  it("rate limit: per-user advisory lock taken inside the create transaction before counting", async () => {
    const h = harness();
    const order: string[] = [];
    h.prisma.$queryRaw.mockImplementation(async () => {
      order.push("lock");
      return [];
    });
    const count = h.prisma.auditLog.count;
    h.prisma.auditLog.count = vi.fn(async (args: any) => {
      order.push("count");
      return count(args);
    });
    await h.service.create(WS, "lead_1", input(), actor);
    expect(h.prisma.$transaction).toHaveBeenCalled();
    expect(order.slice(0, 2)).toEqual(["lock", "count"]);
  });

  it("near the 7-day limit the preview warns it may expire; an expired record is reported as such", async () => {
    const h = harness();
    const near = await h.service.preview(
      WS,
      "lead_1",
      input({
        occurredAt: new Date(
          Date.now() - 7 * DAY + 60 * 60_000,
        ).toISOString(),
      }),
    );
    expect(near.mayExpireBeforeSend).toBe(true);
    const fresh = await h.service.preview(WS, "lead_1", input());
    expect(fresh.mayExpireBeforeSend).toBe(false);

    const same = input();
    await h.service.create(WS, "lead_1", same, actor);
    Object.assign(h.state.logs[0], {
      status: "not_eligible",
      errorCode: "MetaEventTimeExpired",
    });
    await expect(
      h.service.create(WS, "lead_1", same, actor),
    ).resolves.toMatchObject({ outcome: "expired", replayed: true });
  });
});

describe("stuck manual dispatch recovery", () => {
  it("moves a manual send claimed 15+ minutes ago to delivery_unknown, never resending", async () => {
    const { prisma, state } = createDb();
    const now = new Date("2026-10-21T12:00:00.000Z");
    state.logs.push(
      {
        id: "stuck",
        workspaceId: WS,
        sourceTrigger: "manual_conversion",
        status: "dispatching",
        errorMessage: manualDispatchingSince(
          new Date(now.getTime() - 20 * 60_000),
        ),
        createdAt: new Date(now.getTime() - 20 * 60_000),
      },
      {
        id: "recent",
        workspaceId: WS,
        sourceTrigger: "manual_conversion",
        status: "dispatching",
        errorMessage: manualDispatchingSince(new Date(now.getTime() - 60_000)),
        createdAt: new Date(now.getTime() - 60_000),
      },
      {
        id: "rule",
        workspaceId: WS,
        sourceTrigger: "inbound_webhook:umbler:message_phrase",
        status: "dispatching",
        errorMessage: null,
        createdAt: new Date(now.getTime() - 3 * DAY),
      },
    );
    // Beyond the 8-day window: never scanned.
    state.logs.push({
      id: "ancient",
      workspaceId: WS,
      sourceTrigger: "manual_conversion",
      status: "dispatching",
      errorMessage: null,
      createdAt: new Date(now.getTime() - 9 * DAY),
    });
    prisma.workspace.findMany = vi.fn(async () => [{ id: WS }]);
    const recovery = new ManualConversionDispatchRecoveryService(prisma);
    await expect(recovery.recoverStuckDispatches(now)).resolves.toBe(1);
    // Index-bound query: workspaceId + status + createdAt window.
    expect(prisma.conversionEventLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: { in: [WS] },
          status: "dispatching",
          createdAt: { gte: new Date(now.getTime() - 8 * DAY) },
        }),
      }),
    );
    expect(state.logs.find((log) => log.id === "ancient")?.status).toBe(
      "dispatching",
    );
    expect(state.logs.find((log) => log.id === "stuck")).toMatchObject({
      status: "delivery_unknown",
      errorCode: "ManualConversionDispatchInterrupted",
    });
    expect(state.logs.find((log) => log.id === "recent")?.status).toBe(
      "dispatching",
    );
    expect(state.logs.find((log) => log.id === "rule")?.status).toBe(
      "dispatching",
    );
  });
});

describe("reports count a local manual once-per-lead event once", () => {
  const base = {
    phoneHash: "hash_1",
    leadId: "lead_1",
    eventName: "QualifiedLead",
  };

  it("drops the local manual when the automation sent the same event (same or no pixel)", () => {
    const events = [
      {
        ...base,
        id: "manual",
        sourceTrigger: "manual_conversion",
        status: "not_eligible",
        metaConversionDestinationId: null,
      },
      {
        ...base,
        id: "rule",
        sourceTrigger: "inbound_webhook:umbler:message_phrase",
        status: "sent",
        metaConversionDestinationId: "destination_1",
      },
    ];
    expect(dedupeLocalManualLifetimeEvents(events).map((e) => e.id)).toEqual([
      "rule",
    ]);
  });

  it("keeps both for different pixels, keeps a lone local manual, ignores 24h events", () => {
    const manual = {
      ...base,
      id: "manual",
      sourceTrigger: "manual_conversion",
      status: "not_eligible",
      metaConversionDestinationId: "destination_1",
    };
    const rule = {
      ...base,
      id: "rule",
      sourceTrigger: "inbound_webhook:umbler:message_phrase",
      status: "sent",
      metaConversionDestinationId: "destination_2",
    };
    expect(dedupeLocalManualLifetimeEvents([manual, rule])).toHaveLength(2);
    expect(dedupeLocalManualLifetimeEvents([manual])).toHaveLength(1);
    expect(
      dedupeLocalManualLifetimeEvents([
        { ...manual, eventName: "Purchase", metaConversionDestinationId: null },
        { ...rule, eventName: "Purchase" },
      ]),
    ).toHaveLength(2);
    // A canceled (skipped) automation never replaces the manual one.
    expect(
      dedupeLocalManualLifetimeEvents([
        { ...manual, metaConversionDestinationId: null },
        { ...rule, status: "skipped" },
      ]).map((e) => e.id),
    ).toContain("manual");
  });
});

describe("manual conversion in reports and lead detail", () => {
  it("a manual LeadSubmitted is not a new conversation", () => {
    expect(isRuleOriginatedTrigger("manual_conversion")).toBe(true);
    expect(paidLeadSubmittedEventWhere.NOT).toEqual({
      sourceTrigger: { equals: "manual_conversion" },
    });
  });

  it("the lead detail shows the author, the note and whether it can still be canceled", () => {
    const payload = {
      processingMode: "manual_conversion",
      createdByUserId: "user_1",
      createdByName: "Ana Dona",
      note: "Fechou por telefone",
      orderRef: "PED-1",
      idempotencyKey: "key",
    };
    expect(
      manualConversionSummary({
        sourceTrigger: "manual_conversion",
        status: "ready_to_send",
        sourcePayload: payload,
      }),
    ).toEqual({
      createdByName: "Ana Dona",
      note: "Fechou por telefone",
      orderRef: "PED-1",
      canCancel: true,
      origin: "lead_detail",
    });
    expect(
      manualConversionSummary({
        sourceTrigger: "manual_conversion",
        status: "ready_to_send",
        sourcePayload: { ...payload, origin: "kanban" },
      })?.origin,
    ).toBe("kanban");
    expect(
      manualConversionSummary({
        sourceTrigger: "manual_conversion",
        status: "sent",
        sourcePayload: payload,
      })?.canCancel,
    ).toBe(false);
    expect(
      manualConversionSummary({ sourceTrigger: "keyword", status: "sent" }),
    ).toBeNull();
  });
});

describe("CRM Kanban source (same manual path, forward only)", () => {
  it("a kanban move is the same manual conversion, with origin kanban in payload and audit", async () => {
    const h = harness();
    const assertKanbanMove = vi.fn(async () => ({ fromRank: 1, toRank: 2, skipped: 0 }));
    (h.service as any).crm = { assertKanbanMove };
    await h.service.preview(WS, "lead_1", input({ source: "kanban" }));
    const result = await h.service.create(
      WS,
      "lead_1",
      input({ source: "kanban" }),
      actor,
    );
    expect(result).toMatchObject({ outcome: "queued" });
    expect(assertKanbanMove).toHaveBeenCalledTimes(2);
    expect(assertKanbanMove).toHaveBeenCalledWith(WS, "lead_1", "QualifiedLead");
    expect(h.state.logs[0]).toMatchObject({
      sourceTrigger: "manual_conversion",
      sourcePayload: expect.objectContaining({ origin: "kanban" }),
    });
    expect(h.state.audits[0].afterSummary).toMatchObject({ origin: "kanban" });
    expect(h.queue.enqueueSend).toHaveBeenCalledTimes(1);
  });

  it("any manual conversion (lead detail or kanban) and a cancel invalidate the CRM board cache", async () => {
    const h = harness();
    const invalidateWorkspace = vi.fn();
    (h.service as any).crm = {
      assertKanbanMove: vi.fn(async () => ({ fromRank: 1, toRank: 2, skipped: 0 })),
      invalidateWorkspace,
    };
    const result = await h.service.create(WS, "lead_1", input(), actor);
    expect(invalidateWorkspace).toHaveBeenCalledWith(WS);
    await h.service.cancel(WS, "lead_1", result.conversionEventLogId, actor);
    expect(invalidateWorkspace).toHaveBeenCalledTimes(2);
    // A refused registration changes nothing: no invalidation.
    await expect(
      h.service.create(WS, "lead_1", input({ occurredAt: new Date(Date.now() + 86_400_000).toISOString() }), actor),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(invalidateWorkspace).toHaveBeenCalledTimes(2);
  });

  it("nod: a retried kanban move (same idempotencyKey) replays instead of failing same stage", async () => {
    const h = harness();
    let moved = false;
    const assertKanbanMove = vi.fn(async () => {
      // After the first registration the lead sits in the target column.
      if (moved)
        throw new ConflictException({
          message: "O lead já está nesta etapa.",
          code: "crm_same_stage",
        });
      return { fromRank: 1, toRank: 2, skipped: 0 };
    });
    (h.service as any).crm = { assertKanbanMove };
    const request = input({ source: "kanban" });
    const first = await h.service.create(WS, "lead_1", request, actor);
    moved = true;
    const retry = await h.service.create(WS, "lead_1", request, actor);
    expect(retry.conversionEventLogId).toBe(first.conversionEventLogId);
    expect(assertKanbanMove).toHaveBeenCalledTimes(1);
    expect(h.state.logs).toHaveLength(1);
    expect(h.queue.enqueueSend).toHaveBeenCalledTimes(1);
    // A new click (new key) is still checked: same stage is refused.
    await expect(
      h.service.create(WS, "lead_1", input({ source: "kanban" }), actor),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("a backward kanban move is refused before anything is recorded", async () => {
    const h = harness();
    (h.service as any).crm = {
      assertKanbanMove: vi.fn(async () => {
        throw new ConflictException({
          message: "Não é possível voltar etapa: a conversão já foi enviada à Meta",
          code: "crm_backward_move",
        });
      }),
    };
    await expect(
      h.service.create(WS, "lead_1", input({ source: "kanban" }), actor),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      h.service.preview(WS, "lead_1", input({ source: "kanban" })),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.state.logs).toHaveLength(0);
    expect(h.state.audits).toHaveLength(0);
  });

  it("without the board service a kanban source fails closed; the lead detail is unaffected", async () => {
    const h = harness();
    await expect(
      h.service.create(WS, "lead_1", input({ source: "kanban" }), actor),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      h.service.create(WS, "lead_1", input(), actor),
    ).resolves.toMatchObject({ outcome: "queued" });
    expect(h.state.logs[0].sourcePayload.origin).toBeUndefined();
    expect(h.state.audits[0].afterSummary).toMatchObject({
      origin: "lead_detail",
    });
  });
});
