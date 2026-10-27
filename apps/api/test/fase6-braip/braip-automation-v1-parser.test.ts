import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeBraipBody } from "../../src/inbound-webhooks/providers/braip/braip-body";
import {
  braipSaleEventNameOf,
  braipTimestamp,
  braipValueCents,
  parseBraipAutomationV1,
  parseBraipSaleEventV1,
} from "../../src/inbound-webhooks/providers/braip/braip-automation-v1.parser";
import {
  parseSaleEventV1,
  saleEventNameOf,
} from "../../src/inbound-webhooks/providers/sales-platform-sale";

/**
 * Braip postback parser. The fixtures are SYNTHETIC (no public Braip payload
 * example exists): field names follow the design doc table, where every
 * unconfirmed name is PENDENTE until a real postback certifies the release.
 */

function raw(name: string): string {
  return readFileSync(resolve(__dirname, "../fixtures/braip", name), "utf8");
}
function fixture(name: string): Record<string, unknown> {
  return JSON.parse(raw(name)) as Record<string, unknown>;
}

const approved = fixture("approved.synthetic.json");
const waiting = fixture("waiting-payment.synthetic.json");
const abandoned = fixture("abandoned-checkout.synthetic.json");
const canceled = fixture("canceled.synthetic.json");

describe("Braip sale event v1 parser", () => {
  it("maps 'Pagamento Aprovado' to Purchase with product, plan and value", () => {
    const parsed = parseBraipSaleEventV1(approved);
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        provider: "braip",
        eventName: "Purchase",
        automation: "purchase_paid",
        providerStatus: "pagamento aprovado",
        orderRef: "VEN000SYNTH1",
        accountRef: "braip",
        valueCents: 19700,
        currency: "BRL",
        product: { code: "PRO0SYNTH1", name: "Mentoria Sintetica" },
        offer: { code: "PLA0SYNTH1", name: "Oferta principal" },
        productCodes: ["PRO0SYNTH1", "PLA0SYNTH1"],
        // national BR number kept + E.164 equivalent
        phoneCandidates: ["11991231020", "5511991231020"],
      },
    });
    if (!parsed.ok) throw new Error("expected ok");
    // trans_updatedate is Brasilia time (-03:00).
    expect(parsed.value.occurredAt.toISOString()).toBe(
      "2026-10-14T12:00:30.000Z",
    );
  });

  it("maps 'Aguardando Pagamento' (boleto/pix generated) to InitiateCheckout; '197,00' is reais", () => {
    expect(parseBraipSaleEventV1(waiting)).toMatchObject({
      ok: true,
      value: {
        eventName: "InitiateCheckout",
        automation: "checkout_waiting_payment",
        orderRef: "VEN000SYNTH1",
        valueCents: 19700,
      },
    });
  });

  it("maps an abandoned checkout to CartAbandoned keyed by the cart, without value", () => {
    expect(parseBraipSaleEventV1(abandoned)).toMatchObject({
      ok: true,
      value: {
        eventName: "CartAbandoned",
        automation: "cart_abandoned",
        orderRef: "CHK000SYNTH9",
        valueCents: null,
        phoneCandidates: ["5511991231020"],
      },
    });
  });

  it("ignores refunds, chargebacks, cancelations and every other status", () => {
    for (const status of [
      "Cancelada",
      "Chargeback",
      "Devolvida",
      "Estorno Pendente",
      "Em Análise",
      "Em Processamento",
      "Parcialmente Pago",
      "Pagamento Atrasado",
      "Alteração de Vencimento de Boleto",
      "Código de rastreio adicionado",
    ]) {
      const parsed = parseBraipSaleEventV1({ ...canceled, trans_status: status });
      expect(parsed).toMatchObject({
        ok: false,
        errorCode: "braip_sale_v1_status_not_supported",
      });
    }
    // The text always wins over a (PENDENTE) numeric code.
    expect(
      braipSaleEventNameOf({ ...canceled, trans_status_code: 2 }),
    ).toBeNull();
  });

  it("paid wins: an approved status with an abandoned type is a Purchase", () => {
    expect(
      braipSaleEventNameOf({ ...approved, type: "ABANDONO_CHECKOUT" }),
    ).toBe("Purchase");
  });

  it("falls back to the numeric status code only when the text is absent (PENDENTE)", () => {
    const { trans_status: _text, ...noText } = approved;
    expect(braipSaleEventNameOf(noText)).toBe("Purchase");
    expect(braipSaleEventNameOf({ ...noText, trans_status_code: 1 })).toBe(
      "InitiateCheckout",
    );
    expect(braipSaleEventNameOf({ ...noText, trans_status_code: 3 })).toBeNull();
  });

  it("is tolerant to candidate field names and wrappers", () => {
    const alternative = {
      data: {
        transaction_key: "VEN-ALT-1",
        transaction_status: "Aprovado",
        transaction_value: "1.297,90",
        updated_at: "2026-10-14T09:00:00-03:00",
        product: { key: "p-alt", name: "Produto Alt" },
        plan: { key: "o-alt", name: "Plano Alt" },
        client_phone: "5521988887777",
      },
    };
    expect(parseBraipSaleEventV1(alternative)).toMatchObject({
      ok: true,
      value: {
        orderRef: "VEN-ALT-1",
        valueCents: 129790,
        productCodes: ["P-ALT", "O-ALT"],
        phoneCandidates: ["5521988887777"],
      },
    });
  });

  it("never guesses missing data: no transaction, phone, value or date is invalid", () => {
    const { trans_key: _key, ...noKey } = approved;
    expect(parseBraipSaleEventV1(noKey)).toMatchObject({
      ok: false,
      errorCode: "braip_purchase_identity_missing",
    });
    const { client_cel: _cel, ...noPhone } = approved;
    expect(parseBraipSaleEventV1(noPhone)).toMatchObject({
      ok: false,
      errorCode: "braip_automation_v1_invalid_payload",
    });
    const { trans_value: _v, trans_total_value: _t, ...noValue } = approved;
    expect(parseBraipSaleEventV1(noValue)).toMatchObject({
      ok: false,
      errorCode: "braip_automation_v1_invalid_payload",
    });
    // Only an unsupported declared currency is invalid (USD/EUR are accepted).
    expect(
      parseBraipSaleEventV1({ ...approved, trans_currency: "GBP" }),
    ).toMatchObject({ ok: false, errorCode: "braip_automation_v1_invalid_payload" });
    expect(parseBraipSaleEventV1("not an object")).toMatchObject({
      ok: false,
      errorCode: "braip_automation_v1_invalid_payload",
    });
  });

  it("accepts USD/EUR sales and leaves an undeclared currency to the rule/workspace", () => {
    expect(
      parseBraipSaleEventV1({ ...approved, trans_currency: "USD" }),
    ).toMatchObject({ ok: true, value: { currency: "USD", valueCents: 19700 } });
    expect(
      parseBraipSaleEventV1({ ...approved, trans_currency: "eur" }),
    ).toMatchObject({ ok: true, value: { currency: "EUR" } });
    const { trans_currency: _currency, currency: _alt, ...undeclared } = approved;
    expect(parseBraipSaleEventV1(undeclared)).toMatchObject({
      ok: true,
      value: { currency: null, valueCents: 19700 },
    });
  });

  it("keeps the Purchase-only contract for per-rule Purchase URLs", () => {
    expect(parseBraipAutomationV1(waiting)).toEqual({
      ok: false,
      errorCode: "braip_automation_v1_not_purchase",
    });
    expect(parseBraipAutomationV1(approved)).toMatchObject({ ok: true });
  });

  it("dispatches through the sales-platform helpers", () => {
    expect(saleEventNameOf("braip", approved)).toBe("Purchase");
    expect(parseSaleEventV1("braip", canceled)).toMatchObject({
      ok: false,
      kind: "status_not_supported",
      providerStatus: "cancelada",
    });
  });
});

