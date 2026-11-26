// @vitest-environment jsdom

import type {
  ProviderConversionAutomationAuditDto,
  ProviderConversionRuleCapabilitiesDto,
  ProviderConversionRuleDto,
} from "@wpptrack/shared";
import { xmaxEventNames } from "@wpptrack/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ineligibleNumbers,
  offeredRuleOrigins,
  providerRuleOrigin,
  triggerDetailForProviderRule,
} from "../src/app/(app)/conversions/conversion-rules-view";
import {
  buildRulePayload,
  emptyRuleDraft,
} from "../src/app/(app)/conversions/rule-draft";
import {
  ruleEditCapabilities,
} from "../src/app/(app)/conversions/rule-edit";
import { ruleManageTabs } from "../src/app/(app)/conversions/rule-manage";
import { RuleEndpoint } from "../src/app/(app)/conversions/rule-endpoint";
import { NewRuleFlow } from "../src/app/(app)/conversions/new-rule-flow";
import { ReceivedEvents } from "../src/app/(app)/conversions/received-events";
import { ruleOriginDefinition } from "../src/app/(app)/conversions/conversion-origins";
import { XmaxPayloadExample } from "../src/app/(app)/conversions/xmax-payload-example";
import { setupUser } from "./user-shim";
import {
  firstFreeWebhookEvent,
  isWebhookApiMessage,
  webhookRuleForEvent,
  webhookRulesOf,
  xmaxBodyExample,
  xmaxMinimalBodyExample,
  isObservationOnlyOrigin,
  isObservationOnlyProvider,
  observationOnlyCreatedMessage,
} from "../src/app/(app)/conversions/webhook-view";
import { executionReasonLabel } from "../src/app/(app)/settings/provider-conversion-labels";
import {
  capabilities,
  connections,
  numbers,
  providerRule,
} from "./conversions-fixtures";

/**
 * XMAX CRM na tela Conversões: mesmo modelo do Webhook / n8n (uma URL por
 * regra e evento, todos os números, a API escolhe a âncora), mas o valor é
 * sempre o fixo da regra e a regra nasce em observação, visível em Eventos
 * recebidos com a marca "Em observação". Dados fictícios.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
});

const whatsappProviders = [
  "umbler",
  "gupshup",
  "uazapi",
  "meta_cloud",
  "data_crazy",
  "unnichat",
  "waha",
  "roichat",
  "gohighlevel",
];

/** Mesma entrada que a API publica em GET providers/capabilities. */
const capabilitiesWithXmax: ProviderConversionRuleCapabilitiesDto = {
  ...capabilities,
  origins: [
    ...capabilities.origins,
    {
      origin: "automation_xmax",
      scopes: ["all_numbers"],
      channelProviders: whatsappProviders,
      authorChannelProviders: null,
      connectionBound: false,
      labelMatch: null,
      unifiable: false,
      eventNames: [...xmaxEventNames],
    },
  ],
};

function familyRule(input: {
  id: string;
  source: "webhook" | "xmax";
  eventName: ProviderConversionRuleDto["conversionRule"]["eventName"];
  valueCents?: number | null;
}): ProviderConversionRuleDto {
  const rule = providerRule({
    id: input.id,
    triggerType: "provider_automation",
    origin: input.source === "xmax" ? "automation_xmax" : "automation_webhook",
    eventName: input.eventName,
    connectionId: "conn_qr_a",
    scope: "all_numbers",
    phrases: [],
  });
  return {
    ...rule,
    mode: "observation",
    automationSource: input.source,
    webhookValueSource: input.source === "xmax" ? "fixed" : "received",
    conversionRule: {
      ...rule.conversionRule,
      defaultValueCents: input.valueCents ?? null,
      defaultCurrency: null,
    },
  };
}

const xmaxQualified = familyRule({
  id: "xmax_qualified",
  source: "xmax",
  eventName: "QualifiedLead",
});
const xmaxPurchase = familyRule({
  id: "xmax_purchase",
  source: "xmax",
  eventName: "Purchase",
  valueCents: 99000,
});
const n8nPurchase = familyRule({
  id: "wh_purchase",
  source: "webhook",
  eventName: "Purchase",
});
const context = {
  numbers,
  connections,
  capabilities: capabilitiesWithXmax,
  webhookRules: [xmaxQualified, n8nPurchase],
};

