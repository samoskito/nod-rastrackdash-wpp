import { describe, expect, it, vi } from "vitest";
import {
  applyDeferredLeadNovoTiming,
  resolveRuleOverrideReportMode,
  firstContactAttribution,
  firstContactScopeWhere,
  loadLeadIdsByPhoneHash,
  phoneHashesWithoutLeadId,
  repeatConversationLeadIds,
} from "../src/leads/lead-cohort";
import { LeadsService } from "../src/leads/leads.service";
import {
  ReportingMetricsEngine,
  type ReportingMetricEvent,
} from "../src/reporting/reporting-metrics.engine";

type Row = Record<string, unknown>;

/** Small Prisma-like `where` evaluator for the operators these queries use. */
function matches(record: Row, where?: Row): boolean {
  if (!where) return true;

  return Object.entries(where).every(([key, value]) => {
    if (key === "AND")
      return (value as Row[]).every((item) => matches(record, item));
    if (key === "OR")
      return (value as Row[]).some((item) => matches(record, item));
    if (key === "NOT")
      return !(Array.isArray(value) ? value : [value]).some((item) =>
        matches(record, item as Row),
      );

    const current = record[key];

    if (value && typeof value === "object" && !(value instanceof Date)) {
      const condition = value as Row;
      const time = (input: unknown) => new Date(input as Date).getTime();

      if ("endsWith" in condition)
        return String(current ?? "").endsWith(String(condition.endsWith));
      if ("startsWith" in condition)
        return String(current ?? "").startsWith(String(condition.startsWith));

      if ("in" in condition)
        return (condition.in as unknown[]).includes(current);
      if ("notIn" in condition)
        return !(condition.notIn as unknown[]).includes(current);
      if ("not" in condition) return (current ?? null) !== condition.not;
      if ("lt" in condition)
        return current instanceof Date && time(current) < time(condition.lt);
      if ("gte" in condition || "lte" in condition) {
        if (!(current instanceof Date)) return false;
        if ("gte" in condition && time(current) < time(condition.gte))
          return false;
        if ("lte" in condition && time(current) > time(condition.lte))
          return false;
        return true;
      }
    }

    return (current ?? null) === value;
  });
}

function fakePrisma(db: { leads: Row[]; events: Row[] }) {
  const findMany =
    (rows: () => Row[]) =>
    async (args?: { where?: Row; skip?: number; take?: number }) => {
      const found = rows().filter((row) => matches(row, args?.where));
      const start = args?.skip ?? 0;
      return found.slice(start, args?.take ? start + args.take : undefined);
    };

  return {
    lead: {
      findMany: findMany(() => db.leads),
      count: async (args?: { where?: Row }) =>
        db.leads.filter((row) => matches(row, args?.where)).length,
    },
    conversionEventLog: {
      findMany: findMany(() => db.events),
      findFirst: async (args?: { where?: Row }) =>
        db.events.find((row) => matches(row, args?.where)) ?? null,
    },
    metaCampaign: {
      findMany: async () => [
        { campaignId: "cmp_a", name: "Campanha A" },
        { campaignId: "cmp_b", name: "Campanha B" },
      ],
    },
    metaAd: { findMany: async () => [] },
    metaAdSet: { findMany: async () => [] },
    whatsappInstance: { findFirst: async () => null },
  };
}

const leadSubmitted = (input: Row): Row => ({
  workspaceId: "workspace_1",
  eventName: "LeadSubmitted",
  status: "sent",
  businessSource: "paid",
  phoneHash: "phone_ab",
  ...input,
});

/**
 * The owner's example: first contact on 11/10 through campaign A, back on
 * 14/10 through campaign B. The Lead row now points at B (upserts keep the
 * latest ad); the reports keep the lead on A.
 */
