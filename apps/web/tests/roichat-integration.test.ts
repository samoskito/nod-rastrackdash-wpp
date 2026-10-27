import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  inboundWebhookConnectionCreateInputSchema,
  providerConversionRuleCreateInputSchema,
  type ProviderConversionRuleCapabilitiesDto,
} from "@wpptrack/shared";
import {
  offeredRuleOrigins,
  type ConversionConnection,
  type ConversionNumber,
} from "../src/app/(app)/conversions/conversion-rules-view";
import {
  automationPlatformOf,
  hubProviderForInbound,
  providerDisplayName,
  ruleOriginDefinition,
} from "../src/app/(app)/conversions/conversion-origins";
import {
  automationPlatformName,
  buildRulePayload,
  emptyRuleDraft,
} from "../src/app/(app)/conversions/rule-draft";
import {
  deleteConfirmText,
  ruleManageTabs,
} from "../src/app/(app)/conversions/rule-manage";
import { ruleEditCapabilities } from "../src/app/(app)/conversions/rule-edit";
import { singleUrlProviderFor } from "../src/app/(app)/conversions/new-rule-flow";
import {
  buildIntegrationCards,
  cardsForTab,
  type IntegrationHubSnapshot,
} from "../src/app/(app)/integrations/hub/integration-cards";
import {
  integrationLogoPath,
  integrationProvider,
} from "../src/app/(app)/integrations/hub/integration-registry";
import {
  inboundPasteInstruction,
  inboundWebhookProviderLabel,
  rulesCoveringConnection,
} from "../src/app/(app)/integrations/inbound-webhook-panel";
import { RoichatSetupPanel } from "../src/app/(app)/integrations/roichat-setup";
import { executionReasonLabel } from "../src/app/(app)/settings/provider-conversion-labels";
import { capabilities } from "./conversions-fixtures";

/**
 * Fase 6.8 (porte do #183 e #185): ROI Chat no Hub (ao lado de WAHA e Meta
 * Cloud), conexão por número e origem "Compra no ROI Chat". No nod não há
 * gate de integração privada nem vaga paga; produção direta: nada de
 * observação, teste ou liberação nos textos novos. Dados fictícios.
 */

const roichatConnections: ConversionConnection[] = [
  { id: "conn_roichat_a", provider: "roichat", displayName: "ROI Chat Loja", status: "production" },
  { id: "conn_roichat_b", provider: "roichat", displayName: "ROI Chat Suporte", status: "production" },
];
const roichatNumbers: ConversionNumber[] = roichatConnections.map(
  (connection, index) => ({
    id: `ch_roichat_${index + 1}`,
    connectionId: connection.id,
    provider: "roichat",
    connectionName: connection.displayName,
    label: connection.displayName,
    phone: `+551190000000${index + 1}`,
    whatsappInstanceId: null,
    routeIds: [],
    status: "active",
  }),
);

const capabilitiesWithRoichat: ProviderConversionRuleCapabilitiesDto = {
  ...capabilities,
  origins: [
    ...capabilities.origins,
    {
      origin: "automation_roichat",
      scopes: ["all_numbers", "specific_numbers"],
      channelProviders: ["roichat"],
      authorChannelProviders: null,
      connectionBound: true,
      labelMatch: null,
      unifiable: false,
      eventNames: ["Purchase"],
    },
  ],
};

const context = {
  numbers: roichatNumbers,
  connections: roichatConnections,
  capabilities: capabilitiesWithRoichat,
};

function snapshot(
  patch: Partial<IntegrationHubSnapshot> = {},
): IntegrationHubSnapshot {
  return {
    inbound: { enabled: true, providers: [], connections: [] },
    whatsapp: { loaded: true, connections: [], legacyUazapiInstances: 0 },
    payt: { loaded: true, ruleCount: 0, activeRuleCount: 0 },
    crm: {
      kommo: { loadState: "real", statuses: [] },
      pipedrive: { loadState: "real", statuses: [] },
    },
    meta: { connected: false, needsAttention: false, statusLabel: "Não conectada" },
    ...patch,
  };
}

/** Production direct: no new text talks about observation, test or release. */
const forbiddenCopy = /observa|teste|liber|certific|\bQR\b/iu;

