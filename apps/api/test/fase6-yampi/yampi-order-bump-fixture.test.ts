import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { maskSensitivePayload } from "../../src/inbound-webhooks/integration-event-inspection";
import {
  parseYampiSaleEventV1,
  yampiCapiCustomData,
} from "../../src/inbound-webhooks/providers/yampi/yampi-automation-v1.parser";

/**
 * Fase 6.7 — sanitized fixture of a paid Yampi order with an order bump
 * listed first and the account links of the real format (login_url,
 * reorder_url, simulate_url). Every value is fictitious. Covers #187 (main
 * product by the highest value, tokens hidden) and #188 (real order lines).
 */

const order = JSON.parse(
  readFileSync(
    resolve(__dirname, "../fixtures/yampi/order-paid-order-bump.synthetic.json"),
    "utf8",
  ),
) as Record<string, any>;

describe("Yampi paid order with an order bump (sanitized fixture)", () => {
  it("shows the main product (highest price x quantity), with every item in the product filter", () => {
    const parsed = parseYampiSaleEventV1(order, {
      receivedAt: new Date("2026-10-22T12:30:15.000Z"),
    });
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        eventName: "Purchase",
        orderRef: "70000003",
        valueCents: 40190,
        product: { code: "3000011", name: "Kit Ficticio A" },
        offer: { code: "SKU-FICT-A", name: "Kit Ficticio A" },
      },
    });
    if (!parsed.ok) return;
    expect(parsed.value.productCodes).toEqual(
      expect.arrayContaining(["3000010", "BUMP-FICT-01", "3000011", "SKU-FICT-A"]),
    );
  });

  it("sends every line to Meta (bump first) adding up to value_products", () => {
    const lines = yampiCapiCustomData(order);
    expect(lines).toMatchObject({
      customData: {
        contents: [
          { id: "BUMP-FICT-01", quantity: 1, item_price: 34.9 },
          { id: "SKU-FICT-A", quantity: 3, item_price: 61.16 },
          { id: "SKU-FICT-B", quantity: 1, item_price: 61.2 },
          { id: "SKU-FICT-C", quantity: 1, item_price: 61.16 },
          { id: "SKU-FICT-D", quantity: 1, item_price: 61.16 },
        ],
        num_items: 7,
        content_type: "product",
        content_name: "Kit Ficticio A",
        order_id: "70000003",
      },
      itemsTotalCents: 40190,
      itemCount: 5,
    });
  });

  it("hides login_url and the login tokens inside the account links in 'Ver dados recebidos'", () => {
    const masked = maskSensitivePayload(order) as Record<string, any>;
    expect(masked.resource.login_url).toBe("[oculto]");
    expect(masked.resource.reorder_url).toBe(
      "https://loja-ficticia.example/cart/items?customerToken=[oculto]&quantity%5B0%5D=1&store_token=[oculto]",
    );
    expect(masked.resource.simulate_url).toBe(
      "https://loja-ficticia.example/cart?cart_token=carttoken-ficticio-0004&customerToken=[oculto]",
    );
    const text = JSON.stringify(masked);
    for (const secret of [
      "login-ficticio-0003",
      "cliente-ficticio-0003",
      "loja-ficticia-0003",
      "cliente-ficticio-0004",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(maskSensitivePayload({ "X-Yampi-Hmac-SHA256": "abc" })).toEqual({
      "X-Yampi-Hmac-SHA256": "[oculto]",
    });
  });
});
