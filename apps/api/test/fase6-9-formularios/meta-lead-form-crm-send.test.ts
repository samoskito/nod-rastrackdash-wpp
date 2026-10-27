import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversionEventsService } from "../../src/conversion-events/conversion-events.service";
import {
  canRetryConversionEvent,
  canRetryMetaAuthFailureConversionEvent,
} from "../../src/conversion-events/conversion-event-retry";
import { MetaTokenEncryptionService } from "../../src/integrations/meta/meta-token-encryption.service";
import { META_LEAD_FORM_CRM_TRIGGER } from "../../src/meta-lead-forms/meta-crm-capi";

// Fase 6.9 (PR #91 do nod): CRM stage of a Meta instant form, recorded through
// recordLeadFormCrmStage (manual conversion / Kanban) and sent by
// sendReadyEvent to the connection's dataset. Sanitized data only.

const META_LEAD_ID = "900000000000001";

function createHarness(
  options: {
    crmDatasetId?: string | null;
    capiToken?: boolean;
    daysOld?: number;
    active?: boolean;
  } = {},
) {
  const encryption = new MetaTokenEncryptionService({
    META_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
  });
  const graph = encryption.encrypt("graph-token");
  const capi = encryption.encrypt("dataset-token");
  const submission = {
    id: "sub1",
    workspaceId: "ws1",
    connectionId: "conn1",
    leadId: "lead1",
    metaLeadId: META_LEAD_ID,
    pageId: "111",
    campaignId: "cmp1",
    adSetId: "set1",
    adId: "ad1",
    email: "lead@example.test",
    phone: "+5511900000001",
    metaCreatedAt: new Date(Date.now() - (options.daysOld ?? 1) * 86_400_000),
    createdAt: new Date(),
    connection: {
      id: "conn1",
      active: options.active ?? true,
      crmDatasetId:
        options.crmDatasetId === undefined ? "777" : options.crmDatasetId,
      qualifiedEventName: "LeadQualificado",
      graphTokenEncrypted: graph.encryptedAccessToken,
      graphTokenIv: graph.tokenIv,
      graphTokenTag: graph.tokenTag,
      capiTokenEncrypted:
        options.capiToken === false ? null : capi.encryptedAccessToken,
      capiTokenIv: options.capiToken === false ? null : capi.tokenIv,
      capiTokenTag: options.capiToken === false ? null : capi.tokenTag,
    },
  };
  const logs = new Map<string, Record<string, unknown>>();
  const prisma = {
    metaLeadSubmission: {
      findFirst: vi.fn(async ({ where }) => {
        if (where.workspaceId !== submission.workspaceId) return null;
        if (where.id) return where.id === submission.id ? submission : null;
        return where.leadId.in.includes(submission.leadId) &&
          where.fetchStatus === "fetched"
          ? submission
          : null;
      }),
    },
    conversionEventLog: {
      findUnique: vi.fn(async ({ where }) =>
        where.dedupeKey
          ? ([...logs.values()].find((log) => log.dedupeKey === where.dedupeKey) ??
            null)
          : (logs.get(where.id) ?? null),
      ),
      create: vi.fn(async ({ data }) => {
        const log = { id: `log${logs.size + 1}`, ...data };
        logs.set(log.id, log);
        return log;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const log = logs.get(where.id);
        if (!log || log.status !== where.status) return { count: 0 };
        Object.assign(log, data);
        return { count: 1 };
      }),
    },
  };
  const service = new ConversionEventsService(
    prisma as never,
    {} as never,
    encryption,
    undefined,
    { getLockState: async () => ({ inert: false, locked: false }) } as never,
    { META_GRAPH_API_VERSION: "v21.0" },
  );
  const record = (leadIds?: string[]) =>
    service.recordLeadFormCrmStage({
      workspaceId: "ws1",
      leadId: "lead1",
      leadIds,
      phoneHash: "hash1",
      actorUserId: "user1",
      qualifiedAt: new Date(),
    });

  return { service, logs, record, prisma };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Fase 6.9: etapa de CRM do formulário Meta", () => {
  it("records a ready event with the Dashboard Leads event id, once", async () => {
    const h = createHarness();

    const recorded = await h.record();

    expect(recorded).toMatchObject({
      created: ["log1"],
      eventName: "LeadQualificado",
      status: "ready_to_send",
    });
    expect(h.logs.get("log1")).toMatchObject({
      sourceTrigger: META_LEAD_FORM_CRM_TRIGGER,
      eventName: "LeadQualificado",
      status: "ready_to_send",
      eventId: `${META_LEAD_ID}:LeadQualificado`,
      dedupeKey: `ws1:meta_lead_form_crm:${META_LEAD_ID}:LeadQualificado`,
      pixelId: "777",
    });
    expect((await h.record())?.duplicates).toEqual(["log1"]);
  });

  it("a lead without a form submission records nothing", async () => {
    const h = createHarness();

    expect(await h.record(["other_lead"])).toBeNull();
    expect(h.logs.size).toBe(0);
  });

  it("an ineligible lead is kept with the reason, never ready", async () => {
    const h = createHarness({ daysOld: 40 });

    const recorded = await h.record();

    expect(recorded?.errorMessage).toMatch(/28 dias/);
    expect(h.logs.get("log1")).toMatchObject({ status: "not_eligible" });
  });

  it("without a dataset the stage is a configuration block, resendable after the fix", async () => {
    const h = createHarness({ crmDatasetId: null });

    const recorded = await h.record();

    expect(recorded?.status).toBe("not_configured");
    expect(h.logs.get("log1")).toMatchObject({
      status: "not_configured",
      errorCode: "MissingMetaDestination",
    });
    expect(canRetryConversionEvent(h.logs.get("log1") as never)).toBe(true);
  });

  it("claims the log before posting: a second worker never posts again", async () => {
    const h = createHarness();
    await h.record();
    const fetcher = vi.fn(async () =>
      Response.json({ events_received: 1, fbtrace_id: "t" }),
    );
    vi.stubGlobal("fetch", fetcher);

    const [first, second] = await Promise.all([
      h.service.sendReadyEvent("log1"),
      h.service.sendReadyEvent("log1"),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect([first.status, second.status].sort()).toEqual(["sent", "skipped"]);
    const stored = h.logs.get("log1")!;
    expect(stored.status).toBe("sent");
    // The audit copy keeps the 15-17 digit lead id exact (a string).
    expect(JSON.stringify(stored.providerRequestPayload)).toContain(
      `"lead_id":"${META_LEAD_ID}"`,
    );
  });

  it("previews what qualifying would do", async () => {
    const ready = createHarness();
    expect(await ready.service.previewLeadFormCrmStage("ws1", ["lead1"])).toEqual({
      eventName: "LeadQualificado",
      willSend: true,
      reason: null,
    });
    await ready.record();
    expect(
      await ready.service.previewLeadFormCrmStage("ws1", ["lead1"]),
    ).toMatchObject({ willSend: false, reason: expect.stringMatching(/já foi registrada/) });

    const paused = createHarness({ active: false });
    expect(
      await paused.service.previewLeadFormCrmStage("ws1", ["lead1"]),
    ).toMatchObject({ willSend: false, reason: expect.stringMatching(/desativada/) });
  });

  it("sends to the dataset with the dataset token and marks it sent", async () => {
    const h = createHarness();
    await h.record();
    const fetcher = vi.fn(async () =>
      Response.json({ events_received: 1, fbtrace_id: "t" }),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await h.service.sendReadyEvent("log1");

    expect(result.status).toBe("sent");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v21.0/777/events");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer dataset-token",
    );
    expect(String(init.body)).toContain(`"lead_id":${META_LEAD_ID}`);
    expect(String(init.body)).not.toContain("dataset-token");
    expect(h.logs.get("log1")).toMatchObject({ status: "sent" });
    expect(h.logs.get("log1")?.sentAt).toBeInstanceOf(Date);
  });

  it("falls back to the Graph token without a dataset token", async () => {
    const h = createHarness({ capiToken: false });
    await h.record();
    const fetcher = vi.fn(async () =>
      Response.json({ events_received: 1, fbtrace_id: "t" }),
    );
    vi.stubGlobal("fetch", fetcher);

    await h.service.sendReadyEvent("log1");

    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer graph-token",
    );
  });

  it("a paused connection blocks as configuration (Reenviar bloqueados)", async () => {
    const h = createHarness({ active: false });
    await h.record();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const result = await h.service.sendReadyEvent("log1");

    expect(fetcher).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "not_configured",
      errorCode: "MissingMetaDestination",
    });
    expect(
      canRetryConversionEvent(h.logs.get("log1") as never),
    ).toBe(true);
  });

  it("a Meta rejection keeps the Graph code; a dead login (190) is resendable", async () => {
    const h = createHarness();
    await h.record();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { message: "token expired", code: 190, error_subcode: 463 } },
          { status: 400 },
        ),
      ),
    );

    const result = await h.service.sendReadyEvent("log1");

    expect(result.status).toBe("error");
    const log = h.logs.get("log1")!;
    expect(log).toMatchObject({
      status: "error",
      errorCode: "MetaCapiRejected",
      providerResponseSummary: {
        httpStatus: 400,
        error: { code: 190, error_subcode: 463 },
      },
    });
    expect(
      canRetryMetaAuthFailureConversionEvent({
        ...(log as unknown as Parameters<typeof canRetryMetaAuthFailureConversionEvent>[0]),
        sourceTrigger: META_LEAD_FORM_CRM_TRIGGER,
      }),
    ).toBe(true);
  });

  it("an ordinary refusal (code 100) is not resent", async () => {
    const h = createHarness();
    await h.record();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: { message: "bad", code: 100 } }, { status: 400 }),
      ),
    );

    await h.service.sendReadyEvent("log1");

    expect(canRetryConversionEvent(h.logs.get("log1") as never)).toBe(false);
  });
});
