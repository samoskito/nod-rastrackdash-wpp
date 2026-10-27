import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProviderPurchaseIdentity } from "../../src/conversion-rules/provider-purchase-identity";
import { normalizeBraipBody } from "../../src/inbound-webhooks/providers/braip/braip-body";
import { parseBraipSaleEventV1 } from "../../src/inbound-webhooks/providers/braip/braip-automation-v1.parser";
import {
  parseSaleEventV1,
  saleProductFilterMatches,
} from "../../src/inbound-webhooks/providers/sales-platform-sale";

/**
 * Fixtures built from the STRUCTURE of the official Braip postback example
 * (members area, 2026-10-23). Every value is fake; `basic_authentication` is
 * a placeholder. Cancelada's status code is not in the sample (the text wins).
 */

function raw(name: string): string {
  return readFileSync(resolve(__dirname, "../fixtures/braip", name), "utf8");
}
function fixture(name: string): Record<string, unknown> {
  return JSON.parse(raw(name)) as Record<string, unknown>;
}

const waiting = fixture("official-waiting-payment.sanitized.json");
const approved = fixture("official-approved.sanitized.json");
const orderBump = fixture("official-approved-order-bump.sanitized.json");
const canceled = fixture("official-canceled.sanitized.json");
const affiliate = fixture("official-approved-affiliate.sanitized.json");

function ok(payload: unknown) {
  const parsed = parseBraipSaleEventV1(payload);
  if (!parsed.ok) throw new Error(`expected ok, got ${parsed.errorCode}`);
  return parsed.value;
}

function identity(payload: unknown): string {
  const value = ok(payload);
  return buildProviderPurchaseIdentity({
    workspaceId: "ws_fake",
    provider: "braip",
    accountRef: value.accountRef,
    orderRef: value.orderRef,
    eventName: value.eventName,
  });
}

