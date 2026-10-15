import { Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  providerConversionRuleGlobalPrecedence,
  type ProviderConversionRuleCapabilitiesDto,
  type ProviderConversionRuleOriginDto,
  type ProviderConversionRuleScopeDto,
} from "@wpptrack/shared";
import { phoneIdentityKey } from "../common/phone/phone-identity";

/**
 * Alcance das regras de conversao por provedor (Fase 3, Conversoes).
 *
 * Sempre ligado nesta edicao (sem variavel de ambiente). Uma regra e avaliada
 * num canal (numero de WhatsApp) quando:
 *  - scope "specific_numbers" (toda regra criada antes desta fase): o canal e
 *    uma das linhas ProviderConversionRuleChannel da regra; ou
 *  - scope "all_numbers": o provedor do canal suporta a origem da regra (e,
 *    para a automacao Umbler, o canal e da conexao da regra). Avaliado na
 *    hora, entao numeros conectados depois entram automaticamente.
 *
 * Precedencia: num canal, uma regra especifica ativa com a mesma origem e o
 * mesmo evento SUBSTITUI toda regra "all_numbers" dessa origem/evento; a
 * global nem e avaliada ali.
 *
 * Mesmo telefone em varios canais (ex.: o numero conectado pelo Umbler e por
 * uma instancia Uazapi): os dois canais veem a mesma mensagem da equipe. A
 * regra global roda em UM canal canonico por telefone (ativo primeiro, depois
 * o mais antigo), e uma regra especifica em qualquer canal desse telefone
 * substitui a global em todos os canais dele. Canais sem telefone verificavel
 * ficam independentes; o dedupe de negocio (evento + workspace + lead) segue
 * como rede de seguranca contra envio duplicado.
 *
 * Matriz de capacidade desta edicao (derivada dos parsers/ingestao):
 *  - frase da equipe: umbler (observacao de mensagens) e uazapi (fromMe=true
 *    no webhook Uazapi/uazapi_byo);
 *  - frase do contato: umbler (o parser marca authorType "contact"); Uazapi
 *    so avalia mensagens da equipe; gupshup/data_crazy/meta_cloud ainda nao
 *    avaliam regras de mensagem (a observacao so aceita eventos umbler);
 *  - catalogo estruturado: umbler;
 *  - etiqueta: uazapi (por nome entre instancias);
 *  - automacao Umbler: presa a conexao que recebe o callback.
 *  WAHA, Z-API e NOD API nao entram em regras de provedor (nao possuem canal
 *  de entrada); ficam "Em breve".
 */

export type ProviderRuleScope = ProviderConversionRuleScopeDto;
export type ProviderRuleOrigin = ProviderConversionRuleOriginDto;

/** Minimal rule shape every caller can provide from its own include. */
export type ScopedProviderRule = {
  id: string;
  scope?: string | null;
  connectionId: string | null;
  removedAt?: Date | null;
  messageAuthorScope?: string | null;
  conversionRule: {
    triggerType: string;
    eventName: string;
    active?: boolean;
  };
  parserRelease?: { provider: string } | null;
  connection?: { provider: string } | null;
  channels: ReadonlyArray<{ channelId: string }>;
};

/** A WhatsApp channel and the provider of the connection it belongs to. */
export type ScopedChannel = {
  id: string;
  connectionId: string;
  provider: string;
  /** BR-equivalent phone identity of the connected number (null: unknown). */
  phoneKey?: string | null;
  status?: string;
  createdAt?: Date;
};

/** For UI copy: a specific rule disables the global rule on that number. */
export const PROVIDER_RULE_GLOBAL_PRECEDENCE =
  providerConversionRuleGlobalPrecedence;

/** Reason recorded when a global rule yields to a specific one. */
export const PROVIDER_RULE_OVERRIDDEN_REASON = "overridden_by_specific_rule";