describe("Braip value without installment interest (PENDENTE)", () => {
  it("prefers trans_value over a trans_total_value with interest", () => {
    expect(
      parseBraipSaleEventV1({
        ...approved,
        trans_value: 24700,
        trans_total_value: 29760,
      }),
    ).toMatchObject({ ok: true, value: { valueCents: 24700 } });
  });

  it("falls back to trans_total_value when trans_value is missing", () => {
    const { trans_value: _value, ...withoutValue } = approved;
    expect(
      parseBraipSaleEventV1({ ...withoutValue, trans_total_value: 29760 }),
    ).toMatchObject({ ok: true, value: { valueCents: 29760 } });
  });
});

describe("Braip value and date helpers (PENDENTE formats)", () => {
  it("reads integers as cents and decimals as reais", () => {
    expect(braipValueCents(19700)).toBe(19700);
    expect(braipValueCents("19700")).toBe(19700);
    expect(braipValueCents(197.5)).toBe(19750);
    expect(braipValueCents("197.50")).toBe(19750);
    expect(braipValueCents("R$ 1.297,90")).toBe(129790);
    expect(braipValueCents("1,297.90")).toBe(129790);
    expect(braipValueCents(0)).toBeNull();
    expect(braipValueCents("abc")).toBeNull();
  });

  it("reads naive and Brazilian dates as Brasilia time", () => {
    expect(braipTimestamp("2026-10-14 09:00:00")?.toISOString()).toBe(
      "2026-10-14T12:00:00.000Z",
    );
    expect(braipTimestamp("14/10/2026 09:00:00")?.toISOString()).toBe(
      "2026-10-14T12:00:00.000Z",
    );
    expect(braipTimestamp("2026-10-14T12:00:00Z")?.toISOString()).toBe(
      "2026-10-14T12:00:00.000Z",
    );
    expect(braipTimestamp("ontem")).toBeNull();
  });
});

