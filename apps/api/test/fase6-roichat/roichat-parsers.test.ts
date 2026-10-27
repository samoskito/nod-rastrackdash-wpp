import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isRoichatPurchasePayload,
  parseRoichatPayload,
  roichatCurrency,
  roichatEventTime,
  roichatLeadPhone,
  roichatPurchaseFingerprint,
  roichatValueCents,
} from "../../src/inbound-webhooks/providers/roichat/roichat-payload";
import {
  ROICHAT_PURCHASE_WITHOUT_RULE_REASON,
  RoichatV1Parser,
} from "../../src/inbound-webhooks/providers/roichat/roichat-v1.parser";
import { parseRoichatAutomationV1 } from "../../src/inbound-webhooks/providers/roichat/roichat-automation-v1.parser";
import { InboundWebhookParserRegistry } from "../../src/inbound-webhooks/providers/inbound-webhook-parser.registry";

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(__dirname, "../fixtures/roichat", name), "utf8"),
  ) as Record<string, unknown>;
}

const receivedAt = new Date("2026-10-25T15:00:00.000Z");
const context = {
  organizationId: "workspace_ficticio",
  connectedPhone: "+5511900000001",
  receivedAt,
};

describe("ROI Chat — entrada do lead (parser v1)", () => {
  const parser = new RoichatV1Parser();

  it("is registered for roichat/v1", () => {
    expect(
      new InboundWebhookParserRegistry().resolve({
        provider: "roichat",
        parserVersion: "v1",
      }),
    ).toBeInstanceOf(RoichatV1Parser);
  });

  it("reads a CTWA entry with the ad attribution, bound to the URL's number", () => {
    const result = parser.parse(fixture("entry.synthetic.json"), context);
    expect(result.error).toBeNull();
    expect(result.classification).toBe("eligible_route_unresolved");
    expect(result.events).toHaveLength(1);
    const event = result.events[0]!;
    expect(event).toMatchObject({
      provider: "roichat",
      providerEventType: "lead.entry",
      adId: "120200000000000001",
      ctwaClid: "AfjX-clique-ficticio-0001",
      hasCtwa: true,
      occurredAt: new Date(1792000000 * 1000),
      channel: {
        providerChannelId: "+5511900000001",
        connectedPhone: "+5511900000001",
      },
      contact: { phoneNumber: "5547999990000", name: "Fulana de Teste" },
      ad: {
        sourceUrl: "https://www.instagram.com/p/EXEMPLO000/",
        sourceType: "ad",
        title: "RECEBA A RECEITA NO WHATSAPP",
        description: "Texto ficticio do anuncio\nSegunda linha",
        mediaUrl: "https://www.facebook.com/reel/000000000000001",
        thumbnailUrl: "https://scontent.example.fbcdn.net/thumb-ficticia.jpg",
      },
    });
    // No PII (phone, name) in the persisted summary or the event identity.
    const persisted = JSON.stringify([
      event.normalizedSummary,
      event.externalEventId,
      event.contact.externalContactId,
      result.normalizedSummary,
    ]);
    expect(persisted).not.toContain("47999990000");
    expect(persisted).not.toContain("Fulana");
  });

  it("is the same event when the entry is resent (identity = phone + click)", () => {
    const first = parser.parse(fixture("entry.synthetic.json"), context);
    const resent = parser.parse(
      { ...fixture("entry.synthetic.json"), event_time: 1792000100, body: "outro" },
      context,
    );
    expect(resent.events[0]!.dedupeKey).toBe(first.events[0]!.dedupeKey);
  });

  it("ignores the ROI Chat event_id (always the phone)", () => {
    const first = parser.parse(fixture("entry.synthetic.json"), context);
    const otherId = parser.parse(
      { ...fixture("entry.synthetic.json"), event_id: "qualquer-coisa" },
      context,
    );
    expect(otherId.events[0]!.dedupeKey).toBe(first.events[0]!.dedupeKey);
    expect(otherId.events[0]!.externalEventId).not.toContain("5547999990000");
  });

  it("uses the arrival when event_time is missing", () => {
    const { event_time: _omit, ...entry } = fixture("entry.synthetic.json");
    const result = parser.parse(entry, context);
    expect(result.events[0]!.occurredAt).toEqual(receivedAt);
  });

  it("counts an entry without ctwa_clid as 'sem anuncio' (never sent)", () => {
    const { ctwa_clid: _omit, ...entry } = fixture("entry.synthetic.json");
    const result = parser.parse(entry, context);
    expect(result.classification).toBe("ignored_no_ctwa");
    expect(result.events[0]!.hasCtwa).toBe(false);
  });

  it("tolerates missing ad fields", () => {
    const result = parser.parse(
      { telefone: "+5547999990000", ctwa_clid: "AfjX-clique-ficticio-0002" },
      context,
    );
    expect(result.error).toBeNull();
    expect(result.events[0]).toMatchObject({ adId: null, ad: null, hasCtwa: true });
  });

  it("never turns a purchase into a lead entry", () => {
    const result = parser.parse(fixture("purchase.synthetic.json"), context);
    expect(result.classification).toBe("unsupported_event");
    expect(result.classificationReason).toBe(ROICHAT_PURCHASE_WITHOUT_RULE_REASON);
    expect(result.events).toEqual([]);
  });

  it("fails closed without the number bound by the connection or without a phone", () => {
    expect(
      parser.parse(fixture("entry.synthetic.json"), {
        organizationId: "workspace_ficticio",
      }).classification,
    ).toBe("invalid_payload");
    const { telefone: _omit, ...noPhone } = fixture("entry.synthetic.json");
    expect(parser.parse(noPhone, context).classification).toBe("invalid_payload");
  });

  it("accepts the n8n array and { body } envelopes", () => {
    const direct = parser.parse(fixture("entry.synthetic.json"), context);
    expect(parser.parse([fixture("entry.synthetic.json")], context)).toEqual(direct);
    expect(
      parser.parse({ body: fixture("entry.synthetic.json") }, context),
    ).toEqual(direct);
  });
});

