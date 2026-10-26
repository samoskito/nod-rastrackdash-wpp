import { describe, expect, it } from "vitest";
import {
  conversionAuditSourceSchema,
  manualConversionAgeState,
  manualConversionInputSchema,
  manualConversionMayExpireBeforeSend,
  normalizeManualOrderRef,
} from "../src";

const DAY = 24 * 60 * 60_000;
const base = {
  occurredAt: new Date(Date.now() - 60_000).toISOString(),
  sendToMeta: true,
  idempotencyKey: "4b0c5a3e-8f43-4a8f-9c55-0d3a9f1d2e11",
};

function issues(input: Record<string, unknown>) {
  const parsed = manualConversionInputSchema.safeParse({ ...base, ...input });
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => issue.path.join("."));
}

describe("manual conversion input by valuePolicy", () => {
  it("required (Purchase): value, currency and order number are all required", () => {
    expect(issues({ eventName: "Purchase" })).toEqual([
      "valueCents",
      "currency",
      "orderRef",
    ]);
    expect(
      issues({
        eventName: "Purchase",
        valueCents: 19_900,
        currency: "BRL",
        orderRef: "  PED-1  ",
      }),
    ).toEqual([]);
    const parsed = manualConversionInputSchema.parse({
      ...base,
      eventName: "Purchase",
      valueCents: 19_900,
      currency: "USD",
      orderRef: "  PED-1  ",
      note: "   ",
    });
    expect(parsed.orderRef).toBe("PED-1");
    expect(parsed.note).toBeNull();
  });

  it("none (QualifiedLead): a value is refused", () => {
    expect(issues({ eventName: "QualifiedLead" })).toEqual([]);
    expect(
      issues({ eventName: "QualifiedLead", valueCents: 100, currency: "BRL" }),
    ).toEqual(["valueCents"]);
  });

  it("optional (AddToCart): value is optional but needs a currency", () => {
    expect(issues({ eventName: "AddToCart" })).toEqual([]);
    expect(issues({ eventName: "AddToCart", valueCents: 500 })).toEqual([
      "currency",
    ]);
  });

  it("rejects unsupported currencies, long notes and bad idempotency keys", () => {
    expect(
      issues({
        eventName: "Purchase",
        valueCents: 1,
        currency: "ARS",
        orderRef: "x",
      }),
    ).toContain("currency");
    expect(
      issues({ eventName: "QualifiedLead", note: "x".repeat(501) }),
    ).toContain("note");
    expect(
      issues({ eventName: "QualifiedLead", orderRef: "x".repeat(121) }),
    ).toContain("orderRef");
    expect(
      issues({ eventName: "QualifiedLead", idempotencyKey: "abc" }),
    ).toContain("idempotencyKey");
    expect(issues({ eventName: "Schedule" })).toContain("eventName");
  });

  it("date: no future, at most 90 days; over 7 days stays in the panel", () => {
    const now = new Date("2026-10-21T12:00:00.000Z");
    expect(manualConversionAgeState("2026-10-21T11:00:00.000Z", now)).toBe("ok");
    expect(manualConversionAgeState("2026-10-22T12:00:00.000Z", now)).toBe(
      "future",
    );
    expect(manualConversionAgeState("2026-10-10T12:00:00.000Z", now)).toBe(
      "outside_meta_window",
    );
    expect(manualConversionAgeState("2026-07-01T12:00:00.000Z", now)).toBe(
      "too_old",
    );
    expect(
      issues({
        eventName: "QualifiedLead",
        occurredAt: new Date(Date.now() + DAY).toISOString(),
      }),
    ).toEqual(["occurredAt"]);
    expect(
      issues({
        eventName: "QualifiedLead",
        occurredAt: new Date(Date.now() - 91 * DAY).toISOString(),
      }),
    ).toEqual(["occurredAt"]);
  });

  it("order numbers: trim, case, inner spaces/hyphens and a leading # are ignored", () => {
    expect(normalizeManualOrderRef(" #ped-100 ")).toBe("PED100");
    expect(normalizeManualOrderRef("PED 1 00")).toBe("PED100");
    expect(normalizeManualOrderRef("##abc-x")).toBe("ABCX");
    expect(
      issues({
        eventName: "Purchase",
        valueCents: 1,
        currency: "BRL",
        orderRef: " #-- ",
      }),
    ).toContain("orderRef");
  });

  it("confirmDuplicate defaults to false; may-expire window is the last 2h of the 7 days", () => {
    const parsed = manualConversionInputSchema.parse({
      ...base,
      eventName: "QualifiedLead",
    });
    expect(parsed.confirmDuplicate).toBe(false);
    const now = new Date("2026-10-21T12:00:00.000Z");
    expect(
      manualConversionMayExpireBeforeSend("2026-10-14T13:00:00.000Z", now),
    ).toBe(true);
    expect(
      manualConversionMayExpireBeforeSend("2026-10-14T15:00:00.000Z", now),
    ).toBe(false);
    expect(
      manualConversionMayExpireBeforeSend("2026-10-14T11:00:00.000Z", now),
    ).toBe(false);
  });

  it("the audit origin accepts 'manual'", () => {
    expect(conversionAuditSourceSchema.parse("manual")).toBe("manual");
  });
});