function aToBDb() {
  return {
    leads: [
      {
        id: "lead_ab",
        workspaceId: "workspace_1",
        name: "Volta por B",
        phoneDisplay: null,
        phoneHash: "phone_ab",
        status: "active",
        source: "uazapi",
        labels: [],
        campaignId: "cmp_b",
        adSetId: "adset_b",
        adId: "ad_b",
        ctwaClid: "clid_b",
        ctwaSourceUrl: null,
        ctwaThumbnailUrl: null,
        firstMessageAt: new Date("2026-10-11T15:00:00.000Z"),
        lastMessageAt: new Date("2026-10-14T15:00:00.000Z"),
        createdAt: new Date("2026-10-11T15:00:00.000Z"),
        updatedAt: new Date("2026-10-14T15:00:00.000Z"),
      },
    ] as Row[],
    events: [
      leadSubmitted({
        id: "ev_a",
        leadId: "lead_ab",
        campaignId: "cmp_a",
        adSetId: "adset_a",
        adId: "ad_a",
        eventOccurredAt: new Date("2026-10-11T15:00:00.000Z"),
      }),
      leadSubmitted({
        id: "ev_b",
        leadId: "lead_ab",
        campaignId: "cmp_b",
        adSetId: "adset_b",
        adId: "ad_b",
        eventOccurredAt: new Date("2026-10-14T15:00:00.000Z"),
      }),
    ] as Row[],
  };
}

describe("first-contact attribution (shared by Leads and reports)", () => {
  it("lists the A->B lead under campaign A, like the reports, and never under B as new", async () => {
    const service = new LeadsService(fakePrisma(aToBDb()) as never);
    const period = { since: "2026-10-11", until: "2026-10-11" };

    const underA = await service.listLeadsPage("workspace_1", {
      ...period,
      campaignId: "cmp_a",
    });
    const underB = await service.listLeadsPage("workspace_1", {
      ...period,
      campaignId: "cmp_b",
    });
    const adSetA = await service.listLeadsPage("workspace_1", {
      ...period,
      adSetId: "adset_a",
      adId: "ad_a",
    });

    expect(underA.pagination.totalItems).toBe(1);
    expect(underA.items[0]).toMatchObject({
      campaignId: "cmp_a",
      campaignName: "Campanha A",
      adId: "ad_a",
    });
    expect(underB.pagination.totalItems).toBe(0);
    expect(adSetA.pagination.totalItems).toBe(1);
  });

  it("lists the A->B lead as 'voltou' on the return day under the campaign that brought it back", async () => {
    const service = new LeadsService(fakePrisma(aToBDb()) as never);
    const today = { since: "2026-10-14", until: "2026-10-14" };

    const newToday = await service.listLeadsPage("workspace_1", today);
    const returnedToday = await service.listLeadsPage("workspace_1", {
      ...today,
      base: "returning",
    });

    expect(newToday.pagination.totalItems).toBe(0);
    expect(returnedToday.pagination.totalItems).toBe(1);
  });

  it("exports with the same first-contact campaign filter", async () => {
    const service = new LeadsService(fakePrisma(aToBDb()) as never);

    const underA = await service.prepareLeadExport("workspace_1", {
      campaignId: "cmp_a",
    });
    const underB = await service.prepareLeadExport("workspace_1", {
      campaignId: "cmp_b",
    });
    const rows = [];

    for await (const batch of underA.batches) rows.push(...batch);

    expect(underA.totalItems).toBe(1);
    expect(underB.totalItems).toBe(0);
    expect(rows[0]).toMatchObject({ campaign: "Campanha A", adId: "ad_a" });
  });

  it("keeps the filter short: only leads whose ad changed are listed by id", async () => {
    const db = aToBDb();
    const where = await firstContactScopeWhere(
      fakePrisma(db) as never,
      "workspace_1",
      "campaignId",
      "cmp_b",
    );

    expect(where).toEqual({
      OR: [{ campaignId: "cmp_b", id: { notIn: ["lead_ab"] } }],
    });
  });

  it("fills fields the first event lacks only from compatible later events", () => {
    const lead = { campaignId: "cmp_b", adSetId: "adset_b", adId: "ad_b" };
    const event = (input: Row) =>
      leadSubmitted({ leadId: "lead_ab", ...input }) as never;

    // First event names only the campaign; a later one of the same campaign
    // completes it, the B row (other campaign) never does.
    expect(
      firstContactAttribution(lead, [
        event({
          campaignId: "cmp_a",
          adSetId: null,
          adId: null,
          eventOccurredAt: new Date("2026-10-11T10:00:00.000Z"),
        }),
        event({
          campaignId: "cmp_a",
          adSetId: "adset_a",
          adId: "ad_a",
          eventOccurredAt: new Date("2026-10-12T10:00:00.000Z"),
        }),
        event({
          campaignId: "cmp_b",
          adSetId: "adset_b",
          adId: "ad_b",
          eventOccurredAt: new Date("2026-10-14T10:00:00.000Z"),
        }),
      ]),
    ).toEqual({ campaignId: "cmp_a", adSetId: "adset_a", adId: "ad_a" });
    // Only an ad id (no hierarchy yet): the row fills nothing of another ad.
    expect(
      firstContactAttribution(lead, [
        event({
          campaignId: null,
          adSetId: null,
          adId: "ad_a",
          eventOccurredAt: new Date("2026-10-11T10:00:00.000Z"),
        }),
      ]),
    ).toEqual({ campaignId: null, adSetId: null, adId: "ad_a" });
    // No ad event: the row stands; skipped/organic events are ignored.
    expect(
      firstContactAttribution(lead, [
        event({
          campaignId: "cmp_a",
          status: "skipped",
          eventOccurredAt: new Date("2026-10-11T10:00:00.000Z"),
        }),
        event({
          campaignId: "cmp_a",
          businessSource: "organic",
          eventOccurredAt: new Date("2026-10-11T10:00:00.000Z"),
        }),
      ]),
    ).toEqual(lead);
  });
});