describe("ROI Chat — compra (parser automation-v1)", () => {
  it("reads value, currency and time of the purchase", () => {
    const parsed = parseRoichatAutomationV1(
      fixture("purchase.synthetic.json"),
      receivedAt,
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        provider: "roichat",
        eventName: "Purchase",
        phone: "5547999990000",
        valueCents: 2_000,
        currency: "BRL",
        adId: "120200000000000001",
        hasCtwa: true,
        occurredAt: new Date(1792000600 * 1000),
        eventTimeSource: "payload",
      },
    });
  });

  it("without event_time uses the arrival, and the key follows the arrival", () => {
    const { event_time: _omit, ...purchase } = fixture("purchase.synthetic.json");
    const first = parseRoichatAutomationV1(purchase, receivedAt);
    const again = parseRoichatAutomationV1(purchase, receivedAt);
    const later = parseRoichatAutomationV1(
      purchase,
      new Date(receivedAt.getTime() + 60_000),
    );
    expect(first.ok && first.value.occurredAt).toEqual(receivedAt);
    expect(first.ok && first.value.eventTimeSource).toBe("received");
    // Re-evaluation of the stored body (same firstReceivedAt) = same occurrence.
    expect(first.ok && again.ok && first.value.externalExecutionKey).toBe(
      again.ok ? again.value.externalExecutionKey : null,
    );
    // Another arrival is another occurrence (the 12h guard decides repeats).
    expect(first.ok && later.ok && first.value.externalExecutionKey).not.toBe(
      later.ok ? later.value.externalExecutionKey : null,
    );
  });

  it("never sends a future event_time (capped to the arrival)", () => {
    const future = Math.floor(receivedAt.getTime() / 1000) + 3_600;
    const parsed = parseRoichatAutomationV1(
      { ...fixture("purchase.synthetic.json"), event_time: future },
      receivedAt,
    );
    expect(parsed.ok && parsed.value.occurredAt).toEqual(receivedAt);
    expect(parsed.ok && parsed.value.eventTimeSource).toBe("future_capped");
  });

  it("keeps an old event_time (the 7-day Meta window is applied when sending)", () => {
    const old = roichatEventTime(
      Math.floor(receivedAt.getTime() / 1000) - 9 * 24 * 3_600,
      receivedAt,
    );
    expect(old.source).toBe("payload");
  });

  it("reads milliseconds and numeric strings", () => {
    expect(roichatEventTime(1792000600000, receivedAt).occurredAt).toEqual(
      new Date(1792000600 * 1000),
    );
    expect(roichatEventTime("1792000600", receivedAt).occurredAt).toEqual(
      new Date(1792000600 * 1000),
    );
    expect(roichatEventTime("ontem", receivedAt).source).toBe("received");
  });

  it("reads Brazilian and plain value formats", () => {
    expect(roichatValueCents("20.00")).toBe(2_000);
    expect(roichatValueCents("20,00")).toBe(2_000);
    expect(roichatValueCents("1.234,56")).toBe(123_456);
    expect(roichatValueCents("1,234.56")).toBe(123_456);
    expect(roichatValueCents("R$ 97,90")).toBe(9_790);
    expect(roichatValueCents(150.5)).toBe(15_050);
    expect(roichatValueCents("0,00")).toBeNull();
    expect(roichatValueCents("-10")).toBeNull();
    expect(roichatValueCents("abc")).toBeNull();
  });

  it("reads the currency (BRL/USD/EUR, R$ = BRL)", () => {
    expect(roichatCurrency("BRL")).toBe("BRL");
    expect(roichatCurrency("usd")).toBe("USD");
    expect(roichatCurrency("R$")).toBe("BRL");
    expect(roichatCurrency("MXN")).toBeNull();
  });

  it("refuses a present but unreadable value or an unsupported currency", () => {
    expect(
      parseRoichatAutomationV1(
        { ...fixture("purchase.synthetic.json"), valor_venda: "vinte" },
        receivedAt,
      ),
    ).toEqual({ ok: false, errorCode: "roichat_automation_v1_invalid_payload" });
    expect(
      parseRoichatAutomationV1(
        { ...fixture("purchase.synthetic.json"), moeda: "MXN" },
        receivedAt,
      ),
    ).toEqual({ ok: false, errorCode: "roichat_automation_v1_invalid_payload" });
  });

  it("accepts a purchase without valor_venda/moeda (rule value is the fallback)", () => {
    const { valor_venda: _v, moeda: _m, ...purchase } = fixture(
      "purchase.synthetic.json",
    );
    const parsed = parseRoichatAutomationV1(purchase, receivedAt);
    expect(parsed.ok && parsed.value.valueCents).toBeNull();
    expect(parsed.ok && parsed.value.currency).toBeNull();
  });

  it("is not a purchase without event_name (entry) and ignores another event", () => {
    expect(isRoichatPurchasePayload(fixture("entry.synthetic.json"))).toBe(false);
    expect(isRoichatPurchasePayload(fixture("purchase.synthetic.json"))).toBe(true);
    expect(
      isRoichatPurchasePayload({ ...fixture("purchase.synthetic.json"), event_name: "compra" }),
    ).toBe(true);
    expect(
      parseRoichatAutomationV1(fixture("entry.synthetic.json"), receivedAt),
    ).toEqual({ ok: false, errorCode: "roichat_automation_v1_not_purchase" });
    expect(
      parseRoichatPayload(
        { ...fixture("purchase.synthetic.json"), event_name: "Lead" },
        receivedAt,
      )?.kind,
    ).toBe("other_event");
  });

  it("ignores the ROI Chat event_id in the occurrence key", () => {
    const first = parseRoichatAutomationV1(fixture("purchase.synthetic.json"), receivedAt);
    const other = parseRoichatAutomationV1(
      { ...fixture("purchase.synthetic.json"), event_id: "5547000000000" },
      receivedAt,
    );
    expect(first.ok && first.value.externalExecutionKey).toBe(
      other.ok ? other.value.externalExecutionKey : null,
    );
    expect(first.ok && first.value.externalExecutionKey).not.toContain("5547");
  });
});

