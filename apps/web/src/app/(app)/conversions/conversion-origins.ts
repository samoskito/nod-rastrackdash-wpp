import type {
  ConversionEventNameDto,
  ProviderConversionRuleCapabilitiesDto,
  ProviderConversionRuleOriginDto,
} from "@wpptrack/shared";
import { webhookEventNames } from "@wpptrack/shared";
import {
  integrationLogoPath,
  integrationProvider,
  type IntegrationProviderId,
} from "../integrations/hub/integration-registry";

/**
 * Origens de uma regra de conversão na tela Conversões. As origens de
 * provedor espelham a API (`providerConversionRuleOrigins`); a etapa do CRM
 * (Kommo, Pipedrive) é listada só para leitura e editada na janela do CRM no Hub.
 *
 * Em quais números cada origem roda NÃO é decidido aqui: vem de
 * GET /conversion-rules/providers/capabilities (`channelProviders`). A tabela
 * `fallbackChannelProviders` só existe para rotular regras já criadas quando a
 * API de capacidades não respondeu.
 */
export type CrmRuleOrigin = "kommo" | "pipedrive";
export type RuleOriginId = ProviderConversionRuleOriginDto | CrmRuleOrigin;

export type RuleOriginDefinition = {
  id: RuleOriginId;
  kind: "provider" | "crm";
  label: string;
  /** Uma linha, sem jargão: quando a regra dispara. */
  description: string;
  /** Logo exibido quando a origem é uma plataforma própria. */
  logoProvider: IntegrationProviderId | null;
  /**
   * Provedores dos números onde a origem roda, na matriz desta edição
   * (usada só se a API de capacidades não respondeu).
   */
  fallbackChannelProviders: readonly string[];
  /**
   * "provider_anchor" (Umbler/Unnichat; Fase 6.1a, porte do #159): a
   * automação por endereço guarda uma conexão só como âncora da regra
   * (escolhida automaticamente). "Todos os números" vale para os números da
   * conexão, ou para todos os números do provedor em qualquer conexão quando
   * a regra é "todas as conexões" (a Unnichat cria uma conexão por número);
   * números específicos ficam numa conexão só.
   * "any": a regra de venda (Payt) fica presa à conexão dos números
   * escolhidos, só como âncora da URL; a Payt não tem conexão própria.
   */
  connection: "none" | "provider_anchor" | "any";
  /** Evento fixo da origem. */
  lockedEvent?: ConversionEventNameDto;
  /** Eventos que a origem reconhece (padrão: todo o catálogo). */
  allowedEvents?: readonly ConversionEventNameDto[];
  /** Eventos ainda em beta nesta origem (selo “beta”); a API informa o atual. */
  betaEvents?: readonly ConversionEventNameDto[];
};

