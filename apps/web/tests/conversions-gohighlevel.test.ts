import {
  providerConversionRuleIdempotentCreateInputSchema,
  type ProviderConversionRuleCapabilitiesDto,
} from "@wpptrack/shared";
import { describe, expect, it } from "vitest";
import {
  automationPlatformIn,
  hubProviderForInbound,
  providerDisplayName,
  ruleOriginDefinition,
} from "../src/app/(app)/conversions/conversion-origins";
import {
  offeredRuleOrigins,
  type ConversionConnection,
  type ConversionNumber,
} from "../src/app/(app)/conversions/conversion-rules-view";
import { singleUrlProviderFor } from "../src/app/(app)/conversions/new-rule-flow";
import {
  automationPlatformName,
  buildRulePayload,
  emptyRuleDraft,
  type RuleDraft,
} from "../src/app/(app)/conversions/rule-draft";
import { ruleManageTabs } from "../src/app/(app)/conversions/rule-manage";
import { executionReasonLabel } from "../src/app/(app)/settings/provider-conversion-labels";
import { integrationProvider } from "../src/app/(app)/integrations/hub/integration-registry";
import { inboundWebhookProviderLabel } from "../src/app/(app)/integrations/inbound-webhook-panel";
import {
  goHighLevelWebhookInstruction,
  singleUrlSetupSteps,
  supportedEvents,
} from "../src/app/(app)/integrations/single-url/single-url-copy";
import {
  capabilitiesWithPayt,
  connections as baseConnections,
  numbers as baseNumbers,
} from "./conversions-fixtures";

/**
 * GoHighLevel (porte do SaaS e279af76, adaptado): "Etapa no GoHighLevel"
 * (Workflow → ação Webhook), uma URL por regra, mesmo modelo da automação do
 * Unnichat. Dados fictícios.
 */

const ghlConnection: ConversionConnection = {
  id: "conn_ghl_a",
  provider: "gohighlevel",
  displayName: "Clínica Exemplo A",
  status: "observation",
};
const ghlNumber: ConversionNumber = {
  id: "ch_ghl_a",
  connectionId: "conn_ghl_a",
  provider: "gohighlevel",
  connectionName: "Clínica Exemplo A",
  label: "Clínica Exemplo A",
  phone: "+5511900000000",
  whatsappInstanceId: null,
  routeIds: [],
  status: "active",
};

const capabilities: ProviderConversionRuleCapabilitiesDto = {
  ...capabilitiesWithPayt,
  origins: [
    ...capabilitiesWithPayt.origins,
    {
      origin: "automation_gohighlevel",
      scopes: ["all_numbers", "specific_numbers"],
      channelProviders: ["gohighlevel"],
      authorChannelProviders: null,
      connectionBound: true,
      requiresConnection: true,
      labelMatch: null,
      unifiable: false,
    },
  ],
};

const crm = { kommo: false, pipedrive: false };

describe("Nova regra: origem “Etapa no GoHighLevel”", () => {
  it("só aparece com uma conexão GoHighLevel ativa", () => {
    const offered = (connections: ConversionConnection[]) =>
      offeredRuleOrigins({
        numbers: [...baseNumbers, ghlNumber],
        connections,
        capabilities,
        crm,
      } as never);
    expect(offered([...baseConnections, ghlConnection])).toContain(
      "automation_gohighlevel",
    );
    expect(offered([...baseConnections])).not.toContain("automation_gohighlevel");
    expect(
      offered([{ ...ghlConnection, status: "paused" }]),
    ).not.toContain("automation_gohighlevel");
  });

  it("descreve a origem e limita os eventos a Lead, lead qualificado e compra", () => {
    const definition = ruleOriginDefinition("automation_gohighlevel");
    expect(definition).toMatchObject({
      label: "Etapa no GoHighLevel",
      logoProvider: "gohighlevel",
      connection: "provider_anchor",
    });
    expect([...(definition.allowedEvents ?? [])].sort()).toEqual([
      "LeadSubmitted",
      "Purchase",
      "QualifiedLead",
    ]);
    expect(emptyRuleDraft("automation_gohighlevel")).toMatchObject({
      eventName: "QualifiedLead",
      scope: "all_numbers",
      crossConnection: true,
    });
    expect(automationPlatformName("automation_gohighlevel")).toBe("GoHighLevel");
    expect(automationPlatformIn("automation_gohighlevel")).toBe("no GoHighLevel");
    expect(hubProviderForInbound("gohighlevel")).toBe("gohighlevel");
    expect(providerDisplayName("gohighlevel")).toBe("GoHighLevel");
    expect(singleUrlProviderFor("automation_gohighlevel")).toBe("gohighlevel");
    expect(supportedEvents("gohighlevel")).toEqual([
      "LeadSubmitted",
      "QualifiedLead",
      "Purchase",
    ]);
  });

  it("monta a regra como a do Unnichat: todas as localizações e valor fixo opcional", () => {
    const draft: RuleDraft = {
      ...emptyRuleDraft("automation_gohighlevel"),
      name: "Compra no GHL",
      eventName: "Purchase",
      averageValue: "250,00",
      currency: "BRL",
      connectionId: "conn_ghl_a",
    };
    const built = buildRulePayload(draft, {
      numbers: [ghlNumber],
      connections: [ghlConnection],
      capabilities,
      singleUrl: true,
    });
    expect(built).toMatchObject({
      ok: true,
      value: {
        name: "Compra no GHL",
        connectionId: "conn_ghl_a",
        scope: "all_numbers",
        channelIds: [],
        triggerType: "provider_automation",
        eventName: "Purchase",
        defaultValueCents: 25000,
        crossConnectionScope: true,
        perRuleUrl: false,
      },
    });
    expect(
      providerConversionRuleIdempotentCreateInputSchema.safeParse(
        (built as { value: unknown }).value,
      ).success,
    ).toBe(true);
  });
});

describe("Regra do GoHighLevel: URL e instrução do Workflow", () => {
  it("oferece Endereço e configuração e Eventos recebidos", () => {
    expect(
      ruleManageTabs("automation_gohighlevel", { catalog: null }).map((tab) => tab.id),
    ).toEqual(["edit", "endpoint", "received"]);
  });

  it("explica a configuração com as palavras do GoHighLevel", () => {
    expect(goHighLevelWebhookInstruction).toBe(
      "No Workflow do GoHighLevel, adicione a ação Webhook (POST) com esta URL",
    );
    const steps = singleUrlSetupSteps("gohighlevel", "Purchase").join(" ");
    expect(steps).toContain(goHighLevelWebhookInstruction);
    expect(steps).toContain("location.id");
    expect(steps).toContain("mesmo Workflow conta uma vez só");
    expect(steps).toContain("orgânico nunca é enviado");
  });

  it("traduz os motivos do GoHighLevel", () => {
    expect(executionReasonLabel("inbound_webhook_gohighlevel_channel_binding_missing")).toContain(
      "ID da localização",
    );
    expect(executionReasonLabel("gohighlevel_automation_v1_invalid_payload")).toBe(
      "Formato do Webhook do GoHighLevel não reconhecido",
    );
  });
});

describe("Hub: card do GoHighLevel", () => {
  it("diz que também envia conversões das etapas do Workflow", () => {
    expect(integrationProvider("gohighlevel").description).toContain(
      "envie conversões das etapas do Workflow",
    );
    expect(integrationProvider("gohighlevel").logo).toBe(
      "/integrations/gohighlevel.svg",
    );
    expect(inboundWebhookProviderLabel("gohighlevel")).toBe("GoHighLevel");
  });
});
