import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GOHIGHLEVEL_PIPELINE_STAGE_NOT_IN_RULE,
  GOHIGHLEVEL_VALUE_INVALID,
  GOHIGHLEVEL_VALUE_MISSING,
  parseGoHighLevelAutomationV2,
} from "../../src/inbound-webhooks/providers/gohighlevel/gohighlevel-automation-v2.parser";

/** Fictitious payload with the structure of a real GHL Workflow Webhook call. */
const envelope = JSON.parse(
  readFileSync(
    resolve(__dirname, "../fixtures/gohighlevel/opportunity-stage-changed.json"),
    "utf8",
  ),
) as [{ headers: unknown; body: Record<string, any> }];
const receivedAt = new Date("2026-11-20T12:00:00.000Z");

function call(overrides: Record<string, unknown> = {}) {
  return [
    {
      headers: envelope[0].headers,
      body: { ...structuredClone(envelope[0].body), ...overrides },
    },
  ];
}
const purchase = { eventName: "Purchase" };

describe("GoHighLevel automation v2 parser (opportunity stage)", () => {
  it("reads the fictitious capture: value, opportunity, stage and click", () => {
    const parsed = parseGoHighLevelAutomationV2(envelope, receivedAt, purchase);
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        phone: "+5591900000000",
        hasCtwa: true,
        ctwaClid: "CTWA_CLID_FICTICIO",
        adId: "AD_ID_FICTICIO",
        locationId: "LOCATION_ID_FICTICIO",
        workflowId: "WORKFLOW_ID_FICTICIO",
        opportunityId: "OPPORTUNITY_ID_FICTICIO",
        pipelineId: "PIPELINE_ID_FICTICIO",
        pipelineStage: "Proposta enviada",
        valueCents: 150050,
        currency: "BRL",
      },
    });
  });

  it("accepts the correctly spelled pipeline_stage too", () => {
    const parsed = parseGoHighLevelAutomationV2(
      call({ pipleline_stage: undefined, pipeline_stage: "Fechado" }),
      receivedAt,
      purchase,
    );
    expect(parsed.ok && parsed.value.pipelineStage).toBe("Fechado");
  });

  it("dedupes by opportunity + pipeline + stage", () => {
    const key = (overrides: Record<string, unknown>, event = "Purchase") => {
      const parsed = parseGoHighLevelAutomationV2(call(overrides), receivedAt, {
        eventName: event,
      });
      return parsed.ok ? parsed.value.externalExecutionKey : parsed.errorCode;
    };
    const same = key({});
    // A resend (even later, other contact fields) is the same conversion.
    expect(key({ first_name: "Outra" })).toBe(same);
    expect(
      parseGoHighLevelAutomationV2(
        call(),
        new Date("2026-11-21T12:00:00.000Z"),
        purchase,
      ),
    ).toMatchObject({ value: { externalExecutionKey: same } });
    // Another stage, another opportunity or another pipeline: new conversion.
    expect(key({ pipleline_stage: "Fechado" })).not.toBe(same);
    expect(key({ id: "OPPORTUNITY_ID_FICTICIO_2" })).not.toBe(same);
    expect(key({ pipeline_id: "PIPELINE_ID_FICTICIO_2" })).not.toBe(same);
  });

  it("keeps the v1 key for lifetime events and for calls without an opportunity", () => {
    const v1 = (event: string, overrides: Record<string, unknown> = {}) => {
      const parsed = parseGoHighLevelAutomationV2(call(overrides), receivedAt, {
        eventName: event,
      });
      return parsed.ok ? parsed.value.externalExecutionKey : parsed.errorCode;
    };
    // Lifetime events: another stage is still the same key (once per lead).
    expect(v1("QualifiedLead")).toBe(
      v1("QualifiedLead", { pipleline_stage: "Fechado" }),
    );
    expect(v1("LeadSubmitted")).toBe(
      v1("LeadSubmitted", { id: "OPPORTUNITY_ID_FICTICIO_2" }),
    );
    // Without an opportunity id/stage the key is exactly the v1 one
    // (location + workflow + contact), never the opportunity one.
    const noOpportunity = v1("QualifiedLead", {
      id: undefined,
      pipleline_stage: undefined,
    });
    expect(noOpportunity).toBe(v1("QualifiedLead"));
    const purchaseNoOpportunity = v1("Purchase", {
      id: undefined,
      pipleline_stage: undefined,
    });
    expect(purchaseNoOpportunity).toBe(v1("QualifiedLead"));
    expect(purchaseNoOpportunity).not.toBe(v1("Purchase"));
  });

  it("filters by pipeline_id first, then the stage name (case/edge spaces ignored)", () => {
    const rule = {
      ...purchase,
      ghlPipelineId: "PIPELINE_ID_FICTICIO",
      ghlStageName: "proposta ENVIADA ",
    };
    expect(parseGoHighLevelAutomationV2(envelope, receivedAt, rule).ok).toBe(
      true,
    );
    expect(
      parseGoHighLevelAutomationV2(call({ pipleline_stage: "Fechado" }), receivedAt, rule),
    ).toEqual({ ok: false, errorCode: GOHIGHLEVEL_PIPELINE_STAGE_NOT_IN_RULE });
    // Same stage name in ANOTHER pipeline never matches.
    expect(
      parseGoHighLevelAutomationV2(call({ pipeline_id: "OUTRO" }), receivedAt, rule),
    ).toEqual({ ok: false, errorCode: GOHIGHLEVEL_PIPELINE_STAGE_NOT_IN_RULE });
    // No filter: every stage.
    expect(
      parseGoHighLevelAutomationV2(call({ pipleline_stage: "Qualquer" }), receivedAt, purchase).ok,
    ).toBe(true);
  });

  it("uses lead_value, falls back to the rule's fixed value, else refuses", () => {
    const missing = call({ lead_value: undefined });
    expect(
      parseGoHighLevelAutomationV2(missing, receivedAt, {
        ...purchase,
        defaultValueCents: 9900,
      }),
    ).toMatchObject({ ok: true, value: { valueCents: null } });
    expect(
      parseGoHighLevelAutomationV2(missing, receivedAt, purchase),
    ).toEqual({ ok: false, errorCode: GOHIGHLEVEL_VALUE_MISSING });
    expect(
      parseGoHighLevelAutomationV2(call({ lead_value: 0 }), receivedAt, purchase),
    ).toEqual({ ok: false, errorCode: GOHIGHLEVEL_VALUE_MISSING });
    expect(
      parseGoHighLevelAutomationV2(call({ lead_value: "abc" }), receivedAt, purchase),
    ).toEqual({ ok: false, errorCode: GOHIGHLEVEL_VALUE_INVALID });
    // A valid lead_value always wins over the fixed value.
    expect(
      parseGoHighLevelAutomationV2(envelope, receivedAt, {
        ...purchase,
        defaultValueCents: 9900,
      }),
    ).toMatchObject({ value: { valueCents: 150050 } });
  });

  it("does not require value for an event without value, and accepts every event", () => {
    expect(
      parseGoHighLevelAutomationV2(call({ lead_value: undefined }), receivedAt, {
        eventName: "QualifiedLead",
      }).ok,
    ).toBe(true);
    for (const eventName of ["ViewContent", "AddToCart", "InitiateCheckout", "OrderCreated"]) {
      expect(
        parseGoHighLevelAutomationV2(envelope, receivedAt, { eventName }).ok,
      ).toBe(true);
    }
  });

  it("flags a call without ctwa_clid in either source (ignored without a mark downstream)", () => {
    const noClick = call({
      contact: { attributionSource: {}, lastAttributionSource: { adId: "X" } },
    });
    const parsed = parseGoHighLevelAutomationV2(noClick, receivedAt, {
      ...purchase,
      ghlPipelineId: "OUTRA",
      ghlStageName: "Outra",
    });
    // Neither the stage filter nor the value judge a call without a click.
    expect(parsed).toMatchObject({ ok: true, value: { hasCtwa: false } });
  });
});