/** Providers whose TEAM messages run message_phrase rules. */
export const MESSAGE_TEAM_CHANNEL_PROVIDERS = ["umbler", "uazapi"] as const;
/** Providers whose CONTACT messages run message_phrase rules. */
export const MESSAGE_CONTACT_CHANNEL_PROVIDERS = ["umbler"] as const;
/** Providers whose messages run structured catalog rules. */
export const CATALOG_RULE_CHANNEL_PROVIDERS = ["umbler"] as const;
/** Providers whose chats expose WhatsApp labels (tags). */
export const LABEL_RULE_CHANNEL_PROVIDERS = ["uazapi"] as const;
/** WhatsApp providers of this edition that do not run provider rules yet. */
export const UNSUPPORTED_RULE_WHATSAPP_PROVIDERS = [
  "waha",
  "zapi",
  "nod_api",
] as const;

export function providerRuleScope(rule: {
  scope?: string | null;
}): ProviderRuleScope {
  return rule.scope === "all_numbers" ? "all_numbers" : "specific_numbers";
}

/**
 * Origin of a rule, from its trigger and the parser it is bound to. An unbound
 * provider_automation rule can only be a WhatsApp label rule: the Umbler
 * automation always keeps its connection and parser release.
 */
export function providerRuleOrigin(
  rule: Pick<
    ScopedProviderRule,
    "conversionRule" | "parserRelease" | "connection"
  >,
): ProviderRuleOrigin | null {
  switch (rule.conversionRule.triggerType) {
    case "message_phrase":
      return "message_phrase";
    case "structured_catalog":
      return "structured_catalog";
    case "provider_automation": {
      const provider =
        rule.parserRelease?.provider ?? rule.connection?.provider ?? null;
      if (provider === null || provider === "uazapi") return "whatsapp_label";
      if (provider === "umbler") return "automation_umbler";
      return null;
    }
    default:
      return null;
  }
}

/** Channel providers on which a rule origin can be evaluated (any author). */
export function providerRuleOriginChannelProviders(
  origin: ProviderRuleOrigin,
): readonly string[] {
  switch (origin) {
    case "message_phrase":
      return MESSAGE_TEAM_CHANNEL_PROVIDERS;
    case "structured_catalog":
      return CATALOG_RULE_CHANNEL_PROVIDERS;
    case "whatsapp_label":
      return LABEL_RULE_CHANNEL_PROVIDERS;
    case "automation_umbler":
      return ["umbler"];
  }
}

/**
 * Channel providers on which THIS rule can match: a message rule restricted
 * to contact messages only runs where contact messages are evaluated.
 */
export function providerRuleChannelProviders(
  rule: Pick<
    ScopedProviderRule,
    "conversionRule" | "parserRelease" | "connection" | "messageAuthorScope"
  >,
): readonly string[] {
  const origin = providerRuleOrigin(rule);
  if (!origin) return [];
  if (origin === "message_phrase" && rule.messageAuthorScope === "contact") {
    return MESSAGE_CONTACT_CHANNEL_PROVIDERS;
  }
  return providerRuleOriginChannelProviders(origin);
}

/**
 * The Umbler automation resolves the contact on the connection that received
 * the callback, so even "all numbers" means all numbers of that connection.
 */
export function providerRuleOriginIsConnectionBound(
  origin: ProviderRuleOrigin,
): boolean {
  return origin === "automation_umbler";
}

/** Origins whose rule must keep a connection binding (signed endpoint). */
export function providerRuleOriginRequiresConnection(
  origin: ProviderRuleOrigin,
): boolean {
  return origin === "automation_umbler";
}

/** Origins that "Unificar" may merge (never endpoint automations). */
export function providerRuleOriginUnifiable(origin: ProviderRuleOrigin): boolean {
  return (
    origin === "message_phrase" ||
    origin === "structured_catalog" ||
    origin === "whatsapp_label"
  );
}

