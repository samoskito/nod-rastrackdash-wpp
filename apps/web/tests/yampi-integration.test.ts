// @vitest-environment jsdom

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import type {
  IntegrationDetectedProductDto,
  IntegrationEndpointDto,
  IntegrationEventPayloadDto,
  IntegrationUnattributedEventListDto,
  ProviderConversionRuleCapabilitiesDto,
} from "@wpptrack/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ruleOriginDefinition } from "../src/app/(app)/conversions/conversion-origins";
import {
  offeredRuleOrigins,
  providerRuleOrigin,
} from "../src/app/(app)/conversions/conversion-rules-view";
import {
  ruleEventLabelForOrigin,
  yampiEventExplanations,
  yampiEventLabels,
} from "../src/app/(app)/conversions/event-copy";
import {
  buildRulePayload,
  emptyRuleDraft,
  salesSingleConnectionNote,
} from "../src/app/(app)/conversions/rule-draft";
import {
  ruleCurrencyHint,
  singleUrlProviderFor,
} from "../src/app/(app)/conversions/new-rule-flow";
import {
  buildIntegrationCards,
  cardsForTab,
} from "../src/app/(app)/integrations/hub/integration-cards";
import {
  integrationLogoPath,
  integrationProviders,
} from "../src/app/(app)/integrations/hub/integration-registry";
import { parsedSaleRows } from "../src/app/(app)/integrations/single-url/sale-payload-view";
import {
  eventLabel,
  isSalesPlatform,
  productCodeGuidance,
  saleEventExplanation,
  singleUrlPlatformNames,
  singleUrlSetupSteps,
  supportedEvents,
} from "../src/app/(app)/integrations/single-url/single-url-copy";
import { SalesPlatformSingleUrlPanel } from "../src/app/(app)/integrations/single-url/single-url-panels";
import { providerOptions } from "../src/app/(backoffice)/backoffice/inbound-webhooks/integration-events/integration-events-copy";
import { parserProviderLabels } from "../src/app/(backoffice)/backoffice/inbound-webhooks/parsers/parsers-copy";
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

afterEach(() => {
  cleanup();
});

/**
 * Fase 6.7 — Yampi on the Integrations hub and in Conversões (ported from
 * the SaaS 1889af48, #186, adapted to the student edition: open to every
 * workspace, no private-integration flag ("yampiEnabled"), production direct:
 * no "em certificação" notice, nothing to release). Fictitious data only.
 */

