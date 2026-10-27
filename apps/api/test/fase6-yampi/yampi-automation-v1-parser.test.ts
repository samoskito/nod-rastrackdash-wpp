import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProviderPurchaseIdentity } from "../../src/conversion-rules/provider-purchase-identity";
import {
  parseYampiAutomationV1,
  parseYampiSaleEventV1,
  yampiPhoneCandidates,
  yampiTimestamp,
  yampiValueCents,
} from "../../src/inbound-webhooks/providers/yampi/yampi-automation-v1.parser";
import {
  parseSaleEventV1,
  saleProductFilterMatches,
} from "../../src/inbound-webhooks/providers/sales-platform-sale";

/**
 * Fixtures built from the STRUCTURE of real Yampi webhooks (order.paid and
 * cart.reminder pasted by the owner) and of the official docs
 * (docs.yampi.com.br, introduction-webhook). Every value is fictitious
 * (names, e-mails, CPF, phones, ids, tokens, SKUs).
 */

function fixture(name: string): Record<string, any> {
  return JSON.parse(
    readFileSync(resolve(__dirname, "../fixtures/yampi", name), "utf8"),
  ) as Record<string, any>;
}

const paid = fixture("order-paid.synthetic.json");
const cart = fixture("cart-reminder.synthetic.json");
const receivedAt = new Date("2026-10-22T12:30:15.000Z");

function orderEvent(
  event: string,
  patch: (payload: Record<string, any>) => void = () => {},
): Record<string, any> {
  const payload = structuredClone(paid);
  payload.event = event;
  patch(payload);
  return payload;
}

function withAlias(alias: string, statusId: number) {
  return (payload: Record<string, any>) => {
    payload.resource.status_id = statusId;
    payload.resource.status.data = { id: statusId, alias, name: alias };
  };
}

function ok(payload: unknown, at: Date = receivedAt) {
  const parsed = parseYampiSaleEventV1(payload, { receivedAt: at });
  if (!parsed.ok) throw new Error(`expected ok, got ${parsed.errorCode}`);
  return parsed.value;
}

function identity(payload: unknown): string {
  const value = ok(payload);
  return buildProviderPurchaseIdentity({
    workspaceId: "ws_ficticio",
    provider: "yampi",
    accountRef: value.accountRef,
    orderRef: value.orderRef,
    eventName: value.eventName,
  });
}