describe("conversaram mais de uma vez (shared by Leads and reports)", () => {
  const lead = (id: string, firstMessageAt: string): Row => ({
    ...aToBDb().leads[0]!,
    id,
    phoneHash: "phone_dup",
    firstMessageAt: new Date(firstMessageAt),
    createdAt: new Date(firstMessageAt),
  });

  /** One phone, two Lead rows (e.g. two numbers of the workspace). */
  function samePhoneDb() {
    const at = (time: string) => new Date(`2026-10-14T${time}:00.000Z`);

    return {
      leads: [
        lead("lead_x", "2026-10-14T12:00:00.000Z"),
        lead("lead_y", "2026-09-01T12:00:00.000Z"),
      ],
      events: [
        leadSubmitted({
          id: "ev_x",
          leadId: "lead_x",
          phoneHash: "phone_dup",
          eventOccurredAt: at("12:00"),
        }),
        // No lead id: counts for every lead of the phone.
        leadSubmitted({
          id: "ev_phone",
          leadId: null,
          phoneHash: "phone_dup",
          eventOccurredAt: at("13:00"),
        }),
        leadSubmitted({
          id: "ev_y",
          leadId: "lead_y",
          phoneHash: "phone_dup",
          eventOccurredAt: at("14:00"),
        }),
        leadSubmitted({
          id: "ev_skipped",
          leadId: "lead_x",
          phoneHash: "phone_dup",
          status: "skipped",
          eventOccurredAt: at("15:00"),
        }),
      ] as Row[],
    };
  }

  it("counts a conversation without lead id for every lead of the phone", () => {
    expect(
      repeatConversationLeadIds(
        [
          { leadId: "lead_x" },
          { leadId: null, phoneHash: "phone_dup" },
          { leadId: "lead_y" },
          { leadId: null, phoneHash: "phone_unknown" },
          { leadId: null, phoneHash: "phone_unknown" },
        ],
        new Map([["phone_dup", ["lead_x", "lead_y"]]]),
      ).sort(),
    ).toEqual(["lead_x", "lead_y"]);
  });

  it("gives the Leads page and the reports the same people", async () => {
    const db = samePhoneDb();
    const prisma = fakePrisma(db);
    const page = await new LeadsService(prisma as never).listLeadsPage(
      "workspace_1",
      { base: "repeat", since: "2026-10-14", until: "2026-10-14" },
    );
    const events = db.events.map((event) => ({
      adId: null,
      adSetId: null,
      campaignId: "cmp_a",
      currency: null,
      valueCents: null,
      ...event,
    })) as unknown as ReportingMetricEvent[];
    const metrics = new ReportingMetricsEngine().calculate({
      events,
      insight: { spendCents: 0, metaConversationsStarted: 0 },
      leads: [],
      leadIdsByPhoneHash: await loadLeadIdsByPhoneHash(
        prisma,
        "workspace_1",
        phoneHashesWithoutLeadId(events),
      ),
      scope: {},
    });

    expect(page.items.map((item) => item.id).sort()).toEqual([
      "lead_x",
      "lead_y",
    ]);
    expect(metrics.repeatConversationLeads).toBe(2);
  });
});

