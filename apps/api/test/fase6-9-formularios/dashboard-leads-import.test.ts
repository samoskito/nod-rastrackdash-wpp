import { describe, expect, it, vi } from "vitest";
import { hashPhoneIdentity } from "../../src/common/phone/phone-identity";
import {
  nextStatus,
  runDashboardLeadsImport,
  supabaseRestSource,
  type DashboardLeadsLead,
} from "../../src/dashboard-leads-import/dashboard-leads-import";
import {
  licenseWriteAssertion,
  parseArgs,
  resolveCreateWorkspaces,
} from "../../src/scripts/import-dashboard-leads";
import {
  leadLifetimeMetaEventId,
  resolveLeadConversionIdentity,
} from "../../src/conversion-events/lead-lifetime-conversion-guard";

// Fase 6.9 (PR #92 do nod, sem o #90): the imported events carry the keys of
// the nod after #153/#158 (manual_conversion + once-per-lead event_id) and of
// the 6.9 CRM stage. Sanitized data only (fictitious names and phones).

type Row = Record<string, any>;

function createDb(
  options: {
    connection?: boolean;
    existingPhone?: string;
    workspaces?: Row[];
  } = {},
) {
  const workspaces: Row[] = [
    { id: "ws_l", slug: "ws-l", members: [] },
    { id: "ws_v", slug: "ws-v", members: [] },
    ...(options.workspaces ?? []),
  ];
  const audits: Row[] = [];
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
  const prisma: Row = {
    workspace: {
      findUnique: vi.fn(async ({ where, select }) => {
        const row = workspaces.find((item) =>
          where.id ? item.id === where.id : item.slug === where.slug,
        );
        if (!row) return null;
        const owner = select?.members?.where;
        return {
          id: row.id,
          members: row.members
            .filter((m: Row) => owner && m.userId === owner.userId && m.role === owner.role)
            .map((m: Row) => ({ id: m.id })),
        };
      }),
      create: vi.fn(async ({ data }) => {
        const row = { id: `ws_new_${data.slug}`, ...data, members: [] };
        workspaces.push(row);
        return { id: row.id, slug: row.slug };
      }),
    },
    workspaceMember: {
      create: vi.fn(async ({ data }) => {
        const row = { id: `member_${data.workspaceId}`, ...data };
        workspaces.find((item) => item.id === data.workspaceId)!.members.push(row);
        return { id: row.id };
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }) => {
        audits.push(data);
        return {};
      }),
    },
    lead: {
      findFirst: vi.fn(async ({ where }) => leads.find((row) => matches(row, where)) ?? null),
      findMany: vi.fn(async ({ where }) => leads.filter((row) => matches(row, where))),
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

  prisma.$transaction = vi.fn(async (fn: (tx: Row) => unknown) => fn(prisma));
  prisma.$executeRaw = vi.fn(async () => 1);

  return { prisma, leads, submissions, logs, workspaces, audits };
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
    full_name: "Pessoa Teste",
    phone: "+5511987650001",
    email: "lead@example.test",
    field_data: [{ name: "email", values: ["lead@example.test"] }],
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
      { id: "p_l", slug: "alfa", name: "Empresa Alfa", active: true },
      { id: "p_v", slug: "beta", name: "Beta Imóveis", active: true },
      { id: "p_c", slug: "gama", name: "Gama Consultoria", active: true },
      { id: "p_x", slug: "exemplo", name: "Projeto Exemplo", active: false },
    ],
    async *leadPages() {
      yield leads;
    },
  };
}

const workspaceBySlug = { alfa: "ws_l", beta: "ws_v" };