const capabilitiesWithYampi: ProviderConversionRuleCapabilitiesDto = {
  ...capabilitiesWithPayt,
  origins: [
    ...capabilitiesWithPayt.origins,
    {
      origin: "automation_yampi",
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

const hubSnapshot = {
  inbound: { enabled: true, providers: [], connections: [] },
  whatsapp: { loaded: true, connections: [], legacyUazapiInstances: 0 },
  payt: { loaded: true, ruleCount: 0, activeRuleCount: 0 },
  crm: {
    kommo: { loadState: "empty" as const, statuses: [] },
    pipedrive: { loadState: "empty" as const, statuses: [] },
  },
  meta: { connected: false, needsAttention: false, statusLabel: "Disponível" },
};

describe("Yampi card on the Integrations hub (Atendimento e vendas)", () => {
  it("is always offered (no private gate) in Atendimento e vendas, with a local logo", () => {
    const yampi = integrationProviders.find((provider) => provider.id === "yampi");
    expect(yampi).toMatchObject({
      name: "Yampi",
      category: "attendance",
      logoSurface: "dark",
      gate: { kind: "yampi_rules" },
    });
    expect(integrationLogoPath("yampi")).toBe("/integrations/yampi.svg");
    expect(
      existsSync(resolve(__dirname, "../public", integrationLogoPath("yampi").slice(1))),
    ).toBe(true);
    expect(yampi!.description).not.toMatch(forbiddenStudentWords);
    const sources = readFileSync(
      resolve(__dirname, "../public/integrations/SOURCES.md"),
      "utf8",
    );
    expect(sources).toContain("`yampi.svg`");
  });

  it("reads its state from the Yampi rules and URL; available when there is none", () => {
    const card = (patch: object = {}) =>
      buildIntegrationCards({ ...hubSnapshot, ...patch }).find(
        (item) => item.id === "yampi",
      )!;
    // No snapshot at all (and no private flag): still offered.
    expect(card().state).toBe("available");
    expect(
      cardsForTab(buildIntegrationCards(hubSnapshot), "attendance").available.map(
        (item) => item.id,
      ),
    ).toContain("yampi");
    expect(
      card({ yampi: { loaded: true, ruleCount: 0, activeRuleCount: 0, integrationUrl: true } }),
    ).toMatchObject({ state: "active", status: { label: "URL criada, sem regras" } });
    expect(
      card({ yampi: { loaded: true, ruleCount: 1, activeRuleCount: 1, integrationUrl: true } }),
    ).toMatchObject({ state: "active", status: { label: "Recebendo vendas", tone: "ok" } });
  });
});

describe("Yampi single URL copy", () => {
  it("names the platform, lists the webhook events and needs no secret key", () => {
    expect(singleUrlPlatformNames.yampi).toBe("Yampi");
    expect(isSalesPlatform("yampi")).toBe(true);
    expect(supportedEvents("yampi")).toEqual(["Purchase", "InitiateCheckout", "CartAbandoned"]);
    const steps = singleUrlSetupSteps("yampi").join(" ");
    for (const event of ["order.paid", "order.created", "order.status.updated", "cart.reminder"]) {
      expect(steps).toContain(event);
    }
    expect(steps).toMatch(/Não é preciso copiar a chave secreta/u);
    expect(steps).not.toMatch(forbiddenStudentWords);
    expect(productCodeGuidance("yampi")).toMatch(/SKU/u);
  });

  it("uses the Yampi sale labels and explanations, without any release step", () => {
    expect(eventLabel("Purchase", "yampi")).toBe("Pedido pago");
    expect(eventLabel("InitiateCheckout", "yampi")).toBe(
      "Pedido aguardando pagamento (boleto/Pix)",
    );
    expect(eventLabel("CartAbandoned", "yampi")).toBe("Carrinho abandonado");
    expect(saleEventExplanation("yampi", "Purchase")).toMatch(/sem frete e sem juros/u);
    for (const text of [
      ...Object.values(yampiEventLabels),
      ...Object.values(yampiEventExplanations),
    ]) {
      expect(text).not.toMatch(forbiddenStudentWords);
    }
  });

  it("is a filter option of the backoffice “Recebimentos das URLs únicas” and of the readers screen", () => {
    expect(providerOptions).toContainEqual({ value: "yampi", label: "Yampi" });
    expect(parserProviderLabels.yampi).toBe("Yampi");
  });
});

const yampiEndpoint: IntegrationEndpointDto = {
  id: "endpoint_yampi",
  provider: "yampi",
  kind: "sales_platform",
  eventName: null,
  url: "https://api.example.test/webhooks/inbound/integrations/endpoint_yampi?token=segredo-ficticio",
  secretVersion: 1,
  parserCertified: true,
  lastDeliveryAt: null,
  lastRoutedAt: null,
  rotatedAt: null,
  createdAt: "2026-10-27T12:00:00.000Z",
  stats: { received: 0, routed: 0, unattributed: 0, ignored: 0, invalid: 0 },
} as IntegrationEndpointDto;

describe("Yampi single URL panel", () => {
  it("shows the URL, the events, products, unattributed sales and the setup steps (no release notice)", () => {
    const { container } = render(
      createElement(SalesPlatformSingleUrlPanel, {
        provider: "yampi",
        endpoint: yampiEndpoint,
        products: [
          {
            provider: "yampi",
            productCode: "3000001",
            productName: "Produto Ficticio Azul",
            offerCode: "SKU-FICT-01",
            offerName: "Produto Ficticio Azul",
            lastSeenAt: "2026-10-27T12:00:00.000Z",
          } as IntegrationDetectedProductDto,
        ],
        unattributed: {
          total: 1,
          items: [
            {
              id: "event_1",
              provider: "yampi",
              eventName: "Purchase",
              productCode: "3000001",
              productName: "Produto Ficticio Azul",
              offerCode: "SKU-FICT-01",
              valueCents: 59400,
              currency: "BRL",
              reasonCode: "buyer_not_whatsapp_lead",
              reasonLabel: "Comprador não é lead do WhatsApp",
              attemptCount: 1,
              firstReceivedAt: "2026-10-27T12:00:00.000Z",
              lastReceivedAt: "2026-10-27T12:00:00.000Z",
              retryable: true,
            },
          ],
        } as IntegrationUnattributedEventListDto,
        legacyUrls: [],
        ruleEvents: ["Purchase"],
        canManage: true,
        actions: {
          ensure: vi.fn(),
          reveal: vi.fn(),
          rotate: vi.fn(),
          remove: vi.fn(),
          retry: vi.fn(),
          setPublicUrl: vi.fn(),
          loadPayload: vi.fn(),
        } as never,
      }),
    );
    expect(screen.getByText("URL única da Yampi")).toBeTruthy();
    expect(screen.getAllByText("Pedido pago").length).toBeGreaterThan(0);
    expect(screen.getByText("Pedido aguardando pagamento (boleto/Pix)")).toBeTruthy();
    expect(screen.getAllByText(/Carrinho abandonado/u).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/sem frete e sem juros/u).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Cancelamento, reembolso e pagamento recusado/u).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/order\.paid/u).length).toBeGreaterThan(0);
    // Born with the single URL only: no "URLs antigas" section.
    expect(screen.queryByText("URLs antigas")).toBeNull();
    expect(container.textContent ?? "").not.toMatch(/em certificação|Liberar plataforma|\bQR\b/iu);
  });
});

