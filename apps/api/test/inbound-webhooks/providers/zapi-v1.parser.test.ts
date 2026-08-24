import { describe, expect, it } from "vitest";
import {
  ZAPI_V1_PARSER_VERSION,
  ZAPI_V1_PROVIDER,
  ZapiV1Parser,
  parseZapiV1Webhook,
} from "../../../src/inbound-webhooks/providers/zapi/zapi-v1.parser";
import { parseWahaV1Webhook } from "../../../src/inbound-webhooks/providers/waha/waha-v1.parser";

function inboundMessagePayload(
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    phone: "5511988887777",
    message: "Olá, quero saber mais",
    connectedPhone: "5521999996666",
    instanceId: "3CXY1234567890",
    messageId: "zapi-msg-1",
    timestamp: 1_724_000_000,
    fromMe: false,
    isGroup: false,
    participant: null,
    ...overrides,
  };
}

describe("ZapiV1Parser", () => {
  it("has provider 'zapi' and parserVersion 'v1'", () => {
    const parser = new ZapiV1Parser();

    expect(parser.provider).toBe(ZAPI_V1_PROVIDER);
    expect(parser.parserVersion).toBe(ZAPI_V1_PARSER_VERSION);
  });

  it("parses an inbound text message as eligible_route_unresolved when no CTWA is present", () => {
    const result = parseZapiV1Webhook(inboundMessagePayload());

    expect(result.error).toBeNull();
    expect(result.classification).toBe("eligible_route_unresolved");
    expect(result.classificationReason).toBe("no_ctwa_in_zapi_payload");
    expect(result.events).toHaveLength(1);

    const [event] = result.events;

    expect(event.provider).toBe("zapi");
    expect(event.externalMessageId).toBe("zapi-msg-1");
    expect(event.channel).toEqual({
      providerChannelId: "3CXY1234567890",
      connectedPhone: "5521999996666",
      name: null,
    });
    expect(event.contact).toEqual({
      externalContactId: "5511988887777",
      phoneNumber: "5511988887777",
      name: null,
    });
    expect(event.hasCtwa).toBe(false);
    expect(event.message.direction).toBe("inbound");
    expect(event.message.authorType).toBe("contact");
    expect(event.message.text).toBe("Olá, quero saber mais");
  });

  it("marks hasCtwa true when the payload carries a ctwa object", () => {
    const result = parseZapiV1Webhook(
      inboundMessagePayload({
        ctwa: { ad_id: "ad-123", clid: "clid-abc" },
      }),
    );

    expect(result.events).toHaveLength(1);
    const [event] = result.events;

    expect(event.hasCtwa).toBe(true);
    expect(event.adId).toBe("ad-123");
    expect(event.ctwaClid).toBe("clid-abc");
    expect(event.classification).toBe("eligible_route_unresolved");
    expect(event.classificationReason).toBe("route_resolution_pending");
  });

  it("classifies fromMe messages as ignored_outbound", () => {
    const result = parseZapiV1Webhook(
      inboundMessagePayload({ fromMe: true }),
    );

    expect(result.events).toHaveLength(1);
    const [event] = result.events;

    expect(event.classification).toBe("ignored_outbound");
    expect(event.message.direction).toBe("outbound");
  });

  it("classifies group messages as unsupported_event with zero events", () => {
    const result = parseZapiV1Webhook(
      inboundMessagePayload({ isGroup: true }),
    );

    expect(result.classification).toBe("unsupported_event");
    expect(result.classificationReason).toBe("group_not_supported_v1");
    expect(result.events).toHaveLength(0);
    expect(result.error).toBeNull();
  });

  it("falls back to a deterministic hash id when messageId is absent", () => {
    const payload = inboundMessagePayload();
    const record = payload as Record<string, unknown>;
    delete record.messageId;

    const first = parseZapiV1Webhook(payload);
    const second = parseZapiV1Webhook(payload);

    expect(first.events).toHaveLength(1);
    expect(first.events[0].externalMessageId).toMatch(/^hash:[a-f0-9]{64}$/u);
    expect(first.events[0].externalMessageId).toBe(
      second.events[0].externalMessageId,
    );
  });

  it("returns delivery-level invalid_payload when the payload is not an object", () => {
    const result = parseZapiV1Webhook(null);

    expect(result.classification).toBe("invalid_payload");
    expect(result.events).toHaveLength(0);
    expect(result.error).toEqual({
      code: "zapi_v1_invalid_payload",
      message: "Inbound webhook payload failed validation",
    });
  });

  it("returns delivery-level invalid_payload when 'phone' is missing", () => {
    const payload = inboundMessagePayload();
    const record = payload as Record<string, unknown>;
    delete record.phone;

    const result = parseZapiV1Webhook(payload);

    expect(result.classification).toBe("invalid_payload");
    expect(result.events).toHaveLength(0);
  });

  it("produces a distinct dedupeKey per externalMessageId", () => {
    const first = parseZapiV1Webhook(inboundMessagePayload());
    const second = parseZapiV1Webhook(
      inboundMessagePayload({ messageId: "zapi-msg-2" }),
    );

    expect(first.events[0].dedupeKey).not.toBe(second.events[0].dedupeKey);
  });

  it("produces a distinct dedupeKey than waha for the same messageId/channel/org", () => {
    const zapiResult = parseZapiV1Webhook(
      inboundMessagePayload({
        instanceId: "shared-id",
        messageId: "shared-msg",
      }),
    );
    const wahaResult = parseWahaV1Webhook({
      event: "message",
      session: "shared-id",
      payload: {
        from: "5511988887777@c.us",
        to: "5521999996666@c.us",
        timestamp: 1_724_000_000,
        id: { id: "shared-msg" },
        body: "hi",
        fromMe: false,
        type: "chat",
      },
    });

    expect(zapiResult.events[0].dedupeKey).not.toBe(
      wahaResult.events[0].dedupeKey,
    );
  });
});
