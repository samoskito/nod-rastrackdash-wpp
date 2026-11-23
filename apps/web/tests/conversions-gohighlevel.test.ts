import {
  conversionEventNameSchema,
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

  it("descreve a origem e oferece todo evento do pixel de mensagem", () => {
    const definition = ruleOriginDefinition("automation_gohighlevel");
    expect(definition).toMatchObject({
      label: "Etapa no GoHighLevel",
      logoProvider: "gohighlevel",
      connection: "provider_anchor",
    });
    expect([...(definition.allowedEvents ?? [])].sort()).toEqual(
      [...conversionEventNameSchema.options].sort(),
    );
    expect(definition.allowedEvents?.slice(0, 3)).toEqual([
      "QualifiedLead",
      "Purchase",
      "LeadSubmitted",
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
    expect([...supportedEvents("gohighlevel")].sort()).toEqual(
      [...conversionEventNameSchema.options].sort(),
    );
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

  it("com pipeline e etapa: valor do lead_value com reserva opcional, qualquer evento e o filtro (porte do SaaS #277)", () => {
    const draft: RuleDraft = {
      ...emptyRuleDraft("automation_gohighlevel"),
      name: "Compra no GHL",
      eventName: "Purchase",
      averageValue: "250,00",
      currency: "BRL",
      connectionId: "conn_ghl_a",
      ghlStage: {
        pipelineId: "PIPELINE_ID_FICTICIO",
        pipelineName: "Funil Exemplo",
        stageId: "STAGE_ID_2",
        stageName: "Proposta enviada",
      },
    };
    const context = {
      numbers: [ghlNumber],
      connections: [ghlConnection],
      capabilities,
      singleUrl: true,
    };
    const built = buildRulePayload(draft, context);
    expect(built).toMatchObject({
      ok: true,
      value: {
        eventName: "Purchase",
        defaultValueCents: 25000,
        ghlOpportunityValue: true,
        ghlStage: { pipelineId: "PIPELINE_ID_FICTICIO", stageName: "Proposta enviada" },
      },
    });
    expect(
      providerConversionRuleIdempotentCreateInputSchema.safeParse(
        (built as { value: unknown }).value,
      ).success,
    ).toBe(true);
    // Com etapa o valor é opcional (vem da oportunidade).
    expect(buildRulePayload({ ...draft, averageValue: "" }, context)).toMatchObject({
      ok: true,
      value: { ghlOpportunityValue: true },
    });
    // Com etapa vale todo evento do catálogo.
    expect(buildRulePayload({ ...draft, eventName: "AddToCart" }, context)).toMatchObject({ ok: true });
    // Sem etapa a regra fica no leitor anterior: valor fixo obrigatório, sem
    // campos de oportunidade e só Lead / Lead qualificado / Compra.
    const previous = buildRulePayload({ ...draft, ghlStage: null }, context);
    expect(previous).toMatchObject({ ok: true, value: { defaultValueCents: 25000 } });
    expect(previous.ok && "ghlStage" in previous.value).toBe(false);
    expect(previous.ok && "ghlOpportunityValue" in previous.value).toBe(false);
    expect(buildRulePayload({ ...draft, ghlStage: null, averageValue: "" }, context)).toMatchObject({ ok: false });
    expect(buildRulePayload({ ...draft, ghlStage: null, eventName: "AddToCart" }, context)).toMatchObject({ ok: false });
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

describe("GoHighLevel: remover o token (revisão do #145)", () => {
  it("diz que o filtro de etapa salvo continua valendo", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "../src/app/(app)/integrations/inbound-webhook-actions.ts"),
      "utf8",
    );
    expect(source).toContain(
      "O filtro de etapa continua valendo pelo nome salvo; sem token, a lista de etapas não é atualizada.",
    );
    expect(source).not.toContain("valem para todas as etapas");
  });
});

describe("GoHighLevel: editar a regra pela etapa (revisão do SaaS)", () => {
  it("não deixa apagar a etapa de uma regra que lê a oportunidade", async () => {
    const { providerRule, numbers, connections, capabilities } = await import("./conversions-fixtures");
    const { buildRuleUpdatePayload, ruleEditDraft } = await import(
      "../src/app/(app)/conversions/rule-edit"
    );
    const stage = {
      pipelineId: "PIPELINE_A",
      pipelineName: "Funil Exemplo",
      stageId: "STAGE_1",
      stageName: "Ganho",
    };
    const rule = {
      ...providerRule({
        id: "rule_ghl_stage",
        triggerType: "provider_automation",
        origin: "automation_gohighlevel",
        eventName: "Purchase",
        connectionId: "conn_ghl",
        scope: "all_numbers",
      }),
      ghlOpportunityReader: true,
      ghlStage: stage,
    };
    const draft = ruleEditDraft(rule, "automation_gohighlevel");
    expect(draft.ghlStage).toEqual(stage);
    const result = buildRuleUpdatePayload(
      rule,
      { ...draft, ghlStage: null },
      { numbers, connections, capabilities },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toMatch(/precisa de um pipeline e uma etapa/u);
  });
});