describe("Yampi rules on the Conversões screen", () => {
  const base = {
    numbers,
    connections,
    capabilities: capabilitiesWithYampi,
    crm: { kommo: false, pipedrive: false },
  };

  it("offers 'Venda na Yampi' to every workspace whose API accepts the origin and has WhatsApp", () => {
    expect(offeredRuleOrigins(base)).toContain("automation_yampi");
    expect(
      offeredRuleOrigins({ ...base, numbers: [], numbersPartial: true, connections: [] }),
    ).toContain("automation_yampi");
    expect(
      offeredRuleOrigins({ ...base, numbers: [], connections: [] }),
    ).not.toContain("automation_yampi");
    expect(
      offeredRuleOrigins({ ...base, capabilities: capabilitiesWithPayt }),
    ).not.toContain("automation_yampi");
    expect(ruleOriginDefinition("automation_yampi")).toMatchObject({
      label: "Venda na Yampi",
      logoProvider: "yampi",
      connection: "any",
      allowedEvents: ["Purchase", "InitiateCheckout", "CartAbandoned"],
    });
    expect(singleUrlProviderFor("automation_yampi")).toBe("yampi");
    expect(ruleCurrencyHint("automation_yampi")).toMatch(/moeda da venda vence/u);
  });

  it("builds a Yampi rule that receives only through the single URL (never a mode)", () => {
    const draft = {
      ...emptyRuleDraft("automation_yampi"),
      name: "Yampi pedido pago",
      scope: "all_numbers" as const,
      productCodes: ["SKU-FICT-01"],
    };
    const result = buildRulePayload(draft, {
      numbers,
      connections,
      capabilities: capabilitiesWithYampi,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        triggerType: "provider_automation",
        automationSource: "yampi",
        eventName: "Purchase",
        productFilterCodes: ["SKU-FICT-01"],
        perRuleUrl: false,
        scope: "all_numbers",
      },
    });
    expect(result.ok && "mode" in result.value).toBe(false);
    expect(salesSingleConnectionNote("automation_yampi")).toContain("Yampi");
  });

  it("recognizes an existing Yampi rule and labels its events and reasons", () => {
    const rule = providerRule({
      id: "rule_yampi",
      name: "Pedido pago Yampi",
      triggerType: "provider_automation",
      eventName: "Purchase",
      connectionId: "conn_umbler",
      scope: "all_numbers",
      phrases: [],
      automationSource: "yampi",
    });
    expect(providerRuleOrigin({ ...rule, origin: undefined } as never, new Map())).toBe(
      "automation_yampi",
    );
    expect(ruleEventLabelForOrigin("automation_yampi", "InitiateCheckout")).toBe(
      "Pedido aguardando pagamento (boleto/Pix)",
    );
    expect(executionReasonLabel("yampi_purchase_identity_missing")).toBe(
      "Venda da Yampi sem número do pedido",
    );
  });
});

describe("Ver dados recebidos of a Yampi sale (read only)", () => {
  const data: IntegrationEventPayloadDto = {
    eventId: "event_1",
    provider: "yampi",
    status: "unattributed",
    reasonLabel: "Comprador não é lead do WhatsApp",
    receivedAt: "2026-10-27T12:30:15.000Z",
    payloadExpiresAt: "2026-11-03T12:30:15.000Z",
    payloadAvailable: true,
    payloadMessage: null,
    payload: {
      event: "order.paid",
      resource: { id: 70000001, login_url: "[oculto]" },
    },
    parsed: {
      eventName: "Purchase",
      valueCents: 59400,
      currency: "BRL",
      valueSent: true,
      productCode: "3000001",
      productName: "Produto Ficticio Azul",
      offerCode: "SKU-FICT-01",
      offerName: "Produto Ficticio Azul",
      orderRef: "70000001",
      occurredAt: "2026-10-27T12:29:58.000Z",
      phoneMasked: "••••0001",
      providerStatus: "order.paid:paid",
      test: false,
    },
    parseError: null,
  };

  it("lists what the reader read with the Yampi label", () => {
    const rows = Object.fromEntries(parsedSaleRows("yampi", data.parsed!));
    expect(rows).toMatchObject({
      Evento: "Pedido pago",
      Pedido: "70000001",
      Telefone: "••••0001",
      Moeda: "BRL",
    });
    const html = renderToStaticMarkup(
      createElement("pre", null, JSON.stringify(data.payload)),
    );
    expect(html).toContain("[oculto]");
  });
});
