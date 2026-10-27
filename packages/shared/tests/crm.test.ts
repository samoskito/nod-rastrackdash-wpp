import { describe, expect, it } from "vitest";
import {
  CRM_BACKWARD_MOVE_MESSAGE,
  clientNavigation,
  crmBoardQuerySchema,
  crmDaysInStageLabel,
  crmMoveCheck,
  manualConversionInputSchema,
} from "../src";

describe("CRM Kanban shared rules", () => {
  it("moves only forward; skipping stages is allowed; Conversas iniciadas is read-only", () => {
    expect(crmMoveCheck({ rank: 1 }, { rank: 3, readOnly: false })).toEqual({
      ok: true,
      skipped: 1,
    });
    expect(crmMoveCheck({ rank: 2 }, { rank: 1, readOnly: false })).toEqual({
      ok: false,
      reason: "backward",
      message: CRM_BACKWARD_MOVE_MESSAGE,
    });
    expect(crmMoveCheck({ rank: 2 }, { rank: 2, readOnly: false })).toMatchObject({
      ok: false,
      reason: "same",
    });
    expect(crmMoveCheck({ rank: 0 }, { rank: 0, readOnly: true })).toMatchObject({
      ok: false,
      reason: "read_only",
    });
  });

  it("days in the stage, in Portuguese", () => {
    const now = new Date("2026-10-24T12:00:00Z");
    expect(crmDaysInStageLabel("2026-10-24T08:00:00Z", now)).toBe(
      "há menos de 1 dia nesta etapa",
    );
    expect(crmDaysInStageLabel("2026-10-23T08:00:00Z", now)).toBe(
      "há 1 dia nesta etapa",
    );
    expect(crmDaysInStageLabel("2026-10-14T12:00:00Z", now)).toBe(
      "há 10 dias nesta etapa",
    );
  });

  it("board query and manual conversion source", () => {
    expect(crmBoardQuerySchema.safeParse({ since: "2026-10-01" }).success).toBe(true);
    expect(crmBoardQuerySchema.safeParse({ since: "01/10/2026" }).success).toBe(false);
    const base = {
      eventName: "QualifiedLead",
      occurredAt: new Date().toISOString(),
      sendToMeta: true,
      idempotencyKey: "4b0c5a3e-8f43-4a8f-9c55-0d3a9f1d2e11",
    };
    expect(manualConversionInputSchema.parse(base).source).toBeUndefined();
    expect(manualConversionInputSchema.parse({ ...base, source: "kanban" }).source).toBe("kanban");
    expect(manualConversionInputSchema.safeParse({ ...base, source: "x" }).success).toBe(false);
  });

  it("CRM is in the main menu right after Leads", () => {
    const ids = clientNavigation.map((item) => item.id);
    expect(ids.indexOf("crm")).toBe(ids.indexOf("leads") + 1);
  });
});