describe("Yampi webhook: events", () => {
  it("order.paid -> Purchase, value = value_products (no shipping, no interest), BRL", () => {
    const value = ok(paid);
    expect(value).toMatchObject({
      provider: "yampi",
      eventName: "Purchase",
      automation: "purchase_paid",
      providerStatus: "order.paid:paid",
      orderRef: "70000001",
      externalExecutionKey: "70000001",
      accountRef: "yampi",
      // value_products 594; value_total 659.35 (shipping + interest) is NOT used.
      valueCents: 59400,
      currency: "BRL",
      product: { code: "3000001", name: "Produto Ficticio Azul" },
      offer: { code: "SKU-FICT-01", name: "Produto Ficticio Azul" },
      productCodes: ["3000001", "4000001", "SKU-FICT-01"],
      phone: "5511900000001",
      phoneCandidates: ["5511900000001", "11900000001"],
      test: false,
    });
  });

  it("reads the America/Sao_Paulo dates as Brasilia time: 09:29 in Sao Paulo is 12:29 UTC", () => {
    expect(ok(paid).occurredAt.toISOString()).toBe("2026-10-22T12:29:58.000Z");
    expect(
      yampiTimestamp({
        date: "2026-10-22 09:29:52.000000",
        timezone_type: 3,
        timezone: "America/Sao_Paulo",
      })?.toISOString(),
    ).toBe("2026-10-22T12:29:52.000Z");
    // Envelope `time`: no zone, Brasilia time in practice.
    expect(yampiTimestamp("2026-10-22 09:30:12")?.toISOString()).toBe(
      "2026-10-22T12:30:12.000Z",
    );
    // UTC and numeric offsets are honoured; an unknown zone is not guessed.
    expect(
      yampiTimestamp({ date: "2026-10-22 12:29:52.000000", timezone: "UTC" })?.toISOString(),
    ).toBe("2026-10-22T12:29:52.000Z");
    expect(
      yampiTimestamp({ date: "2026-10-22 09:29:52.000000", timezone: "-03:00" })?.toISOString(),
    ).toBe("2026-10-22T12:29:52.000Z");
    expect(yampiTimestamp({ date: "2026-10-22 09:29:52", timezone: "Europe/Lisbon" })).toBeNull();
    expect(yampiTimestamp({ timezone: "America/Sao_Paulo" })).toBeNull();
  });

  it("falls back to the envelope time when the resource has no updated_at", () => {
    const value = ok(
      orderEvent("order.paid", (p) => {
        delete p.resource.updated_at;
      }),
    );
    expect(value.occurredAt.toISOString()).toBe("2026-10-22T12:30:12.000Z");
  });

  it("never returns an event time in the future (capped at the arrival)", () => {
    const future = orderEvent("order.paid", (p) => {
      p.resource.updated_at.date = "2026-10-22 18:00:00.000000";
    });
    expect(ok(future).occurredAt.toISOString()).toBe(receivedAt.toISOString());
    // Within the 5 min skew the time is kept.
    const skew = orderEvent("order.paid", (p) => {
      p.resource.updated_at.date = "2026-10-22 09:33:00.000000";
    });
    expect(ok(skew).occurredAt.toISOString()).toBe("2026-10-22T12:33:00.000Z");
  });

  it("order.status.updated with alias paid is the SAME Purchase as order.paid (never two Purchases)", () => {
    const updated = orderEvent("order.status.updated");
    expect(ok(updated)).toMatchObject({
      eventName: "Purchase",
      providerStatus: "order.status.updated:paid",
    });
    expect(identity(updated)).toBe(identity(paid));
    // status_id 4 without alias is paid too.
    const byId = orderEvent("order.status.updated", (p) => {
      delete p.resource.status;
    });
    expect(identity(byId)).toBe(identity(paid));
  });

  it.each([
    ["cancelled", 5],
    ["refunded", 9],
    ["refused", 8],
    ["handling_products", 6],
    ["shipped", 7],
    ["delivered", 10],
    ["waiting_payment", 3],
  ])("order.status.updated %s is received and ignored", (alias, statusId) => {
    const parsed = parseYampiSaleEventV1(
      orderEvent("order.status.updated", withAlias(alias, statusId)),
      { receivedAt },
    );
    expect(parsed).toEqual({
      ok: false,
      errorCode: "yampi_sale_v1_status_not_supported",
      providerStatus: `order.status.updated:${alias}`,
    });
  });

  it("order.created waiting for payment (boleto/Pix gerado) -> InitiateCheckout at created_at", () => {
    const created = orderEvent("order.created", withAlias("waiting_payment", 3));
    const value = ok(created);
    expect(value).toMatchObject({
      eventName: "InitiateCheckout",
      automation: "checkout_waiting_payment",
      orderRef: "70000001",
      valueCents: 59400,
      currency: "BRL",
    });
    expect(value.occurredAt.toISOString()).toBe("2026-10-22T12:29:52.000Z");
    // Its own identity: never the Purchase of the same order.
    expect(identity(created)).not.toBe(identity(paid));
  });

  it("order.created already paid (card approved at once) is ignored: order.paid is the Purchase", () => {
    const parsed = parseYampiSaleEventV1(orderEvent("order.created"), {
      receivedAt,
    });
    expect(parsed).toMatchObject({
      ok: false,
      errorCode: "yampi_sale_v1_status_not_supported",
      providerStatus: "order.created:paid",
    });
  });

  it("transaction.payment.refused and unknown events are ignored", () => {
    for (const event of ["transaction.payment.refused", "order.updated", "product.created"]) {
      expect(parseYampiSaleEventV1(orderEvent(event), { receivedAt })).toMatchObject({
        ok: false,
        errorCode: "yampi_sale_v1_status_not_supported",
      });
    }
  });

  it("cart.reminder -> CartAbandoned keyed by the cart id, value = totalizers.subtotal", () => {
    // The reminder arrives (envelope time 10:15) after the last cart update.
    const value = ok(cart, new Date("2026-10-22T13:15:01.000Z"));
    expect(value).toMatchObject({
      provider: "yampi",
      eventName: "CartAbandoned",
      automation: "cart_abandoned",
      providerStatus: "cart.reminder",
      orderRef: "cart:20000001",
      // subtotal 297; total 326.9 carries the shipping.
      valueCents: 29700,
      currency: "BRL",
      productCodes: ["3000002", "4000002", "SKU-FICT-02"],
      // full_number already WITH 55 (docs format).
      phone: "5521900000002",
      phoneCandidates: ["5521900000002", "21900000002"],
    });
    expect(value.occurredAt.toISOString()).toBe("2026-10-22T12:45:00.000Z");
    // A second reminder of the same cart is the same CartAbandoned.
    const again = structuredClone(cart);
    again.time = "2026-10-22 11:15:00";
    expect(identity(again)).toBe(identity(cart));
  });

  it("cart.reminder without subtotal is still an abandonment (value optional)", () => {
    const noValue = structuredClone(cart);
    delete noValue.resource.totalizers;
    expect(ok(noValue)).toMatchObject({ eventName: "CartAbandoned", valueCents: null, currency: null });
  });
});

