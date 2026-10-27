import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  crmBoardSql,
  crmColumnSql,
  crmLeadStageSql,
  decodeCrmCursor,
  encodeCrmCursor,
  type CrmPlacementInput,
} from "../../src/crm/crm-board-query";
import {
  CRM_TEST_WS as WS,
  CrmTestDb,
  daysAgo as at,
  type CrmLeadSeed,
  type CrmLogSeed,
} from "../helpers/crm-pglite";

/**
 * The CRM board SQL executed for real (in-process Postgres, PGlite), on the
 * columns of "Lead" / "ConversionEventLog" it reads. Nothing touches the
 * project database.
 */

const range = {
  gte: new Date("2026-09-25T03:00:00.000Z"),
  lte: new Date("2026-10-25T02:59:59.999Z"),
};
const stages = [
  { eventName: "LeadSubmitted", rank: 1 },
  { eventName: "QualifiedLead", rank: 2 },
  { eventName: "Purchase", rank: 3 },
];

let testDb: CrmTestDb;
const run = <T,>(sql: Parameters<CrmTestDb["run"]>[0]) => testDb.run<T>(sql);
const lead = (seed: CrmLeadSeed) => testDb.lead(seed);
const log = (seed: CrmLogSeed) => testDb.log(seed);

function input(overrides: Partial<CrmPlacementInput> = {}): CrmPlacementInput {
  return {
    workspaceId: WS,
    stages,
    ruleOverride: false,
    range,
    ctwaOnly: true,
    ...overrides,
  };
}

beforeAll(async () => {
  testDb = await new CrmTestDb().init();
}, 60_000);

afterAll(async () => {
  await testDb?.close();
});

beforeEach(async () => {
  await testDb.reset();
});

type Row = {
  leadId: string;
  stageRank: number;
  enteredAt: Date;
  valueCents: number | null;
  currency: string | null;
  total: number;
};

function byLead(rows: Row[]) {
  return Object.fromEntries(rows.map((row) => [row.leadId, row]));
}

describe("CRM board SQL: stage = most advanced valid conversion", () => {
  it("places each lead once, in the furthest stage with a valid conversion", async () => {
    await lead({ id: "lead_new" });
    await lead({ id: "lead_qualified" });
    await lead({ id: "lead_buyer" });
    await lead({ id: "lead_blocked" });
    await log({ leadId: "lead_qualified", eventName: "LeadSubmitted", status: "sent", at: at(2) });
    await log({ leadId: "lead_qualified", eventName: "QualifiedLead", status: "queued", at: at(1) });
    await log({ leadId: "lead_buyer", eventName: "QualifiedLead", status: "sent", at: at(1.5) });
    await log({
      leadId: "lead_buyer",
      eventName: "Purchase",
      status: "sent",
      at: at(1),
      valueCents: 19_990,
      currency: "BRL",
    });
    // A later purchase does not change when the lead entered the stage.
    await log({ leadId: "lead_buyer", eventName: "Purchase", status: "sent", at: at(0.5), valueCents: 500, currency: "BRL" });
    // Blocked / failed / skipped / duplicate / shadow never count.
    for (const status of [
      "pending_meta_context",
      "pending_value",
      "not_configured",
      "failed",
      "error",
      "skipped",
      "duplicate",
      "shadow_observed",
      "imported",
      "not_eligible",
    ])
      await log({ leadId: "lead_blocked", eventName: "Purchase", status, at: at(1) });

    const rows = byLead(await run<Row>(crmBoardSql(input(), 21)));
    expect(rows.lead_new).toMatchObject({ stageRank: 1 });
    expect(rows.lead_qualified).toMatchObject({ stageRank: 2 });
    expect(rows.lead_buyer).toMatchObject({
      stageRank: 3,
      valueCents: 19_990,
      currency: "BRL",
    });
    expect(new Date(rows.lead_buyer!.enteredAt).toISOString()).toBe(at(1).toISOString());
    expect(rows.lead_blocked).toMatchObject({ stageRank: 1 });
    expect(Object.keys(rows)).toHaveLength(4);
  });

  it("counts a manual conversion registered only in the panel; a canceled one never", async () => {
    await lead({ id: "lead_panel" });
    await lead({ id: "lead_canceled" });
    await log({
      leadId: "lead_panel",
      eventName: "QualifiedLead",
      status: "not_eligible",
      sourceTrigger: "manual_conversion",
      errorCode: "ManualConversionLocalOnly",
      at: at(1),
    });
    await log({
      leadId: "lead_canceled",
      eventName: "QualifiedLead",
      status: "skipped",
      sourceTrigger: "manual_conversion",
      errorCode: "ManualConversionCanceled",
      at: at(1),
    });
    const rows = byLead(await run<Row>(crmBoardSql(input(), 21)));
    expect(rows.lead_panel?.stageRank).toBe(2);
    expect(rows.lead_canceled?.stageRank).toBe(1);
  });

  it("ignores events of stages that are not on the board and other workspaces", async () => {
    await lead({ id: "lead_1" });
    await log({ leadId: "lead_1", eventName: "AddToCart", status: "sent", at: at(1) });
    await log({ leadId: "lead_1", eventName: "Purchase", status: "sent", at: at(1), workspaceId: "ws_other" });
    await lead({ id: "lead_other_ws", workspaceId: "ws_other" });
    const rows = await run<Row>(crmBoardSql(input(), 21));
    expect(rows).toEqual([expect.objectContaining({ leadId: "lead_1", stageRank: 1 })]);
  });
});

