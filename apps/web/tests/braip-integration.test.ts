import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type {
  IntegrationEventPayloadDto,
  ProviderConversionRuleCapabilitiesDto,
} from "@wpptrack/shared";
import { describe, expect, it, vi } from "vitest";
import { ruleOriginDefinition } from "../src/app/(app)/conversions/conversion-origins";
import {
  offeredRuleOrigins,
  providerRuleOrigin,
} from "../src/app/(app)/conversions/conversion-rules-view";
import {
  braipEventExplanations,
  braipEventLabels,
  ruleEventLabelForOrigin,
} from "../src/app/(app)/conversions/event-copy";
import {
  buildRulePayload,
  emptyRuleDraft,
  salesSingleConnectionNote,
  scopeIssue,
} from "../src/app/(app)/conversions/rule-draft";
import { singleUrlProviderFor } from "../src/app/(app)/conversions/new-rule-flow";
import { buildIntegrationCards } from "../src/app/(app)/integrations/hub/integration-cards";
import {
  integrationLogoPath,
  integrationProviders,
} from "../src/app/(app)/integrations/hub/integration-registry";
import {
  parsedSaleRows,
  SalePayloadView,
} from "../src/app/(app)/integrations/single-url/sale-payload-view";
import {
  eventLabel,
  isSalesPlatform,
  productCodeGuidance,
  saleEventExplanation,
  singleUrlPlatformNames,
  singleUrlSetupSteps,
} from "../src/app/(app)/integrations/single-url/single-url-copy";
import { executionReasonLabel } from "../src/app/(app)/settings/provider-conversion-labels";
import {
  capabilitiesWithPayt,
  connections,
  numbers,
  providerRule,
} from "./conversions-fixtures";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

/**
 * Fase 6.5 — Braip on the Integrations hub and in Conversões (ported from
 * the SaaS 072bb61a, 25a7cd76, b3124d65 and #164; adapted to production
 * direct: no "em certificação" notice, nothing to release, card always
 * offered).
 */

const capabilitiesWithBraip: ProviderConversionRuleCapabilitiesDto = {
  ...capabilitiesWithPayt,
  origins: [
    ...capabilitiesWithPayt.origins,
    {
      origin: "automation_braip",
      scopes: ["all_numbers", "specific_numbers"],
      channelProviders: ["umbler", "gupshup", "uazapi", "meta_cloud", "data_crazy"],
      authorChannelProviders: null,
      connectionBound: false,
      labelMatch: null,
      unifiable: false,
      eventNames: ["Purchase", "InitiateCheckout", "CartAbandoned"],
      betaEventNames: ["CartAbandoned"],
    },
  ],
};

const forbiddenStudentWords = /certifica|liberar|liberad|observa[cç]|em teste|\bQR\b/iu;

describe("Braip card on the Integrations hub", () => {
  it("is always offered (no gate) with the official symbol on the dark tile", () => {
    const braip = integrationProviders.find((provider) => provider.id === "braip");
    expect(braip).toMatchObject({
      name: "Braip",
      category: "attendance",
      logoSurface: "dark",
      gate: { kind: "braip_rules" },
    });
    expect(integrationLogoPath("braip")).toBe("/integrations/braip.png");
    expect(braip!.description).not.toMatch(forbiddenStudentWords);
  });

  it("reads its state from the Braip rules and URL, available when there is none", () => {
    const snapshot = {
      inbound: { enabled: true, providers: [], connections: [] },
      whatsapp: { loaded: true, connections: [], legacyUazapiInstances: 0 },
      payt: { loaded: true, ruleCount: 0, activeRuleCount: 0 },
      crm: {
        kommo: { loadState: "empty" as const, statuses: [] },
        pipedrive: { loadState: "empty" as const, statuses: [] },
      },
      meta: { connected: false, needsAttention: false, statusLabel: "Disponível" },
    };
    const card = (patch: object = {}) =>
      buildIntegrationCards({ ...snapshot, ...patch }).find(
        (item) => item.id === "braip",
      )!;
    // No snapshot at all: still offered.
    expect(card().state).toBe("available");
    expect(
      card({ braip: { loaded: true, ruleCount: 0, activeRuleCount: 0, integrationUrl: true } }),
    ).toMatchObject({ state: "active", status: { label: "URL criada, sem regras" } });
    expect(
      card({ braip: { loaded: true, ruleCount: 2, activeRuleCount: 1, integrationUrl: true } }),
    ).toMatchObject({ state: "active", status: { label: "Recebendo vendas", tone: "ok" } });
  });

  it("records the logo source and ships a real PNG", () => {
    const sources = readFileSync(
      resolve(__dirname, "../public/integrations/SOURCES.md"),
      "utf8",
    );
    expect(sources).toContain("`braip.png`");
    const png = readFileSync(resolve(__dirname, "../public/integrations/braip.png"));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });
});