describe("Braip official postback sample", () => {
  it("Aguardando Pagamento (code 1) -> InitiateCheckout; '23569' is cents; createdate in Sao Paulo time", () => {
    const value = ok(waiting);
    expect(value).toMatchObject({
      eventName: "InitiateCheckout",
      automation: "checkout_waiting_payment",
      providerStatus: "aguardando pagamento",
      orderRef: "venfake0001",
      valueCents: 23569,
      currency: "BRL",
      product: { code: "PROFAKE01", name: "Produto Ficticio" },
      offer: { code: "PLAFAKE01", name: "Plano Ficticio" },
      productCodes: ["PROFAKE01", "PLAFAKE01"],
      phoneCandidates: ["11900000001", "5511900000001"],
      test: false,
    });
    // trans_payment_date is null: the creation date is used (-03:00).
    expect(value.occurredAt.toISOString()).toBe("2026-10-23T13:15:00.000Z");
  });

  it("Pagamento Aprovado (code 2) -> Purchase at trans_payment_date; value is trans_value, not trans_total_value", () => {
    const value = ok(approved);
    expect(value).toMatchObject({
      eventName: "Purchase",
      automation: "purchase_paid",
      orderRef: "venfake0001",
      valueCents: 23569, // trans_total_value (24000) is NOT used
      currency: "BRL",
    });
    expect(value.occurredAt.toISOString()).toBe("2026-10-23T13:19:30.000Z");
  });

  it("type STATUS_ALTERADO is never an abandonment", () => {
    for (const payload of [waiting, approved, canceled]) {
      const parsed = parseBraipSaleEventV1(payload);
      if (parsed.ok) expect(parsed.value.eventName).not.toBe("CartAbandoned");
    }
  });

  it("order bump: routes by the main item only; value is the whole order", () => {
    const value = ok(orderBump);
    expect(value).toMatchObject({
      eventName: "Purchase",
      orderRef: "venfake0002",
      valueCents: 26669, // main + bump (trans_value)
      productCodes: ["PROFAKE01", "PLAFAKE01"],
    });
    expect(value.productCodes).not.toContain("PROFAKEBUMP");
    const codes = value.productCodes ?? [];
    expect(saleProductFilterMatches(["profake01"], codes)).toBe(true);
    expect(saleProductFilterMatches(["profakebump"], codes)).toBe(false);
  });

  it("order bump without top-level codes falls back to the main trans_item (also from a form body)", () => {
    const { product_key: _p, plan_key: _k, product_name: _n, plan_name: _m, ...rest } =
      orderBump;
    expect(ok(rest).productCodes).toEqual(["PROFAKE01", "PLAFAKE01"]);

    const form = new URLSearchParams({
      trans_key: "venfake0003",
      trans_status: "Pagamento Aprovado",
      trans_status_code: "2",
      trans_value: "26669",
      currency: "BRL",
      trans_payment_date: "2026-10-23 10:19:30",
      client_cel: "11900000001",
      "trans_items[0][product_key]": "profakebump",
      "trans_items[0][plan_key]": "plafakebump",
      "trans_items[0][main]": "0",
      "trans_items[1][product_key]": "profake01",
      "trans_items[1][plan_key]": "plafake01",
      "trans_items[1][main]": "1",
    }).toString();
    const normalized = normalizeBraipBody(
      "application/x-www-form-urlencoded",
      Buffer.from(form),
    );
    if (!normalized.ok) throw new Error("expected ok");
    expect(ok(JSON.parse(normalized.body.toString("utf8"))).productCodes).toEqual([
      "PROFAKE01",
      "PLAFAKE01",
    ]);
  });

  it("Cancelada is ignored (status_not_supported), whatever the code", () => {
    expect(parseSaleEventV1("braip", canceled)).toMatchObject({
      ok: false,
      kind: "status_not_supported",
      providerStatus: "cancelada",
    });
  });

  it("dedupe: producer + affiliate postbacks and repeated STATUS_ALTERADO updates share one Purchase identity", () => {
    expect(ok(affiliate)).toMatchObject({
      eventName: "Purchase",
      orderRef: "venfake0001",
      valueCents: 23569, // sale value, not the affiliate commission
    });
    const purchase = identity(approved);
    expect(identity(affiliate)).toBe(purchase);
    // A later update of the same paid sale (e.g. tracking code added).
    expect(
      identity({
        ...approved,
        trans_updatedate: "2026-10-25 09:00:00",
        tracking_code: "FAKE000BR",
      }),
    ).toBe(purchase);
    // The checkout of the same sale is a different event (own identity).
    expect(identity(waiting)).not.toBe(purchase);
  });

  it("the parsed sale carries no PII beyond the phone used for routing", () => {
    const serialized = JSON.stringify(ok(affiliate));
    for (const secret of [
      "FAKE-BRAIP-ACCOUNT-KEY-PLACEHOLDER",
      "cliente@example.test",
      "Cliente Ficticio",
      "produtor@example.test",
      "afiliado@example.test",
      "00000000000",
      "Rua Ficticia",
      "FAKEFBCLID",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("drops basic_authentication before storage, also inside a data wrapper", () => {
    const top = normalizeBraipBody("application/json", Buffer.from(raw("official-approved.sanitized.json")));
    if (!top.ok) throw new Error("expected ok");
    expect(top.body.toString("utf8")).not.toContain("basic_authentication");
    expect(ok(JSON.parse(top.body.toString("utf8"))).orderRef).toBe("venfake0001");

    const wrapped = normalizeBraipBody(
      "application/json",
      Buffer.from(JSON.stringify({ data: approved })),
    );
    if (!wrapped.ok) throw new Error("expected ok");
    const text = wrapped.body.toString("utf8");
    expect(text).not.toContain("basic_authentication");
    expect(text).not.toContain("FAKE-BRAIP-ACCOUNT-KEY-PLACEHOLDER");
  });
});
