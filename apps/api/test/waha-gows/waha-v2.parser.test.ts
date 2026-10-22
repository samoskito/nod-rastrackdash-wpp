import { describe, expect, it } from "vitest";
import { InboundWebhookParserRegistry } from "../../src/inbound-webhooks/providers/inbound-webhook-parser.registry";
import { parseWahaV1Webhook } from "../../src/inbound-webhooks/providers/waha/waha-v1.parser";
import {
  parseWahaSessionStatusEvent,
  parseWahaV2Webhook,
  WahaV2Parser,
  wahaV2UnresolvedContactLid,
  withWahaResolvedContactPhone,
} from "../../src/inbound-webhooks/providers/waha/waha-v2.parser";
import {
  FIXTURE_SELF_PHONE,
  FIXTURE_SESSION,
  wahaGowsFixture,
} from "./helpers/fixtures";

function onlyEvent(result: ReturnType<typeof parseWahaV2Webhook>) {
  expect(result.error).toBeNull();
  expect(result.events).toHaveLength(1);
  return result.events[0]!;
}

describe("WAHA v2 (GoWS) parser — fixtures sintéticas no formato GoWS", () => {
  it("is registered as waha/v2 next to the untouched v1", () => {
    const registry = new InboundWebhookParserRegistry();
    const v2 = registry.resolve({ provider: "waha", parserVersion: "v2" });
    const v1 = registry.resolve({ provider: "waha", parserVersion: "v1" });

    expect(v2).toBeInstanceOf(WahaV2Parser);
    expect(v2.parserVersion).toBe("v2");
    expect(v1.parserVersion).toBe("v1");
  });

  it("reads a CTWA click: ctwaClid, ad id, phone from SenderAlt and the LID kept apart", () => {
    const result = parseWahaV2Webhook(wahaGowsFixture("message-ctwa-clid"));
    const event = onlyEvent(result);

    expect(result.parserVersion).toBe("v2");
    expect(result.classification).toBe("eligible_route_unresolved");
    expect(event.ctwaClid).toMatch(/^Af[A-Za-z0-9_-]{98}$/u);
    expect(event.hasCtwa).toBe(true);
    expect(event.adId).toBe("120200000000000001");
    expect(event.ad).toMatchObject({
      sourceUrl: "https://fb.me/0Synth1",
      title: "Anúncio sintético 1",
      sourceType: "ad",
      thumbnailUrl: "https://cdn.example.invalid/thumb/1.jpg",
    });
    expect(event.contact).toEqual({
      externalContactId: "5500900000101",
      phoneNumber: "5500900000101",
      name: "Contato Sintético 01",
      lid: "100000000000101",
    });
    expect(event.message).toMatchObject({
      direction: "inbound",
      authorType: "contact",
      text: "Olá! Vi o anúncio e quero saber mais (mensagem sintética).",
    });
    expect(event.channel).toEqual({
      providerChannelId: FIXTURE_SESSION,
      connectedPhone: FIXTURE_SELF_PHONE,
      name: null,
    });
    expect(event.externalMessageId).toBe(
      "false_100000000000101@lid_3EB0000000000000000001",
    );
    expect(event.occurredAt.toISOString()).toBe("2026-10-14T17:46:41.000Z");
  });

  it("never uses ctwaPayload as the clid: a Status ad with only sourceID has no ctwaClid", () => {
    const fixture = wahaGowsFixture("message-ctwa-source-id-only");
    const contextInfo =
      fixture.payload._data.Message.extendedTextMessage.contextInfo;
    expect(typeof contextInfo.ctwaPayload).toBe("string");

    const event = onlyEvent(parseWahaV2Webhook(fixture));

    expect(event.ctwaClid).toBeNull();
    expect(event.hasCtwa).toBe(false);
    expect(event.adId).toBe("120200000000000002");
    expect(event.ad?.sourceUrl).toBe("https://wa.me/wamo/0Synth2");
    expect(event.classification).toBe("ignored_no_ctwa");
    expect(event.classificationReason).toBe("ctwa_clid_missing");
  });

  it("classifies an organic message as no CTWA, phone from a phone JID and LID from SenderAlt", () => {
    const event = onlyEvent(parseWahaV2Webhook(wahaGowsFixture("message-organic")));

    expect(event.ctwaClid).toBeNull();
    expect(event.adId).toBeNull();
    expect(event.classificationReason).toBe("ctwa_missing");
    expect(event.contact.phoneNumber).toBe("5500900000103");
    expect(event.contact.lid).toBe("100000000000103");
    expect(event.message.text).toBe(
      "Bom dia, qual o horário de atendimento? (mensagem sintética)",
    );
  });

  it("reads a team message from message.any using RecipientAlt, never the store number (isSelf)", () => {
    const event = onlyEvent(
      parseWahaV2Webhook(wahaGowsFixture("message-any-team-recipient-alt")),
    );

    expect(event.message.direction).toBe("outbound");
    expect(event.message.authorType).toBe("organization_member");
    expect(event.classification).toBe("ignored_outbound");
    expect(event.contact.phoneNumber).toBe("5500900000101");
    expect(event.contact.lid).toBe("100000000000101");
    expect(event.contact.name).toBeNull();
    expect(event.ctwaClid).toBeNull();
    expect(event.channel.connectedPhone).toBe(FIXTURE_SELF_PHONE);
  });

  it("reads a team message without RecipientAlt from payload.to, skipping the self :0 device JID", () => {
    const event = onlyEvent(
      parseWahaV2Webhook(wahaGowsFixture("message-any-team-no-recipient-alt")),
    );

    expect(event.message.direction).toBe("outbound");
    expect(event.contact.phoneNumber).toBe("5500900000103");
    expect(event.contact.phoneNumber).not.toBe(FIXTURE_SELF_PHONE);
  });

  it("discards the message.any copy of an inbound message so it is never counted twice", () => {
    const result = parseWahaV2Webhook(
      wahaGowsFixture("message-any-inbound-duplicate"),
    );

    expect(result.events).toEqual([]);
    expect(result.classification).toBe("unsupported_event");
    expect(result.classificationReason).toBe(
      "inbound_copy_handled_by_message_event",
    );
    expect(result.error).toBeNull();
  });

  it("discards a fromMe copy delivered as message (team messages come from message.any)", () => {
    const fixture = wahaGowsFixture("message-any-team-recipient-alt");
    fixture.event = "message";

    const result = parseWahaV2Webhook(fixture);

    expect(result.events).toEqual([]);
    expect(result.classificationReason).toBe(
      "team_message_handled_by_message_any",
    );
  });

  it("strips the :NN device suffix from JIDs (12-digit number kept as sent)", () => {
    const event = onlyEvent(
      parseWahaV2Webhook(wahaGowsFixture("message-jid-device-suffix")),
    );

    expect(event.contact.phoneNumber).toBe("550000000107");
    expect(event.contact.lid).toBe("100000000000107");
  });

  it.each([
    ["message-ctwa-image-first", "image", "Quero esse modelo (legenda sintética)"],
    ["message-ctwa-ephemeral", "text", "Oi! (mensagem temporária sintética)"],
    ["message-ctwa-view-once", "image", null],
  ] as const)(
    "finds the CTWA clid in %s (media/ephemeral/viewOnce)",
    (name, messageType, text) => {
      const event = onlyEvent(parseWahaV2Webhook(wahaGowsFixture(name)));

      expect(event.ctwaClid).toMatch(/^Af/u);
      expect(event.hasCtwa).toBe(true);
      expect(event.adId).toMatch(/^1202/u);
      expect(event.message.messageType).toBe(messageType);
      expect(event.message.text).toBe(text);
    },
  );

  it("finds the clid inside an ephemeral wrapper only present in RawMessage", () => {
    const fixture = wahaGowsFixture("message-ctwa-ephemeral");
    fixture.payload._data.Message = { conversation: "texto sem contexto" };

    const event = onlyEvent(parseWahaV2Webhook(fixture));

    expect(event.ctwaClid).toMatch(/^Af/u);
  });

  it.each([
    ["message-group", "group_not_supported"],
    ["message-status-broadcast", "status_not_supported"],
  ] as const)("discards %s (%s)", (name, reason) => {
    const result = parseWahaV2Webhook(wahaGowsFixture(name));

    expect(result.events).toEqual([]);
    expect(result.classification).toBe("unsupported_event");
    expect(result.classificationReason).toBe(reason);
  });

  it("never turns a LID into a phone: LID without SenderAlt is unresolved, even with a CTWA clid", () => {
    const result = parseWahaV2Webhook(
      wahaGowsFixture("message-lid-without-sender-alt"),
    );

    expect(result.events).toEqual([]);
    // The ad click is never lost: own reason + hasCtwa/adId in the summary.
    expect(result.classificationReason).toBe("ctwa_contact_phone_unresolved");
    expect(result.normalizedSummary).toMatchObject({
      hasCtwa: true,
      adId: "1202000000000000013",
    });
    expect(wahaV2UnresolvedContactLid(wahaGowsFixture("message-lid-without-sender-alt"))).toBe(
      "100000000000113",
    );
  });

  it("keeps contact_phone_unresolved (hasCtwa false) for an organic LID-only message", () => {
    const fixture = wahaGowsFixture("message-lid-without-sender-alt");
    fixture.payload._data.Message = { conversation: "Oi (mensagem sintética)" };

    const result = parseWahaV2Webhook(fixture);

    expect(result.classificationReason).toBe("contact_phone_unresolved");
    expect(result.normalizedSummary).toMatchObject({ hasCtwa: false, adId: null });
  });

  it("parses the LID-only click once the phone resolved by the WAHA is placed in SenderAlt", () => {
    const fixture = wahaGowsFixture("message-lid-without-sender-alt");
    const resolved = withWahaResolvedContactPhone(fixture, "5500900000113");

    const event = onlyEvent(parseWahaV2Webhook(resolved));

    expect(event.contact.phoneNumber).toBe("5500900000113");
    expect(event.contact.lid).toBe("100000000000113");
    expect(event.ctwaClid).toMatch(/^Af/u);
    // The original body is untouched.
    expect(fixture.payload._data.Info.SenderAlt).toBe("");
  });

  it("resolves the same phone whether the contact arrives by LID or by phone JID", () => {
    const byLid = onlyEvent(parseWahaV2Webhook(wahaGowsFixture("message-ctwa-clid")));
    const byPhone = wahaGowsFixture("message-ctwa-clid");
    byPhone.payload.from = "5500900000101@c.us";
    byPhone.payload._data.Info.Chat = "5500900000101@s.whatsapp.net";
    byPhone.payload._data.Info.Sender = "5500900000101@s.whatsapp.net";
    byPhone.payload._data.Info.SenderAlt = "100000000000101@lid";

    const event = onlyEvent(parseWahaV2Webhook(byPhone));

    expect(event.contact.phoneNumber).toBe(byLid.contact.phoneNumber);
    expect(event.contact.lid).toBe(byLid.contact.lid);
  });

  it.each(["working", "scan-qr-code", "failed", "stopped"] as const)(
    "treats session.status (%s) as a non-message event and exposes the status",
    (status) => {
      const fixture = wahaGowsFixture(`session-status-${status}`);
      const result = parseWahaV2Webhook(fixture);

      expect(result.events).toEqual([]);
      expect(result.classification).toBe("unsupported_event");
      expect(result.classificationReason).toBe("session_status");
      expect(parseWahaSessionStatusEvent(fixture)).toEqual({
        session: FIXTURE_SESSION,
        status: status.toUpperCase().replace(/-/gu, "_"),
        occurredAt: new Date(fixture.timestamp),
      });
    },
  );

  it("ignores unknown events and rejects malformed envelopes", () => {
    expect(
      parseWahaV2Webhook({
        event: "message.ack",
        session: FIXTURE_SESSION,
        payload: { id: "x" },
      }).classificationReason,
    ).toBe("event_type_unsupported");
    expect(parseWahaV2Webhook(null).classification).toBe("invalid_payload");
    expect(parseWahaV2Webhook({ event: "message" }).classification).toBe(
      "invalid_payload",
    );
    expect(parseWahaSessionStatusEvent(wahaGowsFixture("message-organic"))).toBeNull();
  });

  it("never reads a string fromMe: falls back to Info.IsFromMe, else invalid", () => {
    const fixture = wahaGowsFixture("message-organic");
    fixture.payload.fromMe = "false";

    // Info.IsFromMe (boolean) decides; the string is ignored.
    expect(onlyEvent(parseWahaV2Webhook(fixture)).message.direction).toBe("inbound");

    delete fixture.payload._data.Info.IsFromMe;
    expect(parseWahaV2Webhook(fixture).classification).toBe("invalid_payload");
  });

  it("uses the envelope timestamp when the message has no time of its own", () => {
    const fixture = wahaGowsFixture("message-organic");
    delete fixture.payload.timestamp;
    fixture.payload._data.Info.Timestamp = "0001-01-01T00:00:00Z";

    const event = onlyEvent(parseWahaV2Webhook(fixture));

    expect(event.occurredAt.getTime()).toBe(fixture.timestamp);

    delete fixture.timestamp;
    expect(parseWahaV2Webhook(fixture).classification).toBe("invalid_payload");
  });

  it("falls back to Info.Timestamp and Info.ID when payload.timestamp/id are missing", () => {
    const fixture = wahaGowsFixture("message-organic");
    delete fixture.payload.timestamp;
    delete fixture.payload.id;

    const event = onlyEvent(parseWahaV2Webhook(fixture));

    expect(event.externalMessageId).toBe("3EB0000000000000000003");
    expect(event.occurredAt.toISOString()).toBe("2026-10-14T17:46:43.000Z");
  });

  it("keeps v1 intact: v1 never reads the GoWS externalAdReply", () => {
    const v1 = parseWahaV1Webhook(wahaGowsFixture("message-ctwa-clid"));

    expect(v1.parserVersion).toBe("v1");
    expect(v1.events.every((event) => event.ctwaClid === null)).toBe(true);
  });
});
