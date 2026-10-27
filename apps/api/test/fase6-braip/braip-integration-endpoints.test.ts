import { describe, expect, it } from "vitest";
import { InboundWebhookPayloadEncryptionService } from "../../src/inbound-webhooks/inbound-webhook-payload-encryption.service";
import {
  jeanChannels,
  jeanLeads,
  paytSale,
  W,
  world,
  type Rule,
} from "../fase5-url-unica/url-unica-world";

/**
 * Fase 6.5 — Braip on the single-URL base (ported from the SaaS 09d7303a,
 * #164, #169 and #170, adapted to the student edition: production direct,
 * no certification path, no private-integration gate, no account-access
 * check at the URL: a blocked license answers 423 at the global guard).
 */

function braipSale(input: {
  status?: string;
  type?: string;
  transaction?: string;
  phone?: string;
  product?: string;
  plan?: string;
  totalCents?: number;
  updatedAt?: string;
}) {
  return {
    basic_authentication: "SYNTHETIC-KEY-NOT-REAL",
    type: input.type ?? "STATUS_ALTERADO",
    trans_key: input.transaction ?? "VEN-1",
    trans_status: input.status ?? "Pagamento Aprovado",
    trans_total_value: input.totalCents ?? 19700,
    trans_createdate: "2026-10-14 08:59:00",
    trans_updatedate: input.updatedAt ?? "2026-10-14 09:00:00",
    product_key: input.product ?? "pro1",
    product_name: "Mentoria",
    plan_key: input.plan ?? "pla1",
    plan_name: "Oferta principal",
    client_name: "Comprador",
    client_email: "comprador@example.test",
    client_cel: input.phone ?? "(11) 99123-1020",
  };
}

const braipRules: Rule[] = [
  { id: "braip_global", provider: "braip", eventName: "Purchase", scope: "all_numbers", connectionId: "conn_unnichat_a", channelIds: [] },
  { id: "braip_1020", provider: "braip", eventName: "Purchase", scope: "specific_numbers", connectionId: "conn_unnichat_a", channelIds: ["ch_1020"] },
  { id: "braip_checkout", provider: "braip", eventName: "InitiateCheckout", scope: "all_numbers", connectionId: "conn_unnichat_a", channelIds: [] },
  { id: "braip_cart", provider: "braip", eventName: "CartAbandoned", scope: "all_numbers", connectionId: "conn_unnichat_a", channelIds: [] },
  // A Payt rule never takes a Braip sale.
  { id: "payt_global", provider: "payt", eventName: "Purchase", scope: "all_numbers", connectionId: "conn_unnichat_a", channelIds: [] },
];

