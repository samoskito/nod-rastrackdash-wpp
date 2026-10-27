import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { crmBoardSql, type CrmPlacementInput } from "../../src/crm/crm-board-query";
import {
  CRM_TEST_WS as WS,
  CrmTestDb,
  daysAgo as at,
} from "../helpers/crm-pglite";

/**
 * Fase 6.9 (PR #92 do nod): a QualifiedLead that Dashboard Leads already sent
 * is imported as a manual conversion with status "imported". The CRM Kanban
 * (#176) places the lead in that column, so dragging it there again (a new
 * manual conversion, refused by the #153 guard) is never needed. An imported
 * log of another trigger (the external MySQL import, the CRM stage of a form)
 * still never counts. PGlite: in-process Postgres, no project database.
 */

const range = {
  gte: new Date("2026-09-25T03:00:00.000Z"),
  lte: new Date("2026-10-25T02:59:59.999Z"),
};
const input: CrmPlacementInput = {
  workspaceId: WS,
  stages: [
    { eventName: "LeadSubmitted", rank: 1 },
    { eventName: "QualifiedLead", rank: 2 },
    { eventName: "Purchase", rank: 3 },
  ],
  ruleOverride: false,
  range,
  ctwaOnly: true,
};

let testDb: CrmTestDb;

beforeAll(async () => {
  testDb = await new CrmTestDb().init();
}, 60_000);

afterAll(async () => {
  await testDb?.close();
});

beforeEach(async () => {
  await testDb.reset();
});

describe("CRM Kanban: qualificação importada do Dashboard Leads", () => {
  it("an imported manual QualifiedLead places the lead; other imported logs do not", async () => {
    await testDb.lead({ id: "lead_imported" });
    await testDb.lead({ id: "lead_other_import" });
    await testDb.log({
      leadId: "lead_imported",
      eventName: "QualifiedLead",
      status: "imported",
      sourceTrigger: "manual_conversion",
      at: at(2),
    });
    await testDb.log({
      leadId: "lead_other_import",
      eventName: "QualifiedLead",
      status: "imported",
      sourceTrigger: "external_mysql:connector_1",
      at: at(2),
    });

    const rows = await testDb.run<{ leadId: string; stageRank: number }>(
      crmBoardSql(input, 21),
    );
    const byLead = Object.fromEntries(rows.map((row) => [row.leadId, row]));

    expect(byLead.lead_imported).toMatchObject({ stageRank: 2 });
    expect(byLead.lead_other_import).toMatchObject({ stageRank: 1 });
  });
});