export const ruleOriginDefinitions: readonly RuleOriginDefinition[] = [
  {
    id: "message_phrase",
    kind: "provider",
    label: "Frase na conversa",
    description:
      "Quando a equipe (ou o contato, na Umbler) manda uma mensagem com a frase combinada.",
    logoProvider: null,
    fallbackChannelProviders: ["umbler", "uazapi", "waha"],
    connection: "none",
  },
  {
    id: "whatsapp_label",
    kind: "provider",
    label: "Etiqueta no WhatsApp",
    description:
      "Quando a equipe coloca uma etiqueta no contato, nos números da Uazapi (a WAHA não tem etiquetas).",
    logoProvider: "uazapi_byo",
    fallbackChannelProviders: ["uazapi"],
    connection: "none",
  },
  {
    id: "structured_catalog",
    kind: "provider",
    label: "Pedido pelo catálogo",
    description:
      "Quando a mensagem traz um pedido com produto e preço do seu catálogo (Umbler).",
    logoProvider: null,
    fallbackChannelProviders: ["umbler"],
    connection: "none",
    lockedEvent: "Purchase",
  },
  {
    id: "automation_umbler",
    kind: "provider",
    label: "Automação da Umbler",
    description:
      "Quando uma automação do Umbler Talk chama o endereço do evento (vale para todos os números, de todas as conexões).",
    logoProvider: "umbler",
    fallbackChannelProviders: ["umbler"],
    connection: "provider_anchor",
    // O callback da Umbler só conhece estas duas automações.
    allowedEvents: ["QualifiedLead", "Purchase"],
  },
  {
    id: "automation_unnichat",
    kind: "provider",
    label: "Automação do Unnichat",
    description:
      "Quando um fluxo do Unnichat chama a URL do evento (vale para todos os números, de todas as conexões). Qualquer evento do catálogo.",
    logoProvider: "unnichat",
    fallbackChannelProviders: ["unnichat"],
    connection: "provider_anchor",
    // O evento vem da regra, nunca do corpo enviado pelo Unnichat: sem
    // lista de eventos, vale todo o catálogo.
  },
  {
    // Fase 6.8 (porte do #183): a compra chega na mesma URL do número do ROI
    // Chat que recebeu a entrada do lead; uma conexão por número.
    id: "automation_roichat",
    kind: "provider",
    label: "Compra no ROI Chat",
    description:
      "Quando o ROI Chat avisa uma compra na URL do número (event_name Purchase), com o valor e a moeda da venda.",
    logoProvider: "roichat",
    fallbackChannelProviders: ["roichat"],
    connection: "provider_anchor",
    lockedEvent: "Purchase",
    allowedEvents: ["Purchase"],
  },
  {
    // Porte do SaaS e279af76: mesmo modelo da automação do Unnichat (uma URL
    // por regra/evento); o location.id do Workflow diz de qual número
    // GoHighLevel ela é. Só conta o contato que veio de anúncio.
    id: "automation_gohighlevel",
    kind: "provider",
    label: "Etapa no GoHighLevel",
    description:
      "Quando uma etapa do Workflow do GoHighLevel chama a URL da regra (ação Webhook), em qualquer localização conectada.",
    logoProvider: "gohighlevel",
    fallbackChannelProviders: ["gohighlevel"],
    connection: "provider_anchor",
    // Lead qualificado primeiro (padrão): uma regra "Lead recebido" pode
    // substituir o envio da entrada, então nunca é o padrão.
    allowedEvents: ["QualifiedLead", "Purchase", "LeadSubmitted"],
  },
  {
    id: "automation_payt",
    kind: "provider",
    label: "Venda na Payt",
    description:
      "Quando a Payt avisa uma compra aprovada, um Pix/boleto gerado ou um carrinho abandonado de alguém que chegou pelo WhatsApp.",
    logoProvider: "payt",
    fallbackChannelProviders: [
      "umbler",
      "gupshup",
      "uazapi",
      "meta_cloud",
      "data_crazy",
      "unnichat",
      "waha",
      "roichat",
      "gohighlevel",
    ],
    connection: "any",
    // O evento vem do status de cada venda; o valor vem da própria venda.
    allowedEvents: ["Purchase", "InitiateCheckout", "CartAbandoned"],
    betaEvents: ["CartAbandoned"],
  },
  {
    // Fase 6.5: mesma base da Payt (só pela URL única da Braip).
    id: "automation_braip",
    kind: "provider",
    label: "Venda na Braip",
    description:
      "Quando a Braip avisa uma compra aprovada, um boleto/Pix gerado ou um checkout abandonado de alguém que chegou pelo WhatsApp.",
    logoProvider: "braip",
    fallbackChannelProviders: [
      "umbler",
      "gupshup",
      "uazapi",
      "meta_cloud",
      "data_crazy",
      "unnichat",
      "waha",
      "roichat",
      "gohighlevel",
    ],
    connection: "any",
    // O evento vem do status de cada venda; o valor vem da própria venda.
    allowedEvents: ["Purchase", "InitiateCheckout", "CartAbandoned"],
    betaEvents: ["CartAbandoned"],
  },
  {
    // Fase 6.7 (porte do SaaS #186): mesma base da Braip (só pela URL única
    // da Yampi). No nod é liberada para todos os workspaces.
    id: "automation_yampi",
    kind: "provider",
    label: "Venda na Yampi",
    description:
      "Quando a Yampi avisa um pedido pago, um pedido aguardando pagamento (boleto/Pix) ou um carrinho abandonado de alguém que chegou pelo WhatsApp.",
    logoProvider: "yampi",
    fallbackChannelProviders: [
      "umbler",
      "gupshup",
      "uazapi",
      "meta_cloud",
      "data_crazy",
      "unnichat",
      "waha",
      "roichat",
      "gohighlevel",
    ],
    connection: "any",
    // O evento vem do campo `event` de cada aviso; o valor (só os produtos)
    // vem da própria venda.
    allowedEvents: ["Purchase", "InitiateCheckout", "CartAbandoned"],
    betaEvents: ["CartAbandoned"],
  },
  {
    // Webhook / n8n (porte do SaaS 098d0950): o n8n, o painel de atendimento
    // ou o robô SDR chama a URL de uma regra. Sempre todos os números; uma
    // regra por evento; o lead pode ter vindo de qualquer conexão do aluno
    // (API Oficial, Uazapi ou WAHA por URL + token, Umbler, Unnichat...).
    id: "automation_webhook",
    kind: "provider",
    label: "Webhook / n8n",
    description:
      "Quando o seu n8n, painel ou robô chama a URL da regra, para o contato que veio do anúncio.",
    logoProvider: null,
    fallbackChannelProviders: [
      "umbler",
      "gupshup",
      "uazapi",
      "meta_cloud",
      "data_crazy",
      "unnichat",
      "waha",
      "roichat",
      "gohighlevel",
    ],
    connection: "any",
    allowedEvents: [...webhookEventNames],
  },
  {
    id: "kommo",
    kind: "crm",
    label: "Etapa no Kommo",
    description: "Quando o lead muda de etapa no funil do Kommo.",
    logoProvider: "kommo",
    fallbackChannelProviders: [],
    connection: "none",
  },
  {
    id: "pipedrive",
    kind: "crm",
    label: "Etapa ou negócio ganho no Pipedrive",
    description: "Quando o negócio avança de etapa ou é ganho no Pipedrive.",
    logoProvider: "pipedrive",
    fallbackChannelProviders: [],
    connection: "none",
  },
];

