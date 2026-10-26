import { describe, expect, it } from "vitest";
import {
  ConversionEventsService,
  type RecordExternalConversionInput,
} from "../../src/conversion-events/conversion-events.service";

// Fase 6.1b — porte parcial do 75f6f4b3 do SaaS (janela de 7 dias da Meta
// nas automações). Pure status resolution: no dependency is touched.
const service = Object.create(ConversionEventsService.prototype) as {
  resolveExternalInitialStatus(input: RecordExternalConversionInput): {
    status: string;
    errorCode: string | null;
  };
};

function purchase(
  ageDays: number,
  enforceMetaEventWindow?: boolean,
): RecordExternalConversionInput {
  return {
    workspaceId: "workspace_1",
    sourceEventId: "order-1",
    sourceTrigger: "inbound_webhook:payt:provider_automation",
    eventName: "Purchase",
    eventId: "conversion_purchase_1",
    dedupeKey: "purchase:1",
    phoneHash: "phone_hash_1",
    businessSource: "paid",
    adId: "ad_1",
    ctwaClid: "ctwa_1",
    valueCents: 12_345,
    currency: "BRL",
    eventOccurredAt: new Date(Date.now() - ageDays * 86_400_000),
    ...(enforceMetaEventWindow === undefined ? {} : { enforceMetaEventWindow }),
  };
}

describe("Meta seven-day event window for provider automation purchases", () => {
  it("keeps a replayed sale older than 7 days as not_eligible", () => {
    expect(service.resolveExternalInitialStatus(purchase(8, true))).toEqual(
      expect.objectContaining({
        status: "not_eligible",
        errorCode: "MetaEventTimeExpired",
      }),
    );
  });

  it("sends a sale inside the window", () => {
    expect(
      service.resolveExternalInitialStatus(purchase(6.5, true)).status,
    ).toBe("ready_to_send");
  });

  it("does not drop a live sale whose provider clock is slightly ahead", () => {
    expect(
      service.resolveExternalInitialStatus(purchase(-0.001, true)).status,
    ).toBe("ready_to_send");
  });

  it("leaves callers that do not opt in unchanged", () => {
    expect(service.resolveExternalInitialStatus(purchase(30)).status).toBe(
      "ready_to_send",
    );
  });
});
