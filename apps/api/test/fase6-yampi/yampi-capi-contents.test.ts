import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMetaCapiPayload } from "../../src/conversion-events/meta-capi-payload.builder";
import {
  SALES_PLATFORM_PROVIDERS,
  saleCapiCustomData,
} from "../../src/inbound-webhooks/providers/sales-platform-sale";
import {
  YAMPI_CAPI_MAX_ITEMS,
  yampiCapiCustomData,
} from "../../src/inbound-webhooks/providers/yampi/yampi-automation-v1.parser";

/**
 * Yampi Purchase to Meta with the REAL order lines (order bump included).
 * Fictitious values only; the line values reproduce the structure of a real
 * order (bump listed first, 34,90 + 3 x 61,16 + 61,20 + 61,16 + 61,16 =
 * 401,90 = value_products).
 */

function fixture(name: string): Record<string, any> {
  return JSON.parse(
    readFileSync(resolve(__dirname, "../fixtures/yampi", name), "utf8"),
  ) as Record<string, any>;
}

const paid = fixture("order-paid.synthetic.json");
const cart = fixture("cart-reminder.synthetic.json");

function line(
  sku: string,
  price: number,
  quantity: number,
  title: string,
  extra: Record<string, unknown> = {},
) {
  return {
    product_id: 3000000 + quantity,
    sku_id: 4000000 + Math.round(price * 100),
    item_sku: sku,
    quantity,
    price,
    sku: { data: { title } },
    ...extra,
  };
}

const bumpFirstItems = [
  line("BUMP-FICT-01", 34.9, 1, "Frete Expresso Ficticio"),
  line("SKU-FICT-A", 61.16, 3, "Kit Ficticio A"),
  line("SKU-FICT-B", 61.2, 1, "Kit Ficticio B"),
  line("SKU-FICT-C", 61.16, 1, "Kit Ficticio C"),
  line("SKU-FICT-D", 61.16, 1, "Kit Ficticio D"),
];

function yampiOrder(
  patch: (payload: Record<string, any>) => void = () => {},
): Record<string, any> {
  const payload = structuredClone(paid);
  payload.resource.id = 70000777;
  payload.resource.value_products = 401.9;
  payload.resource.items = { data: structuredClone(bumpFirstItems) };
  patch(payload);
  return payload;
}

