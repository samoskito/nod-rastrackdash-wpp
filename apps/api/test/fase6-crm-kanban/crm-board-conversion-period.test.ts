import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  crmBoardSql,
  crmColumnSql,
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
 * Period of the CRM board by the date of the conversion (same field and day
 * boundaries as the Visão geral: eventOccurredAt, America/Sao_Paulo). Executed
 * for real in PGlite; nothing touches the project database.
 */

// "Ontem" in America/Sao_Paulo (UTC-3): 2026-10-23 00:00 .. 23:59:59.999.
const yesterday = {
  gte: new Date("2026-10-23T03:00:00.000Z"),
  lte: new Date("2026-10-24T02:59:59.999Z"),
};
const inYesterday = (hours: number) =>
  new Date(yesterday.gte.getTime() + hours * 3600_000);
const stages = [
  { eventName: "LeadSubmitted", rank: 1 },
  { eventName: "QualifiedLead", rank: 2 },
  { eventName: "Purchase", rank: 3 },
];

let testDb: CrmTestDb;
const lead = (seed: CrmLeadSeed) => testDb.lead(seed);
const log = (seed: CrmLogSeed) => testDb.log(seed);

type Row = {
  leadId: string;
  stageRank: number;
  enteredAt: Date;
  valueCents: number | null;
  total: number;
  afterCursor?: number;
};

function input(overrides: Partial<CrmPlacementInput> = {}): CrmPlacementInput {
  return {
    workspaceId: WS,
    stages,
    ruleOverride: false,
    range: yesterday,
    ctwaOnly: true,
    ...overrides,
  };
}

