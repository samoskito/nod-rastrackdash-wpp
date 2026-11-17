import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GOHIGHLEVEL_AUTOMATION_V1_INVALID,
  GOHIGHLEVEL_AUTOMATION_V1_PARSER_VERSION,
  parseGoHighLevelAutomationV1,
} from "../../src/inbound-webhooks/providers/gohighlevel/gohighlevel-automation-v1.parser";

/**
 * GoHighLevel automation-v1 (Workflow → ação Webhook). Same shape as the real
 * GHL call (raw body or n8n envelope), with SYNTHETIC data only: no real
 * contact, phone, clinic or location.
 */

const receivedAt = new Date("2026-10-26T15:00:00.000Z");

function source(overrides: Record<string, unknown> = {}) {
  return {
    sessionSource: "Paid Social",
    url: "https://ads.example.test/click",
    medium: "whatsapp",
    ctwa_clid: "synthetic-click-first",
    adName: "Synthetic Ad",
    adId: "120000000000000001",
    ...overrides,
  };
}

function ghlCall(overrides: Record<string, unknown> = {}) {
  return {
    contact_id: "contact_synthetic_001",
    first_name: "Fulana",
    full_name: "Fulana Exemplo",
    phone: "+5511900000001",
    tags: "nova oportunidade,atendimento_ativo",
    country: "BR",
    // Contact creation date, NEVER the event time.
    date_created: "2026-10-02T05:56:43.924Z",
    contact_type: "lead",
    location: { id: "location_synthetic_a", name: "Clínica Exemplo" },
    workflow: { id: "workflow_synthetic_qualified", name: "Lead qualificado" },
    triggerData: {},
    contact: {
      attributionSource: source(),
      lastAttributionSource: source({
        ctwa_clid: "synthetic-click-last",
        adId: "120000000000000002",
      }),
    },
    attributionSource: {},
    customData: {},
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe("GoHighLevel automation v1 parser", () => {
  it("reads the raw body and the n8n envelope the same way", () => {
    const raw = parseGoHighLevelAutomationV1(ghlCall(), receivedAt);
    const envelope = parseGoHighLevelAutomationV1(
      [{ headers: { "content-type": "application/json" }, body: ghlCall() }],
      receivedAt,
    );

    expect(raw).toEqual(envelope);
    expect(raw).toMatchObject({
      ok: true,
      value: {
        phone: "+5511900000001",
        hasCtwa: true,
        ctwaClid: "synthetic-click-first",
        adId: "120000000000000001",
        contactId: "contact_synthetic_001",
        locationId: "location_synthetic_a",
        workflowId: "workflow_synthetic_qualified",
        workflowName: "Lead qualificado",
        triggerId: null,
      },
    });
    expect(raw.ok && raw.value.externalExecutionKey).toMatch(
      /^gohighlevel-automation:[0-9a-f]{64}$/u,
    );
    expect(GOHIGHLEVEL_AUTOMATION_V1_PARSER_VERSION).toBe("automation-v1");
  });

  it("prefers attributionSource and falls back to lastAttributionSource only when it has the click", () => {
    const first = parseGoHighLevelAutomationV1(ghlCall(), receivedAt);
    expect(first).toMatchObject({
      ok: true,
      value: { ctwaClid: "synthetic-click-first", adId: "120000000000000001" },
    });

    const lastOnly = parseGoHighLevelAutomationV1(
      ghlCall({
        contact: {
          // An ad id without the click of the same source never counts.
          attributionSource: source({ ctwa_clid: null, adId: "999" }),
          lastAttributionSource: source({
            ctwa_clid: "synthetic-click-last",
            adId: "120000000000000002",
          }),
        },
      }),
      receivedAt,
    );
    expect(lastOnly).toMatchObject({
      ok: true,
      value: { ctwaClid: "synthetic-click-last", adId: "120000000000000002" },
    });
  });

  it("accepts a contact without ctwa_clid as hasCtwa=false (recorded as ctwa_missing downstream)", () => {
    const parsed = parseGoHighLevelAutomationV1(
      ghlCall({ contact: { attributionSource: {}, lastAttributionSource: null } }),
      receivedAt,
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: { hasCtwa: false, ctwaClid: null, adId: null },
    });
  });

  it("keeps a click without adId (page/pixel fallback decides the destination)", () => {
    const parsed = parseGoHighLevelAutomationV1(
      ghlCall({
        contact: {
          attributionSource: source({ adId: undefined }),
          lastAttributionSource: null,
        },
      }),
      receivedAt,
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: { hasCtwa: true, ctwaClid: "synthetic-click-first", adId: null },
    });
  });

  it("requires the lead phone, contact_id, location.id and workflow.id", () => {
    for (const overrides of [
      { phone: "" },
      { phone: null },
      { contact_id: undefined },
      { location: { name: "Sem id" } },
      { workflow: { name: "Sem id" } },
      { contact: { attributionSource: "not-an-object" } },
    ]) {
      expect(parseGoHighLevelAutomationV1(ghlCall(overrides), receivedAt)).toEqual({
        ok: false,
        errorCode: GOHIGHLEVEL_AUTOMATION_V1_INVALID,
      });
    }
    expect(parseGoHighLevelAutomationV1([ghlCall(), ghlCall()], receivedAt)).toEqual({
      ok: false,
      errorCode: GOHIGHLEVEL_AUTOMATION_V1_INVALID,
    });
  });

  it("uses the arrival as event time: never date_created, never in the future", () => {
    vi.useFakeTimers();
    vi.setSystemTime(receivedAt);
    const parsed = parseGoHighLevelAutomationV1(ghlCall(), receivedAt);
    expect(parsed.ok && parsed.value.occurredAt.toISOString()).toBe(
      "2026-10-26T15:00:00.000Z",
    );

    const future = parseGoHighLevelAutomationV1(
      ghlCall(),
      new Date(receivedAt.getTime() + 3_600_000),
    );
    expect(future.ok && future.value.occurredAt.getTime()).toBe(
      receivedAt.getTime(),
    );
    // Live default: the moment the call is read.
    const live = parseGoHighLevelAutomationV1(ghlCall());
    expect(live.ok && live.value.occurredAt.getTime()).toBe(receivedAt.getTime());
  });

  it("dedupes the same contact in the same workflow; different workflows are different conversions", () => {
    const key = (body: unknown, at = receivedAt) => {
      const parsed = parseGoHighLevelAutomationV1(body, at);
      return parsed.ok ? parsed.value.externalExecutionKey : null;
    };
    const same = key(ghlCall());
    // A retry (later arrival, other tags, other contact creation date) is the
    // same conversion.
    expect(
      key(
        ghlCall({ tags: "outra", date_created: "2026-10-03T00:00:00.000Z" }),
        new Date(receivedAt.getTime() + 60_000),
      ),
    ).toBe(same);
    expect(
      key(ghlCall({ workflow: { id: "workflow_synthetic_purchase", name: "Compra" } })),
    ).not.toBe(same);
    expect(key(ghlCall({ contact_id: "contact_synthetic_002" }))).not.toBe(same);
    expect(
      key(ghlCall({ location: { id: "location_synthetic_b", name: "Outra" } })),
    ).not.toBe(same);
    // Optional trigger identifier: each distinct trigger is its own conversion.
    const triggerA = key(ghlCall({ triggerData: { id: "trigger_a" } }));
    expect(triggerA).not.toBe(same);
    expect(key(ghlCall({ triggerData: { id: "trigger_a" } }))).toBe(triggerA);
    expect(key(ghlCall({ triggerData: { id: "trigger_b" } }))).not.toBe(triggerA);
  });
});