describe("ROI Chat — telefone do lead", () => {
  it("keeps a Brazilian number with +55 and adds 55 to a national one", () => {
    expect(roichatLeadPhone("+5547999990000")).toBe("5547999990000");
    expect(roichatLeadPhone("+55 (47) 99999-0000")).toBe("5547999990000");
    expect(roichatLeadPhone("47999990000")).toBe("5547999990000");
    expect(roichatLeadPhone(5547999990000)).toBe("5547999990000");
  });

  it("never adds 55 to a foreign number with an international prefix", () => {
    expect(roichatLeadPhone("+351 912 345 678")).toBe("351912345678");
    // "+1 415..." would look like the BR DDD 14 without the prefix rule.
    expect(roichatLeadPhone("+1 415 555 0100")).toBe("14155550100");
    expect(roichatLeadPhone("00351912345678")).toBe("351912345678");
  });

  it("refuses an unusable phone", () => {
    expect(roichatLeadPhone("")).toBeNull();
    expect(roichatLeadPhone("123")).toBeNull();
    expect(roichatLeadPhone(null)).toBeNull();
  });

  it("fingerprints the same person across +55 / 9th-digit forms, never the phone itself", () => {
    const withNine = roichatPurchaseFingerprint({
      phone: "5547999990000",
      valueCents: 2_000,
      currency: "BRL",
    });
    const withoutNine = roichatPurchaseFingerprint({
      phone: "554799990000",
      valueCents: 2_000,
      currency: "BRL",
    });
    expect(withNine).toBe(withoutNine);
    expect(withNine).not.toContain("47999990000");
    expect(
      roichatPurchaseFingerprint({ phone: "5547999990000", valueCents: 2_100, currency: "BRL" }),
    ).not.toBe(withNine);
    expect(
      roichatPurchaseFingerprint({ phone: "5547999990000", valueCents: 2_000, currency: "USD" }),
    ).not.toBe(withNine);
  });
});

