/**
 * Porte do #173 (a1b600c2): horários da Payt sem fuso são hora de Brasília e
 * o event_time nunca fica no futuro (limite: recebimento + 5 min). A parte do
 * Brink Park não se aplica ao nod.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProviderPurchaseIdentity } from "../../src/conversion-rules/provider-purchase-identity";
import {
  PAYT_FUTURE_SKEW_MS,
  parsePaytAutomationV1,
  parsePaytSaleEventV1,
  paytTimestamp,
} from "../../src/inbound-webhooks/providers/payt/payt-automation-v1.parser";

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(__dirname, "../fase4-payt/fixtures", name), "utf8"),
  ) as Record<string, unknown>;
}

const paid = fixture("order-paid.sanitized.json");
const waiting = fixture("order-nonpaid.sanitized.json");
const cod = fixture("order-cod-confirmed.sanitized.json");

/** Real-format Payt payloads of the 23/10 incident (sanitized). */
function waitingPayment23Oct() {
  return {
    seller_id: "seller-1",
    status: "waiting_payment",
    type: "order",
    transaction_id: "TXN1417",
    started_at: "2026-10-23 14:16:40.000000",
    updated_at: "2026-10-23 14:17:05.000000",
    customer: { phone: "+55 11 99999-9999" },
    product: { code: "PROD1", name: "Produto", price: 9_700, quantity: 1 },
    transaction: {
      total_price: 9_700,
      payment_method: "pix",
      created_at: "2026-10-23 14:17:05",
      updated_at: "2026-10-23 14:17:05",
      expires_at: "2026-10-23 16:17:01",
    },
  };
}

function lostCart23Oct() {
  return {
    seller_id: "seller-1",
    status: "lost_cart",
    type: "lost_cart",
    cart_id: "CART2139",
    started_at: "2026-10-23 21:39:30.000000",
    updated_at: "2026-10-23 21:39:30.000000",
    customer: { phone: "+55 11 99999-9999" },
    product: { code: "PROD1", name: "Produto", quantity: 1 },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Payt timestamps are Brasilia wall-clock time", () => {
  it("reads a naive timestamp (with or without microseconds) as -03:00", () => {
    expect(paytTimestamp("2026-10-23 21:39:30.000000")?.toISOString()).toBe(
      "2026-10-24T00:39:30.000Z",
    );
    expect(paytTimestamp("2026-10-23 14:17:05")?.toISOString()).toBe(
      "2026-10-23T17:17:05.000Z",
    );
    expect(paytTimestamp("2026-10-23T14:17:05")?.toISOString()).toBe(
      "2026-10-23T17:17:05.000Z",
    );
  });

  it("keeps an explicit zone", () => {
    expect(paytTimestamp("2026-10-23T21:39:30Z")?.toISOString()).toBe(
      "2026-10-23T21:39:30.000Z",
    );
    expect(paytTimestamp("2026-10-23T21:39:30-03:00")?.toISOString()).toBe(
      "2026-10-24T00:39:30.000Z",
    );
    expect(paytTimestamp("2026-10-23T21:39:30.000+00:00")?.toISOString()).toBe(
      "2026-10-23T21:39:30.000Z",
    );
  });

  it("rejects empty or invalid values", () => {
    expect(paytTimestamp(null)).toBeNull();
    expect(paytTimestamp("")).toBeNull();
    expect(paytTimestamp("2026-13-40 25:00:00")).toBeNull();
    expect(paytTimestamp("not a date")).toBeNull();
  });

  it("abandoned cart at 21:39 Brasilia is 00:39Z (not 21:39Z / 18:39 local)", () => {
    const parsed = parsePaytSaleEventV1(lostCart23Oct(), {
      receivedAt: new Date("2026-10-24T00:39:33.000Z"),
    });
    if (!parsed.ok) throw new Error(parsed.errorCode);
    expect(parsed.value.eventName).toBe("CartAbandoned");
    expect(parsed.value.occurredAt.toISOString()).toBe(
      "2026-10-24T00:39:30.000Z",
    );
  });

  it("waiting_payment created 14:17:05 Brasilia (pix expires 16:17:01) is 17:17:05Z", () => {
    const parsed = parsePaytSaleEventV1(waitingPayment23Oct(), {
      receivedAt: new Date("2026-10-23T17:17:07.000Z"),
    });
    if (!parsed.ok) throw new Error(parsed.errorCode);
    expect(parsed.value.eventName).toBe("InitiateCheckout");
    expect(parsed.value.occurredAt.toISOString()).toBe(
      "2026-10-23T17:17:05.000Z",
    );
  });

  it("sanitized fixtures: paid_at / created_at read as -03:00", () => {
    const purchase = parsePaytAutomationV1(paid);
    if (!purchase.ok) throw new Error(purchase.errorCode);
    // paid_at "2024-11-22 15:20:45" Brasilia.
    expect(purchase.value.occurredAt.toISOString()).toBe(
      "2024-11-22T18:20:45.000Z",
    );
    const checkout = parsePaytSaleEventV1(waiting);
    if (!checkout.ok) throw new Error(checkout.errorCode);
    expect(checkout.value.occurredAt.toISOString()).toBe(
      "2024-11-22T18:20:45.000Z",
    );
    const confirmedCod = parsePaytSaleEventV1(cod);
    if (!confirmedCod.ok) throw new Error(confirmedCod.errorCode);
    // created_at / updated_at "2026-09-16 10:57:35" Brasilia.
    expect(confirmedCod.value.occurredAt.toISOString()).toBe(
      "2026-09-16T13:57:35.000Z",
    );
  });
});