describe("runDashboardLeadsImport", () => {
  const history = [
    lead({
      status: "qualificado",
      qualified_at: "2026-10-02T10:00:00Z",
      sent_to_meta: true,
      sent_at: "2026-10-02T10:00:01Z",
      event_name: "LeadQualificado",
      notes: "observação de teste",
    }),
    lead({
      id: "dl_2",
      project_id: "p_v",
      source: "whatsapp",
      meta_lead_id: null,
      ctwa_clid: "ctwa_1",
      page_id: null,
      phone: "5511977770000",
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

    expect(report.unmappedProjects).toEqual(["gama", "exemplo"]);
    expect(report.workspacesCreated).toEqual([]);
    expect(report.unroutedLeads).toBe(1);
    expect(report.projects.alfa).toMatchObject({
      leads: 1,
      peopleCreated: 1,
      submissions: 1,
      importedEvents: 1,
      statusUpdated: 1,
      notesNotImported: 1,
    });
    expect(report.projects.beta).toMatchObject({ leads: 1, importedEvents: 1 });
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
    // #158/#153: a manual conversion, imported, with the once-per-lead
    // event_id a rule or a manual registration of this lead would send.
    const waLog = db.logs.get("manual:ws_v:dashboard-leads:dl_2");
    expect(waLog).toMatchObject({
      status: "imported",
      eventName: "LeadSubmitted",
      sourceTrigger: "manual_conversion",
      sourceEventId: "manual:dashboard-leads:dl_2",
      sourcePayload: expect.objectContaining({
        processingMode: "manual_conversion",
        idempotencyKey: "dashboard-leads:dl_2",
        importedFrom: "dashboard_leads_import",
      }),
    });
    expect(waLog?.eventId).toMatch(/^lead_/);
    const identity = await resolveLeadConversionIdentity(
      db.prisma as never,
      "ws_v",
      waLead.id,
    );
    expect(waLog?.eventId).toBe(
      leadLifetimeMetaEventId("ws_v", identity.lockIdentity, "LeadSubmitted"),
    );
    // No #90 key anywhere.
    expect([...db.logs.keys()].some((key) => key.includes("manual_status"))).toBe(false);
  });

  it("a WhatsApp event outside the once-per-lead catalog is counted, not imported", async () => {
    const db = createDb();

    const report = await runDashboardLeadsImport(
      db.prisma as never,
      source([
        lead({
          id: "dl_x",
          project_id: "p_v",
          source: "whatsapp",
          meta_lead_id: null,
          ctwa_clid: "ctwa_x",
          page_id: null,
          phone: "5511977770000",
          status: "qualificado",
          sent_to_meta: true,
          sent_at: "2026-10-03T10:00:00Z",
          event_name: "Contact",
        }),
      ]),
      { apply: true, workspaceBySlug },
    );

    expect(report.projects.beta).toMatchObject({ importedEvents: 0, eventsNotImported: 1 });
    expect(db.logs.size).toBe(0);
  });

  it("--apply asks the license first; the dry-run never does", async () => {
    const db = createDb();
    const assertCanWrite = vi.fn(async () => {
      throw new Error("Licença bloqueada");
    });

    await expect(
      runDashboardLeadsImport(db.prisma as never, source(history), {
        apply: true,
        workspaceBySlug,
        assertCanWrite,
      }),
    ).rejects.toThrow(/Licença bloqueada/);
    expect(db.prisma.lead.upsert).not.toHaveBeenCalled();

    const dryRun = vi.fn(async () => undefined);
    await runDashboardLeadsImport(db.prisma as never, source(history), {
      apply: false,
      workspaceBySlug,
      assertCanWrite: dryRun,
    });
    expect(dryRun).not.toHaveBeenCalled();
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
    const db = createDb({ existingPhone: "+551177770000" });

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

    expect(report.projects.alfa).toMatchObject({
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
        workspaceBySlug: { alfa: "missing" },
      }),
    ).rejects.toThrow(/nao existe/);
  });
});

