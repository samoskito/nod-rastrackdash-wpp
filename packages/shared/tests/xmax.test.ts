import { describe, expect, it } from "vitest";
import {
  conversionEventCarriesValue,
  conversionEventNameSchema,
  inboundWebhookProviders,
  integrationReceiptReasons,
  isWebhookFamilyProvider,
  isXmaxProvider,
  providerConversionRuleCreateInputSchema,
  providerConversionRuleOrigins,
  xmaxEventNames,
} from "../src";

const base = {
  name: "XMAX: Lead qualificado",
  scope: "all_numbers" as const,
  channelIds: [],
  mode: "observation" as const,
  triggerType: "provider_automation" as const,
  automationSource: "xmax" as const,
  eventName: "QualifiedLead" as const,
};
const parse = (input: object) =>
  providerConversionRuleCreateInputSchema.safeParse(input).success;

describe("XMAX CRM rule contract", () => {
  it("is a provider, an origin and part of the Webhook / n8n family", () => {
    expect(parse(base)).toBe(true);
    expect(isXmaxProvider("xmax")).toBe(true);
    expect(isWebhookFamilyProvider("xmax")).toBe(true);
    expect(isWebhookFamilyProvider("webhook")).toBe(true);
    expect(isWebhookFamilyProvider("gohighlevel")).toBe(false);
    expect(providerConversionRuleOrigins).toContain("automation_xmax");
    expect(inboundWebhookProviders).toContain("xmax");
  });

  it("offers every event of the messaging pixel", () => {
    expect([...xmaxEventNames]).toEqual(conversionEventNameSchema.options);
    for (const eventName of conversionEventNameSchema.options) {
      expect(
        parse({
          ...base,
          eventName,
          ...(conversionEventCarriesValue(eventName)
            ? { defaultValueCents: 150000 }
            : {}),
        }),
      ).toBe(true);
    }
  });

  it("value: always the rule's fixed value (required for a purchase)", () => {
    const purchase = { ...base, eventName: "Purchase" as const };
    expect(parse(purchase)).toBe(false);
    expect(parse({ ...purchase, defaultValueCents: 150000 })).toBe(true);
    expect(
      parse({ ...purchase, defaultValueCents: 150000, webhookValueSource: "fixed" }),
    ).toBe(true);
    expect(
      parse({
        ...purchase,
        defaultValueCents: 150000,
        webhookValueSource: "received",
      }),
    ).toBe(false);
  });

  it("every number, own URL, no phrases or labels", () => {
    expect(parse({ ...base, scope: "specific_numbers", channelIds: ["c1"] })).toBe(
      false,
    );
    expect(parse({ ...base, perRuleUrl: false })).toBe(false);
    expect(parse({ ...base, triggerPhrases: ["fechou"] })).toBe(false);
  });

  it("the discard reasons have plain Portuguese labels", () => {
    expect(integrationReceiptReasons).toMatchObject({
      xmax_missing_phone: expect.any(String),
      xmax_missing_opportunity_id: expect.any(String),
      xmax_automation_v1_invalid_payload: expect.any(String),
      xmax_value_missing: expect.any(String),
    });
  });
});