describe("Yampi webhook: phone", () => {
  const phoneOf = (phone: unknown) => yampiPhoneCandidates({ customer: { data: { phone } } });

  it("accepts full_number WITHOUT 55 (real payload) and WITH 55 (docs): 55 first", () => {
    expect(phoneOf({ full_number: "11900000001" })).toEqual(["5511900000001", "11900000001"]);
    expect(phoneOf({ full_number: "5511900000001" })).toEqual(["5511900000001", "11900000001"]);
    expect(phoneOf({ full_number: "1133330000" })).toEqual(["551133330000", "1133330000"]);
  });

  it("prefers area_code + number (no ambiguity with DDD 55)", () => {
    expect(phoneOf({ full_number: "55900000003", area_code: "55", number: "900000003" })).toEqual([
      "5555900000003",
      "55900000003",
    ]);
  });

  it("uses formated_number when full_number is missing; never the whatsapp_link", () => {
    expect(phoneOf({ formated_number: "(11) 90000-0001" })).toEqual(["5511900000001", "11900000001"]);
    expect(phoneOf({ whatsapp_link: "https://wa.me/5511900000001" })).toEqual([]);
  });

  it("keeps a foreign number as received (no guessed 55)", () => {
    expect(phoneOf({ full_number: "351910000000" })).toEqual(["351910000000"]);
  });

  it("an order without phone is an invalid receipt, never a send", () => {
    const parsed = parseYampiSaleEventV1(
      orderEvent("order.paid", (p) => {
        p.resource.customer.data.phone = {};
      }),
      { receivedAt },
    );
    expect(parsed).toEqual({ ok: false, errorCode: "yampi_automation_v1_invalid_payload" });
  });
});

describe("Yampi webhook: value and identity", () => {
  it("parses reais as numbers or numeric strings", () => {
    expect(yampiValueCents(594)).toBe(59400);
    expect(yampiValueCents(197.9)).toBe(19790);
    expect(yampiValueCents("197,90")).toBe(19790);
    expect(yampiValueCents("197.90")).toBe(19790);
    expect(yampiValueCents(0)).toBeNull();
    expect(yampiValueCents("R$ 10")).toBeNull();
  });

  it("never sends value_total/buyer_value_total: without value_products the order is invalid", () => {
    const parsed = parseYampiSaleEventV1(
      orderEvent("order.paid", (p) => {
        delete p.resource.value_products;
      }),
      { receivedAt },
    );
    expect(parsed).toEqual({ ok: false, errorCode: "yampi_automation_v1_invalid_payload" });
  });

  it("an order without id has no identity", () => {
    const parsed = parseYampiSaleEventV1(
      orderEvent("order.paid", (p) => {
        delete p.resource.id;
      }),
      { receivedAt },
    );
    expect(parsed).toEqual({ ok: false, errorCode: "yampi_purchase_identity_missing" });
  });

  it("a repeated order.paid has the same identity (resend = duplicate receipt)", () => {
    expect(identity(structuredClone(paid))).toBe(identity(paid));
  });

  it("is reachable through the sales-platform helper and the product filter", () => {
    const parsed = parseSaleEventV1("yampi", paid, { receivedAt });
    expect(parsed).toMatchObject({ ok: true, value: { provider: "yampi", eventName: "Purchase" } });
    const codes = ok(paid).productCodes ?? [];
    expect(saleProductFilterMatches(["sku-fict-01"], codes)).toBe(true);
    expect(saleProductFilterMatches(["3000001"], codes)).toBe(true);
    expect(saleProductFilterMatches(["9999999"], codes)).toBe(false);
    expect(parseSaleEventV1("yampi", orderEvent("order.status.updated", withAlias("cancelled", 5)))).toMatchObject({
      ok: false,
      kind: "status_not_supported",
    });
  });

  it("Purchase-only view: non-purchases are 'not purchase', not failures", () => {
    expect(parseYampiAutomationV1(paid, { receivedAt })).toMatchObject({ ok: true });
    expect(parseYampiAutomationV1(cart, { receivedAt })).toEqual({
      ok: false,
      errorCode: "yampi_automation_v1_not_purchase",
    });
    expect(parseYampiAutomationV1("x")).toEqual({
      ok: false,
      errorCode: "yampi_automation_v1_invalid_payload",
    });
  });

  it("accepts the n8n test envelope ([{ body }])", () => {
    expect(ok([{ body: paid }]).orderRef).toBe("70000001");
  });
});

describe("Yampi webhook: main product", () => {
  it("shows the item with the highest total, not an order bump listed first", () => {
    const bumpFirst = JSON.parse(JSON.stringify(paid));
    bumpFirst.resource.items.data.unshift({
      product_id: 3999999,
      sku_id: 4999999,
      item_sku: "BUMP-FRETE",
      price: 34.9,
      quantity: 1,
      sku: { data: { title: "Frete Expresso Ficticio" } },
    });
    const value = ok(bumpFirst);
    expect(value.product).toEqual({ code: "3000001", name: "Produto Ficticio Azul" });
    expect(value.offer).toEqual({ code: "SKU-FICT-01", name: "Produto Ficticio Azul" });
    // The bump still enters the product filter.
    expect(value.productCodes).toEqual(
      expect.arrayContaining(["3999999", "4999999", "BUMP-FRETE", "3000001"]),
    );
  });
});