describe("Braip single URL copy", () => {
  it("names the platform and tells where to paste the URL in the Braip", () => {
    expect(singleUrlPlatformNames.braip).toBe("Braip");
    expect(isSalesPlatform("braip")).toBe(true);
    const steps = singleUrlSetupSteps("braip").join(" ");
    expect(steps).toContain("Ferramentas → Postback");
    expect(steps).toContain("Pagamento Aprovado");
    expect(steps).not.toMatch(forbiddenStudentWords);
    expect(productCodeGuidance("braip")).toContain("Braip");
  });

  it("uses the Braip sale labels and explanations, without any release step", () => {
    expect(eventLabel("Purchase", "braip")).toBe("Compra aprovada");
    expect(eventLabel("InitiateCheckout", "braip")).toBe("Boleto/Pix gerado");
    expect(eventLabel("CartAbandoned", "braip")).toBe("Checkout abandonado");
    expect(saleEventExplanation("braip", "Purchase")).toContain("Pagamento Aprovado");
    for (const text of [
      ...Object.values(braipEventLabels),
      ...Object.values(braipEventExplanations),
    ]) {
      expect(text).not.toMatch(forbiddenStudentWords);
    }
  });
});

describe("Braip rules on the Conversões screen", () => {
  const base = {
    numbers,
    connections,
    capabilities: capabilitiesWithBraip,
    crm: { kommo: false, pipedrive: false },
  };

  it("offers 'Venda na Braip' with a WhatsApp number, connection or an incomplete read (#164)", () => {
    expect(offeredRuleOrigins(base)).toContain("automation_braip");
    expect(
      offeredRuleOrigins({ ...base, numbers: [], numbersPartial: true, connections: [] }),
    ).toContain("automation_braip");
    expect(offeredRuleOrigins({ ...base, numbers: [] })).toContain(
      "automation_braip",
    );
    expect(
      offeredRuleOrigins({ ...base, numbers: [], connections: [] }),
    ).not.toContain("automation_braip");
    // Never offered when the API does not accept the origin.
    expect(
      offeredRuleOrigins({ ...base, capabilities: capabilitiesWithPayt }),
    ).not.toContain("automation_braip");
    expect(ruleOriginDefinition("automation_braip")).toMatchObject({
      label: "Venda na Braip",
      logoProvider: "braip",
      connection: "any",
      allowedEvents: ["Purchase", "InitiateCheckout", "CartAbandoned"],
    });
  });

  it("builds a Braip rule that receives only through the single URL (never a mode)", () => {
    const draft = {
      ...emptyRuleDraft("automation_braip"),
      name: "Venda Braip",
      scope: "all_numbers" as const,
      productCodes: ["PRO1ABC"],
    };
    const result = buildRulePayload(draft, {
      numbers,
      connections,
      capabilities: capabilitiesWithBraip,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        triggerType: "provider_automation",
        automationSource: "braip",
        eventName: "Purchase",
        productFilterCodes: ["PRO1ABC"],
        perRuleUrl: false,
        scope: "all_numbers",
      },
    });
    expect(result.ok && "mode" in result.value).toBe(false);
    expect(singleUrlProviderFor("automation_braip")).toBe("braip");
  });

  it("keeps the numbers of one connection, with the Braip note", () => {
    const issue = scopeIssue(
      {
        origin: "automation_braip",
        scope: "specific_numbers",
        channelIds: [numbers[0]!.id, numbers.at(-1)!.id],
        connectionId: null,
        messageAuthorScope: "team",
      },
      { numbers, connections, capabilities: capabilitiesWithBraip },
    );
    if (numbers[0]!.connectionId !== numbers.at(-1)!.connectionId) {
      expect(issue).toBe(salesSingleConnectionNote("automation_braip"));
    }
    expect(salesSingleConnectionNote("automation_braip")).toContain("Braip");
  });

  it("recognizes an existing Braip rule and labels its events", () => {
    const rule = providerRule({
      id: "rule_braip",
      name: "Compra Braip",
      triggerType: "provider_automation",
      eventName: "Purchase",
      connectionId: "conn_umbler",
      scope: "all_numbers",
      phrases: [],
      automationSource: "braip",
    });
    expect(providerRuleOrigin({ ...rule, origin: undefined } as never, new Map())).toBe(
      "automation_braip",
    );
    expect(ruleEventLabelForOrigin("automation_braip", "InitiateCheckout")).toBe(
      "Boleto/Pix gerado",
    );
    expect(executionReasonLabel("braip_purchase_identity_missing")).toBe(
      "Venda da Braip sem transação identificada",
    );
  });
});