describe("XMAX CRM in Conversões", () => {
  const crm = { kommo: false, pipedrive: false };

  it("is offered with any WhatsApp connection of the student (API says so)", () => {
    expect(
      offeredRuleOrigins({
        numbers,
        connections,
        capabilities: capabilitiesWithXmax,
        crm,
      }),
    ).toContain("automation_xmax");
    expect(
      offeredRuleOrigins({ numbers, connections, capabilities, crm }),
    ).not.toContain("automation_xmax");
    expect(ruleOriginDefinition("automation_xmax")).toMatchObject({
      label: "Etapa no CRM da XMAX",
      // The rule cards use the XMAX logo of the Integrations hub.
      logoProvider: "xmax",
    });
    // Lead qualificado, then Compra, then every other event of the pixel.
    expect(ruleOriginDefinition("automation_xmax").allowedEvents?.slice(0, 2)).toEqual([
      "QualifiedLead",
      "Purchase",
    ]);
    expect(
      [...(ruleOriginDefinition("automation_xmax").allowedEvents ?? [])].sort(),
    ).toEqual([...xmaxEventNames].sort());
  });

  it("an XMAX rule never turns a number into 'not evaluated' (any WhatsApp)", () => {
    expect(
      ineligibleNumbers(numbers, capabilitiesWithXmax, "automation_xmax"),
    ).toEqual([]);
  });

  it("reads the origin from automationSource and describes the fixed value", () => {
    const { origin: _origin, ...withoutOrigin } = xmaxPurchase;
    expect(providerRuleOrigin(withoutOrigin, new Map())).toBe("automation_xmax");
    expect(triggerDetailForProviderRule(xmaxPurchase, "automation_xmax")).toMatch(
      /^Valor fixo de/u,
    );
    expect(triggerDetailForProviderRule(xmaxQualified, "automation_xmax")).toBe(
      "Etapa da XMAX chama a URL da regra",
    );
  });

  it("one rule per event of the XMAX, separate from the n8n rules", () => {
    const family = webhookRulesOf([xmaxQualified, n8nPurchase], ["webhook", "xmax"]);
    expect(family.map((rule) => rule.id).sort()).toEqual(
      ["wh_purchase", "xmax_qualified"].sort(),
    );
    // The n8n Purchase rule does not take the XMAX Purchase event.
    expect(webhookRuleForEvent(family, "Purchase", "xmax")).toBeNull();
    expect(webhookRuleForEvent(family, "QualifiedLead", "xmax")?.id).toBe(
      "xmax_qualified",
    );
    expect(firstFreeWebhookEvent(family, "xmax")).toBe("Purchase");
    expect(firstFreeWebhookEvent(family)).toBe("QualifiedLead");
  });

  it("Nova regra payload: every number, no connection, fixed value, observation", () => {
    const draft = {
      ...emptyRuleDraft("automation_xmax"),
      name: "XMAX: Compra",
      eventName: "Purchase" as const,
      scope: "all_numbers" as const,
    };
    // A purchase needs the fixed value.
    expect(buildRulePayload(draft, context)).toMatchObject({
      ok: false,
      message: "Informe o valor da conversão.",
    });
    expect(
      buildRulePayload({ ...draft, averageValue: "990,00" }, context),
    ).toEqual({
      ok: true,
      value: {
        name: "XMAX: Compra",
        scope: "all_numbers",
        channelIds: [],
        mode: "observation",
        triggerType: "provider_automation",
        automationSource: "xmax",
        eventName: "Purchase",
        webhookValueSource: "fixed",
        defaultValueCents: 99000,
      },
    });
    // Even if the draft carried "received" (never for XMAX), it sends fixed.
    expect(
      buildRulePayload(
        { ...draft, averageValue: "990,00", webhookValueSource: "received" },
        context,
      ),
    ).toMatchObject({ ok: true, value: { webhookValueSource: "fixed" } });
    // The XMAX event already has its URL.
    expect(
      buildRulePayload({ ...draft, eventName: "QualifiedLead" }, context),
    ).toMatchObject({ ok: false });
  });

  it("Gerenciar: URL tab and received events; value without source switch", () => {
    expect(
      ruleManageTabs("automation_xmax", xmaxPurchase).map((tab) => tab.id),
    ).toEqual(["edit", "endpoint", "received"]);
    expect(ruleEditCapabilities(xmaxPurchase, "automation_xmax")).toMatchObject({
      value: true,
      webhookValueSource: false,
    });
  });

  it("API refusals and receipt reasons are written for the screen", () => {
    expect(
      isWebhookApiMessage("Este evento já tem uma regra da XMAX; use a URL dela"),
    ).toBe(true);
    expect(isWebhookApiMessage("A regra da XMAX usa sempre o valor fixo")).toBe(true);
    expect(executionReasonLabel("xmax_missing_phone")).toBe(
      "Oportunidade sem telefone do lead",
    );
    expect(executionReasonLabel("xmax_missing_opportunity_id")).toBe(
      "Chamada da XMAX sem ID_oportunidade",
    );
    expect(executionReasonLabel("contact_not_paid_lead")).toBe(
      "Contato não é lead de anúncio",
    );
  });

  it("body example: the XMAX fields the reader knows, fictitious", () => {
    const body = JSON.parse(xmaxBodyExample());
    expect(body).toEqual({
      ID_oportunidade: "90001",
      Titulo_oportunidade: "Lead Teste",
      Etapa_oportunidade: "3 Negociação",
      Telefone_oportunidade: "5511900000002",
      Contatos_oportunidade: "[]",
    });
    expect(xmaxBodyExample()).not.toMatch(/@|token/iu);
    expect(JSON.parse(xmaxMinimalBodyExample())).toEqual({
      ID_oportunidade: "<id da oportunidade>",
      Telefone_oportunidade: "<telefone com DDI e DDD>",
    });
  });

  it("payload example component: method, token header, fields, both bodies, copy button", () => {
    const { container } = render(createElement(XmaxPayloadExample));
    const text = container.textContent ?? "";
    expect(text).toMatch(/POST/u);
    expect(text).toMatch(/x-wpptrack-webhook-token/u);
    for (const field of [
      "ID_oportunidade",
      "Telefone_oportunidade",
      "Contatos_oportunidade",
      "Etapa_oportunidade",
      "contact_number",
    ]) {
      expect(text).toContain(field);
    }
    expect(text).toMatch(/5511999999999/u);
    expect(text).toMatch(/valor fixo da regra/u);
    expect(text).toContain("Lead Teste");
    expect(text).toContain("<id da oportunidade>");
    expect(screen.getAllByRole("button", { name: /Copiar JSON/u })).toHaveLength(2);
  });

  it("observation-only origins get the observation message, never the server-off one", () => {
    expect(isObservationOnlyOrigin("automation_xmax")).toBe(true);
    expect(isObservationOnlyOrigin("automation_payt")).toBe(false);
    expect(isObservationOnlyProvider("xmax")).toBe(true);
    expect(isObservationOnlyProvider("payt")).toBe(false);
    expect(isObservationOnlyProvider(undefined)).toBe(false);
    expect(observationOnlyCreatedMessage).toMatch(/^Regra criada em observação/u);
    expect(observationOnlyCreatedMessage).toMatch(/nada vai para a Meta/u);
    expect(observationOnlyCreatedMessage).not.toMatch(
      /Dokploy|INBOUND_|desligado no servidor|sem envio/iu,
    );
  });

  it("URL tab shows the XMAX steps (stage automation, header option), no QR", () => {
    const { container } = render(
      createElement(RuleEndpoint as never, {
        rule: {
          ...xmaxPurchase,
          endpoint: {
            id: "endpoint_1",
            lastDeliveryAt: null,
            lastSuccessfulParseAt: null,
            rotatedAt: null,
            removedAt: null,
            publicUrlDisabledAt: null,
          },
        },
        origin: "automation_xmax",
        canManage: true,
        rotateAction: vi.fn(),
        onRotated: vi.fn(),
        onDismiss: vi.fn(),
      }),
    );
    expect(screen.getAllByText(/x-wpptrack-webhook-token/u).length).toBeGreaterThan(0);
    expect(container.textContent).toContain("Telefone_oportunidade");
    expect(screen.getByText(/A XMAX não cria lead/u)).toBeTruthy();
    expect(container.textContent).not.toMatch(/QR|n8n/u);
  });
});

