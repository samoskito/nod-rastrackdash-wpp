import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parsePaytAutomationV1,
  PAYT_AUTOMATION_V1_PARSER_VERSION,
} from "../../src/inbound-webhooks/providers/payt/payt-automation-v1.parser";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(resolve(__dirname, "fixtures", name), "utf8"),
  ) as unknown;
}

describe("Payt automation v1 parser", () => {
  it("parses a paid order as a BRL Purchase in cents without retaining PII", () => {
    const parsed = parsePaytAutomationV1(fixture("order-paid.sanitized.json"));

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        provider: "payt",
        automation: "purchase_paid",
        eventName: "Purchase",
        phone: "11999999999",
        phoneCandidates: ["11999999999", "5511999999999"],
        externalExecutionKey: "PAYTS2",
        valueCents: 296616,
        currency: "BRL",
        test: true,
      },
    });
    expect(PAYT_AUTOMATION_V1_PARSER_VERSION).toBe("automation-v1");
    expect(JSON.stringify(parsed)).not.toContain("integration_key");
  });

  it("treats a non-paid order as a non-purchase, not an invalid purchase", () => {
    expect(
      parsePaytAutomationV1(fixture("order-nonpaid.sanitized.json")),
    ).toEqual({ ok: false, errorCode: "payt_automation_v1_not_purchase" });
  });

  it("parses a confirmed cash-on-delivery order as a Purchase", () => {
    const parsed = parsePaytAutomationV1(
      fixture("order-cod-confirmed.sanitized.json"),
    );

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        eventName: "Purchase",
        phone: "63999990071",
        phoneCandidates: ["63999990071", "5563999990071"],
        externalExecutionKey: "SYNTHCOD1",
        valueCents: 36699,
        currency: "BRL",
        test: false,
      },
    });
  });

  it("treats cash-on-delivery orders with a status other than order_confirmed as non-purchases", () => {
    const confirmed = fixture("order-cod-confirmed.sanitized.json") as Record<
      string,
      unknown
    >;

    expect(parsePaytAutomationV1({ ...confirmed, status: "canceled" })).toEqual(
      { ok: false, errorCode: "payt_automation_v1_not_purchase" },
    );
  });

  it("normalizes the cash-on-delivery type casing", () => {
    const confirmed = fixture("order-cod-confirmed.sanitized.json") as Record<
      string,
      unknown
    >;

    expect(
      parsePaytAutomationV1({ ...confirmed, type: "CASH_ON_DELIVERY" }),
    ).toMatchObject({ ok: true, value: { externalExecutionKey: "SYNTHCOD1" } });
  });

  it("allows an absent payment_status but rejects one that is present and unpaid", () => {
    const paid = fixture("order-paid.sanitized.json") as Record<string, any>;
    const withoutStatus = {
      ...paid,
      transaction: { ...paid.transaction },
    };
    delete withoutStatus.transaction.payment_status;
    expect(parsePaytAutomationV1(withoutStatus)).toMatchObject({ ok: true });
    expect(
      parsePaytAutomationV1({
        ...withoutStatus,
        transaction: {
          ...withoutStatus.transaction,
          payment_status: "pending",
        },
      }),
    ).toEqual({ ok: false, errorCode: "payt_automation_v1_not_purchase" });
  });

  it("optionally unwraps the n8n array envelope", () => {
    const parsed = parsePaytAutomationV1(
      fixture("order-paid-n8n-envelope.sanitized.json"),
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: { externalExecutionKey: "PAYTS2", valueCents: 296616 },
    });
  });

  it("rejects paid orders missing a transaction id or a usable phone", () => {
    const paid = fixture("order-paid.sanitized.json") as Record<
      string,
      unknown
    >;
    for (const payload of [
      { ...paid, transaction_id: "" },
      { ...paid, customer: { ...(paid.customer as object), phone: "abc" } },
    ]) {
      expect(parsePaytAutomationV1(payload)).toEqual({
        ok: false,
        errorCode:
          "transaction_id" in payload && payload.transaction_id === ""
            ? "payt_purchase_identity_missing"
            : "payt_automation_v1_invalid_payload",
      });
    }
  });
});

it("requires a real seller identity and never substitutes integration_key", () => {
  const paid = fixture("order-paid.sanitized.json") as Record<string, unknown>;
  for (const seller_id of [undefined, "", "a\0b"]) {
    expect(parsePaytAutomationV1({ ...paid, seller_id })).toEqual({
      ok: false,
      errorCode: "payt_purchase_identity_missing",
    });
  }
});
