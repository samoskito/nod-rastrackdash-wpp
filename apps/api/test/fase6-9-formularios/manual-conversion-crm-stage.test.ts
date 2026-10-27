import { ConflictException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const proofMock = vi.hoisted(() => ({
  resolveCtwaLeadProof: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("../../src/conversion-rules/ctwa-lead-proof", () => proofMock);

import { ConversionEventsService } from "../../src/conversion-events/conversion-events.service";
import {
  findPriorLeadLifetimeConversion,
  resolveLeadConversionIdentity,
} from "../../src/conversion-events/lead-lifetime-conversion-guard";
import { MetaTokenEncryptionService } from "../../src/integrations/meta/meta-token-encryption.service";
import {
  LeadAlreadyConvertedConflict,
  ManualConversionService,
} from "../../src/leads/manual-conversion.service";

// Fase 6.9 (PR #91 do nod, "Qualificado" ligado ao #158/#176): a QualifiedLead
// registered by the manual conversion (lead detail or Kanban) also records
// the CRM stage of the lead's Meta instant form, on its own dataset, outside
// the once-per-lead-per-pixel guard of #153. Sanitized data only.

const WS = "workspace_1";
const META_LEAD_ID = "900000000000002";

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

function harness(
  lead: Record<string, unknown> = {},
  options: { submission?: boolean; datasetId?: string | null } = {},
) {
  const encryption = new MetaTokenEncryptionService({
    META_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
  });
  const token = encryption.encrypt("graph-token-exemplo");
  const state = {
    leads: [
      {
        id: "lead_1",
        workspaceId: WS,
        phoneHash: "hash_1",
        phoneDisplay: "+55 11 98765-0002",
        campaignId: "campaign_1",
        adSetId: "adset_1",
        adId: "ad_1",
        ctwaClid: null,
        whatsappInstanceId: null,
        ...lead,
      },
    ] as any[],
    logs: [] as any[],
    audits: [] as any[],
    submissions: [] as any[],
  };
  if (options.submission !== false)
    state.submissions.push({
      id: "submission_1",
      workspaceId: WS,
      connectionId: "form_connection_1",
      leadId: "lead_1",
      metaLeadId: META_LEAD_ID,
      pageId: "page_1",
      campaignId: "campaign_1",
      adSetId: "adset_1",
      adId: "ad_1",
      email: "lead@example.test",
      phone: "+5511987650002",
      fetchStatus: "fetched",
      metaCreatedAt: new Date(Date.now() - 2 * 86_400_000),
      createdAt: new Date(),
      connection: {
        id: "form_connection_1",
        active: true,
        crmDatasetId: options.datasetId === undefined ? "888" : options.datasetId,
        qualifiedEventName: "LeadQualificado",
        graphTokenEncrypted: token.encryptedAccessToken,
        graphTokenIv: token.tokenIv,
        graphTokenTag: token.tokenTag,
        capiTokenEncrypted: null,
        capiTokenIv: null,
        capiTokenTag: null,
      },
    });
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
    metaLeadSubmission: table(() => state.submissions),
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
        if (data.dedupeKey && state.logs.some((log) => log.dedupeKey === data.dedupeKey))
          throw Object.assign(new Error("unique"), { code: "P2002" });
        const log = { id: `log_${++sequence}`, createdAt: new Date(), ...data };
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
      findFirst: vi.fn(async () => ({ label: null, pixelName: "Pixel", pixelId: "pixel_ad" })),
    },
    metaCampaign: { findFirst: vi.fn(async () => ({ name: "Campanha" })) },
    metaAd: { findFirst: vi.fn(async () => ({ name: "Anúncio" })) },
    workspace: { findUnique: vi.fn(async () => ({ conversionCurrency: "BRL" })) },
    $queryRaw: vi.fn(async () => [{ locked: "" }]),
  };
  prisma.$transaction = vi.fn(async (operation: any) => operation(prisma));
  const conversions = new ConversionEventsService(
    prisma,
    {} as any,
    encryption,
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
      conversionDestinationId: "destination_ad",
      pixelId: "pixel_ad",
      pageId: "page_ad",
    })),
  };
  const queue = { enqueueSend: vi.fn(async () => ({ status: "queued" })) };
  const service = new ManualConversionService(prisma, conversions, routes as any, queue as any, {});
  return { prisma, state, service, queue };
}