describe("Braip body normalization", () => {
  it("converts a form-urlencoded postback to the same JSON and drops the account key", () => {
    const normalized = normalizeBraipBody(
      "application/x-www-form-urlencoded",
      Buffer.from(raw("approved.synthetic.form.txt")),
    );
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) throw new Error("expected ok");
    expect(normalized.format).toBe("form");
    const body = JSON.parse(normalized.body.toString("utf8"));
    expect(body.basic_authentication).toBeUndefined();
    expect(body.meta).toEqual({ src: "ctwa", utm_source: "facebook" });
    expect(parseBraipSaleEventV1(body)).toMatchObject({
      ok: true,
      value: { eventName: "Purchase", orderRef: "VEN000SYNTH1", valueCents: 19700 },
    });
  });

  it("accepts JSON (also without content type) and drops the account key", () => {
    for (const contentType of ["application/json", undefined, "text/plain"]) {
      const normalized = normalizeBraipBody(
        contentType,
        Buffer.from(raw("approved.synthetic.json")),
      );
      if (!normalized.ok) throw new Error("expected ok");
      expect(
        JSON.parse(normalized.body.toString("utf8")).basic_authentication,
      ).toBeUndefined();
    }
  });

  it("rejects bodies that are neither an object nor a form", () => {
    expect(normalizeBraipBody("application/json", Buffer.from("[1,2]"))).toEqual({
      ok: false,
      errorCode: "braip_body_invalid",
    });
    expect(
      normalizeBraipBody("multipart/form-data; boundary=x", Buffer.from("--x")),
    ).toEqual({ ok: false, errorCode: "braip_body_unsupported" });
    // prototype pollution keys are dropped
    const polluted = normalizeBraipBody(
      "application/x-www-form-urlencoded",
      Buffer.from("__proto__[x]=1&a[constructor]=2&trans_key=K"),
    );
    if (!polluted.ok) throw new Error("expected ok");
    expect(JSON.parse(polluted.body.toString("utf8"))).toEqual({ trans_key: "K" });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});