describe("Yampi order lines for the Meta custom_data", () => {
  it("sends every line (order bump first), num_items, the Yampi order id and the main product title", () => {
    const result = yampiCapiCustomData(yampiOrder());

    expect(result).toEqual({
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
        // 3 x 61,16 = 183,48: the main product, never the bump listed first.
        content_name: "Kit Ficticio A",
        order_id: "70000777",
      },
      itemsTotalCents: 40190,
      itemCount: 5,
    });
  });

  it("keeps only code, quantity and price in contents (no buyer data)", () => {
    const result = yampiCapiCustomData(yampiOrder());
    const serialized = JSON.stringify(result?.customData.contents);
    for (const personal of [
      "Fulana",
      "fulana.teste@example.com",
      "000.000.000-00",
      "11900000001",
    ]) {
      expect(serialized).not.toContain(personal);
    }
    for (const item of result!.customData.contents) {
      expect(Object.keys(item).sort()).toEqual(
        ["id", "item_price", "quantity"].sort(),
      );
    }
  });

  it("falls back to sku_id, then product_id when the SKU code is missing", () => {
    const result = yampiCapiCustomData(
      yampiOrder((payload) => {
        payload.resource.items = {
          data: [
            { sku_id: 4000009, product_id: 3000009, quantity: 1, price: 10 },
            { product_id: 3000010, quantity: 2, price: 5 },
            { quantity: 1, price: 99 },
          ],
        };
      }),
    );
    expect(result?.customData.contents).toEqual([
      { id: "4000009", quantity: 1, item_price: 10 },
      { id: "3000010", quantity: 2, item_price: 5 },
    ]);
    expect(result?.customData.num_items).toBe(3);
  });

  it("reports the items total when it differs from value_products (coupon) and keeps every line", () => {
    const result = yampiCapiCustomData(
      yampiOrder((payload) => {
        payload.resource.value_products = 361.71;
        payload.resource.value_discount = 40.19;
      }),
    );
    expect(result?.itemsTotalCents).toBe(40190);
    expect(result?.customData.contents).toHaveLength(5);
  });

  it(`sends at most ${YAMPI_CAPI_MAX_ITEMS} lines; num_items still counts the whole order`, () => {
    const result = yampiCapiCustomData(
      yampiOrder((payload) => {
        payload.resource.items = {
          data: Array.from({ length: 60 }, (_, index) =>
            line(`SKU-FICT-${index}`, 1, 1, `Item Ficticio ${index}`),
          ),
        };
      }),
    );
    expect(result?.customData.contents).toHaveLength(YAMPI_CAPI_MAX_ITEMS);
    expect(result?.customData.contents[49]?.id).toBe("SKU-FICT-49");
    expect(result?.customData.num_items).toBe(60);
    expect(result?.itemCount).toBe(60);
  });

  it("also covers order.status.updated paid and order.created waiting payment", () => {
    const updated = yampiCapiCustomData(
      yampiOrder((payload) => {
        payload.event = "order.status.updated";
      }),
    );
    expect(updated?.customData.order_id).toBe("70000777");
    const created = yampiCapiCustomData(
      yampiOrder((payload) => {
        payload.event = "order.created";
        payload.resource.status = { data: { alias: "waiting_payment" } };
      }),
    );
    expect(created?.customData.contents).toHaveLength(5);
  });

  it("keeps the generic item for an abandoned cart, an order without lines and other statuses", () => {
    expect(yampiCapiCustomData(cart)).toBeNull();
    expect(
      yampiCapiCustomData(
        yampiOrder((payload) => {
          payload.resource.items = { data: [] };
        }),
      ),
    ).toBeNull();
    expect(
      yampiCapiCustomData(
        yampiOrder((payload) => {
          payload.event = "order.status.updated";
          payload.resource.status = { data: { alias: "canceled" } };
        }),
      ),
    ).toBeNull();
    expect(yampiCapiCustomData(null)).toBeNull();
  });

  it("is Yampi only: every other sales platform keeps the generic item", () => {
    for (const provider of SALES_PLATFORM_PROVIDERS) {
      const result = saleCapiCustomData(provider, yampiOrder());
      if (provider === "yampi") expect(result).not.toBeNull();
      else expect(result).toBeNull();
    }
  });
});

describe("Meta payload of a Yampi Purchase", () => {
  const base = {
    eventName: "Purchase" as const,
    eventTime: new Date("2026-10-22T12:29:58.000Z"),
    eventId: "conversion_purchase_abc123",
    phoneHash: "phone_hash_1",
    ctwaClid: "clid_1",
    pageId: "page_1",
    adId: "ad_1",
    valueCents: 40190,
    currency: "BRL",
  };

  it("sends the real lines with the Yampi order id and keeps event_id and value", () => {
    const lines = yampiCapiCustomData(yampiOrder())!;
    const payload = buildMetaCapiPayload({
      ...base,
      customData: lines.customData,
    });
    expect(payload.data[0]!.event_id).toBe("conversion_purchase_abc123");
    expect(payload.data[0]!.custom_data).toEqual({
      ...lines.customData,
      ad_id: "ad_1",
      value: 401.9,
      currency: "BRL",
    });
  });

  it("the rule's configured content name still wins over the product title", () => {
    const lines = yampiCapiCustomData(yampiOrder())!;
    const payload = buildMetaCapiPayload({
      ...base,
      contentName: "Nome da Regra",
      customData: lines.customData,
    });
    expect(payload.data[0]!.custom_data.content_name).toBe("Nome da Regra");
  });

  it("sends value_products even when the lines add up to more (coupon)", () => {
    const lines = yampiCapiCustomData(yampiOrder())!;
    const payload = buildMetaCapiPayload({
      ...base,
      valueCents: 36171,
      customData: lines.customData,
    });
    expect(payload.data[0]!.custom_data.value).toBe(361.71);
    expect(payload.data[0]!.custom_data.contents).toHaveLength(5);
  });

  it("regression: without customData (Payt, Braip, Hotmart, Brink Park, ROI Chat) the generic item is unchanged", () => {
    const payload = buildMetaCapiPayload({ ...base, customData: null });
    expect(payload.data[0]!.custom_data).toEqual({
      order_id: "conversion_purchase_abc123",
      contents: [
        { id: "conversion_purchase_abc123", quantity: 1, item_price: 401.9 },
      ],
      content_type: "product",
      num_items: 1,
      ad_id: "ad_1",
      value: 401.9,
      currency: "BRL",
    });
  });
});