const actor = { userId: "user_1", name: "Pessoa Dona" };
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
    idempotencyKey: `00000000-0000-4000-9000-${String(keySequence).padStart(12, "0")}`,
    ...overrides,
  } as any;
}

const crmLogs = (state: { logs: any[] }) =>
  state.logs.filter((log) => log.sourceTrigger === "meta_lead_form_crm");

beforeEach(() => {
  proofMock.resolveCtwaLeadProof.mockReset();
  proofMock.resolveCtwaLeadProof.mockResolvedValue(null);
});

describe("Fase 6.9: QualifiedLead manual/Kanban envia a etapa do formulário Meta", () => {
  it("form-only lead: the WhatsApp event stays in the panel, the CRM stage is queued", async () => {
    const h = harness();

    const result = await h.service.create(WS, "lead_1", input(), actor);

    // No ctwa_clid: the messaging QualifiedLead is panel-only (#158).
    expect(result.outcome).toBe("local_only");
    const [crm] = crmLogs(h.state);
    expect(crm).toMatchObject({
      eventName: "LeadQualificado",
      status: "ready_to_send",
      eventId: `${META_LEAD_ID}:LeadQualificado`,
      dedupeKey: `${WS}:meta_lead_form_crm:${META_LEAD_ID}:LeadQualificado`,
      pixelId: "888",
      leadId: "lead_1",
    });
    expect(crm.sourcePayload).toMatchObject({
      submissionId: "submission_1",
      actorUserId: "user_1",
      originConversionEventLogId: h.state.logs[0].id,
    });
    expect(h.queue.enqueueSend).toHaveBeenCalledWith(crm.id, WS);
    expect(result.crmStage).toMatchObject({ outcome: "queued", eventName: "LeadQualificado" });
    expect(result.message).toMatch(/formulário Meta foi enfileirada/);
  });

  it("lead with form and WhatsApp: both events, each to its own destination", async () => {
    const h = harness({ ctwaClid: "clid_1" });

    const result = await h.service.create(WS, "lead_1", input(), actor);

    expect(result.outcome).toBe("queued");
    const manual = h.state.logs.find((log) => log.sourceTrigger === "manual_conversion");
    expect(manual).toMatchObject({
      status: "ready_to_send",
      metaConversionDestinationId: "destination_ad",
    });
    expect(manual.eventId).toMatch(/^lead_/);
    expect(crmLogs(h.state)).toHaveLength(1);
    expect(h.queue.enqueueSend).toHaveBeenCalledTimes(2);
  });

  it("'Enviar à Meta' off, another event or no form: no CRM stage", async () => {
    const off = harness();
    await off.service.create(WS, "lead_1", input({ sendToMeta: false }), actor);
    expect(crmLogs(off.state)).toHaveLength(0);

    const other = harness({ ctwaClid: "clid_1" });
    await other.service.create(
      WS,
      "lead_1",
      input({ eventName: "Purchase", valueCents: 10_000, currency: "BRL", orderRef: "PED-1" }),
      actor,
    );
    expect(crmLogs(other.state)).toHaveLength(0);

    const noForm = harness({}, { submission: false });
    const result = await noForm.service.create(WS, "lead_1", input(), actor);
    expect(crmLogs(noForm.state)).toHaveLength(0);
    expect(result.crmStage).toBeUndefined();
  });

  it("a second QualifiedLead is a 409 and the stage is never recorded twice", async () => {
    const h = harness();
    await h.service.create(WS, "lead_1", input(), actor);

    const second = h.service.create(WS, "lead_1", input(), actor);

    await expect(second).rejects.toBeInstanceOf(ConflictException);
    await expect(second).rejects.not.toThrow(/formulário Meta/);
    expect(crmLogs(h.state)).toHaveLength(1);
  });

  it("lead already qualified by a phrase rule: 409, but the CRM stage (another dataset) is recorded once", async () => {
    const h = harness({ ctwaClid: "clid_1" });
    h.state.logs.push({
      id: "rule_log",
      workspaceId: WS,
      leadId: "lead_1",
      eventName: "QualifiedLead",
      sourceTrigger: "inbound_webhook:umbler:message_phrase",
      status: "sent",
      dedupeKey: "provider-conversion:x",
      metaConversionDestinationId: "destination_ad",
      sourcePayload: { channelId: "channel_a" },
      eventOccurredAt: new Date(Date.now() - 86_400_000),
      createdAt: new Date(Date.now() - 86_400_000),
    });

    const attempt = h.service.create(WS, "lead_1", input(), actor);

    await expect(attempt).rejects.toBeInstanceOf(LeadAlreadyConvertedConflict);
    await expect(attempt).rejects.toThrow(/^Lead já convertido .* formulário Meta foi enfileirada/u);
    expect(h.state.logs.filter((log) => log.sourceTrigger === "manual_conversion")).toHaveLength(0);
    expect(crmLogs(h.state)).toHaveLength(1);
  });

  it("preview shows the CRM stage on the confirmation step", async () => {
    const h = harness();
    expect((await h.service.preview(WS, "lead_1", input())).crmStage).toEqual({
      eventName: "LeadQualificado",
      willSend: true,
      reason: null,
    });
    expect(
      (await h.service.preview(WS, "lead_1", input({ sendToMeta: false }))).crmStage,
    ).toMatchObject({ willSend: false, reason: expect.stringMatching(/só no painel/) });

    const noDataset = harness({}, { datasetId: null });
    expect((await noDataset.service.preview(WS, "lead_1", input())).crmStage).toMatchObject({
      willSend: false,
      reason: expect.stringMatching(/dataset/),
    });
  });
});