describe("XMAX CRM: the observed call is visible in Eventos recebidos", () => {
  const audit: ProviderConversionAutomationAuditDto = {
    providerRuleId: "xmax_qualified",
    summary: {
      total: 1,
      observed: 1,
      blocked: 0,
      queued: 0,
      materialized: 0,
      failed: 0,
      invalid: 0,
      recoverable: 0,
    },
    items: [
      {
        deliveryId: "delivery_xmax_1",
        executionId: null,
        receivedAt: "2026-11-26T13:00:00.000Z",
        lastReceivedAt: "2026-11-26T13:00:00.000Z",
        providerEventType: null,
        eventName: "QualifiedLead",
        automation: null,
        status: "observed",
        reasonCode: null,
        attemptCount: 1,
        executionAttemptCount: 0,
        channel: { id: "ch_01", name: "Recepção", connectedPhone: "+5511900000001" },
        leadResolved: true,
        payloadAvailable: true,
        payloadExpiresAt: "2026-12-02T13:00:00.000Z",
        reprocessable: false,
      },
    ] as ProviderConversionAutomationAuditDto["items"],
  };

  it("shows the 'Em observação' mark and the call, nothing sent", async () => {
    render(
      createElement(ReceivedEvents, {
        ruleId: "xmax_qualified",
        origin: "automation_xmax",
        mode: "observation",
        canManage: true,
        loadAction: vi.fn(async () => ({
          ok: true as const,
          message: "ok",
          automationAudit: audit,
        })) as never,
        loadPayloadAction: vi.fn() as never,
        reprocessAction: vi.fn() as never,
      }),
    );
    expect(await screen.findByText("Em observação")).toBeTruthy();
    expect(screen.getByText(/nada vai para a Meta/u)).toBeTruthy();
    expect(screen.getAllByText(/sem envio/iu).length).toBeGreaterThan(0);
  });
});

