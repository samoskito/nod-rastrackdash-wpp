import { describe, expect, it } from "vitest";
import {
  maskPhone,
  maskSensitivePayload,
  maskSensitiveText,
  parseIntegrationSale,
} from "../../src/inbound-webhooks/integration-event-inspection";
import {
  jeanChannels,
  jeanLeads,
  W,
  world,
} from "../fase5-url-unica/url-unica-world";

/**
 * Fase 6.5 — porte do SaaS #169 sem a certificação. In the SaaS an
 * unattributed real sale could "liberar a plataforma"; in the nod the Braip
 * reader is already certified (production direct), so an unattributed sale
 * only offers "Ver dados recebidos" (masked, audited) and "Tentar de novo".
 * Opening the data never changes the release nor sends anything.
 */

describe("unattributed Braip sale: read only, never a release", () => {
  it("opens the masked data of an unattributed sale without touching the parser release or sending", async () => {
    const w = world({ channels: jeanChannels, rules: [], leads: jeanLeads });
    const { endpoint, token } = await w.connect("braip");
    const accepted = await w.post(endpoint.id, token, {
      type: "STATUS_ALTERADO",
      trans_key: "VEN-U1",
      trans_status: "Pagamento Aprovado",
      trans_value: "54700",
      currency: "BRL",
      trans_createdate: "2026-10-23 11:08:00",
      trans_updatedate: "2026-10-23 11:09:00",
      product_key: "pro1",
      client_cel: "11900004321",
      client_email: "comprador@example.test",
    });
    expect(accepted).toMatchObject({ routing: "unattributed" });
    const view = await w.service.readEventPayload(W, accepted.eventId, "operator");
    expect(view.parsed).toMatchObject({
      eventName: "Purchase",
      valueCents: 54700,
      orderRef: "VEN-U1",
      phoneMasked: "••••4321",
    });
    expect(view).not.toHaveProperty("certification");
    expect(w.observed).toHaveLength(0);
    // The service has no certification method at all.
    expect((w.service as any).certifyParserWithUnattributedSale).toBeUndefined();
    const unattributed = await w.service.listUnattributed(W, "braip");
    expect(unattributed.items[0]).not.toHaveProperty("certificationEligible");
    expect(unattributed.items[0]).toMatchObject({ retryable: true });
  });
});

describe("masking of the received data (incl. tokens inside URLs)", () => {
  it("hides account keys and credentials at any depth", () => {
    const masked = maskSensitivePayload({
      basic_authentication: "KEY",
      integration_key: "PAYT",
      data: { token: "T", nested: [{ api_key: "A", ok: "visible" }] },
      client_cel: "11900001234",
    }) as any;
    expect(masked.basic_authentication).toBe("[oculto]");
    expect(masked.integration_key).toBe("[oculto]");
    expect(masked.data.token).toBe("[oculto]");
    expect(masked.data.nested[0]).toEqual({ api_key: "[oculto]", ok: "visible" });
  });

  it("hides credentials carried in URL query params", () => {
    const masked = maskSensitivePayload({
      trans_payment_url: "https://example.test/pay?token=abc&x=1",
      login: "https://example.test/a?customerToken=zz#frag",
      store: "https://example.test/s?store_token=s1&access_token=a1",
    }) as any;
    expect(masked.trans_payment_url).toBe(
      "https://example.test/pay?token=[oculto]&x=1",
    );
    expect(masked.login).toBe("https://example.test/a?customerToken=[oculto]#frag");
    expect(masked.store).toBe(
      "https://example.test/s?store_token=[oculto]&access_token=[oculto]",
    );
  });

  it("hides credentials of a refused form body and keeps only the last 4 phone digits", () => {
    expect(maskSensitiveText("basic_authentication=K&trans_key=V1")).toBe(
      "basic_authentication=[oculto]&trans_key=V1",
    );
    // Bracketed, percent-encoded and multipart keys, and encoded URL tokens.
    expect(maskSensitiveText("data[basic_authentication]=K&ok=1")).toBe(
      "data[basic_authentication]=[oculto]&ok=1",
    );
    expect(maskSensitiveText("data%5Btoken%5D=T1&ok=1")).toBe(
      "data%5Btoken%5D=[oculto]&ok=1",
    );
    expect(
      maskSensitiveText("link=https%3A%2F%2Fx.test%2Fa%3Ftoken%3DSECRET1&ok=1"),
    ).not.toContain("SECRET1");
    const multipart =
      "--b\r\nContent-Disposition: form-data; name=\"basic_authentication\"\r\n\r\nKEY123\r\n--b\r\nContent-Disposition: form-data; name=\"trans_key\"\r\n\r\nVEN1\r\n--b--";
    const maskedMultipart = maskSensitiveText(multipart);
    expect(maskedMultipart).not.toContain("KEY123");
    expect(maskedMultipart).toContain("VEN1");
    expect(maskPhone("(11) 99123-1020")).toBe("••••1020");
    expect(maskPhone("12")).toBeNull();
  });

  it("re-reads a stored sale with the current parser (unsupported provider is an error, never a guess)", () => {
    expect(
      parseIntegrationSale({ provider: "unnichat", currency: null }, {}),
    ).toMatchObject({ ok: false, errorCode: "integration_provider_unsupported" });
    expect(
      parseIntegrationSale(
        { provider: "braip", currency: "BRL" },
        { trans_status: "Cancelada", trans_key: "C1" },
      ),
    ).toMatchObject({ ok: false, errorCode: "braip_sale_v1_status_not_supported" });
  });
});
