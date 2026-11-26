import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createHarness, input } from "../fase4-payt/payt-ingestion-harness";

/**
 * XMAX CRM on the rule's own URL (one URL per event). Same model as Webhook /
 * n8n: the rule is anchored on a WhatsApp connection of the student (the
 * XMAX creates no lead); its stored parser release is the XMAX reader, born
 * in observation. Fictitious data only.
 */
const opportunity = () =>
  JSON.parse(
    readFileSync(
      resolve(__dirname, "../fixtures/xmax/opportunity.synthetic.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;

function xmaxHarness(
  eventName: "QualifiedLead" | "Purchase",
  cents: number | null = null,
) {
  const harness = createHarness({ eventName });
  const providerRule = harness.endpoint.providerRule as any;
  providerRule.connection.provider = "meta_cloud";
  providerRule.connection.parserRelease.provider = "meta_cloud";
  providerRule.parserRelease.provider = "xmax";
  providerRule.parserRelease.id = "inbound_parser_xmax_automation_v1";
  providerRule.parserRelease.status = "observation_only";
  providerRule.parserReleaseId = "inbound_parser_xmax_automation_v1";
  providerRule.mode = "observation";
  providerRule.conversionRule.name = "XMAX: Compra";
  providerRule.conversionRule.defaultValueCents = cents;
  providerRule.conversionRule.defaultCurrency = null;
  providerRule.conversionRule.defaultItems = { webhookValueSource: "fixed" };
  return harness;
}
const send = (harness: ReturnType<typeof xmaxHarness>, body: unknown) =>
  harness.service.ingest(input(Buffer.from(JSON.stringify(body))));

describe("XMAX CRM on the rule's own URL", () => {
  it("takes the event from the rule, never from the stage, and keeps only the opportunity in the summary", async () => {
    const harness = xmaxHarness("QualifiedLead");
    const first = await send(harness, opportunity());
    expect(first).toMatchObject({ status: "accepted", duplicate: false });
    expect(harness.conversionObservation.observeAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        automation: expect.objectContaining({
          provider: "xmax",
          eventName: "QualifiedLead",
          phone: "5511900000002",
          externalExecutionKey: expect.stringMatching(
            /^xmax-opportunity:[0-9a-f]{64}$/u,
          ),
        }),
      }),
    );
    const stored = [...harness.deliveries.values()][0]!;
    expect(stored.normalizedSummary).toMatchObject({
      eventName: "QualifiedLead",
      xmaxOpportunityId: "90001",
      xmaxStage: "3 Negociação",
      xmaxContactLinked: false,
    });
    // No contact data (phone, e-mail) in the stored summary.
    const summary = JSON.stringify(stored.normalizedSummary);
    expect(summary).not.toContain("5511900000002");
    expect(summary).not.toContain("@");
  });

  it("the same opportunity on the same event is counted once (another stage with the same URL too)", async () => {
    const harness = xmaxHarness("QualifiedLead");
    const first = await send(harness, opportunity());
    const resend = await send(harness, opportunity());
    const otherStage = await send(harness, {
      ...opportunity(),
      Etapa_oportunidade: "4 Proposta",
    });
    expect(resend).toMatchObject({ deliveryId: first.deliveryId, duplicate: true });
    expect(otherStage).toMatchObject({
      deliveryId: first.deliveryId,
      duplicate: true,
    });
    expect(harness.deliveries.size).toBe(1);
    // A resend is re-read on the SAME delivery and occurrence key, so the
    // decision (frozen per occurrence) never counts it twice.
    const keys = new Set(
      harness.conversionObservation.observeAutomation.mock.calls.map(
        (call: any) => [call[0].deliveryId, call[0].automation.externalExecutionKey].join("|"),
      ),
    );
    expect(keys.size).toBe(1);
  });

  it("another opportunity is another occurrence", async () => {
    const harness = xmaxHarness("Purchase", 150000);
    const first = await send(harness, opportunity());
    const second = await send(harness, { ...opportunity(), ID_oportunidade: "90003" });
    expect(second.duplicate).toBe(false);
    expect(second.deliveryId).not.toBe(first.deliveryId);
    expect(harness.deliveries.size).toBe(2);
  });

  it.each([
    ["missing_phone", { Telefone_oportunidade: "" }, "xmax_missing_phone"],
    [
      "missing_opportunity_id",
      { ID_oportunidade: "" },
      "xmax_missing_opportunity_id",
    ],
  ])("a call with %s is recorded with a visible reason and never observed", async (_label, overrides, code) => {
    const harness = xmaxHarness("QualifiedLead");
    const result = await send(harness, { ...opportunity(), ...overrides });
    expect(result.observationStatus).toBe("invalid_payload");
    expect([...harness.deliveries.values()][0]).toMatchObject({
      parseErrorCode: code,
    });
    expect(harness.conversionObservation.observeAutomation).not.toHaveBeenCalled();
  });

  it("a purchase without the rule's fixed value is recorded with a clear reason", async () => {
    const harness = xmaxHarness("Purchase", null);
    const result = await send(harness, opportunity());
    expect(result.observationStatus).toBe("invalid_payload");
    expect([...harness.deliveries.values()][0]).toMatchObject({
      parseErrorCode: "xmax_value_missing",
    });
  });

  it("paid leads only: an organic contact is ignored and leaves no mark that dedupes", async () => {
    const harness = xmaxHarness("QualifiedLead");
    harness.conversionObservation.observeAutomation.mockResolvedValueOnce({
      decisionId: null,
      decisionCode: null,
      reasonCode: "contact_not_paid_lead",
      disposition: "ignored",
      executionId: null,
      eligibleExecutionId: null,
      reviewId: null,
      channelId: null,
      leadResolved: false,
    });
    const organic = await send(harness, opportunity());
    expect(organic.observationStatus).toBe("ignored");
    const stored = [...harness.deliveries.values()].find(
      (delivery: any) => delivery.id === organic.deliveryId,
    )!;
    expect(stored.ingressKey).toBe(`xmax-organic:${organic.deliveryId}`);
    expect(stored.normalizedSummary).toMatchObject({
      reasonCode: "contact_not_paid_lead",
    });
    // The same opportunity again (the contact became a paid lead): a first call.
    const again = await send(harness, opportunity());
    expect(again.duplicate).toBe(false);
    expect(again.deliveryId).not.toBe(organic.deliveryId);
    expect(harness.conversionObservation.observeAutomation).toHaveBeenCalledTimes(2);
  });

  it("refuses a wrong token like every rule URL", async () => {
    const harness = xmaxHarness("QualifiedLead");
    await expect(
      harness.service.ingest(
        input(Buffer.from(JSON.stringify(opportunity())), "wrong-token"),
      ),
    ).rejects.toThrow();
    expect(harness.deliveries.size).toBe(0);
  });
});