/**
 * Tarefa 20: "Conversas por anuncio" counts every entry (deferred receipts
 * included); "Leads novos" follows the LeadSubmitted actually sent: on entry
 * by default, on the rule send for a lead whose entry was deferred.
 */
describe("leads novos x conversas with the LeadSubmitted rule override", () => {
  const leadRow = (id: string, phoneHash: string, firstMessageAt: string) => ({
    id,
    workspaceId: "workspace_1",
    name: id,
    phoneDisplay: null,
    phoneHash,
    status: "active",
    source: "unnichat",
    labels: [],
    campaignId: "cmp_a",
    adSetId: "adset_a",
    adId: "ad_a",
    ctwaClid: `clid_${id}`,
    ctwaSourceUrl: null,
    ctwaThumbnailUrl: null,
    firstMessageAt: new Date(firstMessageAt),
    lastMessageAt: new Date(firstMessageAt),
    createdAt: new Date(firstMessageAt),
    updatedAt: new Date(firstMessageAt),
  });

  /** lead_n: entry sent on 11/10. lead_d: entry deferred on 11/10, rule sent on 13/10. */
  function overrideDb() {
    return {
      leads: [
        leadRow("lead_n", "phone_n", "2026-10-11T15:00:00.000Z"),
        leadRow("lead_d", "phone_d", "2026-10-11T16:00:00.000Z"),
      ] as Row[],
      events: [
        leadSubmitted({
          id: "entry_n",
          leadId: "lead_n",
          phoneHash: "phone_n",
          sourceTrigger: "inbound_webhook:unnichat",
          campaignId: "cmp_a",
          adSetId: "adset_a",
          adId: "ad_a",
          eventOccurredAt: new Date("2026-10-11T15:00:00.000Z"),
        }),
        leadSubmitted({
          id: "entry_d",
          leadId: "lead_d",
          phoneHash: "phone_d",
          sourceTrigger: "inbound_webhook:unnichat",
          status: "not_eligible",
          errorCode: "lead_submitted_deferred_to_rule",
          campaignId: "cmp_a",
          adSetId: "adset_a",
          adId: "ad_a",
          eventOccurredAt: new Date("2026-10-11T16:00:00.000Z"),
        }),
        leadSubmitted({
          id: "rule_d",
          leadId: "lead_d",
          phoneHash: "phone_d",
          sourceTrigger: "inbound_webhook:unnichat:provider_automation",
          campaignId: "cmp_a",
          adSetId: "adset_a",
          adId: "ad_a",
          eventOccurredAt: new Date("2026-10-13T12:00:00.000Z"),
        }),
      ] as Row[],
    };
  }
  const day = (date: string) => ({
    gte: new Date(`${date}T03:00:00.000Z`),
    lte: new Date(
      new Date(`${date}T03:00:00.000Z`).getTime() + 24 * 3600_000 - 1,
    ),
  });
  const metricEvents = (rows: Row[]) =>
    rows.map((row) => ({
      currency: null,
      valueCents: null,
      ...row,
    })) as unknown as ReportingMetricEvent[];

  const flagOn = { LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED: "true" };
  // nod: the flag is on by default; only an explicit false turns it off.
  const flagOff = { LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED: "false" };

  it("flag off (explicit false): Leads page is exactly the previous behavior (deferred lead new on the entry day), no extra query", async () => {
    const prisma = fakePrisma(overrideDb());
    const findFirst = vi.spyOn(prisma.conversionEventLog, "findFirst");
    const service = new LeadsService(prisma as never, flagOff);
    const page = await service.listLeadsPage("workspace_1", {
      since: "2026-10-11",
      until: "2026-10-11",
    });
    expect(page.items.map((item) => item.id).sort()).toEqual(["lead_d", "lead_n"]);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("report mode: on only with the flag AND a deferred receipt around the period", async () => {
    const db = overrideDb();
    const range = day("2026-10-13");
    expect(
      await resolveRuleOverrideReportMode(fakePrisma(db) as never, "workspace_1", range, flagOff),
    ).toBe(false);
    // nod default (variable unset): on.
    expect(
      await resolveRuleOverrideReportMode(fakePrisma(db) as never, "workspace_1", range, {}),
    ).toBe(true);
    expect(
      await resolveRuleOverrideReportMode(fakePrisma(db) as never, "workspace_1", range, flagOn),
    ).toBe(true);
    db.events = db.events.filter((event) => event.id !== "entry_d");
    expect(
      await resolveRuleOverrideReportMode(fakePrisma(db) as never, "workspace_1", range, flagOn),
    ).toBe(false);
  });

  it("Leads page: the deferred lead is new on the rule day, not on the entry day", async () => {
    const service = new LeadsService(fakePrisma(overrideDb()) as never, flagOn);
    const ids = async (since: string, until: string) =>
      (await service.listLeadsPage("workspace_1", { since, until })).items
        .map((item) => item.id)
        .sort();

    expect(await ids("2026-10-11", "2026-10-11")).toEqual(["lead_n"]);
    expect(await ids("2026-10-12", "2026-10-12")).toEqual([]);
    expect(await ids("2026-10-13", "2026-10-13")).toEqual(["lead_d"]);
    expect(await ids("2026-10-11", "2026-10-13")).toEqual(["lead_d", "lead_n"]);
  });

  it("reports: conversas count the deferred entry; leads novos count it once, dated by the rule send", async () => {
    const db = overrideDb();
    const prisma = fakePrisma(db);
    const engine = new ReportingMetricsEngine();
    const leadsOf = async (range: { gte: Date; lte: Date }) =>
      applyDeferredLeadNovoTiming(
        prisma as never,
        "workspace_1",
        db.leads.filter((lead) =>
          matches(lead, { firstMessageAt: range }),
        ) as never[],
        range,
        async (wanted) =>
          db.leads.filter((lead) => wanted.includes(lead.id as string)) as never[],
      );
    const metrics = async (range: { gte: Date; lte: Date }) =>
      engine.calculate({
        events: metricEvents(
          db.events.filter((event) => matches(event, { eventOccurredAt: range })),
        ),
        insight: { spendCents: 0, metaConversationsStarted: 0 },
        leads: (await leadsOf(range)) as never,
        scope: {},
      });

    // Entry day: both conversations, only the regular lead is new.
    const entryDay = await metrics(day("2026-10-11"));
    expect(entryDay.adConversationEvents).toBe(2);
    expect(entryDay.realConversations).toBe(1);
    // Rule day: no new conversation (the rule LeadSubmitted is not one), the
    // deferred lead becomes new.
    const ruleDay = await metrics(day("2026-10-13"));
    expect(ruleDay.adConversationEvents).toBe(0);
    expect(ruleDay.realConversations).toBe(1);
    // Whole period: two conversations, two leads novos (never three).
    const period = {
      gte: day("2026-10-11").gte,
      lte: day("2026-10-13").lte,
    };
    const whole = await metrics(period);
    expect(whole.adConversationEvents).toBe(2);
    expect(whole.realConversations).toBe(2);
    expect(whole.repeatConversationLeads).toBe(0);
    // Daily chart: the deferred lead lands on the rule day.
    const daily = engine.dailyRealConversationCounts(
      { leads: (await leadsOf(period)) as never },
      (date) => date.toISOString().slice(0, 10),
    );
    expect(Object.fromEntries(daily)).toEqual({
      "2026-10-11": 1,
      "2026-10-13": 1,
    });
  });

  it("deferred lead whose rule never fired: in conversas, never in leads novos", async () => {
    const db = overrideDb();
    db.events = db.events.filter((event) => event.id !== "rule_d");
    const range = day("2026-10-11");
    const leads = await applyDeferredLeadNovoTiming(
      fakePrisma(db) as never,
      "workspace_1",
      db.leads as never[],
      range,
      async () => [],
    );
    expect(leads.map((lead: Row) => lead.id)).toEqual(["lead_n"]);
  });

  it("without deferred receipts nothing changes (flag off / no override rule)", async () => {
    const db = overrideDb();
    db.events = db.events.filter((event) => event.leadId === "lead_n");
    const input = db.leads as never[];
    await expect(
      applyDeferredLeadNovoTiming(
        fakePrisma(db) as never,
        "workspace_1",
        input,
        day("2026-10-11"),
        async () => {
          throw new Error("must not load extra leads");
        },
      ),
    ).resolves.toBe(input);
  });
});