export function ruleOriginDefinition(id: RuleOriginId): RuleOriginDefinition {
  const definition = ruleOriginDefinitions.find((item) => item.id === id);

  if (!definition) {
    throw new Error(`Unknown rule origin: ${id}`);
  }

  return definition;
}

export function isRuleOriginId(value: unknown): value is RuleOriginId {
  return ruleOriginDefinitions.some((item) => item.id === value);
}

/** Provedores de número onde a origem roda (API de capacidades primeiro). */
export function originChannelProviders(
  origin: RuleOriginId,
  capabilities: ProviderConversionRuleCapabilitiesDto | null,
): readonly string[] {
  const definition = ruleOriginDefinition(origin);
  if (definition.kind === "crm") return [];

  return (
    capabilities?.origins.find((item) => item.origin === origin)
      ?.channelProviders ?? definition.fallbackChannelProviders
  );
}

/**
 * Eventos que a origem reconhece, na ordem da tela. A API de capacidades
 * manda (`eventNames`); sem ela vale a lista da origem.
 */
export function originEventNames(
  origin: RuleOriginId,
  capabilities: ProviderConversionRuleCapabilitiesDto | null,
): readonly ConversionEventNameDto[] | null {
  const definition = ruleOriginDefinition(origin);
  const fromApi = capabilities?.origins.find(
    (item) => item.origin === origin,
  )?.eventNames;

  return fromApi && fromApi.length > 0
    ? fromApi
    : (definition.allowedEvents ?? null);
}

/** Eventos em beta da origem (API primeiro; só a Payt tem hoje). */
export function originBetaEvents(
  origin: RuleOriginId,
  capabilities: ProviderConversionRuleCapabilitiesDto | null,
): readonly ConversionEventNameDto[] {
  const fromApi = capabilities?.origins.find(
    (item) => item.origin === origin,
  )?.betaEventNames;

  return fromApi ?? ruleOriginDefinition(origin).betaEvents ?? [];
}

/** Provedores que leem mensagens do contato (regra "Só o contato"). */
export function contactMessageProviders(
  capabilities: ProviderConversionRuleCapabilitiesDto | null,
): readonly string[] {
  const entry = capabilities?.origins.find(
    (item) => item.origin === "message_phrase",
  );
  return entry?.authorChannelProviders?.contact ?? ["umbler"];
}

export type RuleLogo = {
  src: string;
  surface: "dark" | "light";
  name: string;
};

export function providerLogo(id: IntegrationProviderId): RuleLogo {
  const provider = integrationProvider(id);

  return {
    src: integrationLogoPath(id),
    surface: provider.logoSurface,
    name: provider.name,
  };
}

/** Cartão do Hub de um provedor de entrada ("uazapi" é o cartão Uazapi; "waha", o da WAHA). */
export function hubProviderForInbound(
  provider: string,
): IntegrationProviderId | null {
  switch (provider) {
    case "uazapi":
      return "uazapi_byo";
    case "umbler":
    case "gupshup":
    case "data_crazy":
    case "unnichat":
    case "meta_cloud":
    case "waha":
    case "roichat":
    case "gohighlevel":
      return provider;
    default:
      return null;
  }
}

/** Nome do provedor de um número, para avisos ("Gupshup", "WAHA"...). */
export function providerDisplayName(provider: string): string {
  switch (provider) {
    case "uazapi":
    case "uazapi_byo":
      return "Uazapi";
    case "waha":
      return "WAHA";
    case "zapi":
      return "Z-API";
    case "nod_api":
      return "NOD API";
    case "meta_cloud":
      return "WhatsApp Cloud API";
    case "umbler":
      return "Umbler Talk";
    case "gupshup":
      return "Gupshup";
    case "data_crazy":
      return "Data Crazy";
    case "unnichat":
      return "Unnichat";
    case "roichat":
      return "ROI Chat";
    case "gohighlevel":
      return "GoHighLevel";
    default:
      return provider;
  }
}

/** Onde as regras do CRM são editadas: janela do CRM no Hub (aba CRM). */
export function crmManageHref(origin: CrmRuleOrigin): string {
  return `/integrations?abrir=${origin}`;
}

/**
 * Fase 6.1a (porte do #159): a plataforma de uma automação com o artigo do
 * texto do nod ("da Umbler", "do Unnichat"; "na Umbler", "no Unnichat").
 */
export function automationPlatformOf(origin: string): string {
  if (origin === "automation_roichat") return "do ROI Chat";
  if (origin === "automation_gohighlevel") return "do GoHighLevel";
  return origin === "automation_umbler" ? "da Umbler" : "do Unnichat";
}

export function automationPlatformIn(origin: string): string {
  if (origin === "automation_roichat") return "no ROI Chat";
  if (origin === "automation_gohighlevel") return "no GoHighLevel";
  return origin === "automation_umbler" ? "na Umbler" : "no Unnichat";
}