describe("ROI Chat — formato real com o anúncio em `anuncio`", () => {
  it("reads ctwa_clid, ad id and creative from the nested object", () => {
    const parsed = parseRoichatPayload(
      fixture("entrada-real-anuncio-aninhado.json"),
      receivedAt,
    );

    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("entry");
    expect(parsed!.phone).toBe("5547900000002");
    expect(parsed!.contactName).toBe("Fulana Ficticia");
    expect(parsed!.ctwaClid).toBe(
      "AfhgFICTICIOctwaClidAninhado0000000000000000",
    );
    expect(parsed!.adId).toBe("120200000000000001");
    expect(parsed!.ad).toMatchObject({
      sourceUrl: "https://fb.me/ficticio",
      title: "Titulo ficticio",
      mediaType: "video",
      thumbnailUrl: "https://scontent.example.fbcdn.net/v/ficticio.jpg",
    });
  });

  it("reads a purchase whose ad data is nested", () => {
    const parsed = parseRoichatPayload(
      {
        ...fixture("entrada-real-anuncio-aninhado.json"),
        event_name: "Purchase",
        valor_venda: "20.00",
        moeda: "BRL",
      },
      receivedAt,
    );

    expect(parsed!.kind).toBe("purchase");
    expect(parsed!.ctwaClid).toBe(
      "AfhgFICTICIOctwaClidAninhado0000000000000000",
    );
    expect(parsed!.valueCents).toBe(2000);
    expect(parsed!.currency).toBe("BRL");
  });

  it("keeps reading the top-level format", () => {
    const parsed = parseRoichatPayload(
      {
        telefone: "+5547900000002",
        ctwa_clid: "AfhgTOPLEVEL",
        source_id: "120200000000000009",
      },
      receivedAt,
    );

    expect(parsed!.ctwaClid).toBe("AfhgTOPLEVEL");
    expect(parsed!.adId).toBe("120200000000000009");
  });
});
