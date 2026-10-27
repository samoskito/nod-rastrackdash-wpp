import { describe, expect, it } from "vitest";
import {
  diagnosticSourceSchema,
  inboundWebhookProviderSchema,
  integrationEndpointCreateInputSchema,
  integrationEndpointKindFor,
  integrationEndpointListSchema,
  integrationEndpointProviderSchema,
  integrationEndpointSupportedEvents,
  integrationReceiptReasonLabel,
  isSalesPlatformProvider,
  providerConversionAutomationSourceSchema,
  providerConversionRuleCreateInputSchema,
  providerConversionRuleOriginSchema,
  salesPlatformLabels,
} from "../src";

/**
 * Fase 6.7 — contracts of the Yampi sales platform (single URL), ported from
 * the SaaS #186. In the student edition the Yampi is open to every workspace:
 * no "yampiEnabled" flag on the endpoints list, no private-integration key.
 */

describe("Yampi sales-platform contracts", () => {
  it("is a sales platform of the single URL, like Payt and Braip", () => {
    expect(isSalesPlatformProvider("yampi")).toBe(true);
    expect(salesPlatformLabels.yampi).toBe("Yampi");
    expect(integrationEndpointProviderSchema.parse("yampi")).toBe("yampi");
    expect(integrationEndpointKindFor("yampi")).toBe("sales_platform");
    expect(integrationEndpointSupportedEvents("yampi")).toEqual([
      "Purchase",
      "InitiateCheckout",
      "CartAbandoned",
    ]);
    expect(inboundWebhookProviderSchema.parse("yampi")).toBe("yampi");
    expect(diagnosticSourceSchema.parse("yampi")).toBe("yampi");
    expect(providerConversionAutomationSourceSchema.parse("yampi")).toBe("yampi");
    expect(providerConversionRuleOriginSchema.parse("automation_yampi")).toBe(
      "automation_yampi",
    );
  });

  it("creates the Yampi URL without an event and a sale rule of a sale event only", () => {
    expect(integrationEndpointCreateInputSchema.safeParse({ provider: "yampi" }).success).toBe(true);
    expect(
      integrationEndpointCreateInputSchema.safeParse({ provider: "yampi", eventName: "Purchase" }).success,
    ).toBe(false);
    const rule = {
      name: "Yampi",
      triggerType: "provider_automation",
      automationSource: "yampi",
      eventName: "Purchase",
      scope: "all_numbers",
      connectionId: "conn_1",
      productFilterCodes: ["sku-fict-01"],
      perRuleUrl: false,
    };
    expect(providerConversionRuleCreateInputSchema.parse(rule)).toMatchObject({
      automationSource: "yampi",
      productFilterCodes: ["SKU-FICT-01"],
    });
    const wrong = providerConversionRuleCreateInputSchema.safeParse({
      ...rule,
      eventName: "QualifiedLead",
    });
    expect(wrong.success).toBe(false);
    expect(JSON.stringify(wrong.error)).toContain("A Yampi envia");
  });

  it("reads the Yampi receipt reasons in plain Portuguese", () => {
    expect(integrationReceiptReasonLabel("yampi_purchase_identity_missing")).toMatch(
      /Sem identificação do pedido/u,
    );
    expect(integrationReceiptReasonLabel("yampi_sale_v1_status_not_supported")).toBe(
      integrationReceiptReasonLabel("status_not_supported"),
    );
    expect(integrationReceiptReasonLabel("yampi_automation_v1_invalid_payload")).toMatch(
      /Formato não reconhecido/u,
    );
  });

  it("has no SaaS private-integration flag on the endpoints list", () => {
    const shape = integrationEndpointListSchema.shape as Record<string, unknown>;
    expect(shape).not.toHaveProperty("yampiEnabled");
    expect(shape).not.toHaveProperty("brinkParkEnabled");
  });
});
