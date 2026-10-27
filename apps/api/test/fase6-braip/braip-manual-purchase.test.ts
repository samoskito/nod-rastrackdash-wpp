import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { manualConversionOriginLabel } from "../../src/leads/manual-conversion.service";
import {
  manualPurchaseSalesPlatformOf,
  manualPurchaseSalesPlatformTriggers,
} from "../../src/leads/manual-conversion-sales-platforms";

/**
 * Fase 6.5 — porte do hunk de compra do SaaS #158 para a Braip, pelo ponto
 * de extensão da 6.2a: uma compra manual com o número do pedido deduplica
 * contra a venda da Braip com a mesma transação (trans_key).
 */

const approved = JSON.parse(
  readFileSync(
    resolve(__dirname, "../fixtures/braip/official-approved.sanitized.json"),
    "utf8",
  ),
) as Record<string, unknown>;

describe("manual purchase vs a Braip sale", () => {
  it("reads the Braip order (trans_key) of the preserved postback", () => {
    const platform = manualPurchaseSalesPlatformOf({
      provider: "braip",
      version: "automation-v1",
    });
    expect(platform?.provider).toBe("braip");
    expect(platform!.readOrderRef(approved)).toBe(approved.trans_key);
    // Not a sale (cancelled) or unreadable: no order is guessed.
    expect(
      platform!.readOrderRef({ ...approved, trans_status: "Cancelada" }),
    ).toBeNull();
    expect(platform!.readOrderRef("not json")).toBeNull();
  });

  it("never reads another parser version and keeps Payt", () => {
    expect(
      manualPurchaseSalesPlatformOf({ provider: "braip", version: "v1" }),
    ).toBeNull();
    expect(manualPurchaseSalesPlatformTriggers()).toEqual([
      "inbound_webhook:payt:",
      "inbound_webhook:braip:",
      "inbound_webhook:yampi:",
    ]);
  });

  it("names the Braip as the origin of a prior conversion", () => {
    expect(
      manualConversionOriginLabel("inbound_webhook:braip:provider_automation"),
    ).toBe("Braip");
  });
});