describe("XMAX CRM Nova regra flow copy", () => {
  function renderFlow(origin: "automation_xmax" | "automation_webhook") {
    return render(
      createElement(NewRuleFlow, {
        offeredOrigins: [origin],
        initialOrigin: origin,
        numbers,
        connections,
        capabilities: capabilitiesWithXmax,
        createAction: vi.fn(),
        confirmAction: vi.fn(),
        onFinished: () => undefined,
        webhookRules: [],
      }),
    );
  }

  it("XMAX: helper names the XMAX automation and value is only the fixed one", async () => {
    const user = setupUser();
    const { container } = renderFlow("automation_xmax");
    await user.selectOptions(screen.getByLabelText("Evento"), "InitiateCheckout");
    const text = container.textContent ?? "";
    expect(text).toContain("A automação da etapa no CRM da XMAX chama a URL desta regra");
    expect(text).toContain("Uma regra por evento.");
    expect(text).not.toMatch(/n8n|robô/u);
    expect(text).toContain("Exige valor: o valor fixo desta regra.");
    expect(text).not.toMatch(/extra[ií]do da mensagem/u);
  });

  it("Webhook / n8n keeps its own helper and value copy", async () => {
    const user = setupUser();
    const { container } = renderFlow("automation_webhook");
    await user.selectOptions(screen.getByLabelText("Evento"), "InitiateCheckout");
    const text = container.textContent ?? "";
    expect(text).toContain("O n8n, o painel ou o robô chama a URL desta regra");
    expect(text).toMatch(/fixo ou extra[ií]do da mensagem/u);
  });
});

describe("XMAX CRM Nova regra flow", () => {
  it("skips Alcance, picks the first free XMAX event and shows the rule URL once", async () => {
    const user = setupUser();
    const createAction = vi.fn(async (_formData: FormData) => ({
      ok: true as const,
      ruleId: "rule_xmax",
      ruleMode: "observation" as const,
      webhookUrl:
        "https://api.exemplo.test/webhooks/inbound/conversions/x?token=ficticio",
      message: "Regra criada em observação.",
    }));
    const { container } = render(
      createElement(NewRuleFlow, {
        offeredOrigins: ["automation_xmax"],
        initialOrigin: "automation_xmax",
        numbers,
        connections,
        capabilities: capabilitiesWithXmax,
        createAction,
        confirmAction: vi.fn(),
        onFinished: () => undefined,
        // The n8n Purchase rule does not block the XMAX Purchase.
        webhookRules: [xmaxQualified, n8nPurchase],
      }),
    );
    expect(screen.queryByText("Alcance")).toBeNull();
    const select = screen.getByLabelText("Evento") as HTMLSelectElement;
    expect(select.value).toBe("Purchase");
    expect(
      (select.querySelector("option[value=QualifiedLead]") as HTMLOptionElement)
        .disabled,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: /Continuar/ }));
    expect(
      (screen.getByLabelText("Nome da regra") as HTMLInputElement).value,
    ).toBe("XMAX: Compra realizada");
    // Fixed value only: no "Usar o valor recebido" choice.
    expect(screen.queryByText("Usar o valor recebido")).toBeNull();
    expect(screen.getByText(/Começa em observação/u)).toBeTruthy();
    await user.type(screen.getByLabelText(/Valor/u, { selector: "input" }), "990,00");
    await user.click(screen.getByRole("button", { name: "Criar regra" }));
    await screen.findByText("Regra criada");
    const payload = JSON.parse(
      String(createAction.mock.calls[0]![0].get("payload")),
    );
    expect(payload).toMatchObject({
      automationSource: "xmax",
      eventName: "Purchase",
      scope: "all_numbers",
      mode: "observation",
      webhookValueSource: "fixed",
      defaultValueCents: 99000,
    });
    expect(payload.connectionId).toBeUndefined();
    expect(screen.getByText("URL da regra (exibida uma única vez)")).toBeTruthy();
    expect(container.textContent).not.toMatch(/QR/u);
  });
});