describe("CRM board SQL: first column (default vs rule override)", () => {
  async function seedDeferred() {
    await lead({ id: "lead_deferred" });
    await log({
      leadId: "lead_deferred",
      eventName: "LeadSubmitted",
      status: "not_eligible",
      errorCode: "lead_submitted_deferred_to_rule",
      at: at(2),
    });
    await lead({ id: "lead_rule_sent" });
    await log({
      leadId: "lead_rule_sent",
      eventName: "LeadSubmitted",
      status: "not_eligible",
      errorCode: "lead_submitted_deferred_to_rule",
      at: at(2),
    });
    await log({
      leadId: "lead_rule_sent",
      eventName: "LeadSubmitted",
      status: "sent",
      sourceTrigger: "inbound_webhook:umbler:message_phrase",
      at: at(1),
    });
    await lead({ id: "lead_plain" });
  }

  it("default mode: every lead without a later conversion is in Leads novos", async () => {
    await seedDeferred();
    const rows = byLead(await run<Row>(crmBoardSql(input(), 21)));
    expect(rows.lead_deferred?.stageRank).toBe(1);
    expect(rows.lead_rule_sent?.stageRank).toBe(1);
    expect(rows.lead_plain?.stageRank).toBe(1);
  });

  it("override mode: deferred leads wait in Conversas iniciadas until the rule sends the Lead", async () => {
    await seedDeferred();
    const rows = byLead(
      await run<Row>(crmBoardSql(input({ ruleOverride: true }), 21)),
    );
    expect(rows.lead_deferred?.stageRank).toBe(0);
    expect(rows.lead_rule_sent?.stageRank).toBe(1);
    expect(new Date(rows.lead_rule_sent!.enteredAt).toISOString()).toBe(at(1).toISOString());
    expect(rows.lead_plain?.stageRank).toBe(1);
  });
});

