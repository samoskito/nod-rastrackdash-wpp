import { describe, expect, it, vi } from "vitest";
import { hashPhoneIdentity } from "../../src/common/phone/phone-identity";
import { MetaTokenEncryptionService } from "../../src/integrations/meta/meta-token-encryption.service";
import { MetaLeadFormGraphError } from "../../src/meta-lead-forms/meta-lead-form-graph.client";
import { MetaLeadFormsService } from "../../src/meta-lead-forms/meta-lead-forms.service";

const env = {
  META_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  API_PUBLIC_URL: "https://api.example.test/",
};

function createHarness(options: { existingLeadPhone?: string } = {}) {
  const encryption = new MetaTokenEncryptionService(env);
  const token = encryption.encrypt("graph-token-1234");
  const connection = {
    id: "conn1",
    workspaceId: "ws1",
    label: "Locaville",
    pageId: "111",
    formIds: [] as string[],
    active: true,
    graphTokenEncrypted: token.encryptedAccessToken,
    graphTokenIv: token.tokenIv,
    graphTokenTag: token.tokenTag,
  };
  const submissions = new Map<string, Record<string, unknown>>();
  const existingHash = options.existingLeadPhone
    ? hashPhoneIdentity(options.existingLeadPhone)
    : null;
  const prisma = {
    metaLeadFormConnection: {
      findMany: vi.fn(async ({ where }) =>
        where.pageId.in.includes(connection.pageId) ? [connection] : [],
      ),
    },
    metaLeadSubmission: {
      findUnique: vi.fn(
        async ({ where }) => submissions.get(where.metaLeadId) ?? null,
      ),
      upsert: vi.fn(async ({ where, create, update }) => {
        const row = submissions.has(where.metaLeadId) ? update : create;
        submissions.set(where.metaLeadId, { metaLeadId: where.metaLeadId, ...row });
        return row;
      }),
    },
    lead: {
      findFirst: vi.fn(async ({ where }) =>
        existingHash && where.phoneHash.in.includes(existingHash)
          ? { id: "lead_wa", phoneHash: existingHash }
          : null,
      ),
    },
  };
  const leads = {
    upsertFromWhatsappWebhook: vi.fn(async (_input: unknown) => ({
      id: "lead_1",
    })),
  };
  const graph = {
    fetchLead: vi.fn(async (id: string, graphToken: string) => {
      expect(graphToken).toBe("graph-token-1234");
      return {
        id,
        created_time: "2026-10-16T10:00:00+0000",
        campaign_id: "cmp1",
        adset_id: "set1",
        ad_id: "ad1",
        form_id: "form1",
        field_data: [
          { name: "full_name", values: ["Ana Souza"] },
          { name: "email", values: ["ana@x.com"] },
          { name: "phone_number", values: ["+5547997831903"] },
        ],
      };
    }),
    subscribePage: vi.fn(),
  };
  const service = new MetaLeadFormsService(
    prisma as never,
    encryption,
    leads as never,
    env,
    graph as never,
  );

  return { service, prisma, leads, graph, submissions };
}

const change = { leadgen_id: "900000000000001", page_id: "111", form_id: "form1" };

describe("MetaLeadFormsService.ingestLeadgen", () => {
  it("reads the lead on the Graph API and saves person and submission", async () => {
    const h = createHarness();

    const result = await h.service.ingestLeadgen([change]);

    expect(result).toMatchObject({ saved: 1, unrouted: 0, fetchFailed: 0 });
    expect(h.leads.upsertFromWhatsappWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws1",
        name: "Ana Souza",
        phone: "+5547997831903",
        phoneHash: hashPhoneIdentity("+5547997831903"),
        source: "meta_lead_form",
        recordMessageTimestamps: false,
        adId: "ad1",
      }),
    );
    expect(h.submissions.get(change.leadgen_id)).toMatchObject({
      workspaceId: "ws1",
      connectionId: "conn1",
      leadId: "lead_1",
      email: "ana@x.com",
      adId: "ad1",
      fetchStatus: "fetched",
    });
  });

  it("joins the person already talking on WhatsApp without its attribution", async () => {
    const h = createHarness({ existingLeadPhone: "+554797831903" });

    await h.service.ingestLeadgen([change]);

    const [call] = h.leads.upsertFromWhatsappWebhook.mock
      .calls[0] as unknown as [Record<string, unknown>];
    expect(call.phoneHash).toBe(hashPhoneIdentity("+554797831903"));
    expect(call).not.toHaveProperty("adId");
    expect(call.preserveExistingSource).toBe(true);
  });

  it("a redelivered lead is a duplicate", async () => {
    const h = createHarness();
    await h.service.ingestLeadgen([change]);

    const again = await h.service.ingestLeadgen([change]);

    expect(again).toMatchObject({ saved: 0, duplicates: 1 });
    expect(h.graph.fetchLead).toHaveBeenCalledTimes(1);
  });

  it("keeps a Graph failure as fetch_failed and retries it next time", async () => {
    const h = createHarness();
    h.graph.fetchLead.mockRejectedValueOnce(
      new MetaLeadFormGraphError("token expired", 400, 190),
    );

    const first = await h.service.ingestLeadgen([change]);
    expect(first.fetchFailed).toBe(1);
    expect(h.submissions.get(change.leadgen_id)).toMatchObject({
      fetchStatus: "fetch_failed",
      fetchError: "token expired",
      leadId: null,
    });

    const second = await h.service.ingestLeadgen([change]);
    expect(second.saved).toBe(1);
    expect(h.submissions.get(change.leadgen_id)?.fetchStatus).toBe("fetched");
  });

  it("a Page without connection is unrouted and never read", async () => {
    const h = createHarness();

    const result = await h.service.ingestLeadgen([{ ...change, page_id: "222" }]);

    expect(result.unrouted).toBe(1);
    expect(h.graph.fetchLead).not.toHaveBeenCalled();
  });
});
