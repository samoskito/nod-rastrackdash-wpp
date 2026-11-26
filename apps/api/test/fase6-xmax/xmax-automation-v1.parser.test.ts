import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  XMAX_OPPORTUNITY_KEY_PREFIX,
  parseXmaxForRule,
} from "../../src/inbound-webhooks/providers/xmax/xmax-automation-v1.parser";
import { parseWebhookFamilyForRule } from "../../src/inbound-webhooks/providers/webhook/webhook-family";

/**
 * XMAX CRM: leitor da etapa da oportunidade (porte do SaaS
 * xmax-opportunity.parser.ts, corpos fictícios no formato dos corpos reais
 * vistos no SaaS). O evento vem da regra; a etapa nunca decide nada.
 */
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(resolve(__dirname, "../fixtures/xmax", name), "utf8"),
  ) as any;
const opportunity = () => fixture("opportunity.synthetic.json");
const receivedAt = new Date("2026-11-26T12:00:00.000Z");
const qualified = {
  eventName: "QualifiedLead",
  defaultValueCents: null,
  defaultItems: { webhookValueSource: "fixed" },
};
const purchase = (cents: number | null) => ({
  eventName: "Purchase",
  defaultValueCents: cents,
  defaultItems: { webhookValueSource: "fixed" },
});

describe("XMAX CRM opportunity reader", () => {
  it("reads the opportunity phone, takes the event from the rule and never reads the e-mail", () => {
    const parsed = parseXmaxForRule(opportunity(), receivedAt, qualified);
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        provider: "xmax",
        automation: "crm_automation",
        eventName: "QualifiedLead",
        phone: "5511900000002",
        phoneNumberId: null,
        hasMessageId: true,
        valueCents: null,
        currency: null,
        fingerprint: null,
        xmax: {
          opportunityId: "90001",
          stage: "3 Negociação",
          contactLinked: false,
        },
      },
    });
    expect(JSON.stringify(parsed)).not.toContain("@");
  });

  it("without the opportunity phone, uses the first contact of Contatos_oportunidade (JSON text), unwrapped from an n8n capture", () => {
    const parsed = parseXmaxForRule(
      fixture("opportunity-contact.synthetic.json"),
      receivedAt,
      purchase(150000),
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        phone: "5511900000003",
        eventName: "Purchase",
        xmax: { opportunityId: "90002", contactLinked: true },
      },
    });
    expect(JSON.stringify(parsed)).not.toContain("@");
  });

  it("accepts the contact list as a real array too", () => {
    const parsed = parseXmaxForRule(
      {
        ...opportunity(),
        Telefone_oportunidade: "",
        Contatos_oportunidade: [{ contact_id: 1, contact_number: "5511900000004" }],
      },
      receivedAt,
      qualified,
    );
    expect(parsed).toMatchObject({ ok: true, value: { phone: "5511900000004" } });
  });

  it("the key is the opportunity + the rule's event: never the stage, the queue or the time", () => {
    const first = parseXmaxForRule(opportunity(), receivedAt, qualified);
    const otherStage = parseXmaxForRule(
      { ...opportunity(), Etapa_oportunidade: "4 Proposta", Queue_id_v2: "99" },
      new Date("2026-11-27T12:00:00.000Z"),
      qualified,
    );
    const otherEvent = parseXmaxForRule(opportunity(), receivedAt, purchase(1000));
    const otherOpportunity = parseXmaxForRule(
      { ...opportunity(), ID_oportunidade: 90009 },
      receivedAt,
      qualified,
    );
    if (!first.ok || !otherStage.ok || !otherEvent.ok || !otherOpportunity.ok) {
      throw new Error("fixture");
    }
    expect(first.value.externalExecutionKey).toMatch(
      new RegExp(`^${XMAX_OPPORTUNITY_KEY_PREFIX}[0-9a-f]{64}$`, "u"),
    );
    expect(otherStage.value.externalExecutionKey).toBe(
      first.value.externalExecutionKey,
    );
    expect(otherEvent.value.externalExecutionKey).not.toBe(
      first.value.externalExecutionKey,
    );
    expect(otherOpportunity.value.externalExecutionKey).not.toBe(
      first.value.externalExecutionKey,
    );
    // No phone (PII) in the key.
    expect(first.value.externalExecutionKey).not.toContain("5511900000002");
  });

  it.each([
    ["missing_opportunity_id", { ID_oportunidade: "" }, "xmax_missing_opportunity_id"],
    [
      "missing_phone",
      { Telefone_oportunidade: "", Contatos_oportunidade: "[]" },
      "xmax_missing_phone",
    ],
    [
      "missing_phone (broken contacts JSON)",
      { Telefone_oportunidade: "", Contatos_oportunidade: "[{" },
      "xmax_missing_phone",
    ],
  ])("%s is refused with its own reason", (_label, overrides, errorCode) => {
    expect(
      parseXmaxForRule({ ...opportunity(), ...overrides }, receivedAt, qualified),
    ).toEqual({ ok: false, errorCode });
  });

  it.each([
    ["not an object", "texto"],
    ["a list of two", [{}, {}]],
    ["a body without ID_oportunidade", { phone: "5511900000002" }],
  ])("an invalid payload (%s) is refused", (_label, payload) => {
    expect(parseXmaxForRule(payload, receivedAt, qualified)).toEqual({
      ok: false,
      errorCode: "xmax_automation_v1_invalid_payload",
    });
  });

  it("a purchase needs the rule's fixed value (the XMAX sends no value)", () => {
    expect(parseXmaxForRule(opportunity(), receivedAt, purchase(null))).toEqual({
      ok: false,
      errorCode: "xmax_value_missing",
    });
    expect(parseXmaxForRule(opportunity(), receivedAt, purchase(99000))).toMatchObject({
      ok: true,
      value: { valueCents: null, eventName: "Purchase" },
    });
  });

  it("the family dispatcher picks the XMAX reader for an XMAX rule", () => {
    expect(
      parseWebhookFamilyForRule("xmax", opportunity(), receivedAt, qualified),
    ).toMatchObject({ ok: true, value: { provider: "xmax" } });
    // The Webhook / n8n reader does not know the XMAX body.
    expect(
      parseWebhookFamilyForRule("webhook", opportunity(), receivedAt, {
        ...qualified,
        defaultItems: null,
      }),
    ).toMatchObject({ ok: false });
  });
});