describe("Ver dados recebidos (read only)", () => {
  const data: IntegrationEventPayloadDto = {
    eventId: "event_1",
    provider: "braip",
    status: "unattributed",
    reasonLabel: "Comprador não é lead do WhatsApp",
    receivedAt: "2026-10-23T14:09:00.000Z",
    payloadExpiresAt: "2026-10-30T14:09:00.000Z",
    payloadAvailable: true,
    payloadMessage: null,
    payload: { trans_key: "VEN-1", basic_authentication: "[oculto]" },
    parsed: {
      eventName: "Purchase",
      valueCents: 54700,
      currency: "BRL",
      valueSent: true,
      productCode: "PRO1",
      productName: "Produto",
      offerCode: null,
      offerName: null,
      orderRef: "VEN-1",
      occurredAt: "2026-10-23T14:09:00.000Z",
      phoneMasked: "••••1020",
      providerStatus: "pagamento aprovado",
      test: false,
    },
    parseError: null,
  };

  it("lists what the reader read, with the masked phone and the Braip label", () => {
    const rows = Object.fromEntries(parsedSaleRows("braip", data.parsed!));
    expect(rows).toMatchObject({
      Evento: "Compra aprovada",
      Pedido: "VEN-1",
      Telefone: "••••1020",
      Moeda: "BRL",
    });
  });

  it("renders the payload next to the reading, with no release button", () => {
    const html = renderToStaticMarkup(createElement(SalePayloadView, { data }));
    expect(html).toContain("O que lemos");
    expect(html).toContain("Dados recebidos");
    expect(html).toContain("[oculto]");
    expect(html).not.toMatch(forbiddenStudentWords);
    expect(html).not.toContain("<button");
  });

  it("explains an expired payload instead of showing it", () => {
    const html = renderToStaticMarkup(
      createElement(SalePayloadView, {
        data: {
          ...data,
          payloadAvailable: false,
          payload: null,
          payloadMessage: "Os dados recebidos já foram apagados.",
        },
      }),
    );
    expect(html).toContain("já foram apagados");
    expect(html).not.toContain("payload-block");
  });
});

describe("Braip panel source (no student release step)", () => {
  it("never shows an 'em certificação' notice or a release action", () => {
    for (const file of [
      "../src/app/(app)/integrations/single-url/single-url-panels.tsx",
      "../src/app/(app)/integrations/single-url/sale-payload-view.tsx",
      "../src/app/(app)/integrations/single-url/single-url-copy.ts",
    ]) {
      const text = readFileSync(resolve(__dirname, file), "utf8");
      expect(text, file).not.toMatch(/certification|Liberar plataforma|em certificação/iu);
    }
  });
});