describe("ROI Chat no Hub", () => {
  it("is a WhatsApp official card, next to WAHA and Meta Cloud, with a local logo", () => {
    const provider = integrationProvider("roichat");
    expect(provider).toMatchObject({
      name: "ROI Chat",
      category: "whatsapp_official",
      gate: { kind: "inbound_provider", provider: "roichat" },
    });
    expect(provider.description).not.toMatch(forbiddenCopy);
    expect(
      existsSync(resolve(__dirname, "../public", integrationLogoPath("roichat").slice(1))),
    ).toBe(true);
    expect(hubProviderForInbound("roichat")).toBe("roichat");
  });

  it("is offered whenever the API offers it (no private-integration gate) and active with a connection", () => {
    const offered = buildIntegrationCards(
      snapshot({
        inbound: {
          enabled: true,
          providers: [{ provider: "roichat", creationEnabled: true }],
          connections: [],
        },
      }),
    );
    expect(cardsForTab(offered, "whatsapp").available.map((card) => card.id)).toContain(
      "roichat",
    );
    const active = buildIntegrationCards(
      snapshot({
        inbound: {
          enabled: true,
          providers: [{ provider: "roichat", creationEnabled: true }],
          connections: [{ provider: "roichat", status: "production" }],
        },
      }),
    ).find((card) => card.id === "roichat");
    expect(active).toMatchObject({
      state: "active",
      status: { label: "Enviando conversões", tone: "ok" },
    });
  });
});

describe("Conexão ROI Chat (uma conexão = um número = uma URL)", () => {
  it("requires the client's WhatsApp number when creating the connection", () => {
    expect(
      inboundWebhookConnectionCreateInputSchema.safeParse({
        provider: "roichat",
        displayName: "ROI Chat Loja",
      }).success,
    ).toBe(false);
    expect(
      inboundWebhookConnectionCreateInputSchema.safeParse({
        provider: "roichat",
        displayName: "ROI Chat Loja",
        connectedPhone: "+55 11 90000-0001",
      }).success,
    ).toBe(true);
  });

  it("labels the provider and tells where to paste the number URL", () => {
    expect(inboundWebhookProviderLabel("roichat")).toBe("ROI Chat");
    expect(providerDisplayName("roichat")).toBe("ROI Chat");
    expect(inboundPasteInstruction("roichat")).toContain("ROI Chat");
    expect(inboundPasteInstruction("roichat")).toMatch(/entrada.*compra/u);
  });

  it("shows the webhook guide: same URL for entry and purchase, Meta route, purchase rule", () => {
    const html = renderToStaticMarkup(createElement(RoichatSetupPanel));
    expect(html).toContain("Configuração no ROI Chat");
    expect(html).toContain("rota Meta");
    expect(html).toContain("Compra no ROI Chat");
    expect(html).toContain("ctwa_clid");
    expect(html).toContain("12 horas");
    expect(html).not.toMatch(forbiddenCopy);
  });

  it("counts on each number the rules for all ROI Chat numbers anchored on another one", () => {
    const rule = (id: string, connectionId: string, extra: object = {}) =>
      ({ id, connectionId, scope: "specific_numbers", ...extra }) as never;
    const rules = [
      rule("own_a", "conn_roichat_a"),
      rule("all", "conn_roichat_a", { scope: "all_numbers", crossConnectionScope: true }),
      rule("umbler_all", "conn_umbler", { scope: "all_numbers", crossConnectionScope: true }),
    ];
    const connections = [
      ...roichatConnections,
      { id: "conn_umbler", provider: "umbler" },
    ];
    const ids = (connectionId: string) =>
      rulesCoveringConnection(
        rules,
        connections.find((item) => item.id === connectionId)!,
        connections,
      ).map((item) => item.id);
    expect(ids("conn_roichat_a")).toEqual(["own_a", "all"]);
    expect(ids("conn_roichat_b")).toEqual(["all"]);
  });

  it("explains every ROI Chat reason in plain words", () => {
    for (const reason of [
      "purchase_repeated_within_12h",
      "roichat_purchase_without_rule",
      "roichat_automation_v1_invalid_payload",
      "inbound_webhook_roichat_channel_binding_missing",
    ]) {
      expect(executionReasonLabel(reason)).not.toBe(reason);
    }
  });
});