describe("Braip: one URL per workspace (same base as Payt)", () => {
  it("connects once as a sales platform (no event in the URL)", async () => {
    const w = world({ channels: jeanChannels, rules: braipRules, leads: jeanLeads });
    const first = await w.connect("braip");
    const second = await w.connect("braip");
    expect(second.endpoint.id).toBe(first.endpoint.id);
    expect(first.endpoint).toMatchObject({ provider: "braip", kind: "sales_platform", eventName: null });
    expect(first.url.pathname).toBe(`/webhooks/inbound/integrations/${first.endpoint.id}`);
    // The Payt URL is another address.
    expect((await w.connect("payt")).endpoint.id).not.toBe(first.endpoint.id);
  });

  it("routes by the buyer's origin number (national / +55 forms): specific on 1020, global on 5520", async () => {
    const w = world({ channels: jeanChannels, rules: braipRules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("braip");
    const on1020 = await w.post(endpoint.id, token, braipSale({ transaction: "A1", phone: "(11) 99123-1020" }));
    const on5520 = await w.post(endpoint.id, token, braipSale({ transaction: "B1", phone: "+55 11 98765-5520" }));
    expect(on1020).toMatchObject({ routing: "routed" });
    expect(on5520).toMatchObject({ routing: "routed" });
    expect(w.observed.map((call: any) => call.providerRuleId)).toEqual(["braip_1020", "braip_global"]);
    expect(w.observed[0].automation).toMatchObject({ provider: "braip", eventName: "Purchase", valueCents: 19700 });
  });

  it.each([
    ["Pagamento Aprovado", "STATUS_ALTERADO", "Purchase", "braip_1020"],
    ["Aguardando Pagamento", "STATUS_ALTERADO", "InitiateCheckout", "braip_checkout"],
    ["Abandono de Checkout", "ABANDONO_CHECKOUT", "CartAbandoned", "braip_cart"],
    // paid wins over an abandoned type
    ["Pagamento Aprovado", "ABANDONO_CHECKOUT", "Purchase", "braip_1020"],
  ])("maps status %s (type %s) to %s", async (status, type, eventName, ruleId) => {
    const w = world({ channels: jeanChannels, rules: braipRules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("braip");
    await w.post(endpoint.id, token, braipSale({ status, type }));
    expect(w.observed).toHaveLength(1);
    expect(w.observed[0]).toMatchObject({ providerRuleId: ruleId, automation: { eventName } });
    expect([...w.receipts.values()][0]).toMatchObject({ provider: "braip", eventName, status: "routed" });
  });

  it("records refunds/chargebacks/cancelations as ignored and never routes them", async () => {
    const w = world({ channels: jeanChannels, rules: braipRules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("braip");
    const statuses = ["Cancelada", "Chargeback", "Devolvida", "Estorno Pendente"];
    for (const [index, status] of statuses.entries()) {
      expect(
        await w.post(endpoint.id, token, braipSale({ status, transaction: `R${index}` })),
      ).toMatchObject({ routing: "ignored", reasonCode: "status_not_supported" });
    }
    expect(w.observed).toHaveLength(0);
    expect([...w.receipts.values()].map((r) => r.providerStatus)).toEqual([
      "cancelada",
      "chargeback",
      "devolvida",
      "estorno pendente",
    ]);
  });

  it("explains unattributed sales and detects product + plan codes", async () => {
    const w = world({
      channels: jeanChannels,
      rules: [{ ...braipRules[1]!, productFilterCodes: ["PROA"] }],
      leads: jeanLeads,
    });
    const { endpoint, token } = await w.connect("braip");
    expect(
      await w.post(endpoint.id, token, braipSale({ transaction: "X1", product: "prob" })),
    ).toMatchObject({ routing: "unattributed", reasonCode: "product_without_rule" });
    expect(
      await w.post(endpoint.id, token, braipSale({ transaction: "X2", product: "proa", phone: "11900000000" })),
    ).toMatchObject({ routing: "unattributed", reasonCode: "buyer_not_whatsapp_lead" });
    // The plan (offer) code also matches the product filter.
    expect(
      await w.post(endpoint.id, token, braipSale({ transaction: "X3", product: "other", plan: "proa" })),
    ).toMatchObject({ routing: "routed" });
    expect([...w.receipts.values()][0]).toMatchObject({
      productCode: "PROB",
      productName: "Mentoria",
      offerCode: "PLA1",
      offerName: "Oferta principal",
      valueCents: 19700,
      currency: "BRL",
    });
    const list = await w.service.listUnattributed(W, "braip");
    expect(list.items.map((item) => item.reasonCode).sort()).toEqual([
      "buyer_not_whatsapp_lead",
      "product_without_rule",
    ]);
  });

  it("dedupes resends of the same sale+event (even with a different body) into ONE receipt and ONE delivery", async () => {
    const w = world({ channels: jeanChannels, rules: braipRules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("braip");
    await w.post(endpoint.id, token, braipSale({ transaction: "D1" }));
    const resend = await w.post(
      endpoint.id,
      token,
      braipSale({ transaction: "D1", type: "TRACKING_CODE_ADDED", updatedAt: "2026-10-15 10:00:00" }),
    );
    expect(resend).toMatchObject({ duplicate: true, routing: "routed" });
    expect(w.receipts.size).toBe(1);
    expect([...w.receipts.values()][0].attemptCount).toBe(2);
    expect(w.deliveries.size).toBe(1);
    const keys = new Set(
      w.observed.map((call: any) => `${call.providerRuleId}|${call.automation.externalExecutionKey}`),
    );
    expect(keys.size).toBe(1);
    // The same transaction's checkout is another event: its own receipt.
    await w.post(endpoint.id, token, braipSale({ transaction: "D1", status: "Aguardando Pagamento" }));
    expect(w.receipts.size).toBe(2);
  });

  it("accepts a form-urlencoded postback and never stores the Braip account key", async () => {
    const w = world({ channels: jeanChannels, rules: braipRules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("braip");
    const form = new URLSearchParams(
      Object.entries(braipSale({ transaction: "F1" })).map(([k, v]) => [k, String(v)]),
    ).toString();
    await expect(
      w.postRaw(endpoint.id, token, "application/x-www-form-urlencoded", form),
    ).resolves.toMatchObject({ routing: "routed" });
    const receipt = [...w.receipts.values()][0];
    const encryption = new InboundWebhookPayloadEncryptionService({
      INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    } as any);
    const stored = (w.service as any).decryptEventPayload(receipt).toString("utf8");
    expect(JSON.parse(stored)).toMatchObject({ trans_key: "F1" });
    expect(stored).not.toContain("SYNTHETIC-KEY-NOT-REAL");
    expect(JSON.stringify(receipt)).not.toContain("comprador@example.test");
    expect(encryption).toBeDefined();
  });

  it("keeps an invalid postback (no transaction key) as a receipt, never a send", async () => {
    const w = world({ channels: jeanChannels, rules: braipRules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("braip");
    const { trans_key: _key, ...noKey } = braipSale({});
    await expect(w.post(endpoint.id, token, noKey)).resolves.toMatchObject({
      routing: "invalid",
      reasonCode: "braip_purchase_identity_missing",
    });
    expect(w.observed).toHaveLength(0);
  });

  it("never lets an event time land in the future (fase 6.0 rule, now for Braip)", async () => {
    const w = world({ channels: jeanChannels, rules: braipRules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("braip");
    await w.post(
      endpoint.id,
      token,
      braipSale({ transaction: "FUT", updatedAt: "2099-01-01 10:00:00" }),
    );
    const receipt = [...w.receipts.values()][0];
    expect(receipt.occurredAt.getTime()).toBeLessThanOrEqual(
      receipt.firstReceivedAt.getTime(),
    );
  });
});

describe("URL box counters after a sale (SaaS #164)", () => {
  it("counts an unattributed sale everywhere the URL box reads (list, Mostrar URL, Gerar URL, Gerar nova)", async () => {
    const w = world({ channels: jeanChannels, rules: [], leads: jeanLeads });
    const { endpoint, token } = await w.connect("braip");
    expect(endpoint.stats).toMatchObject({ received: 0 });
    const accepted = await w.post(endpoint.id, token, braipSale({ transaction: "U1", phone: "11900000000" }));
    expect(accepted).toMatchObject({ status: "accepted", routing: "unattributed", duplicate: false });
    const expected = {
      lastDeliveryAt: expect.any(String),
      stats: { received: 1, routed: 0, unattributed: 1, ignored: 0, invalid: 0 },
    };
    const listed = await w.service.list(W, true);
    expect(listed.endpoints.find((item) => item.id === endpoint.id)).toMatchObject(expected);
    await expect(w.service.reveal(W, endpoint.id, "operator")).resolves.toMatchObject(expected);
    await expect(w.service.ensure(W, { provider: "braip" }, "operator")).resolves.toMatchObject(expected);
    await expect(w.service.rotate(W, endpoint.id, "operator")).resolves.toMatchObject(expected);
  });
});

describe("Recebimentos das URLs únicas: what each outcome stores (SaaS #170)", () => {
  const rules: Rule[] = [
    { id: "braip_1020", provider: "braip", eventName: "Purchase", scope: "specific_numbers", connectionId: "conn_unnichat_a", channelIds: ["ch_1020"] },
  ];
  const sevenDays = 7 * 86_400_000;
  const encrypted = (r: any) =>
    Boolean(r.encryptedPayload && r.payloadIv && r.payloadTag && r.encryptionKeyVersion !== null);
  const decrypt = (w: ReturnType<typeof world>, r: any) =>
    (w.service as any).decryptEventPayload(r).toString("utf8") as string;

  it("keeps routed, unattributed, ignored (Cancelada) and invalid receipts with the encrypted payload for 7 days", async () => {
    const w = world({ channels: jeanChannels, rules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("braip");
    await w.post(endpoint.id, token, braipSale({ transaction: "OK1" }));
    await w.post(endpoint.id, token, braipSale({ transaction: "NL1", phone: "(21) 98888-0000" }));
    await w.post(endpoint.id, token, braipSale({ transaction: "C1", status: "Cancelada" }));
    const { trans_key: _key, ...noKey } = braipSale({ transaction: "X" });
    await w.post(endpoint.id, token, noKey);

    const receipts = [...w.receipts.values()];
    expect(receipts.map((r) => [r.status, r.reasonCode])).toEqual([
      ["routed", null],
      ["unattributed", "buyer_not_whatsapp_lead"],
      ["ignored", "status_not_supported"],
      ["invalid", "braip_purchase_identity_missing"],
    ]);
    for (const r of receipts) {
      expect(encrypted(r)).toBe(true);
      expect(r.payloadExpiresAt.getTime() - r.firstReceivedAt.getTime()).toBe(sevenDays);
      expect(JSON.stringify(r)).not.toContain("comprador@");
    }
    expect(decrypt(w, receipts[2])).toContain("Cancelada");
  });

  it("records a missing/wrong token or a removed URL as metadata only (never the body), same 404, collapsed per hour", async () => {
    const w = world({ channels: jeanChannels, rules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("braip");
    await expect(w.post(endpoint.id, "wrong", braipSale({}))).rejects.toThrow("Webhook não encontrado");
    await expect(w.post(endpoint.id, "wrong-again", braipSale({}))).rejects.toThrow("Webhook não encontrado");
    await expect(w.post(endpoint.id, "", braipSale({}))).rejects.toThrow("Webhook não encontrado");
    await expect(w.post("unknown-endpoint", token, braipSale({}))).rejects.toThrow("Webhook não encontrado");
    await w.service.remove(W, endpoint.id, "operator");
    await expect(w.post(endpoint.id, token, braipSale({}))).rejects.toThrow("Webhook não encontrado");

    const receipts = [...w.receipts.values()];
    expect(receipts.map((r) => [r.status, r.reasonCode, r.attemptCount])).toEqual([
      // Revisão do #121: a mesma recusa (endpoint, IP, motivo) dentro de um
      // minuto não é gravada de novo (o 404 é o mesmo).
      ["rejected", "token_invalid", 1],
      ["rejected", "token_missing", 1],
      ["rejected", "endpoint_removed", 1],
    ]);
    for (const r of receipts) {
      expect(r.encryptedPayload ?? null).toBeNull();
      expect(r.payloadIv ?? null).toBeNull();
      expect(r.eventName).toBeNull();
      expect(r.contactIdentityHash ?? null).toBeNull();
    }
  });

  it("keeps the body (encrypted) of an authenticated call refused for its body", async () => {
    const w = world({ channels: jeanChannels, rules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("payt");
    await expect(w.postRaw(endpoint.id, token, "application/json", "{broken")).rejects.toThrow("Payload JSON inválido");
    await expect(w.postRaw(endpoint.id, token, "text/plain", '{"a":1}')).rejects.toThrow(/Content-Type/u);
    const receipts = [...w.receipts.values()];
    expect(receipts.map((r) => [r.status, r.reasonCode])).toEqual([
      ["rejected", "body_invalid_json"],
      ["rejected", "content_type_unsupported"],
    ]);
    for (const r of receipts) {
      expect(encrypted(r)).toBe(true);
      expect(r.payloadExpiresAt.getTime() - r.firstReceivedAt.getTime()).toBe(sevenDays);
    }
    expect(decrypt(w, receipts[0])).toBe("{broken");
  });

  it("keeps a refused Braip body as metadata only: the account key is never stored", async () => {
    const w = world({ channels: jeanChannels, rules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("braip");
    await expect(
      w.postRaw(
        endpoint.id,
        token,
        "multipart/form-data; boundary=b",
        "--b\r\nContent-Disposition: form-data; name=\"basic_authentication\"\r\n\r\nKEY123\r\n--b--",
      ),
    ).rejects.toMatchObject({ status: 415 });
    const [receipt] = [...w.receipts.values()];
    expect(receipt).toMatchObject({ status: "rejected", reasonCode: "content_type_unsupported" });
    expect(receipt.encryptedPayload ?? null).toBeNull();
  });

  it("never retries (routes/sends) a refused, ignored or invalid receipt", async () => {
    const w = world({ channels: jeanChannels, rules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("payt");
    await expect(w.postRaw(endpoint.id, token, "application/json", "{broken")).rejects.toThrow();
    const braip = await w.connect("braip");
    await w.post(braip.endpoint.id, braip.token, braipSale({ transaction: "C9", status: "Cancelada" }));
    const { trans_key: _key, ...noKey } = braipSale({ transaction: "X9" });
    await w.post(braip.endpoint.id, braip.token, noKey);
    const [rejected, ignored, invalid] = [...w.receipts.values()];
    expect([rejected.status, ignored.status, invalid.status]).toEqual(["rejected", "ignored", "invalid"]);
    await expect(w.service.retryEvent(W, rejected.id, "operator")).rejects.toMatchObject({
      status: 409,
      message: "Este recebimento foi recusado na chegada e não pode ser reenviado",
    });
    for (const receipt of [ignored, invalid]) {
      await expect(w.service.retryEvent(W, receipt.id, "operator")).rejects.toMatchObject({
        status: 409,
        message: "Somente eventos sem atribuição podem ser tentados de novo",
      });
    }
    expect(w.observed).toHaveLength(0);
  });

  it("never shows refusals on the student screens (URL counters, last delivery, Vendas sem atribuição)", async () => {
    const w = world({ channels: jeanChannels, rules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("braip");
    await expect(w.post(endpoint.id, "wrong", braipSale({}))).rejects.toThrow();
    expect((await w.service.list(W, true)).endpoints[0]!.lastDeliveryAt).toBeNull();
    await w.post(endpoint.id, token, braipSale({ transaction: "NL2", phone: "(21) 98888-0000" }));
    const list = await w.service.list(W, true);
    expect(list.endpoints[0]!.stats).toMatchObject({ received: 1, unattributed: 1 });
    const unattributed = await w.service.listUnattributed(W, "braip");
    expect(unattributed.items).toHaveLength(1);
  });
});

describe("Ver dados recebidos of a stored sale (SaaS #169, read only)", () => {
  it("shows the masked payload next to what the reader read, audited; never a certification", async () => {
    const w = world({ channels: jeanChannels, rules: [], leads: jeanLeads });
    const { endpoint, token } = await w.connect("braip");
    const accepted = await w.post(endpoint.id, token, {
      ...braipSale({ transaction: "V1", phone: "11900001234" }),
      access_token: "should-hide",
      trans_payment_url: "https://example.test/pay?token=abc123&x=1",
    });
    const view = await w.service.readEventPayload(W, accepted.eventId, "operator");
    expect(view).toMatchObject({
      eventId: accepted.eventId,
      provider: "braip",
      status: "unattributed",
      payloadAvailable: true,
      parseError: null,
      parsed: {
        eventName: "Purchase",
        valueCents: 19700,
        currency: "BRL",
        valueSent: true,
        orderRef: "V1",
        phoneMasked: "••••1234",
        productCode: "PRO1",
      },
    });
    expect(view).not.toHaveProperty("certification");
    const text = JSON.stringify(view.payload);
    expect(text).not.toContain("should-hide");
    expect(text).not.toContain("abc123");
    expect(text).toContain("token=[oculto]");
    // The Braip account key never even reached storage.
    expect(text).not.toContain("SYNTHETIC-KEY-NOT-REAL");
    expect(w.audit.some((entry: any) => entry.action === "integration_endpoint.event.payload.read")).toBe(true);
  });

  it("does not open a refused receipt nor another workspace's sale", async () => {
    const w = world({ channels: jeanChannels, rules: [], leads: jeanLeads });
    const { endpoint } = await w.connect("braip");
    await expect(w.post(endpoint.id, "wrong", braipSale({}))).rejects.toThrow();
    const rejected = [...w.receipts.values()][0];
    await expect(w.service.readEventPayload(W, rejected.id, "operator")).rejects.toMatchObject({ status: 404 });
    await expect(w.service.readEventPayload("other", rejected.id, "operator")).rejects.toMatchObject({ status: 404 });
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