/** Capability matrix exposed to the Conversions screen. */
export function providerRuleCapabilities(): ProviderConversionRuleCapabilitiesDto {
  const origins: ProviderConversionRuleCapabilitiesDto["origins"] = [
    {
      origin: "message_phrase",
      scopes: ["all_numbers", "specific_numbers"],
      channelProviders: [...MESSAGE_TEAM_CHANNEL_PROVIDERS],
      authorChannelProviders: {
        team: [...MESSAGE_TEAM_CHANNEL_PROVIDERS],
        contact: [...MESSAGE_CONTACT_CHANNEL_PROVIDERS],
      },
      connectionBound: false,
      labelMatch: null,
      unifiable: true,
    },
    {
      origin: "structured_catalog",
      scopes: ["all_numbers", "specific_numbers"],
      channelProviders: [...CATALOG_RULE_CHANNEL_PROVIDERS],
      authorChannelProviders: null,
      connectionBound: false,
      labelMatch: null,
      unifiable: true,
    },
    {
      origin: "whatsapp_label",
      scopes: ["all_numbers", "specific_numbers"],
      channelProviders: [...LABEL_RULE_CHANNEL_PROVIDERS],
      authorChannelProviders: null,
      connectionBound: false,
      labelMatch: "name_across_instances",
      unifiable: true,
    },
    {
      origin: "automation_umbler",
      scopes: ["all_numbers", "specific_numbers"],
      channelProviders: ["umbler"],
      authorChannelProviders: null,
      connectionBound: true,
      labelMatch: null,
      unifiable: false,
    },
  ];
  return {
    workspaceScopeEnabled: true,
    globalPrecedence: PROVIDER_RULE_GLOBAL_PRECEDENCE,
    origins,
    unsupportedWhatsappProviders: [...UNSUPPORTED_RULE_WHATSAPP_PROVIDERS],
  };
}

export function providerRulePrecedenceKey(
  rule: Pick<
    ScopedProviderRule,
    "conversionRule" | "parserRelease" | "connection"
  >,
): string | null {
  const origin = providerRuleOrigin(rule);
  return origin ? `${origin}|${rule.conversionRule.eventName}` : null;
}

function isLiveRule(rule: ScopedProviderRule): boolean {
  return rule.conversionRule.active !== false && !rule.removedAt;
}

/** Whether the rule's scope (ignoring precedence) includes this channel. */
export function providerRuleCoversChannel(
  rule: ScopedProviderRule,
  channel: ScopedChannel,
): boolean {
  if (providerRuleScope(rule) === "specific_numbers") {
    return rule.channels.some((scope) => scope.channelId === channel.id);
  }
  const origin = providerRuleOrigin(rule);
  if (!origin) return false;
  if (!providerRuleChannelProviders(rule).includes(channel.provider))
    return false;
  return (
    !providerRuleOriginIsConnectionBound(origin) ||
    rule.connectionId === channel.connectionId
  );
}

export type ProviderRuleApplicability<R> = {
  /** Rules to evaluate on the channel, in the input order. */
  applicable: R[];
  /** Global rules skipped on this channel and the specific rules that won. */
  overridden: Array<{ rule: R; bySpecificRuleIds: string[] }>;
  /** Global rules skipped because the same phone runs them on another channel. */
  duplicatePhone: Array<{ rule: R; canonicalChannelId: string }>;
};

export type ProviderRulePhoneContext = {
  /** Every live channel of the same phone, including the channel itself. */
  phoneChannels?: readonly ScopedChannel[];
  /** Specific rules (beyond `rules`) that may own a channel of that phone. */
  peerRules?: readonly ScopedProviderRule[];
};