async function board(overrides: Partial<CrmPlacementInput> = {}) {
  const rows = await testDb.run<Row>(crmBoardSql(input(overrides), 21));
  return Object.fromEntries(rows.map((row) => [row.leadId, row]));
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

describe("CRM board: period by the date of the conversion", () => {
  it("lead of last week with a Purchase yesterday is in Compra, not in the entry column", async () => {
    await lead({ id: "old_buyer", firstMessageAt: at(7) });
    await log({ leadId: "old_buyer", eventName: "LeadSubmitted", status: "sent", at: at(7) });
    await log({ leadId: "old_buyer", eventName: "QualifiedLead", status: "sent", at: at(5) });
    await log({
      leadId: "old_buyer",
      eventName: "Purchase",
      status: "sent",
      at: inYesterday(10),
      valueCents: 9_000,
      currency: "BRL",
    });
    // Entered yesterday, no conversion: entry column.
    await lead({ id: "new_yesterday", firstMessageAt: inYesterday(8) });
    // Qualified last week, nothing yesterday: not on yesterday's board.
    await lead({ id: "stale", firstMessageAt: at(7) });
    await log({ leadId: "stale", eventName: "QualifiedLead", status: "sent", at: at(5) });

    const rows = await board();
    expect(rows.old_buyer).toMatchObject({ stageRank: 3, valueCents: 9_000 });
    expect(new Date(rows.old_buyer!.enteredAt).toISOString()).toBe(
      inYesterday(10).toISOString(),
    );
    expect(rows.new_yesterday).toMatchObject({ stageRank: 1 });
    expect(rows.stale).toBeUndefined();
    expect(Object.keys(rows).sort()).toEqual(["new_yesterday", "old_buyer"]);
  });

  it("Compra count equals the 6 Purchase conversions of the day (leads of other days)", async () => {
    for (let i = 1; i <= 6; i += 1) {
      await lead({ id: `buyer_${i}`, firstMessageAt: at(3 + i) });
      await log({ leadId: `buyer_${i}`, eventName: "Purchase", status: "sent", at: inYesterday(i) });
    }
    // The day before never counts in "ontem"; skipped never counts at all.
    await lead({ id: "day_before", firstMessageAt: at(9) });
    await log({ leadId: "day_before", eventName: "Purchase", status: "sent", at: at(2) });
    await lead({ id: "skipped_buy", firstMessageAt: at(9) });
    await log({ leadId: "skipped_buy", eventName: "Purchase", status: "skipped", at: inYesterday(2) });

    const rows = Object.values(await board()).filter((row) => row.stageRank === 3);
    expect(rows).toHaveLength(6);
    expect(rows[0]!.total).toBe(6);
  });

  it("a Purchase that failed or was blocked at Meta still puts the lead in Compra (overview counts it)", async () => {
    const statuses = ["sent", "failed", "pending_meta_context", "not_configured", "duplicate"];
    for (const [i, status] of statuses.entries()) {
      await lead({ id: `s${i}`, firstMessageAt: at(8 + i) });
      await log({ leadId: `s${i}`, eventName: "Purchase", status, at: inYesterday(i + 1) });
    }
    const rows = Object.values(await board()).filter((row) => row.stageRank === 3);
    // Same count as the overview: every Purchase of the day except skipped.
    expect(rows).toHaveLength(statuses.length);
    expect(rows[0]!.total).toBe(statuses.length);
    // The entry column keeps its strict rule: a failed LeadSubmitted is not an entry.
    await lead({ id: "entry_failed", firstMessageAt: inYesterday(2) });
    await log({ leadId: "entry_failed", eventName: "LeadSubmitted", status: "failed", at: inYesterday(2) });
    expect((await board()).entry_failed).toMatchObject({ stageRank: 1 });
  });

  it("with a period only conversions inside it place the lead (one column per lead)", async () => {
    // Qualified yesterday, Purchase in an earlier period: Lead qualificado.
    await lead({ id: "q_now_p_before", firstMessageAt: at(20) });
    await log({ leadId: "q_now_p_before", eventName: "Purchase", status: "sent", at: at(10) });
    await log({ leadId: "q_now_p_before", eventName: "QualifiedLead", status: "sent", at: inYesterday(7) });
    // Purchase only in an earlier period, arrived earlier: not on the board.
    await lead({ id: "only_before", firstMessageAt: at(20) });
    await log({ leadId: "only_before", eventName: "Purchase", status: "sent", at: at(10) });
    // Arrived yesterday with a (backdated) Purchase before the period: entry column.
    await lead({ id: "arrived_p_before", firstMessageAt: inYesterday(4) });
    await log({ leadId: "arrived_p_before", eventName: "Purchase", status: "sent", at: at(5) });
    // Qualified and Purchase both yesterday: only Compra (exclusive).
    await lead({ id: "both_now", firstMessageAt: at(20) });
    await log({ leadId: "both_now", eventName: "QualifiedLead", status: "sent", at: inYesterday(5) });
    await log({ leadId: "both_now", eventName: "Purchase", status: "sent", at: inYesterday(9) });

    const rows = await board();
    expect(rows.q_now_p_before).toMatchObject({ stageRank: 2 });
    expect(new Date(rows.q_now_p_before!.enteredAt).toISOString()).toBe(inYesterday(7).toISOString());
    expect(rows.only_before).toBeUndefined();
    expect(rows.arrived_p_before).toMatchObject({ stageRank: 1 });
    expect(rows.both_now).toMatchObject({ stageRank: 3 });
    expect(Object.values(rows).filter((row) => row.leadId === "both_now")).toHaveLength(1);
  });

  it("a Purchase after the period does not pull yesterday's lead out of the entry column", async () => {
    await lead({ id: "bought_today", firstMessageAt: inYesterday(5) });
    await log({
      leadId: "bought_today",
      eventName: "Purchase",
      status: "sent",
      at: new Date(yesterday.lte.getTime() + 3600_000),
    });
    expect((await board()).bought_today).toMatchObject({ stageRank: 1 });
  });

  it("a repurchase yesterday puts the lead in Compra yesterday", async () => {
    await lead({ id: "repeat", firstMessageAt: at(20) });
    await log({ leadId: "repeat", eventName: "Purchase", status: "sent", at: at(10) });
    await log({ leadId: "repeat", eventName: "Purchase", status: "sent", at: inYesterday(12) });
    expect((await board()).repeat).toMatchObject({ stageRank: 3 });
  });

  it("São Paulo day boundary: 23:30 local is yesterday, 00:30 local is today", async () => {
    await lead({ id: "late", firstMessageAt: at(9) });
    await log({ leadId: "late", eventName: "Purchase", status: "sent", at: new Date("2026-10-24T02:30:00.000Z") });
    await lead({ id: "after_midnight", firstMessageAt: at(9) });
    await log({ leadId: "after_midnight", eventName: "Purchase", status: "sent", at: new Date("2026-10-24T03:30:00.000Z") });
    const rows = await board();
    expect(rows.late).toMatchObject({ stageRank: 3 });
    expect(rows.after_midnight).toBeUndefined();
  });

  it("number filter and per-column pagination keep working", async () => {
    for (let i = 1; i <= 4; i += 1) {
      await lead({
        id: `b${i}`,
        firstMessageAt: at(10 + i),
        whatsappInstanceId: i <= 3 ? "inst_1" : "inst_2",
      });
      await log({ leadId: `b${i}`, eventName: "Purchase", status: "sent", at: inYesterday(i) });
    }
    expect(Object.keys(await board({ whatsappInstanceId: "inst_1" })).sort()).toEqual([
      "b1",
      "b2",
      "b3",
    ]);
    const first = await testDb.run<Row>(crmColumnSql(input(), 3, null, 2));
    expect(first.map((row) => row.leadId)).toEqual(["b4", "b3"]);
    expect(first[0]!.afterCursor).toBe(4);
    const next = await testDb.run<Row>(
      crmColumnSql(input(), 3, { enteredAt: first[1]!.enteredAt, leadId: "b3" }, 2),
    );
    expect(next.map((row) => row.leadId)).toEqual(["b2", "b1"]);
  });

  it("nod: an imported manual conversion (1.3.0 rows) counts by its date too", async () => {
    await lead({ id: "imported_buyer", firstMessageAt: at(30) });
    await log({
      leadId: "imported_buyer",
      eventName: "Purchase",
      status: "imported",
      sourceTrigger: "manual_conversion",
      at: inYesterday(3),
    });
    expect((await board()).imported_buyer).toMatchObject({ stageRank: 3 });
  });

  it("without a period the board is unchanged (every lead, most advanced stage)", async () => {
    await lead({ id: "x", firstMessageAt: at(40) });
    await log({ leadId: "x", eventName: "Purchase", status: "sent", at: at(30) });
    const rows = await testDb.run<Row>(crmBoardSql(input({ range: null }), 21));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ leadId: "x", stageRank: 3 });
  });
});

