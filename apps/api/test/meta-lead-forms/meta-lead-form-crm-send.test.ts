import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConversionEventsService,
  META_LEAD_FORM_CRM_TRIGGER,
} from "../../src/conversion-events/conversion-events.service";
import { MetaTokenEncryptionService } from "../../src/integrations/meta/meta-token-encryption.service";

const META_LEAD_ID = "900000000000001";

function createHarness(
  options: { crmDatasetId?: string | null; capiToken?: boolean; daysOld?: number } = {},
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
    metaLeadId: META_LEAD_ID,
    pageId: "111",
    campaignId: "cmp1",
    adSetId: "set1",
    adId: "ad1",
    email: "ana@x.com",
    phone: "+5547997831903",
    metaCreatedAt: new Date(Date.now() - (options.daysOld ?? 1) * 86_400_000),
    createdAt: new Date(),
    connection: {
      id: "conn1",
      active: true,
      crmDatasetId:
        options.crmDatasetId === undefined ? "777" : options.crmDatasetId,
      qualifiedEventName: "LeadQualificado",
      graphTokenEncrypted: graph.encryptedAccessToken,
      graphTokenIv: graph.tokenIv,
      graphTokenTag: graph.tokenTag,
      capiTokenEncrypted: options.capiToken === false ? null : capi.encryptedAccessToken,
      capiTokenIv: options.capiToken === false ? null : capi.tokenIv,
      capiTokenTag: options.capiToken === false ? null : capi.tokenTag,
    },
  };
  const logs = new Map<string, Record<string, unknown>>();
  const prisma = {
    metaLeadSubmission: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === submission.id && where.workspaceId === submission.workspaceId
          ? submission
          : null,
      ),
    },
    conversionEventLog: {
      findUnique: vi.fn(async ({ where }) =>
        where.dedupeKey
          ? ([...logs.values()].find((log) => log.dedupeKey === where.dedupeKey) ?? null)
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
  const record = () =>
    service.recordLeadFormCrmConversion({
      workspaceId: "ws1",
      leadId: "lead1",
      phoneHash: "hash1",
      submissionId: "sub1",
      actorUserId: "user1",
    });

  return { service, logs, record };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("instant-form CRM conversion", () => {
  it("records a ready event with the Dashboard Leads event id", async () => {
    const h = createHarness();

    const recorded = await h.record();

    expect(recorded.created).toHaveLength(1);
    expect(h.logs.get("log1")).toMatchObject({
      sourceTrigger: META_LEAD_FORM_CRM_TRIGGER,
      eventName: "LeadQualificado",
      status: "ready_to_send",
      eventId: `${META_LEAD_ID}:LeadQualificado`,
      pixelId: "777",
    });
    expect((await h.record()).duplicates).toEqual(["log1"]);
  });

  it("an ineligible lead is kept with the reason, never queued", async () => {
    const h = createHarness({ daysOld: 40 });

    const recorded = await h.record();

    expect(recorded.errorMessage).toMatch(/28 dias/);
    expect(h.logs.get("log1")).toMatchObject({ status: "not_eligible" });
  });

  it("sends to the dataset with the CAPI token and marks it sent", async () => {
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
    expect(h.logs.get("log1")).toMatchObject({ status: "sent" });
    expect(h.logs.get("log1")?.sentAt).toBeInstanceOf(Date);
  });

  it("falls back to the Graph token without a CAPI token", async () => {
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

  it("a Meta rejection is stored as a retryable error", async () => {
    const h = createHarness();
    await h.record();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: { message: "bad", code: 100 } }, { status: 400 }),
      ),
    );

    const result = await h.service.sendReadyEvent("log1");

    expect(result.status).toBe("error");
    expect(h.logs.get("log1")).toMatchObject({
      status: "error",
      errorCode: "MetaCapiRejected",
    });
  });
});
