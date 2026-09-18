import { describe, expect, it } from "vitest";
import {
  META_CLOUD_V1_PARSER_VERSION,
  META_CLOUD_V1_PROVIDER,
  MetaCloudV1Parser,
  parseMetaCloudV1Webhook,
} from "../../../src/inbound-webhooks/providers/meta-cloud/meta-cloud-v1.parser";

function ctwaPayload(): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "1027592893372156",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "551132630883",
                phone_number_id: "1255764307625415",
              },
              contacts: [
                {
                  profile: { name: "Contato teste" },
                  wa_id: "5511974108069",
                },
              ],
              messages: [
                {
                  referral: {
                    source_url: "https://fb.me/test",
                    source_id: "120250454222470468",
                    source_type: "ad",
                    body: "Anuncio teste",
                    headline: "Conheca nossa oferta",
                    ctwa_clid: "AfhSuO26CqPSb4E",
                  },
                  from: "5511974108069",
                  id: "wamid.meta-message-1",
                  timestamp: "1789493700",
                  text: { body: "Quero saber mais" },
                  type: "text",
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("MetaCloudV1Parser", () => {
  it("registers the Meta Cloud v1 identity", () => {
    const parser = new MetaCloudV1Parser();

    expect(parser.provider).toBe(META_CLOUD_V1_PROVIDER);
    expect(parser.parserVersion).toBe(META_CLOUD_V1_PARSER_VERSION);
  });

  it("parses a real CTWA Cloud API message with WABA channel identity", () => {
    const result = parseMetaCloudV1Webhook(ctwaPayload());

    expect(result.classification).toBe("eligible_route_unresolved");
    expect(result.events).toHaveLength(1);
    expect(result.normalizedSummary).toMatchObject({
      provider: "meta_cloud",
      parserVersion: "v1",
      eventCount: 1,
    });

    const [event] = result.events;
    expect(event).toMatchObject({
      provider: "meta_cloud",
      organizationId: "1027592893372156",
      externalMessageId: "wamid.meta-message-1",
      adId: "120250454222470468",
      ctwaClid: "AfhSuO26CqPSb4E",
      hasCtwa: true,
      classification: "eligible_route_unresolved",
      channel: {
        providerChannelId: "1255764307625415",
        connectedPhone: "551132630883",
      },
      contact: {
        externalContactId: "5511974108069",
        phoneNumber: "5511974108069",
        name: "Contato teste",
      },
      message: {
        text: "Quero saber mais",
        messageType: "text",
      },
    });
    expect(event.occurredAt.toISOString()).toBe("2026-09-15T17:35:00.000Z");
  });

  it("classifies a message without referral as ignored_no_ctwa", () => {
    const payload = ctwaPayload();
    const message = (
      (
        (
          (payload.entry as Array<Record<string, unknown>>)[0].changes as Array<
            Record<string, unknown>
          >
        )[0].value as Record<string, unknown>
      ).messages as Array<Record<string, unknown>>
    )[0];
    delete message.referral;

    const result = parseMetaCloudV1Webhook(payload);

    expect(result.classification).toBe("ignored_no_ctwa");
    expect(result.classificationReason).toBe("ctwa_missing");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      hasCtwa: false,
      ctwaClid: null,
      classification: "ignored_no_ctwa",
    });
  });

  it.each([
    [
      "non-messages change",
      {
        object: "whatsapp_business_account",
        entry: [{ id: "waba", changes: [{ field: "statuses", value: {} }] }],
      },
    ],
    ["bad envelope", "not-json-object"],
  ])("handles %s safely", (_label, payload) => {
    const result = parseMetaCloudV1Webhook(payload);

    expect(["unsupported_event", "invalid_payload"]).toContain(
      result.classification,
    );
    expect(result.events).toHaveLength(0);
  });
});
