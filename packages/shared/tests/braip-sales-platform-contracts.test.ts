import { describe, expect, it } from "vitest";
import {
  backofficeIntegrationEventQuerySchema,
  backofficeParserReleaseListSchema,
  diagnosticSourceSchema,
  inboundWebhookProviderSchema,
  integrationEndpointCreateInputSchema,
  integrationEndpointEventStatusSchema,
  integrationEndpointKindFor,
  integrationEndpointSupportedEvents,
  integrationEventPayloadSchema,
  integrationReceiptReasonLabel,
  isSalesPlatformProvider,
  providerConversionRuleCreateInputSchema,
  providerConversionRuleOriginSchema,
  salesPlatformLabels,
} from "../src";

/** Fase 6.5 — contracts of the Braip sales platform (single URL). */

describe("Braip sales-platform contracts", () => {
  it("is a sales platform of the single URL, like Payt", () => {
    expect(isSalesPlatformProvider("braip")).toBe(true);
    expect(isSalesPlatformProvider("unnichat")).toBe(false);
    expect(salesPlatformLabels.braip).toBe("Braip");
    expect(integrationEndpointKindFor("braip")).toBe("sales_platform");
    expect(integrationEndpointSupportedEvents("braip")).toEqual([
      "Purchase",
      "InitiateCheckout",
      "CartAbandoned",
    ]);
    expect(inboundWebhookProviderSchema.parse("braip")).toBe("braip");
    expect(diagnosticSourceSchema.parse("braip")).toBe("braip");
    expect(providerConversionRuleOriginSchema.parse("automation_braip")).toBe(
      "automation_braip",
    );
  });

  it("creates the Braip URL without an event and a sale rule of a sale event only", () => {
    expect(integrationEndpointCreateInputSchema.safeParse({ provider: "braip" }).success).toBe(true);
    expect(
      integrationEndpointCreateInputSchema.safeParse({ provider: "braip", eventName: "Purchase" }).success,
    ).toBe(false);
    const rule = {
      name: "Braip",
      triggerType: "provider_automation",
      automationSource: "braip",
      eventName: "Purchase",
      scope: "all_numbers",
      connectionId: "conn_1",
      productFilterCodes: ["pro1abc"],
    };
    expect(providerConversionRuleCreateInputSchema.parse(rule)).toMatchObject({
      automationSource: "braip",
      productFilterCodes: ["PRO1ABC"],
    });
    const wrong = providerConversionRuleCreateInputSchema.safeParse({
      ...rule,
      eventName: "QualifiedLead",
    });
    expect(wrong.success).toBe(false);
    expect(JSON.stringify(wrong.error)).toContain("A Braip envia compra aprovada");
  });

  it("knows the refused receipts and reads their reasons in plain Portuguese", () => {
    expect(integrationEndpointEventStatusSchema.parse("rejected")).toBe("rejected");
    expect(integrationReceiptReasonLabel("token_invalid")).toBe("Token da URL não confere");
    expect(integrationReceiptReasonLabel("braip_purchase_identity_missing")).toBe(
      "Sem identificação do pedido (ex.: trans_key)",
    );
    expect(backofficeIntegrationEventQuerySchema.parse({}).limit).toBe(50);
    expect(backofficeIntegrationEventQuerySchema.safeParse({ limit: 1000 }).success).toBe(false);
    expect(backofficeIntegrationEventQuerySchema.parse({ status: "duplicate" }).status).toBe("duplicate");
  });

  it("carries no certification field in the read-only views", () => {
    const shape = integrationEventPayloadSchema.shape as Record<string, unknown>;
    expect(shape).not.toHaveProperty("certification");
    expect(
      backofficeParserReleaseListSchema.safeParse({ releases: [] }).success,
    ).toBe(true);
  });
});
