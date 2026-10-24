import { describe, expect, it } from "vitest";
import {
  channelConnectable,
  pendingNumberState,
  type PendingChannelRow,
} from "../../src/conversion-rules/provider-rule-global-activation";
import {
  BRIDGE_PROVISIONED_EVENTS,
  UAZAPI_BRIDGE_PROVISIONED_EVENT,
} from "../../src/conversion-rules/provider-rule-global-auto-activation.service";
import {
  CATALOG_RULE_CHANNEL_PROVIDERS,
  LABEL_RULE_CHANNEL_PROVIDERS,
  MESSAGE_CONTACT_CHANNEL_PROVIDERS,
  MESSAGE_TEAM_CHANNEL_PROVIDERS,
  providerRuleCapabilities,
} from "../../src/conversion-rules/provider-rule-scope";
import { isBridgedWhatsappProvider } from "../../src/inbound-webhooks/bridged-whatsapp-providers";
import { metaRouteRequiredForProvider } from "../../src/inbound-webhooks/inbound-webhook-production-activation";

function wahaChannel(
  overrides: Partial<PendingChannelRow> = {},
): PendingChannelRow {
  return {
    id: "channel_waha",
    connectionId: "connection_waha",
    status: "discovered",
    channelName: "WAHA Loja",
    connectedPhone: "sessao-loja",
    whatsappInstanceId: "instance_waha",
    connection: {
      id: "connection_waha",
      provider: "waha",
      status: "observation",
      removedAt: null,
    },
    routes: [],
    whatsappInstance: { status: "active" },
    ...overrides,
  } as PendingChannelRow;
}

describe("WAHA nas regras de frase: matriz e ativação", () => {
  it("a WAHA roda frase da equipe e catálogo, nunca etiqueta nem frase do contato", () => {
    expect(MESSAGE_TEAM_CHANNEL_PROVIDERS).toContain("waha");
    expect(CATALOG_RULE_CHANNEL_PROVIDERS).toContain("waha");
    expect(LABEL_RULE_CHANNEL_PROVIDERS).not.toContain("waha");
    expect(MESSAGE_CONTACT_CHANNEL_PROVIDERS).not.toContain("waha");
    const capabilities = providerRuleCapabilities();
    expect(capabilities.unsupportedWhatsappProviders).not.toContain("waha");
    expect(
      capabilities.origins.find((origin) => origin.origin === "whatsapp_label")
        ?.channelProviders,
    ).not.toContain("waha");
  });

  it("o número WAHA é cadastrado pela ponte: sem rota Meta salva, destino por anúncio", () => {
    expect(isBridgedWhatsappProvider("waha")).toBe(true);
    expect(isBridgedWhatsappProvider("uazapi")).toBe(true);
    expect(isBridgedWhatsappProvider("umbler")).toBe(false);
    expect(metaRouteRequiredForProvider("waha")).toBe(false);
    expect(metaRouteRequiredForProvider("uazapi")).toBe(false);
    expect(metaRouteRequiredForProvider("gupshup")).toBe(true);
  });

  it("só envia com a conexão WAHA ativa em Integrações", () => {
    expect(channelConnectable(wahaChannel())).toBe(true);
    expect(
      channelConnectable(wahaChannel({ whatsappInstance: { status: "suspended" } })),
    ).toBe(false);
    expect(
      channelConnectable(wahaChannel({ whatsappInstance: null })),
    ).toBe(false);
  });

  it("número WAHA ainda em observação é ativável pela regra (sem pedir rota Meta), sem mostrar a sessão como telefone", () => {
    const channel = wahaChannel();
    const state = pendingNumberState({
      channel,
      gate: { id: "connection_waha", provider: "waha", status: "observation" },
      siblings: [],
    });
    expect(state).toMatchObject({
      provider: "waha",
      reason: "channel_not_active",
      activatable: true,
      phone: null,
    });
    const paused = pendingNumberState({
      channel,
      gate: { id: "connection_waha", provider: "waha", status: "paused" },
      siblings: [],
    });
    expect(paused).toMatchObject({ reason: "connection_paused", activatable: false });
  });

  it("a ativação automática acorda com a ponte da WAHA, além da Uazapi", () => {
    expect(BRIDGE_PROVISIONED_EVENTS).toEqual(
      expect.arrayContaining([
        UAZAPI_BRIDGE_PROVISIONED_EVENT,
        "inbound_webhook.waha_bridge_provisioned",
      ]),
    );
  });
});
