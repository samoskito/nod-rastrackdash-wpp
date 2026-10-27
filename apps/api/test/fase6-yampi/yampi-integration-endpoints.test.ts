import { describe, expect, it } from "vitest";
import {
  jeanChannels,
  jeanLeads,
  paytSale,
  W,
  world,
  type Rule,
} from "../fase5-url-unica/url-unica-world";

/**
 * Fase 6.7 — Yampi on the single-URL base (ported from the SaaS 1889af48,
 * #186, and 087df11b, #187), adapted to the student edition: open to every
 * workspace (no private-sales-platform-gate, no yampi-feature-gate, no
 * "yampiEnabled" flag), production direct (reader certified by migration),
 * no account-access check at the URL (a blocked license answers 423 at the
 * global guard). Fictitious data only.
 */

/** Synthetic Yampi webhook (structure of the real payloads, fictitious data). */
function yampiSale(
  input: {
    event?: string;
    alias?: string;
    statusId?: number;
    order?: number;
    fullNumber?: string;
    productId?: number;
    sku?: string;
    updatedAt?: string;
  } = {},
) {
  return {
    event: input.event ?? "order.paid",
    time: "2026-10-14 08:59:50",
    merchant: { id: 900001, alias: "loja-ficticia" },
    resource: {
      id: input.order ?? 70000001,
      number: 1001,
      status_id: input.statusId ?? 4,
      status: { data: { id: input.statusId ?? 4, alias: input.alias ?? "paid" } },
      value_total: 659.35,
      buyer_value_total: 659.35,
      value_products: 594,
      value_shipment: 29.9,
      value_tax: 35.45,
      value_discount: 0,
      created_at: { date: "2026-10-14 08:59:00.000000", timezone_type: 3, timezone: "America/Sao_Paulo" },
      updated_at: {
        date: input.updatedAt ?? "2026-10-14 08:59:30.000000",
        timezone_type: 3,
        timezone: "America/Sao_Paulo",
      },
      customer: {
        data: {
          name: "Fulana de Teste",
          email: "fulana.teste@example.com",
          cpf: "000.000.000-00",
          // Real payload: WITHOUT 55.
          phone: { full_number: input.fullNumber ?? "11991231020" },
        },
      },
      items: {
        data: [
          {
            product_id: input.productId ?? 3000001,
            sku_id: 4000001,
            item_sku: input.sku ?? "SKU-FICT-01",
            quantity: 2,
            price: 297,
            sku: { data: { title: "Produto Ficticio Azul" } },
          },
        ],
      },
      transactions: { data: [{ id: 60000001, status: "paid", amount: 623.9, installments: 3 }] },
    },
  };
}

const yampiRules: Rule[] = [
  { id: "yampi_global", provider: "yampi", eventName: "Purchase", scope: "all_numbers", connectionId: "conn_unnichat_a", channelIds: [] },
  { id: "yampi_1020", provider: "yampi", eventName: "Purchase", scope: "specific_numbers", connectionId: "conn_unnichat_a", channelIds: ["ch_1020"] },
  { id: "yampi_checkout", provider: "yampi", eventName: "InitiateCheckout", scope: "all_numbers", connectionId: "conn_unnichat_a", channelIds: [] },
  { id: "yampi_cart", provider: "yampi", eventName: "CartAbandoned", scope: "all_numbers", connectionId: "conn_unnichat_a", channelIds: [] },
  // A Braip rule never takes a Yampi sale.
  { id: "braip_global", provider: "braip", eventName: "Purchase", scope: "all_numbers", connectionId: "conn_unnichat_a", channelIds: [] },
];