describe("runDashboardLeadsImport --create-workspaces", () => {
  const createWorkspaces = { ownerUserId: "owner_1", actorUserId: "platform_1" };
  const history = [
    lead({ id: "dl_l", project_id: "p_l", source: "whatsapp", meta_lead_id: null, ctwa_clid: "c1" }),
    lead({
      id: "dl_v",
      project_id: "p_v",
      source: "whatsapp",
      meta_lead_id: null,
      ctwa_clid: "c2",
      phone: "5511977770000",
    }),
  ];

  it("creates one company per active project for the same owner", async () => {
    const db = createDb();

    const report = await runDashboardLeadsImport(db.prisma as never, source(history), {
      apply: true,
      workspaceBySlug: {},
      createWorkspaces,
    });

    expect(report.workspacesCreated).toEqual(["alfa", "beta", "gama"]);
    expect(report.skippedInactiveProjects).toEqual(["exemplo"]);
    const created = db.workspaces.filter((item) => item.id.startsWith("ws_new_"));
    expect(created.map((item) => [item.slug, item.name])).toEqual([
      ["alfa", "Empresa Alfa"],
      ["beta", "Beta Imóveis"],
      ["gama", "Gama Consultoria"],
    ]);
    for (const workspace of created) {
      expect(workspace.members).toEqual([
        expect.objectContaining({ userId: "owner_1", role: "owner" }),
      ]);
    }
    expect(db.audits).toHaveLength(6);
    expect(db.audits[0]).toMatchObject({
      actorUserId: "platform_1",
      actorType: "platform_owner",
      action: "backoffice.workspace_created",
      afterSummary: { source: "dashboard_leads_import" },
    });
    expect(db.leads.map((row) => row.workspaceId).sort()).toEqual([
      "ws_new_alfa",
      "ws_new_beta",
    ]);
  });

  it("a second run reuses the companies", async () => {
    const db = createDb();
    const run = () =>
      runDashboardLeadsImport(db.prisma as never, source(history), {
        apply: true,
        workspaceBySlug: {},
        createWorkspaces,
      });

    await run();
    const again = await run();

    expect(again.workspacesCreated).toEqual([]);
    expect(again.workspacesReused).toEqual(["alfa", "beta", "gama"]);
    expect(db.prisma.workspace.create).toHaveBeenCalledTimes(3);
    expect(db.leads).toHaveLength(2);
  });

  it("dry-run lists the companies to create without writing", async () => {
    const db = createDb();

    const report = await runDashboardLeadsImport(db.prisma as never, source(history), {
      apply: false,
      workspaceBySlug: {},
      createWorkspaces,
    });

    expect(report.workspacesCreated).toEqual(["alfa", "beta", "gama"]);
    expect(report.projects.alfa).toMatchObject({ leads: 1, peopleCreated: 1 });
    expect(db.prisma.workspace.create).not.toHaveBeenCalled();
    expect(db.prisma.lead.upsert).not.toHaveBeenCalled();
  });

  it("refuses a slug owned by someone else", async () => {
    const db = createDb({
      workspaces: [
        { id: "ws_other", slug: "beta", members: [{ id: "m", userId: "other", role: "owner" }] },
      ],
    });

    await expect(
      runDashboardLeadsImport(db.prisma as never, source(history), {
        apply: false,
        workspaceBySlug: {},
        createWorkspaces,
      }),
    ).rejects.toThrow(/--map beta=/);
  });

  it("--map wins over creation", async () => {
    const db = createDb();

    const report = await runDashboardLeadsImport(db.prisma as never, source(history), {
      apply: true,
      workspaceBySlug: { alfa: "ws_l" },
      createWorkspaces,
    });

    expect(report.workspacesCreated).toEqual(["beta", "gama"]);
    expect(db.leads.find((row) => row.ctwaClid === "c1")?.workspaceId).toBe("ws_l");
  });
});

describe("resolveCreateWorkspaces", () => {
  const users = (rows: Row[]) => ({
    user: {
      findFirst: vi.fn(async ({ where }) =>
        rows.find(
          (row) =>
            row.email === where.email.equals &&
            (!where.platformRole || row.platformRole === where.platformRole),
        ) ?? null,
      ),
    },
  });
  const client = { id: "owner_1", email: "cliente@example.test", passwordHash: "h", platformRole: null };
  const platform = { id: "platform_1", email: "plataforma@example.test", passwordHash: "h", platformRole: "platform_owner" };

  it("accepts an activated client login and a platform owner", async () => {
    await expect(
      resolveCreateWorkspaces(users([client, platform]) as never, "cliente@example.test", "plataforma@example.test"),
    ).resolves.toEqual({ ownerUserId: "owner_1", actorUserId: "platform_1" });
  });

  it("refuses a platform login, a pending activation or a non-platform actor", async () => {
    await expect(
      resolveCreateWorkspaces(users([platform]) as never, "plataforma@example.test", "plataforma@example.test"),
    ).rejects.toThrow(/administrador da plataforma/);
    await expect(
      resolveCreateWorkspaces(
        users([{ ...client, passwordHash: null }, platform]) as never,
        "cliente@example.test",
        "plataforma@example.test",
      ),
    ).rejects.toThrow(/ativado/);
    await expect(
      resolveCreateWorkspaces(users([client]) as never, "cliente@example.test", "cliente@example.test"),
    ).rejects.toThrow(/Platform Owner/);
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
  it("needs a mapping or --create-workspaces and is dry-run by default", () => {
    expect(parseArgs(["--map", "alfa=ws_l"])).toEqual({
      apply: false,
      workspaceBySlug: { alfa: "ws_l" },
      createWorkspaces: false,
      ownerEmail: undefined,
      actorEmail: undefined,
    });
    expect(() => parseArgs(["--apply"])).toThrow(/--map/);
  });

  it("--create-workspaces needs both e-mails", () => {
    expect(
      parseArgs([
        "--create-workspaces",
        "--owner-email",
        "cliente@example.test",
        "--actor-email",
        "plataforma@example.test",
        "--apply",
      ]),
    ).toMatchObject({
      apply: true,
      createWorkspaces: true,
      ownerEmail: "cliente@example.test",
      actorEmail: "plataforma@example.test",
      workspaceBySlug: {},
    });
    expect(() =>
      parseArgs(["--create-workspaces", "--owner-email", "cliente@example.test"]),
    ).toThrow(/--actor-email/);
  });
});
