import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildInboundWebhookEventDedupeKey } from "../../../src/inbound-webhooks/providers/inbound-webhook-parser";
import {
  DataCrazyV1Parser,
  DATA_CRAZY_V1_PROVIDER,
} from "../../../src/inbound-webhooks/providers/data-crazy/data-crazy-v1.parser";

const fixtureDirectory = resolve(__dirname, "..", "fixtures", "data-crazy");

function loadFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(resolve(fixtureDirectory, name), "utf8"),
  ) as unknown;
}

function firstItem(name = "ctwa-presente.json"): Record<string, unknown> {
  return (loadFixture(name) as Array<Record<string, unknown>>)[0]!;
}

function parseBody(item: Record<string, unknown>): {
  body: Record<string, unknown>;
  mensagem: Record<string, unknown>;
} {
  const body = JSON.parse(item.body as string) as Record<string, unknown>;
  const mensagem = JSON.parse(body.mensagem as string) as Record<
    string,
    unknown
  >;
  return { body, mensagem };
}

describe("Data Crazy v1 inbound webhook parser", () => {
  const parser = new DataCrazyV1Parser();
  const parserContext = { organizationId: "organization_context_001" };
  const parse = (payload: unknown) => parser.parse(payload, parserContext);

  it("parses the three-layer envelope and maps CTWA only from mensagem.referral", () => {
    const item = firstItem();
    expect(item).not.toHaveProperty("messageData");
    expect(item).not.toHaveProperty("instanceData");
    const result = parse(loadFixture("ctwa-presente.json"));
    const event = result.events[0]!;

    expect(result).toMatchObject({
      provider: DATA_CRAZY_V1_PROVIDER,
      parserVersion: "v1",
      providerEventType: "message",
      classification: "eligible_route_unresolved",
      classificationReason: "route_resolution_pending",
      error: null,
    });
    expect(result.events).toHaveLength(1);
    expect(event).toMatchObject({
      provider: DATA_CRAZY_V1_PROVIDER,
      externalEventId: "message_fixture_001",
      externalMessageId: "message_fixture_001",
      organizationId: "organization_context_001",
      channel: {
        providerChannelId: "instance_fixture_001",
        connectedPhone: "instance_fixture_001",
        name: "Synthetic Sales Instance",
      },
      contact: {
        externalContactId: "lead_fixture_001",
        phoneNumber: "551199999123",
      },
      message: {
        direction: "inbound",
        authorType: "contact",
        messageType: "text",
        text: "Synthetic inbound message.",
      },
      adId: "ad_fixture_001",
      ctwaClid: "ctwa_fixture_001",
      hasCtwa: true,
    });
    expect(event.normalizedSummary.connectedPhoneSuffix).toBe("");
    expect(event.dedupeKey).toBe(
      buildInboundWebhookEventDedupeKey({
        provider: DATA_CRAZY_V1_PROVIDER,
        organizationId: "organization_context_001",
        providerChannelId: "instance_fixture_001",
        externalMessageId: "message_fixture_001",
      }),
    );
  });

  it("requires authenticated organization context and never trusts payload organization fields", () => {
    expect(parser.parse(loadFixture("ctwa-presente.json"))).toMatchObject({
      classification: "invalid_payload",
      events: [],
      error: { code: "data_crazy_v1_item_invalid" },
    });
    const item = firstItem();
    const { body, mensagem } = parseBody(item);
    body.organizationId = "payload_organization_must_be_ignored";
    mensagem.organizationId = "payload_message_organization_must_be_ignored";
    body.mensagem = JSON.stringify(mensagem);
    item.body = JSON.stringify(body);
    expect(parse([item]).events[0]?.organizationId).toBe(
      "organization_context_001",
    );
  });

  it("keeps leadId as external identity and keeps sensitive values out of summaries", () => {
    const result = parse(loadFixture("ctwa-presente.json"));
    const event = result.events[0]!;
    const summary = JSON.stringify({
      delivery: result.normalizedSummary,
      event: event.normalizedSummary,
    });
    expect(event.contact.externalContactId).toBe("lead_fixture_001");
    expect(event.contact.externalContactId).not.toBe(event.contact.phoneNumber);
    expect(event.normalizedSummary.phoneDivergenceDetected).toBe(true);
    expect(result.normalizedSummary).not.toHaveProperty("ctwaClid");
    expect(event.normalizedSummary).not.toHaveProperty("ctwaClid");
    for (const sensitiveValue of [
      "551199999123",
      "5511999999123",
      "Synthetic inbound message.",
      "ctwa_fixture_001",
      "example.invalid",
    ]) {
      expect(summary).not.toContain(sensitiveValue);
    }
  });

  it("observes a lead without CTWA but does not expose ad attribution", () => {
    const result = parse(loadFixture("ctwa-ausente.json"));
    const event = result.events[0]!;
    expect(result).toMatchObject({
      classification: "ignored_no_ctwa",
      classificationReason: "ctwa_missing",
      error: null,
    });
    expect(event).toMatchObject({
      hasCtwa: false,
      ctwaClid: null,
      adId: null,
      ad: null,
      classification: "ignored_no_ctwa",
    });
    expect(event.message.text).toBe(
      "https://example.invalid/preview/fixture-002",
    );
  });

  it("maps every item in a batch and ignores an invalid item without dropping valid events", () => {
    const payload = loadFixture("array-multiplo.json") as unknown[];
    payload.push({ body: "invalid" });
    const result = parse(payload);
    expect(result.events).toHaveLength(2);
    expect(result.classification).toBe("eligible_route_unresolved");
    expect(result.events.map((event) => event.classification)).toEqual([
      "eligible_route_unresolved",
      "ignored_no_ctwa",
    ]);
    expect(result.error).toBeNull();
  });

  it.each([
    ["body-nao-json.json", "data_crazy_v1_body_json_invalid"],
    ["mensagem-nao-json.json", "data_crazy_v1_mensagem_json_invalid"],
  ])("reports the bounded parse failure for %s", (fixture, code) => {
    expect(parse(loadFixture(fixture))).toMatchObject({
      classification: "invalid_payload",
      events: [],
      error: { code },
    });
  });

  it("reports an explicit bound failure before parsing an oversized body string", () => {
    const item = firstItem();
    item.body = "{" + "x".repeat(512 * 1024) + "}";
    expect(parse([item])).toMatchObject({
      classification: "invalid_payload",
      error: { code: "data_crazy_v1_body_too_large" },
    });
  });

  it("fails closed when stable message or instance contract fields are absent", () => {
    for (const mutate of [
      (item: Record<string, unknown>) => {
        const { body, mensagem } = parseBody(item);
        delete (mensagem.messageData as Record<string, unknown>).id;
        body.mensagem = JSON.stringify(mensagem);
        item.body = JSON.stringify(body);
      },
      (item: Record<string, unknown>) => {
        const { body, mensagem } = parseBody(item);
        delete (mensagem.instanceData as Record<string, unknown>).id;
        body.mensagem = JSON.stringify(mensagem);
        item.body = JSON.stringify(body);
      },
    ]) {
      const item = firstItem();
      mutate(item);
      expect(parse([item])).toMatchObject({
        classification: "invalid_payload",
        events: [],
        error: { code: "data_crazy_v1_item_invalid" },
      });
    }
  });

  it("never uses the lead phone (body.telefone) as the channel phone", () => {
    const result = parse(loadFixture("array-multiplo.json"));
    for (const event of result.events) {
      expect(event.channel.connectedPhone).toBe(
        event.channel.providerChannelId,
      );
      expect(event.channel.connectedPhone).not.toMatch(/^\d+$/u);
      expect(event.normalizedSummary.connectedPhoneSuffix).toBe("");
    }
  });

  it("still fails closed when body.telefone is missing", () => {
    const item = firstItem();
    const { body } = parseBody(item);
    delete body.telefone;
    item.body = JSON.stringify(body);
    expect(parse([item])).toMatchObject({
      classification: "invalid_payload",
      events: [],
      error: { code: "data_crazy_v1_item_invalid" },
    });
  });

  it("does not treat top-level CTWA-like fields as attribution", () => {
    const item = firstItem("ctwa-ausente.json");
    const { body } = parseBody(item);
    body.ctwa_clid = "top_level_ctwa_must_be_ignored";
    body.source_id = "top_level_ad_must_be_ignored";
    item.body = JSON.stringify(body);
    expect(parse([item]).events[0]).toMatchObject({
      hasCtwa: false,
      ctwaClid: null,
      adId: null,
    });
  });

  it("uses messageData.id as stable semantic identity across content changes", () => {
    const first = parse(loadFixture("ctwa-presente.json"));
    const item = firstItem();
    const { body, mensagem } = parseBody(item);
    (mensagem.messageData as Record<string, unknown>).text =
      "Synthetic changed content.";
    body.mensagem = JSON.stringify(mensagem);
    item.body = JSON.stringify(body);
    expect(parse([item]).events[0]?.dedupeKey).toBe(first.events[0]?.dedupeKey);
  });

  it("classifies an empty batch as unsupported and a non-array as invalid", () => {
    expect(parse(loadFixture("array-vazio.json"))).toMatchObject({
      classification: "unsupported_event",
      classificationReason: "empty_batch",
      error: null,
    });
    expect(parse({})).toMatchObject({
      classification: "invalid_payload",
      error: { code: "data_crazy_v1_root_array_required" },
    });
  });
});