describe("Yampi: one URL per workspace, open to every workspace", () => {
  it("connects once as a sales platform, without any private-integration flag", async () => {
    const w = world({ channels: jeanChannels, rules: yampiRules, leads: jeanLeads });
    const first = await w.connect("yampi");
    const second = await w.connect("yampi");
    expect(second.endpoint.id).toBe(first.endpoint.id);
    expect(first.endpoint).toMatchObject({ provider: "yampi", kind: "sales_platform", eventName: null });
    expect(first.url.pathname).toBe(`/webhooks/inbound/integrations/${first.endpoint.id}`);
    const list = await w.service.list(W, true);
    expect(list.endpoints.map((item) => item.provider)).toContain("yampi");
    // No SaaS-only private flags in the student edition's contract.
    expect(list).not.toHaveProperty("yampiEnabled");
    expect(list).not.toHaveProperty("brinkParkEnabled");
    // Products and unattributed sales are open too.
    await expect(w.service.listProducts(W, "yampi")).resolves.toBeDefined();
    await expect(w.service.listUnattributed(W, "yampi")).resolves.toMatchObject({ total: 0 });
    // The Braip URL is another address.
    expect((await w.connect("braip")).endpoint.id).not.toBe(first.endpoint.id);
  });

  it("attributes by the buyer's phone (with or without 55) to the origin number; value = value_products", async () => {
    const w = world({ channels: jeanChannels, rules: yampiRules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("yampi");
    const on1020 = await w.post(endpoint.id, token, yampiSale({ order: 1, fullNumber: "11991231020" }));
    const on5520 = await w.post(endpoint.id, token, yampiSale({ order: 2, fullNumber: "5511987655520" }));
    expect(on1020).toMatchObject({ routing: "routed" });
    expect(on5520).toMatchObject({ routing: "routed" });
    expect(w.observed.map((call: any) => call.providerRuleId)).toEqual(["yampi_1020", "yampi_global"]);
    expect(w.observed[0].automation).toMatchObject({
      provider: "yampi",
      eventName: "Purchase",
      valueCents: 59400, // value_products, never value_total (65935)
      currency: "BRL",
    });
    expect((w.observed[0].automation as { occurredAt: Date }).occurredAt.toISOString()).toBe(
      "2026-10-14T11:59:30.000Z",
    );
  });

  it("order.created waiting for payment (boleto/Pix) -> InitiateCheckout; cart.reminder -> CartAbandoned", async () => {
    const w = world({ channels: jeanChannels, rules: yampiRules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("yampi");
    await w.post(endpoint.id, token, yampiSale({ event: "order.created", alias: "waiting_payment", statusId: 3, order: 10 }));
    const reminder = {
      event: "cart.reminder",
      time: "2026-10-14 08:59:50",
      merchant: { id: 900001, alias: "loja-ficticia" },
      resource: {
        id: 20000001,
        token: "carttoken-ficticio-0002",
        totalizers: { subtotal: 297, discount: 0, shipment: 29.9, total: 326.9 },
        updated_at: { date: "2026-10-14 08:50:00.000000", timezone_type: 3, timezone: "America/Sao_Paulo" },
        customer: { data: { phone: { full_number: "5511991231020" } } },
        tracking_data: { name: "Fulana de Teste", email: "fulana.teste@example.com" },
      },
    };
    await w.post(endpoint.id, token, reminder);
    expect(
      w.observed.map((call: any) => [call.providerRuleId, call.automation.eventName, call.automation.valueCents]),
    ).toEqual([
      ["yampi_checkout", "InitiateCheckout", 59400],
      ["yampi_cart", "CartAbandoned", 29700],
    ]);
  });

  it("order.paid repeated and order.status.updated (paid) are ONE receipt and ONE delivery (never two Purchases)", async () => {
    const w = world({ channels: jeanChannels, rules: yampiRules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("yampi");
    await w.post(endpoint.id, token, yampiSale({ order: 77 }));
    const resend = await w.post(endpoint.id, token, yampiSale({ order: 77 }));
    const updated = await w.post(
      endpoint.id,
      token,
      yampiSale({ order: 77, event: "order.status.updated", updatedAt: "2026-10-14 08:59:45.000000" }),
    );
    expect(resend).toMatchObject({ duplicate: true, routing: "routed" });
    expect(updated).toMatchObject({ duplicate: true, routing: "routed" });
    expect(w.receipts.size).toBe(1);
    expect([...w.receipts.values()][0].attemptCount).toBe(3);
    expect(w.deliveries.size).toBe(1);
    const keys = new Set(
      w.observed.map((call: any) => `${call.providerRuleId}|${call.automation.externalExecutionKey}`),
    );
    expect(keys.size).toBe(1);
  });

  it("records cancelado, reembolso, recusado and other statuses as ignored, never routed", async () => {
    const w = world({ channels: jeanChannels, rules: yampiRules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("yampi");
    const cases: Array<[string, string, number]> = [
      ["order.status.updated", "cancelled", 5],
      ["order.status.updated", "refunded", 9],
      ["transaction.payment.refused", "refused", 8],
      ["order.created", "paid", 4],
    ];
    for (const [index, [event, alias, statusId]] of cases.entries()) {
      expect(
        await w.post(endpoint.id, token, yampiSale({ event, alias, statusId, order: 900 + index })),
      ).toMatchObject({ routing: "ignored", reasonCode: "status_not_supported" });
    }
    expect(w.observed).toHaveLength(0);
    expect([...w.receipts.values()].map((r) => r.providerStatus)).toEqual([
      "order.status.updated:cancelled",
      "order.status.updated:refunded",
      "transaction.payment.refused:refused",
      "order.created:paid",
    ]);
  });

  it("lists sales without attribution (buyer not a lead, product without rule) and detects products", async () => {
    const w = world({
      channels: jeanChannels,
      rules: [{ ...yampiRules[1]!, productFilterCodes: ["SKU-FICT-01"] }],
      leads: jeanLeads,
    });
    const { endpoint, token } = await w.connect("yampi");
    expect(
      await w.post(endpoint.id, token, yampiSale({ order: 31, sku: "SKU-OUTRO", productId: 3999999 })),
    ).toMatchObject({ routing: "unattributed", reasonCode: "product_without_rule" });
    expect(
      await w.post(endpoint.id, token, yampiSale({ order: 32, fullNumber: "11900000000" })),
    ).toMatchObject({ routing: "unattributed", reasonCode: "buyer_not_whatsapp_lead" });
    expect([...w.receipts.values()][0]).toMatchObject({
      productCode: "3999999",
      productName: "Produto Ficticio Azul",
      offerCode: "SKU-OUTRO",
      valueCents: 59400,
      currency: "BRL",
    });
    const list = await w.service.listUnattributed(W, "yampi");
    expect(list.items.map((item) => item.reasonCode).sort()).toEqual([
      "buyer_not_whatsapp_lead",
      "product_without_rule",
    ]);
    // No PII in the receipt columns (the payload is only stored encrypted).
    expect(JSON.stringify([...w.receipts.values()][0])).not.toContain("fulana.teste@example.com");
  });

  it("shows the highest-value item as the product, not an order bump listed first (#187)", async () => {
    const w = world({ channels: jeanChannels, rules: [], leads: jeanLeads });
    const { endpoint, token } = await w.connect("yampi");
    const sale = yampiSale({ order: 41, fullNumber: "11900000000" });
    sale.resource.items.data.unshift({
      product_id: 3999998,
      sku_id: 4999998,
      item_sku: "BUMP-FRETE",
      quantity: 1,
      price: 34.9,
      sku: { data: { title: "Frete Expresso Ficticio" } },
    });
    await w.post(endpoint.id, token, sale);
    expect([...w.receipts.values()][0]).toMatchObject({
      productCode: "3000001",
      productName: "Produto Ficticio Azul",
      offerCode: "SKU-FICT-01",
    });
  });

  it("keeps an invalid webhook (no order id) as a receipt, never a send", async () => {
    const w = world({ channels: jeanChannels, rules: yampiRules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("yampi");
    const noId = yampiSale({});
    delete (noId.resource as { id?: number }).id;
    await expect(w.post(endpoint.id, token, noId)).resolves.toMatchObject({
      routing: "invalid",
      reasonCode: "yampi_purchase_identity_missing",
    });
    expect(w.observed).toHaveLength(0);
  });

  it("never lets an event time land in the future", async () => {
    const w = world({ channels: jeanChannels, rules: yampiRules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("yampi");
    await w.post(endpoint.id, token, yampiSale({ order: 51, updatedAt: "2099-01-01 10:00:00.000000" }));
    const receipt = [...w.receipts.values()][0];
    expect(receipt.occurredAt.getTime()).toBeLessThanOrEqual(receipt.firstReceivedAt.getTime());
  });

  it("refuses a missing/wrong token with the same 404, recording metadata only", async () => {
    const w = world({ channels: jeanChannels, rules: yampiRules, leads: jeanLeads });
    const { endpoint } = await w.connect("yampi");
    await expect(w.post(endpoint.id, "wrong", yampiSale({}))).rejects.toThrow("Webhook não encontrado");
    const [receipt] = [...w.receipts.values()];
    expect(receipt).toMatchObject({ status: "rejected", reasonCode: "token_invalid" });
    expect(receipt.encryptedPayload ?? null).toBeNull();
    expect(w.observed).toHaveLength(0);
  });
});

describe("Ver dados recebidos of a Yampi sale (masked, read only)", () => {
  it("hides the HMAC header copy, login_url and the login tokens inside links (#187)", async () => {
    const w = world({ channels: jeanChannels, rules: [], leads: jeanLeads });
    const { endpoint, token } = await w.connect("yampi");
    const sale = yampiSale({ order: 61, fullNumber: "11900001234" });
    const accepted = await w.post(endpoint.id, token, {
      ...sale,
      "x-yampi-hmac-sha256": "hmac-ficticio-nao-real",
      resource: {
        ...sale.resource,
        login_url: "https://loja-ficticia.example/auth/login/force?token=login-ficticio-123",
        reorder_url:
          "https://loja-ficticia.example/cart/items?customerToken=cliente-ficticio-1&quantity%5B0%5D=1&store_token=loja-ficticia-9",
        simulate_url: "https://loja-ficticia.example/cart?cart_token=c1&customerToken=cliente-ficticio-2",
      },
    });
    const view = await w.service.readEventPayload(W, accepted.eventId, "operator");
    expect(view).toMatchObject({
      provider: "yampi",
      status: "unattributed",
      payloadAvailable: true,
      parsed: {
        eventName: "Purchase",
        valueCents: 59400,
        currency: "BRL",
        orderRef: "61",
        phoneMasked: "••••1234",
        productCode: "3000001",
        offerCode: "SKU-FICT-01",
      },
    });
    expect(view).not.toHaveProperty("certification");
    const text = JSON.stringify(view.payload);
    for (const secret of [
      "hmac-ficticio-nao-real",
      "login-ficticio-123",
      "cliente-ficticio-1",
      "cliente-ficticio-2",
      "loja-ficticia-9",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("customerToken=[oculto]");
    expect(text).toContain("store_token=[oculto]");
    expect(w.audit.some((entry: any) => entry.action === "integration_endpoint.event.payload.read")).toBe(true);
  });

  it("keeps the Payt URL working exactly as before (no regression)", async () => {
    const w = world({
      channels: jeanChannels,
      rules: [{ id: "payt_global", provider: "payt", eventName: "Purchase", scope: "all_numbers", connectionId: "conn_unnichat_a", channelIds: [] }],
      leads: jeanLeads,
    });
    const { endpoint, token } = await w.connect("payt");
    await expect(w.post(endpoint.id, token, paytSale({ order: "P1" }))).resolves.toMatchObject({ routing: "routed" });
  });
});
