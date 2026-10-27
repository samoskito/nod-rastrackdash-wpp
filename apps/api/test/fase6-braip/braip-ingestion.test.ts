import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderConversionAutomationObservationResult } from "../../src/conversion-rules/provider-conversion-observation.service";
import { createHarness, input } from "../fase4-payt/payt-ingestion-harness";

/**
 * Fase 6.5 — Braip per-rule pipeline (same contract as Payt), ported from
 * the SaaS (09d7303a). The Braip rule sits on a WhatsApp connection only as
 * the anchor; its stored parser release is Braip's.
 */

const braipBody = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ...JSON.parse(
    readFileSync(
      resolve(__dirname, "../fixtures/braip/approved.synthetic.json"),
      "utf8",
    ),
  ),
  ...overrides,
});

function braipHarness() {
  const harness = createHarness({
    eventName: "Purchase",
    production: true,
    payt: true,
  });
  const rule = harness.endpoint.providerRule as any;
  rule.parserRelease.provider = "braip";
  rule.parserReleaseId = "inbound_parser_braip_automation_v1";
  rule.parserRelease.id = "inbound_parser_braip_automation_v1";
  rule.conversionRule.name = "Venda Braip";
  return harness;
}

function storedBody(
  harness: ReturnType<typeof createHarness>,
  deliveryId: string,
) {
  const delivery = [...harness.deliveries.values()].find(
    (candidate) => candidate.id === deliveryId,
  )!;
  return JSON.parse(
    harness.encryption
      .decrypt(
        {
          encryptedPayload: delivery.encryptedPayload,
          payloadIv: delivery.payloadIv,
          payloadTag: delivery.payloadTag,
          encryptionKeyVersion: delivery.encryptionKeyVersion,
        },
        {
          workspaceId: delivery.workspaceId,
          connectionId: delivery.connectionId,
          deliveryId: delivery.id,
        },
      )
      .toString("utf8"),
  );
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

describe("Braip per-rule pipeline (same contract as Payt)", () => {
  it("accepts a form-urlencoded postback, stores canonical JSON without the account key", async () => {
    const harness = braipHarness();
    const form = readFileSync(
      resolve(__dirname, "../fixtures/braip/approved.synthetic.form.txt"),
    );
    const result = await harness.service.ingest({
      ...input(form),
      contentType: "application/x-www-form-urlencoded",
    });
    expect(result.duplicate).toBe(false);
    const stored = storedBody(harness, result.deliveryId);
    expect(stored.trans_key).toBe("VEN000SYNTH1");
    expect(stored.basic_authentication).toBeUndefined();
    expect(
      (harness.conversionObservation.observeAutomation as any).mock.calls.at(-1)![0]
        .automation,
    ).toMatchObject({ provider: "braip", eventName: "Purchase", valueCents: 19700 });
  });

  it("ignores another event on a Purchase rule (waiting payment), never an error", async () => {
    const harness = braipHarness();
    const result = await harness.service.ingest(
      input(
        Buffer.from(
          JSON.stringify(braipBody({ trans_status: "Aguardando Pagamento" })),
        ),
      ),
    );
    expect(result.observationStatus).toBe("ignored");
    expect(
      harness.conversionObservation.observeAutomation,
    ).not.toHaveBeenCalled();
  });

  it("dedupes a resend with a different body into the same delivery and stores the latest body before a decision", async () => {
    const harness = braipHarness();
    (harness.conversionObservation.observeAutomation as any).mockResolvedValueOnce(
      blocked,
    );
    const first = await harness.service.ingest(
      input(Buffer.from(JSON.stringify(braipBody()))),
    );
    // Braip sends the same approved sale again (e.g. tracking code added).
    const resend = await harness.service.ingest(
      input(
        Buffer.from(
          JSON.stringify(
            braipBody({
              type: "TRACKING_CODE_ADDED",
              trans_updatedate: "2026-10-15 10:00:00",
            }),
          ),
        ),
      ),
    );
    expect(resend).toMatchObject({
      deliveryId: first.deliveryId,
      duplicate: true,
    });
    expect(harness.deliveries.size).toBe(1);
    expect(storedBody(harness, first.deliveryId).type).toBe(
      "TRACKING_CODE_ADDED",
    );
    const keys = new Set(
      (harness.conversionObservation.observeAutomation as any).mock.calls.map(
        (call: any[]) => call[0].automation.externalExecutionKey,
      ),
    );
    expect(keys.size).toBe(1);
  });

  it("refuses a multipart body (only JSON or form-urlencoded)", async () => {
    const harness = braipHarness();
    await expect(
      harness.service.ingest({
        ...input(Buffer.from("--x\r\n")),
        contentType: "multipart/form-data; boundary=x",
      }),
    ).rejects.toMatchObject({ status: 415 });
  });
});