/** Active channels first, then the oldest, then the smallest id. */
export function canonicalPhoneChannel(
  channels: readonly ScopedChannel[],
): ScopedChannel | null {
  const sorted = [...channels].sort((left, right) => {
    const leftActive = left.status === undefined || left.status === "active";
    const rightActive = right.status === undefined || right.status === "active";
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    const byDate =
      (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0);
    if (byDate !== 0) return byDate;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return sorted[0] ?? null;
}

/**
 * Applies scope + precedence for one channel. Input order is preserved, so a
 * set of specific-only rules (every rule before this phase) comes back exactly
 * as the old `rule.channels.some(...)` filter returned it. `context` carries
 * the other channels of the same phone (see the module comment).
 */
export function selectApplicableProviderRules<R extends ScopedProviderRule>(
  rules: readonly R[],
  channel: ScopedChannel,
  context: ProviderRulePhoneContext = {},
): ProviderRuleApplicability<R> {
  const phoneChannels = context.phoneChannels?.some(
    (candidate) => candidate.id === channel.id,
  )
    ? context.phoneChannels
    : [channel, ...(context.phoneChannels ?? [])];
  const covering = rules.filter(
    (rule) => isLiveRule(rule) && providerRuleCoversChannel(rule, channel),
  );
  const specificByKey = new Map<string, Set<string>>();
  for (const rule of [...rules, ...(context.peerRules ?? [])]) {
    if (!isLiveRule(rule) || providerRuleScope(rule) !== "specific_numbers")
      continue;
    const key = providerRulePrecedenceKey(rule);
    if (!key) continue;
    if (
      !phoneChannels.some((candidate) =>
        providerRuleCoversChannel(rule, candidate),
      )
    )
      continue;
    specificByKey.set(key, (specificByKey.get(key) ?? new Set()).add(rule.id));
  }
  const applicable: R[] = [];
  const overridden: ProviderRuleApplicability<R>["overridden"] = [];
  const duplicatePhone: ProviderRuleApplicability<R>["duplicatePhone"] = [];
  for (const rule of covering) {
    if (providerRuleScope(rule) !== "all_numbers") {
      applicable.push(rule);
      continue;
    }
    const key = providerRulePrecedenceKey(rule);
    const winners = key ? specificByKey.get(key) : undefined;
    if (winners?.size) {
      overridden.push({ rule, bySpecificRuleIds: [...winners] });
      continue;
    }
    const canonical = canonicalPhoneChannel(
      phoneChannels.filter((candidate) =>
        providerRuleCoversChannel(rule, candidate),
      ),
    );
    if (canonical && canonical.id !== channel.id) {
      duplicatePhone.push({ rule, canonicalChannelId: canonical.id });
      continue;
    }
    applicable.push(rule);
  }
  return { applicable, overridden, duplicatePhone };
}

/**
 * Prisma filter for "rules that may apply to a channel of `connectionId`":
 * rules bound to that connection or unbound ones, which are either scoped to
 * one of the channels or global. Precedence and capability are then applied in
 * memory by `selectApplicableProviderRules`.
 */
export function providerRuleCandidateWhere(input: {
  connectionId: string;
  channelIds: string[];
}): Prisma.ProviderConversionRuleConfigWhereInput {
  return {
    AND: [
      { OR: [{ connectionId: input.connectionId }, { connectionId: null }] },
      {
        OR: [
          {
            channels: {
              some:
                input.channelIds.length === 1
                  ? { channelId: input.channelIds[0]! }
                  : { channelId: { in: input.channelIds } },
            },
          },
          { scope: "all_numbers" },
        ],
      },
    ],
  };
}

type ChannelLookupClient = Pick<
  Prisma.TransactionClient,
  "inboundWebhookChannel"
>;

/** Page size of the workspace channel scan. */
export const PROVIDER_RULE_SCOPE_CHANNEL_PAGE = 500;
/** Hard bound: a scope never silently truncates; past this it refuses. */
export const PROVIDER_RULE_SCOPE_CHANNEL_LIMIT = 5_000;

const scopeLogger = new Logger("ProviderRuleScope");

/**
 * Phone of a channel. A Uazapi bridge channel stores a placeholder (the
 * provider instance id or the instance id) until a connection test reports
 * the real number, so only a value different from those placeholders is a
 * phone. Unverifiable values yield null (the channel stays independent).
 */
export function channelPhoneKey(channel: {
  connectedPhone?: string | null;
  providerChannelId?: string | null;
  organizationId?: string | null;
  provider?: string | null;
}): string | null {
  const phone = channel.connectedPhone?.trim();
  if (!phone) return null;
  if (
    channel.provider === "uazapi" &&
    (phone === channel.providerChannelId?.trim() ||
      phone === channel.organizationId?.trim())
  ) {
    return null;
  }
  return phoneIdentityKey(phone) ?? null;
}

/**
 * Every live channel of the workspace with its connection provider and phone.
 * Channels of removed connections, and of deleted (suspended) WhatsApp
 * instances, are never part of a dynamic scope. Pages through the workspace;
 * past PROVIDER_RULE_SCOPE_CHANNEL_LIMIT it fails instead of truncating.
 */
export async function listWorkspaceScopeChannels(
  client: ChannelLookupClient,
  workspaceId: string,
): Promise<ScopedChannel[]> {
  const result: ScopedChannel[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await client.inboundWebhookChannel.findMany({
      where: {
        workspaceId,
        connection: { is: { workspaceId, removedAt: null } },
        OR: [
          { whatsappInstanceId: null },
          { whatsappInstance: { is: { status: { not: "suspended" } } } },
        ],
      },
      select: {
        id: true,
        connectionId: true,
        organizationId: true,
        providerChannelId: true,
        status: true,
        createdAt: true,
        connectedPhone: true,
        connection: { select: { provider: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: PROVIDER_RULE_SCOPE_CHANNEL_PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    for (const channel of page) {
      const provider = channel.connection?.provider ?? "";
      result.push({
        id: channel.id,
        connectionId: channel.connectionId,
        provider,
        phoneKey: channelPhoneKey({ ...channel, provider }),
        status: channel.status,
        createdAt: channel.createdAt,
      });
    }
    if (result.length > PROVIDER_RULE_SCOPE_CHANNEL_LIMIT) {
      scopeLogger.warn(
        JSON.stringify({
          event: "provider_rule_scope_channel_limit",
          workspaceId,
          limit: PROVIDER_RULE_SCOPE_CHANNEL_LIMIT,
        }),
      );
      throw new Error("provider_rule_scope_channel_limit_exceeded");
    }
    if (page.length < PROVIDER_RULE_SCOPE_CHANNEL_PAGE) return result;
    cursor = page[page.length - 1]!.id;
  }
}

/** Channels of the same phone as `channelId` (itself included). */
export function samePhoneChannels(
  channels: readonly ScopedChannel[],
  channelId: string,
): ScopedChannel[] {
  const self = channels.find((channel) => channel.id === channelId);
  if (!self) return [];
  if (!self.phoneKey) return [self];
  return channels.filter((channel) => channel.phoneKey === self.phoneKey);
}

/**
 * Channel ids a rule may resolve an occurrence to (scope only, precedence is
 * applied once the channel is known). Specific rules answer without a query.
 */
export async function resolveProviderRuleScopeChannelIds(
  client: ChannelLookupClient,
  workspaceId: string,
  rule: ScopedProviderRule,
): Promise<string[]> {
  if (providerRuleScope(rule) === "specific_numbers") {
    return rule.channels.map((scope) => scope.channelId);
  }
  const channels = await listWorkspaceScopeChannels(client, workspaceId);
  return channels
    .filter((channel) => providerRuleCoversChannel(rule, channel))
    .map((channel) => channel.id);
}

type RuleLookupClient = Pick<
  Prisma.TransactionClient,
  "providerConversionRuleConfig"
>;

const peerRuleSelect = {
  id: true,
  scope: true,
  connectionId: true,
  removedAt: true,
  messageAuthorScope: true,
  conversionRule: {
    select: { triggerType: true, eventName: true, active: true },
  },
  parserRelease: { select: { provider: true } },
  connection: { select: { provider: true } },
  channels: { select: { channelId: true } },
} satisfies Prisma.ProviderConversionRuleConfigSelect;

/** Active specific rules of the given triggers scoped to any of the channels. */
async function loadSpecificPeerRules(
  client: RuleLookupClient,
  input: { workspaceId: string; channelIds: string[]; triggerTypes: string[] },
): Promise<ScopedProviderRule[]> {
  if (input.channelIds.length === 0 || input.triggerTypes.length === 0)
    return [];
  return client.providerConversionRuleConfig.findMany({
    where: {
      workspaceId: input.workspaceId,
      removedAt: null,
      scope: "specific_numbers",
      conversionRule: {
        active: true,
        triggerType: { in: input.triggerTypes as never[] },
      },
      channels: { some: { channelId: { in: input.channelIds } } },
    },
    select: peerRuleSelect,
    take: 200,
  });
}

/**
 * Scope + precedence for one occurrence channel, phone-aware. Rule sets
 * without any live global rule (every rule created before this phase) take
 * the synchronous path and issue no query at all.
 */
export async function resolveApplicableProviderRules<
  R extends ScopedProviderRule,
>(
  client: ChannelLookupClient & RuleLookupClient,
  input: { workspaceId: string; rules: readonly R[]; channel: ScopedChannel },
): Promise<ProviderRuleApplicability<R>> {
  const globals = input.rules.filter(
    (rule) => isLiveRule(rule) && providerRuleScope(rule) === "all_numbers",
  );
  if (globals.length === 0) {
    return selectApplicableProviderRules(input.rules, input.channel);
  }
  const channels = await listWorkspaceScopeChannels(client, input.workspaceId);
  const phoneChannels = samePhoneChannels(channels, input.channel.id).map(
    (candidate) =>
      // The occurrence knows its own provider/connection for sure.
      candidate.id === input.channel.id
        ? { ...candidate, ...input.channel, phoneKey: candidate.phoneKey }
        : candidate,
  );
  const self =
    phoneChannels.find((candidate) => candidate.id === input.channel.id) ??
    input.channel;
  const siblingIds = phoneChannels
    .map((candidate) => candidate.id)
    .filter((id) => id !== input.channel.id);
  const peerRules = await loadSpecificPeerRules(client, {
    workspaceId: input.workspaceId,
    channelIds: siblingIds,
    triggerTypes: [
      ...new Set(globals.map((rule) => rule.conversionRule.triggerType)),
    ],
  });
  return selectApplicableProviderRules(input.rules, self, {
    phoneChannels,
    peerRules,
  });
}

/**
 * For an all_numbers rule whose occurrence resolved to `channelId`: the active
 * specific rules of the same origin and event that own that channel, or any
 * channel of the same phone. Empty for specific rules (never overridden).
 */
export async function findOverridingSpecificRuleIds(
  client: ChannelLookupClient & RuleLookupClient,
  input: { workspaceId: string; rule: ScopedProviderRule; channelId: string },
): Promise<string[]> {
  if (providerRuleScope(input.rule) !== "all_numbers") return [];
  const origin = providerRuleOrigin(input.rule);
  if (!origin) return [];
  const phoneChannelIds = samePhoneChannels(
    await listWorkspaceScopeChannels(client, input.workspaceId),
    input.channelId,
  ).map((channel) => channel.id);
  const channelIds = [...new Set([input.channelId, ...phoneChannelIds])];
  const candidates = await client.providerConversionRuleConfig.findMany({
    where: {
      workspaceId: input.workspaceId,
      id: { not: input.rule.id },
      removedAt: null,
      scope: "specific_numbers",
      conversionRule: {
        active: true,
        triggerType: input.rule.conversionRule.triggerType as never,
        eventName: input.rule.conversionRule.eventName,
      },
      channels: {
        some:
          channelIds.length === 1
            ? { channelId: input.channelId }
            : { channelId: { in: channelIds } },
      },
    },
    select: {
      id: true,
      conversionRule: { select: { triggerType: true, eventName: true } },
      parserRelease: { select: { provider: true } },
      connection: { select: { provider: true } },
    },
    take: 20,
  });
  return candidates
    .filter((candidate) => providerRuleOrigin(candidate) === origin)
    .map((candidate) => candidate.id);
}