describe("CRM board SQL: filters", () => {
  it("period by arrival (first message, else creation), CTWA only, number, campaign", async () => {
    await lead({ id: "in_period" });
    await lead({ id: "too_old", firstMessageAt: at(40) });
    await lead({ id: "no_message_recent", firstMessageAt: null, createdAt: at(3) });
    await lead({ id: "no_message_old", firstMessageAt: null, createdAt: at(45) });
    await lead({ id: "organic", campaignId: null, adId: null, ctwaClid: null });
    await lead({ id: "other_number", whatsappInstanceId: "inst_2" });
    await lead({ id: "number_1", whatsappInstanceId: "inst_1" });
    await lead({ id: "camp_2", campaignId: "camp_2" });

    const all = (await run<Row>(crmBoardSql(input(), 21))).map((row) => row.leadId).sort();
    expect(all).toEqual(
      ["camp_2", "in_period", "no_message_recent", "number_1", "other_number"].sort(),
    );
    const byNumber = await run<Row>(
      crmBoardSql(input({ whatsappInstanceId: "inst_1" }), 21),
    );
    expect(byNumber.map((row) => row.leadId)).toEqual(["number_1"]);
    const byCampaign = (
      await run<Row>(
        crmBoardSql(
          input({
            campaign: {
              campaignId: "camp_2",
              // First-contact corrections: moved away / moved in.
              excludeIds: [],
              includeIds: ["in_period"],
            },
          }),
          21,
        ),
      )
    ).map((row) => row.leadId);
    expect(byCampaign.sort()).toEqual(["camp_2", "in_period"]);
    const excluded = await run<Row>(
      crmBoardSql(
        input({
          campaign: { campaignId: "camp_2", excludeIds: ["camp_2"], includeIds: [] },
        }),
        21,
      ),
    );
    expect(excluded).toEqual([]);
  });
});

describe("CRM board SQL: totals and pagination per column", () => {
  it("returns the first N of every column with the real totals, newest first", async () => {
    for (let index = 0; index < 30; index += 1) {
      await lead({ id: `novo_${String(index).padStart(2, "0")}`, firstMessageAt: at(10 - index * 0.1) });
    }
    for (let index = 0; index < 5; index += 1) {
      await lead({ id: `qual_${index}` });
      await log({ leadId: `qual_${index}`, eventName: "QualifiedLead", status: "sent", at: at(3 - index * 0.1) });
    }
    const rows = await run<Row>(crmBoardSql(input(), 21));
    const novos = rows.filter((row) => row.stageRank === 1);
    const qualified = rows.filter((row) => row.stageRank === 2);
    expect(novos).toHaveLength(21);
    expect(novos[0]).toMatchObject({ leadId: "novo_29", total: 30 });
    expect(qualified).toHaveLength(5);
    expect(qualified[0]).toMatchObject({ leadId: "qual_4", total: 5 });

    // "Carregar mais": after the 20th card of Leads novos.
    const cursor = decodeCrmCursor(
      encodeCrmCursor({
        enteredAt: new Date(novos[19]!.enteredAt),
        leadId: novos[19]!.leadId,
      }),
    )!;
    const next = await run<Row & { afterCursor: number }>(
      crmColumnSql(input(), 1, cursor, 21),
    );
    expect(next.map((row) => row.leadId)).toEqual(
      Array.from({ length: 10 }, (_, index) => `novo_${String(9 - index).padStart(2, "0")}`),
    );
    expect(next[0]?.afterCursor).toBe(10);
    const first = await run<Row & { afterCursor: number }>(
      crmColumnSql(input(), 2, null, 21),
    );
    expect(first).toHaveLength(5);
  });

  it("current column of a single lead (forward-only check), regardless of period", async () => {
    await lead({ id: "old_lead", firstMessageAt: at(200) });
    await log({ leadId: "old_lead", eventName: "QualifiedLead", status: "sent", at: at(100) });
    const rows = await run<Row>(
      crmLeadStageSql(input({ range: null, leadId: "old_lead", ctwaOnly: false })),
    );
    expect(rows).toEqual([expect.objectContaining({ leadId: "old_lead", stageRank: 2 })]);
  });
});

