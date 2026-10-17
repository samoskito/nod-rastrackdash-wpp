import { describe, expect, it, vi } from "vitest";
import { hashPhoneIdentity } from "../src/common/phone/phone-identity";
import {
  nextStatus,
  runDashboardLeadsImport,
  supabaseRestSource,
  type DashboardLeadsLead,
} from "../src/dashboard-leads-import/dashboard-leads-import";
import { parseArgs } from "../src/scripts/import-dashboard-leads";

type Row = Record<string, any>;

function createDb(options: { connection?: boolean; existingPhone?: string } = {}) {
  const leads: Row[] = options.existingPhone
    ? [
        {
          id: "lead_existing",
          workspaceId: "ws_v",
          phoneHash: hashPhoneIdentity(options.existingPhone),
          status: "active",
          adId: "ad_wa",
          createdAt: new Date(0),
        },
      ]
    : [];
  const submissions = new Map<string, Row>();
  const logs = new Map<string, Row>();
  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([key, value]) =>
      value && typeof value === "object" && "in" in value
        ? value.in.includes(row[key])
        : row[key] === value,
    );
  const prisma = {
    workspace: {
      findUnique: vi.fn(async ({ where }) =>
        ["ws_l", "ws_v"].includes(where.id) ? { id: where.id } : null,
      ),
    },
    lead: {
      findFirst: vi.fn(async ({ where }) => leads.find((row) => matches(row, where)) ?? null),
      upsert: vi.fn(async ({ where, create, update }) => {
        const key = where.workspaceId_phoneHash;
        const found = leads.find(
          (item) => item.workspaceId === key.workspaceId && item.phoneHash === key.phoneHash,
        );
        if (found) {
          for (const [field, value] of Object.entries(update as Row)) {
            if (value !== undefined) found[field] = value;
          }
          return { id: found.id };
        }
        const row: Row = { id: `lead_${leads.length + 1}`, createdAt: new Date(), ...create };
        leads.push(row);
        return { id: row.id };
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
      update: vi.fn(async ({ where, data }) => {
        const row = leads.find((item) => item.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
    metaLeadFormConnection: {
      findFirst: vi.fn(async ({ where }) =>
        options.connection !== false && where.workspaceId === "ws_l" && where.pageId === "page_l"
          ? {
              id: "conn_l",
              pageId: "page_l",
              crmDatasetId: "777",
              qualifiedEventName: "LeadQualificado",
            }
          : null,
      ),
    },
    metaLeadSubmission: {
      upsert: vi.fn(async ({ where, create }) => {
        submissions.set(where.metaLeadId, create);
        return create;
      }),
    },
    conversionEventLog: {
      upsert: vi.fn(async ({ where, create }) => {
        if (!logs.has(where.dedupeKey)) logs.set(where.dedupeKey, create);
        return logs.get(where.dedupeKey);
      }),
    },
  };

  return { prisma, leads, submissions, logs };
}

function lead(overrides: Partial<DashboardLeadsLead>): DashboardLeadsLead {
  return {
    id: "dl_1",
    project_id: "p_l",
    source: "lead_form",
    meta_lead_id: "900000000000001",
    ctwa_clid: null,
    page_id: "page_l",
    form_id: "form_1",
    campaign_id: "cmp",
    adset_id: "set",
    ad_id: "ad",
    created_time: "2026-10-01T10:00:00Z",
    created_at: "2026-10-01T10:00:05Z",
    full_name: "Ana Souza",
    phone: "+5547997831903",
    email: "ana@x.com",
    field_data: [{ name: "email", values: ["ana@x.com"] }],
    status: "novo",
    status_changed_at: null,
    qualified_at: null,
    notes: null,
    sent_to_meta: false,
    sent_at: null,
    event_name: null,
    meta_fbtrace_id: null,
    ...overrides,
  };
}

function source(leads: DashboardLeadsLead[]) {
  return {
    listProjects: async () => [
      { id: "p_l", slug: "locaville" },
      { id: "p_v", slug: "venerata" },
      { id: "p_c", slug: "consultatu" },
    ],
    async *leadPages() {
      yield leads;
    },
  };
}

const workspaceBySlug = { locaville: "ws_l", venerata: "ws_v" };

describe("runDashboardLeadsImport", () => {
  const history = [
    lead({
      status: "qualificado",
      qualified_at: "2026-10-02T10:00:00Z",
      sent_to_meta: true,
      sent_at: "2026-10-02T10:00:01Z",
      event_name: "LeadQualificado",
      notes: "ligou",
    }),
    lead({
      id: "dl_2",
      project_id: "p_v",
      source: "whatsapp",
      meta_lead_id: null,
      ctwa_clid: "ctwa_1",
      page_id: null,
      phone: "5547988887777",
      status: "qualificado",
      sent_to_meta: true,
      sent_at: "2026-10-03T10:00:00Z",
      event_name: "LeadSubmitted",
    }),
    lead({ id: "dl_3", project_id: "p_c", source: "web" }),
    lead({ id: "dl_4", project_id: null }),
  ];

  it("dry-run reports without writing", async () => {
    const db = createDb();

    const report = await runDashboardLeadsImport(db.prisma as never, source(history), {
      apply: false,
      workspaceBySlug,
    });

    expect(report.unmappedProjects).toEqual(["consultatu"]);
    expect(report.unroutedLeads).toBe(1);
    expect(report.projects.locaville).toMatchObject({
      leads: 1,
      peopleCreated: 1,
      submissions: 1,
      importedEvents: 1,
      statusUpdated: 1,
      notesNotImported: 1,
    });
    expect(report.projects.venerata).toMatchObject({ leads: 1, importedEvents: 1 });
    expect(db.prisma.lead.upsert).not.toHaveBeenCalled();
    expect(db.prisma.conversionEventLog.upsert).not.toHaveBeenCalled();
  });

  it("apply records sent events under the keys the lead screen uses", async () => {
    const db = createDb();

    await runDashboardLeadsImport(db.prisma as never, source(history), {
      apply: true,
      workspaceBySlug,
    });

    const formLead = db.leads.find((row) => row.workspaceId === "ws_l")!;
    expect(formLead).toMatchObject({ status: "qualified", source: "dashboard_leads" });
    expect(db.submissions.get("900000000000001")).toMatchObject({
      connectionId: "conn_l",
      leadId: formLead.id,
      fetchStatus: "fetched",
    });
    expect(
      db.logs.get("ws_l:meta_lead_form_crm:900000000000001:LeadQualificado"),
    ).toMatchObject({ status: "imported", eventName: "LeadQualificado" });

    const waLead = db.leads.find((row) => row.workspaceId === "ws_v")!;
    expect(waLead.ctwaClid).toBe("ctwa_1");
    expect(
      db.logs.get(`ws_v:${waLead.id}:manual_status:QualifiedLead`),
    ).toMatchObject({ status: "imported", eventName: "LeadSubmitted" });
  });

  it("running twice changes nothing", async () => {
    const db = createDb();
    const run = () =>
      runDashboardLeadsImport(db.prisma as never, source(history), {
        apply: true,
        workspaceBySlug,
      });

    await run();
    await run();

    expect(db.leads).toHaveLength(2);
    expect(db.logs.size).toBe(2);
  });

  it("joins a person already in the workspace and keeps its attribution", async () => {
    const db = createDb({ existingPhone: "+554788887777" });

    await runDashboardLeadsImport(db.prisma as never, source(history), {
      apply: true,
      workspaceBySlug,
    });

    expect(db.leads.filter((row) => row.workspaceId === "ws_v")).toHaveLength(1);
    expect(db.leads[0]).toMatchObject({ id: "lead_existing", adId: "ad_wa", status: "qualified" });
  });

  it("a lead form without connection imports the person, not the event", async () => {
    const db = createDb({ connection: false });

    const report = await runDashboardLeadsImport(db.prisma as never, source(history), {
      apply: true,
      workspaceBySlug,
    });

    expect(report.projects.locaville).toMatchObject({
      skippedWithoutConnection: 1,
      importedEvents: 0,
    });
    expect(db.submissions.size).toBe(0);
    expect(db.leads.some((row) => row.workspaceId === "ws_l")).toBe(true);
  });

  it("refuses a workspace that does not exist", async () => {
    const db = createDb();

    await expect(
      runDashboardLeadsImport(db.prisma as never, source(history), {
        apply: false,
        workspaceBySlug: { locaville: "missing" },
      }),
    ).rejects.toThrow(/nao existe/);
  });
});

describe("nextStatus", () => {
  it("only moves forward and never discards a qualification", () => {
    expect(nextStatus("active", "qualified")).toBe("qualified");
    expect(nextStatus("qualified", "lost")).toBeNull();
    expect(nextStatus("active", "lost")).toBe("lost");
    expect(nextStatus("converted", "qualified")).toBeNull();
    expect(nextStatus("active", "new")).toBeNull();
  });
});

describe("supabaseRestSource", () => {
  it("pages the leads with the service key", async () => {
    const fetcher = vi.fn(async (url: string) =>
      Response.json(url.includes("offset=0") ? [{ id: "a" }, { id: "b" }] : [{ id: "c" }]),
    );
    const rest = supabaseRestSource("https://x.supabase.co/", "service-key", fetcher as never, 2);

    const pages = [];
    for await (const page of rest.leadPages()) pages.push(page);

    expect(pages.map((page) => page.length)).toEqual([2, 1]);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://x.supabase.co/rest/v1/leads?select=*&order=created_at.asc,id.asc&limit=2&offset=0",
    );
    expect((init.headers as Record<string, string>).apikey).toBe("service-key");
  });
});

describe("parseArgs", () => {
  it("needs at least one mapping and is dry-run by default", () => {
    expect(parseArgs(["--map", "locaville=ws_l"])).toEqual({
      apply: false,
      workspaceBySlug: { locaville: "ws_l" },
    });
    expect(() => parseArgs(["--apply"])).toThrow(/--map/);
  });
});
