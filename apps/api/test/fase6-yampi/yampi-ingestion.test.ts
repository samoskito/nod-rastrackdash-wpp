import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderConversionAutomationObservationResult } from "../../src/conversion-rules/provider-conversion-observation.service";
import { createHarness, input } from "../fase4-payt/payt-ingestion-harness";

/**
 * Fase 6.7 — Yampi per-rule pipeline (same contract as Payt and Braip),
 * ported from the SaaS (#186). The Yampi rule sits on a WhatsApp connection
 * only as the anchor; its stored parser release is Yampi's. Fictitious data.
 */

function fixture(name: string): Record<string, any> {
  return JSON.parse(
    readFileSync(resolve(__dirname, "../fixtures/yampi", name), "utf8"),
  ) as Record<string, any>;
}

const paid = fixture("order-paid.synthetic.json");

function yampiHarness(
  eventName: "Purchase" | "InitiateCheckout" | "CartAbandoned" = "Purchase",
) {
  const harness = createHarness({
    eventName,
    production: true,
    payt: true,
  });
  const rule = harness.endpoint.providerRule as any;
  rule.parserRelease.provider = "yampi";
  rule.parserReleaseId = "inbound_parser_yampi_automation_v1";
  rule.parserRelease.id = "inbound_parser_yampi_automation_v1";
  rule.conversionRule.name = "Venda Yampi";
  return harness;
}

function body(payload: unknown) {
  return input(Buffer.from(JSON.stringify(payload)));
}

const blocked: ProviderConversionAutomationObservationResult = {
  decisionId: null,
  decisionCode: null,
  reasonCode: "payt_channel_missing_or_ambiguous",
  disposition: "blocked",
  executionId: null,
  eligibleExecutionId: null,
  reviewId: null,
  channelId: null,
  leadResolved: false,
} as ProviderConversionAutomationObservationResult;

describe("Yampi per-rule pipeline (same contract as Payt/Braip)", () => {
  it("observes an order.paid as the Purchase of the rule (value_products, BRL)", async () => {
    const harness = yampiHarness();
    const result = await harness.service.ingest(body(paid));
    expect(result.duplicate).toBe(false);
    expect(
      (harness.conversionObservation.observeAutomation as any).mock.calls.at(-1)![0]
        .automation,
    ).toMatchObject({
      provider: "yampi",
      eventName: "Purchase",
      valueCents: 59400,
      currency: "BRL",
      orderRef: "70000001",
    });
  });

  it("ignores another event on a Purchase rule (cart.reminder, boleto/Pix), never an error", async () => {
    for (const payload of [
      fixture("cart-reminder.synthetic.json"),
      fixture("order-created-waiting-payment.synthetic.json"),
    ]) {
      const harness = yampiHarness();
      const result = await harness.service.ingest(body(payload));
      expect(result.observationStatus).toBe("ignored");
      expect(
        harness.conversionObservation.observeAutomation,
      ).not.toHaveBeenCalled();
    }
  });

  it("takes the boleto/Pix order on an InitiateCheckout rule", async () => {
    const harness = yampiHarness("InitiateCheckout");
    await harness.service.ingest(
      body(fixture("order-created-waiting-payment.synthetic.json")),
    );
    expect(
      (harness.conversionObservation.observeAutomation as any).mock.calls.at(-1)![0]
        .automation,
    ).toMatchObject({
      provider: "yampi",
      eventName: "InitiateCheckout",
      orderRef: "70000002",
    });
  });

  it("dedupes order.paid and the later order.status.updated (paid) into the same delivery", async () => {
    const harness = yampiHarness();
    (harness.conversionObservation.observeAutomation as any).mockResolvedValueOnce(
      blocked,
    );
    const first = await harness.service.ingest(body(paid));
    const updated = structuredClone(paid);
    updated.event = "order.status.updated";
    const resend = await harness.service.ingest(body(updated));
    expect(resend).toMatchObject({
      deliveryId: first.deliveryId,
      duplicate: true,
    });
    expect(harness.deliveries.size).toBe(1);
    const keys = new Set(
      (harness.conversionObservation.observeAutomation as any).mock.calls.map(
        (call: any[]) => call[0].automation.externalExecutionKey,
      ),
    );
    expect(keys.size).toBe(1);
  });

  it("accepts only JSON (the Yampi webhook is JSON)", async () => {
    const harness = yampiHarness();
    await expect(
      harness.service.ingest({
        ...body(paid),
        contentType: "application/x-www-form-urlencoded",
      }),
    ).rejects.toMatchObject({ status: 415 });
  });
});
