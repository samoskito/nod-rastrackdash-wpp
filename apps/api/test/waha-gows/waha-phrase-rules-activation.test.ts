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
  canonicalPhoneChannel,
  providerRuleCapabilities,
  selectApplicableProviderRules,
  type ScopedChannel,
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

describe("mesmo telefone em Uazapi e WAHA: o canal vivo vence", () => {
  const now = new Date("2026-10-24T12:00:00.000Z");
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  const channel = (
    id: string,
    provider: string,
    overrides: Partial<ScopedChannel> = {},
  ): ScopedChannel => ({
    id,
    connectionId: `connection_${id}`,
    provider,
    phoneKey: "5511987654321",
    status: "active",
    productionReady: true,
    ...overrides,
  });
  const globalRule = {
    id: "global",
    scope: "all_numbers",
    connectionId: null,
    channels: [],
    removedAt: null,
    conversionRule: { triggerType: "message_phrase", eventName: "Purchase", active: true },
    parserRelease: null,
    connection: null,
    messageAuthorScope: "team",
  } as never;

  function runsOn(channels: ScopedChannel[]): string[] {
    return channels
      .filter(
        (candidate) =>
          selectApplicableProviderRules([globalRule], candidate, {
            phoneChannels: channels,
          }).applicable.length === 1,
      )
      .map((candidate) => candidate.id);
  }

  it("Uazapi antiga parada e WAHA ativa: a regra global roda só na WAHA", () => {
    const uazapi = channel("uazapi", "uazapi", {
      createdAt: hoursAgo(24 * 90),
      lastSeenAt: hoursAgo(48),
    });
    const waha = channel("waha", "waha", {
      createdAt: hoursAgo(24),
      lastSeenAt: hoursAgo(0),
    });
    expect(canonicalPhoneChannel([uazapi, waha])?.id).toBe("waha");
    expect(runsOn([uazapi, waha])).toEqual(["waha"]);
  });

  it("o inverso: WAHA parada e Uazapi ativa, roda só na Uazapi", () => {
    const uazapi = channel("uazapi", "uazapi", {
      createdAt: hoursAgo(24),
      lastSeenAt: hoursAgo(0),
    });
    const waha = channel("waha", "waha", {
      createdAt: hoursAgo(24 * 90),
      lastSeenAt: hoursAgo(48),
    });
    expect(runsOn([uazapi, waha])).toEqual(["uazapi"]);
  });

  it("dois canais vivos do mesmo telefone: um só vencedor estável (ativo, depois o mais antigo)", () => {
    const older = channel("older", "uazapi", {
      createdAt: hoursAgo(100),
      lastSeenAt: hoursAgo(0.01),
    });
    const newer = channel("newer", "waha", {
      createdAt: hoursAgo(10),
      lastSeenAt: hoursAgo(0),
    });
    expect(runsOn([older, newer])).toEqual(["older"]);
    // An inactive channel loses to an active one when both are live.
    expect(runsOn([{ ...older, status: "paused" }, newer])).toEqual(["newer"]);
  });

  it("um canal só por telefone continua sendo o próprio vencedor", () => {
    const only = channel("only", "waha", { lastSeenAt: hoursAgo(500), productionReady: false });
    expect(canonicalPhoneChannel([only])?.id).toBe("only");
    expect(runsOn([only])).toEqual(["only"]);
  });
});