describe("Payt event time never lands in the future", () => {
  it("caps a time beyond receivedAt + skew at receivedAt", () => {
    const receivedAt = new Date("2026-10-23T21:40:00.000Z");
    // A payload that would be 3h ahead of the arrival (wrong clock/zone).
    const parsed = parsePaytSaleEventV1(
      {
        ...lostCart23Oct(),
        started_at: "2026-10-24T00:39:30Z",
        updated_at: "2026-10-24T00:39:30Z",
      },
      { receivedAt },
    );
    if (!parsed.ok) throw new Error(parsed.errorCode);
    expect(parsed.value.occurredAt.toISOString()).toBe(receivedAt.toISOString());
  });

  it("tolerates a small provider clock skew", () => {
    const receivedAt = new Date("2026-10-24T00:39:00.000Z");
    const parsed = parsePaytSaleEventV1(lostCart23Oct(), { receivedAt });
    if (!parsed.ok) throw new Error(parsed.errorCode);
    // 30s ahead of the arrival: under the skew, kept.
    expect(parsed.value.occurredAt.toISOString()).toBe(
      "2026-10-24T00:39:30.000Z",
    );
    expect(PAYT_FUTURE_SKEW_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("without receivedAt the reference is now (live ingestion)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T22:00:00.000Z"));
    const parsed = parsePaytSaleEventV1(lostCart23Oct());
    if (!parsed.ok) throw new Error(parsed.errorCode);
    expect(parsed.value.occurredAt.toISOString()).toBe(
      "2026-10-23T22:00:00.000Z",
    );
  });

  it("an old event keeps its time (Meta 7-day window judged downstream)", () => {
    const parsed = parsePaytSaleEventV1(lostCart23Oct(), {
      receivedAt: new Date("2026-11-05T12:00:00.000Z"),
    });
    if (!parsed.ok) throw new Error(parsed.errorCode);
    expect(parsed.value.occurredAt.toISOString()).toBe(
      "2026-10-24T00:39:30.000Z",
    );
  });

  // nod: sem o despachante sales-platform-sale.ts (chega na 6.5); o
  // contrato de compra (parsePaytAutomationV1) repassa o receivedAt.
  it("the Purchase parser forwards receivedAt", () => {
    const receivedAt = new Date("2024-11-22T18:00:00.000Z");
    // paid_at 15:20:45 Brasilia = 18:20:45Z: 20 min after the arrival.
    const parsed = parsePaytAutomationV1(paid, { receivedAt });
    if (!parsed.ok) throw new Error(parsed.errorCode);
    expect(parsed.value.occurredAt.toISOString()).toBe(receivedAt.toISOString());
  });
});

describe("dedupe identity does not depend on the timestamp", () => {
  it("same order -> same keys whatever the time reading", () => {
    const a = parsePaytSaleEventV1(lostCart23Oct());
    const b = parsePaytSaleEventV1({
      ...lostCart23Oct(),
      started_at: "2026-10-23T21:39:30Z",
      updated_at: "2026-10-23T21:39:30Z",
    });
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(a.value.occurredAt.getTime()).not.toBe(b.value.occurredAt.getTime());
    expect(a.value.externalExecutionKey).toBe(b.value.externalExecutionKey);
    const identity = (value: typeof a.value) =>
      buildProviderPurchaseIdentity({
        workspaceId: "ws_1",
        provider: value.provider,
        accountRef: value.accountRef,
        orderRef: value.orderRef,
        eventName: value.eventName,
      });
    expect(identity(a.value)).toBe(identity(b.value));
  });
});