describe("CRM board SQL: large workspaces (query shape)", () => {
  it("parameters never grow with the leads; output bounded by columns x page size", () => {
    const small = crmBoardSql(input(), 21);
    const huge = crmBoardSql(
      input({
        campaign: {
          campaignId: "camp_1",
          excludeIds: Array.from({ length: 50_000 }, (_, i) => `away_${i}`),
          includeIds: Array.from({ length: 50_000 }, (_, i) => `in_${i}`),
        },
      }),
      21,
    );
    // The corrections travel as 2 array parameters, never as IN lists.
    expect(huge.values.length - small.values.length).toBeLessThanOrEqual(3);
    expect(huge.text).toContain("= ANY(");
    expect(huge.text).not.toMatch(/IN \((\$\d+, ){20,}/u);
    for (const text of [small.text, huge.text]) {
      expect(text).toContain('DISTINCT ON (c."leadId")');
      expect(text).toContain("row_number() OVER (PARTITION BY p.stage_rank");
      expect(text).toContain("count(*) OVER (PARTITION BY p.stage_rank)");
      expect(text).toContain("x.rn <=");
      expect(text).toContain('l."workspaceId" =');
      expect(text).toContain('c."workspaceId" =');
      expect(text).toContain('JOIN "ConversionEventLog" c ON c."leadId" = p.id');
    }
    expect(crmColumnSql(input(), 1, null, 21).text).toMatch(/LIMIT \$\d+\s*$/u);
  });

  it("5,000 leads and 12,000 logs: one query, real totals, at most 21 rows per column", async () => {
    await testDb.db.exec(`
      INSERT INTO "Lead" (id, "workspaceId", "campaignId", "adId", "ctwaClid", "firstMessageAt", "createdAt")
      SELECT 'big_' || lpad(g::text, 5, '0'), '${WS}', 'camp_1', 'ad_1', 'clid',
             TIMESTAMP '2026-10-20 12:00:00' - (g || ' minutes')::interval,
             TIMESTAMP '2026-10-20 12:00:00' - (g || ' minutes')::interval
      FROM generate_series(1, 5000) g;
      INSERT INTO "ConversionEventLog" (id, "workspaceId", "leadId", "sourceTrigger", "eventName", status, "eventOccurredAt")
      SELECT 'ls_' || g, '${WS}', 'big_' || lpad(g::text, 5, '0'), 'auto_lead', 'LeadSubmitted', 'sent', TIMESTAMP '2026-10-20 12:00:00'
      FROM generate_series(1, 5000) g;
      INSERT INTO "ConversionEventLog" (id, "workspaceId", "leadId", "sourceTrigger", "eventName", status, "eventOccurredAt")
      SELECT 'ql_' || g, '${WS}', 'big_' || lpad(g::text, 5, '0'), 'keyword', 'QualifiedLead',
             CASE WHEN g % 2 = 0 THEN 'sent' ELSE 'failed' END, TIMESTAMP '2026-10-21 12:00:00'
      FROM generate_series(1, 4000) g;
      INSERT INTO "ConversionEventLog" (id, "workspaceId", "leadId", "sourceTrigger", "eventName", status, "eventOccurredAt", "valueCents", currency)
      SELECT 'pu_' || g, '${WS}', 'big_' || lpad(g::text, 5, '0'), 'inbound_webhook:payt', 'Purchase', 'sent',
             TIMESTAMP '2026-10-22 12:00:00', 9900, 'BRL'
      FROM generate_series(1, 3000) g WHERE g % 3 = 0;
    `);
    const rows = await run<{ stageRank: number; total: number }>(
      crmBoardSql(input(), 21),
    );
    const totals = Object.fromEntries(
      rows.map((row) => [row.stageRank, Number(row.total)]),
    );
    // Buyers: g % 3 == 0 up to 3000. Qualified: even g up to 4000 that did
    // not buy (failed QualifiedLead never counts).
    const buyers = 1000;
    const qualified = Array.from({ length: 4000 }, (_, i) => i + 1).filter(
      (g) => g % 2 === 0 && !(g <= 3000 && g % 3 === 0),
    ).length;
    expect(totals).toEqual({
      1: 5000 - buyers - qualified,
      2: qualified,
      3: buyers,
    });
    expect(rows).toHaveLength(63);
  });
});