describe("Fase 6.9: QualifiedLead importado do Dashboard Leads (PR #92)", () => {
  function withImported(h: ReturnType<typeof harness>) {
    h.state.logs.push({
      id: "imported_log",
      workspaceId: WS,
      leadId: "lead_1",
      eventName: "QualifiedLead",
      sourceTrigger: "manual_conversion",
      status: "imported",
      dedupeKey: `manual:${WS}:dashboard-leads:dl_1`,
      metaConversionDestinationId: null,
      sourcePayload: {
        processingMode: "manual_conversion",
        createdByUserId: "dashboard_leads_import",
        idempotencyKey: "dashboard-leads:dl_1",
      },
      eventOccurredAt: new Date(Date.now() - 2 * 86_400_000),
      createdAt: new Date(Date.now() - 2 * 86_400_000),
    });
  }

  it("blocks a new manual QualifiedLead (409) and an automation (#153 guard)", async () => {
    const h = harness({ ctwaClid: "clid_1" }, { submission: false });
    withImported(h);

    await expect(h.service.create(WS, "lead_1", input(), actor)).rejects.toBeInstanceOf(
      ConflictException,
    );

    const identity = await resolveLeadConversionIdentity(h.prisma, WS, "lead_1");
    const prior = await findPriorLeadLifetimeConversion(h.prisma, {
      workspaceId: WS,
      identity,
      eventName: "QualifiedLead",
      conversionDestinationId: "destination_any",
      channelId: "channel_a",
      pipeline: "provider_rule",
      ownDedupeKey: "provider-conversion:new",
    });
    expect(prior).toEqual({
      conversionEventLogId: "imported_log",
      reasonCode: "lead_already_converted_other_source",
    });
  });
});