describe("Origem “Compra no ROI Chat” na Nova regra", () => {
  it("is offered only with the API origin and a live ROI Chat connection", () => {
    const base = {
      numbers: [],
      connections: [],
      capabilities: capabilitiesWithRoichat,
      crm: { kommo: false, pipedrive: false },
    };
    expect(offeredRuleOrigins(base)).not.toContain("automation_roichat");
    expect(
      offeredRuleOrigins({
        ...base,
        numbers: roichatNumbers,
        connections: roichatConnections,
      }),
    ).toContain("automation_roichat");
    expect(
      offeredRuleOrigins({
        ...base,
        capabilities,
        numbers: roichatNumbers,
        connections: roichatConnections,
      }),
    ).not.toContain("automation_roichat");
  });

  it("is a purchase-only origin for ROI Chat numbers, with no URL of its own", () => {
    expect(ruleOriginDefinition("automation_roichat")).toMatchObject({
      label: "Compra no ROI Chat",
      lockedEvent: "Purchase",
      fallbackChannelProviders: ["roichat"],
      connection: "provider_anchor",
    });
    expect(singleUrlProviderFor("automation_roichat")).toBeNull();
    expect(automationPlatformName("automation_roichat")).toBe("ROI Chat");
    expect(automationPlatformOf("automation_roichat")).toBe("do ROI Chat");
    expect(
      ruleManageTabs("automation_roichat", { catalog: null }).map((tab) => tab.id),
    ).toEqual(["edit", "received"]);
    expect(deleteConfirmText("automation_roichat")).toContain("ROI Chat");
  });

  it("creates the rule for every ROI Chat number without a mode (born sending), value from the sale", () => {
    const draft = {
      ...emptyRuleDraft("automation_roichat"),
      name: "Compra no ROI Chat",
      scope: "all_numbers" as const,
      crossConnection: true,
      channelIds: [],
    };
    const payload = buildRulePayload(draft, context);
    expect(payload.ok).toBe(true);
    const value = payload.ok ? payload.value : {};
    expect(value).toMatchObject({
      name: "Compra no ROI Chat",
      scope: "all_numbers",
      channelIds: [],
      triggerType: "provider_automation",
      eventName: "Purchase",
      automationSource: "roichat",
      crossConnectionScope: true,
      perRuleUrl: false,
    });
    expect(value).not.toHaveProperty("mode");
    expect(value).not.toHaveProperty("defaultValueCents");
    // The shared schema accepts it without a rule value (fallback optional).
    expect(providerConversionRuleCreateInputSchema.safeParse(value).success).toBe(true);
  });

  it("keeps an optional fallback value and refuses an invalid one", () => {
    const base = {
      ...emptyRuleDraft("automation_roichat"),
      name: "Compra no ROI Chat",
      scope: "all_numbers" as const,
      crossConnection: true,
      channelIds: [],
    };
    const withFallback = buildRulePayload(
      { ...base, averageValue: "20,00", currency: "BRL" },
      context,
    );
    expect(withFallback.ok && withFallback.value).toMatchObject({
      defaultValueCents: 2_000,
      defaultCurrency: "BRL",
    });
    expect(buildRulePayload({ ...base, averageValue: "abc" }, context)).toEqual({
      ok: false,
      message: "Informe um valor de reserva válido.",
    });
  });

  it("a specific-number rule stays on that number's connection", () => {
    const draft = {
      ...emptyRuleDraft("automation_roichat"),
      name: "Compra loja",
      scope: "specific_numbers" as const,
      channelIds: ["ch_roichat_2"],
    };
    const payload = buildRulePayload(draft, context);
    expect(payload.ok && payload.value).toMatchObject({
      connectionId: "conn_roichat_b",
      channelIds: ["ch_roichat_2"],
    });
  });

  it("edits the optional fallback value of a ROI Chat rule", () => {
    expect(
      ruleEditCapabilities(
        {
          conversionRule: { eventName: "Purchase" },
          connectionId: "conn_roichat_a",
          catalog: null,
        } as never,
        "automation_roichat",
      ),
    ).toMatchObject({ value: true, currency: true, productFilter: false });
  });

  it("the shared schema refuses another event for ROI Chat", () => {
    expect(
      providerConversionRuleCreateInputSchema.safeParse({
        name: "Lead ROI Chat",
        connectionId: "conn_roichat_a",
        channelIds: [],
        scope: "all_numbers",
        triggerType: "provider_automation",
        eventName: "QualifiedLead",
        automationSource: "roichat",
      }).success,
    ).toBe(false);
  });
});
