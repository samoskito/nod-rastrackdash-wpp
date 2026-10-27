import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { manualConversionOriginLabel } from "../../src/leads/manual-conversion.service";
import { normalizeManualOrderRef } from "@wpptrack/shared";
import { manualOrderKey } from "../../src/leads/manual-conversion-payload";
import {
  manualPurchaseSalesPlatformOf,
  manualPurchaseSalesPlatformTriggers,
} from "../../src/leads/manual-conversion-sales-platforms";

/**
 * Fase 6.7 — compra manual com o pedido da Yampi (porte do SaaS #186 no
 * ponto de extensão da 6.2a/6.5): uma compra manual com o número do pedido
 * deduplica contra a venda da Yampi com o mesmo id de pedido
 * (`resource.id`), o mesmo que entra na identidade da compra.
 */

const paid = JSON.parse(
  readFileSync(
    resolve(__dirname, "../fixtures/yampi/order-paid.synthetic.json"),
    "utf8",
  ),
) as Record<string, any>;

describe("manual purchase vs a Yampi sale", () => {
  it("reads the Yampi order id of the preserved webhook (paid and status updated to paid)", () => {
    const platform = manualPurchaseSalesPlatformOf({
      provider: "yampi",
      version: "automation-v1",
    });
    expect(platform?.provider).toBe("yampi");
    expect(platform!.readOrderRef(paid)).toBe("70000001");
    expect(
      platform!.readOrderRef({ ...paid, event: "order.status.updated" }),
    ).toBe("70000001");
    // Same key on both sides (manual typed order and the sale's order).
    expect(manualOrderKey("ws_ficticio", "70000001")).toBe(
      manualOrderKey("ws_ficticio", platform!.readOrderRef(paid)!),
    );
    expect(normalizeManualOrderRef(" 70000001 ")).toBe(
      normalizeManualOrderRef("70000001"),
    );
  });

  it("never guesses an order: cancelled, unknown event or unreadable payload", () => {
    const platform = manualPurchaseSalesPlatformOf({
      provider: "yampi",
      version: "automation-v1",
    })!;
    const cancelled = structuredClone(paid);
    cancelled.event = "order.status.updated";
    cancelled.resource.status.data.alias = "cancelled";
    expect(platform.readOrderRef(cancelled)).toBeNull();
    expect(platform.readOrderRef({ ...paid, event: "product.created" })).toBeNull();
    expect(platform.readOrderRef("not json")).toBeNull();
  });

  it("never reads another parser version; Payt and Braip keep working", () => {
    expect(
      manualPurchaseSalesPlatformOf({ provider: "yampi", version: "v1" }),
    ).toBeNull();
    expect(manualPurchaseSalesPlatformTriggers()).toEqual([
      "inbound_webhook:payt:",
      "inbound_webhook:braip:",
      "inbound_webhook:yampi:",
    ]);
  });

  it("names the Yampi as the origin of a prior conversion", () => {
    expect(
      manualConversionOriginLabel("inbound_webhook:yampi:provider_automation"),
    ).toBe("Yampi");
  });
});
