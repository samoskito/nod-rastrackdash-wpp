import { describe, expect, it } from "vitest";
import {
  WAHA_V1_PARSER_VERSION,
  WAHA_V1_PROVIDER,
  WahaV1Parser,
  parseWahaV1Webhook,
} from "../../../src/inbound-webhooks/providers/waha/waha-v1.parser";

function inboundMessagePayload(
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    event: "message",
    session: "default",
    payload: {
      from: "5511988887777@c.us",
      to: "5521999996666@c.us",
      timestamp: 1_724_000_000,
      id: { id: "waha-msg-1", serialNumber: 1 },
      body: "Olá, quero saber mais",
      fromMe: false,
      self: "user",
      isMedia: false,
      isMMS: false,
      type: "chat",
      caption: null,
      acknowledged: 1,
      ...overrides,
    },
  };
}

describe("WahaV1Parser", () => {
  it("has provider 'waha' and parserVersion 'v1'", () => {
    const parser = new WahaV1Parser();

    expect(parser.provider).toBe(WAHA_V1_PROVIDER);
    expect(parser.parserVersion).toBe(WAHA_V1_PARSER_VERSION);
  });

  it("parses an inbound text message as eligible_route_unresolved when no CTWA is present", () => {
    const result = parseWahaV1Webhook(inboundMessagePayload());

    expect(result.error).toBeNull();
    expect(result.classification).toBe("eligible_route_unresolved");
    expect(result.classificationReason).toBe("no_ctwa_in_waha_payload");
    expect(result.events).toHaveLength(1);

    const [event] = result.events;

    expect(event.provider).toBe("waha");
    expect(event.externalMessageId).toBe("waha-msg-1");
    expect(event.channel).toEqual({
      providerChannelId: "default",
      connectedPhone: "5521999996666",
      name: null,
    });
    expect(event.contact).toEqual({
      externalContactId: "5511988887777",
      phoneNumber: "5511988887777",
      name: null,
    });
    expect(event.hasCtwa).toBe(false);
    expect(event.classification).toBe("eligible_route_unresolved");
    expect(event.message.direction).toBe("inbound");
    expect(event.message.authorType).toBe("contact");
    expect(event.message.text).toBe("Olá, quero saber mais");
  });

  it("marks hasCtwa true when the payload carries a ctwa object", () => {
    const result = parseWahaV1Webhook(
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
    const result = parseWahaV1Webhook(
      inboundMessagePayload({ fromMe: true }),
    );

    expect(result.events).toHaveLength(1);
    const [event] = result.events;

    expect(event.classification).toBe("ignored_outbound");
    expect(event.message.direction).toBe("outbound");
  });

  it("classifies group chats (@g.us) as unsupported_event with zero events", () => {
    const result = parseWahaV1Webhook(
      inboundMessagePayload({ from: "120363012345678901@g.us" }),
    );

    expect(result.classification).toBe("unsupported_event");
    expect(result.classificationReason).toBe(
      "group_messages_not_supported_in_v1",
    );
    expect(result.events).toHaveLength(0);
    expect(result.error).toBeNull();
  });

  it("classifies non-'message' events (e.g. acks) as unsupported_event with zero events", () => {
    const result = parseWahaV1Webhook({
      event: "message.ack",
      session: "default",
      payload: { id: { id: "waha-msg-1" } },
    });

    expect(result.classification).toBe("unsupported_event");
    expect(result.classificationReason).toBe("event_type_unsupported");
    expect(result.events).toHaveLength(0);
  });

  it("normalizes millisecond timestamps defensively", () => {
    const result = parseWahaV1Webhook(
      inboundMessagePayload({ timestamp: 1_724_000_000_000 }),
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0].occurredAt.toISOString()).toBe(
      new Date(1_724_000_000_000).toISOString(),
    );
  });

  it("returns delivery-level invalid_payload when the payload is not an object", () => {
    const result = parseWahaV1Webhook("not-an-object");

    expect(result.classification).toBe("invalid_payload");
    expect(result.events).toHaveLength(0);
    expect(result.error).toEqual({
      code: "waha_v1_invalid_payload",
      message: "Inbound webhook payload failed validation",
    });
  });

  it("returns delivery-level invalid_payload when 'from' is missing", () => {
    const payload = inboundMessagePayload();
    const record = payload as { payload: Record<string, unknown> };
    delete record.payload.from;

    const result = parseWahaV1Webhook(payload);

    expect(result.classification).toBe("invalid_payload");
    expect(result.events).toHaveLength(0);
  });

  it("produces a distinct dedupeKey per externalMessageId", () => {
    const first = parseWahaV1Webhook(inboundMessagePayload());
    const second = parseWahaV1Webhook(
      inboundMessagePayload({ id: { id: "waha-msg-2" } }),
    );

    expect(first.events[0].dedupeKey).not.toBe(second.events[0].dedupeKey);
  });
});
