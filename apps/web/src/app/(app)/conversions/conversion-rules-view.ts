import type {
  ConversionEventNameDto,
  InboundWebhookChannelDto,
  InboundWebhookConnectionDto,
  ProviderConversionRuleCapabilitiesDto,
  ProviderConversionRuleDto,
  ProviderConversionRuleOriginDto,
  ProviderConversionRulePendingNumberDto,
} from "@wpptrack/shared";
import { formatMoney } from "@wpptrack/shared";
import type { KommoConnectionDetailDto } from "../integrations/kommo-actions";
import type { PipedriveConnectionDetailDto } from "../integrations/pipedrive-actions";
import {
  isDeferredToRuleReason,
  leadSubmittedOverrideCopy,
} from "./lead-submitted-override";
import { ruleEventLabel, ruleEventLabelForOrigin } from "./event-copy";
import {
  automationPlatformOf,
  crmManageHref,
  contactMessageProviders,
  hubProviderForInbound,
  originBetaEvents,
  originChannelProviders,
  providerLogo,
  ruleOriginDefinition,
  ruleOriginDefinitions,
  type CrmRuleOrigin,
  type RuleLogo,
  type RuleOriginDefinition,
  type RuleOriginId,
} from "./conversion-origins";

/**
 * Server-safe view model of the Conversions screen: every rule of the
 * workspace (provider rules + CRM rules) as one flat, filterable list.
 * Pure functions only, so the page, the client screen and the tests share
 * exactly the same wording and decisions.
 */

/** One WhatsApp number (inbound channel) of the workspace. */
export type ConversionNumber = {
  id: string;
  connectionId: string;
  provider: string;
  connectionName: string;
  /** Name given in the provider, else the phone. */
  label: string;
  phone: string;
  whatsappInstanceId: string | null;
  /** Route ids of the number (CRM authorizations may point to them). */
  routeIds: string[];
  status: InboundWebhookChannelDto["status"];
};

export type ConversionConnection = Pick<
  InboundWebhookConnectionDto,
  "id" | "provider" | "displayName" | "status"
>;

export function toConversionNumbers(
  connections: Array<{
    connection: ConversionConnection;
    channels: InboundWebhookChannelDto[];
  }>,
): ConversionNumber[] {
  return connections.flatMap(({ connection, channels }) =>
    channels.map((channel) => ({
      id: channel.id,
      connectionId: channel.connectionId,
      provider: connection.provider,
      connectionName: connection.displayName,
      label: channel.channelName ?? channel.connectedPhone,
      phone: channel.connectedPhone,
      whatsappInstanceId: channel.whatsappInstanceId,
      routeIds: channel.routes.map((route) => route.id),
      status: channel.status,
    })),
  );
}

export type RuleStatus =
  | "observation"
  | "production"
  | "paused"
  | "unified"
  | "number_removed";

export const ruleStatusLabels: Record<RuleStatus, string> = {
  // Fase 6.1c (produção direta): regra ativa sem envio só existe quando o
  // envio foi desligado (pelo operador ou no servidor) ou a integração ainda
  // não foi validada. Não há mais etapa de observação para o aluno.
  observation: "Envio desligado",
  production: "Envio automático",
  paused: "Pausada",
  unified: "Unificada",
  number_removed: "Número removido",
};

/** Warning of a rule whose number was removed (it no longer receives anything). */
export const numberRemovedWarning = {
  title: "Número removido",
  body: "Esta regra não recebe mais eventos. Pause, exclua ou unifique.",
} as const;

/** The same warning in one line. */
export const numberRemovedNote = "Número removido: esta regra não recebe mais eventos. Pause, exclua ou unifique.";

/** Two rules of the same automation event own the same numbers. */
export function duplicateEventRuleNote(names: string): string {
  return `Duas regras para o mesmo evento em ${names} — unifique as regras para ficar só uma.`;
}

export type RuleScopeKind = "all_numbers" | "specific_numbers";

export type RuleRowExecution = {
  label: string;
  occurredAt: string;
  tone: "ok" | "warn" | "bad" | "neutral";
};

export type ConversionRuleRow = {
  key: string;
  kind: "provider" | "crm";
  id: string;
  name: string;
  origin: RuleOriginId;
  originLabel: string;
  /** Platform behind the origin (e.g. "Umbler Talk", "Vários canais"). */
  platformLabel: string | null;
  logo: RuleLogo | null;
  eventName: ConversionEventNameDto;
  eventLabel: string;
  /** Evento ainda em beta na origem (selo “beta” ao lado do evento). */
  eventBeta?: boolean;
  /** What triggers it, in one short line (phrase, tag, stage...). */
  triggerDetail: string | null;
  scope: RuleScopeKind;
  scopeLabel: string;
  /** Numbers the rule is (or would be) evaluated on: drives the filter. */
  numberIds: string[];
  /** CRM rules of the whole account match every number. */
  appliesToAllNumbers: boolean;
  status: RuleStatus;
  statusLabel: string;
  /** "Substituída no número X" and friends. */
  notes: string[];
  /** Avisos que pedem atenção (ex.: regra ativa que não vale em nenhum número). */
  warnings: string[];
  /** Highlighted warning (callout), e.g. "Número removido". */
  warning?: { title: string; body: string } | null;
  lastExecution: RuleRowExecution | null;
  /** CRM rules: where they are managed today. */
  manageHref: string | null;
  connectionId: string | null;
  mode: "observation" | "production" | null;
  active: boolean;
  /**
   * "Todos os números": números cobertos que ainda não enviam, com o motivo
   * (ausente/vazio: todos os números cobertos enviam).
   */
  pendingNumbers?: ProviderConversionRulePendingNumberDto[];
  /** "Unificar": the rule this one was folded into (provider rules). */
  unifiedIntoRuleId?: string | null;
  /** Other rules were unified into this one ("vale para todos os números"). */
  isUnifyTarget?: boolean;
  /** The number/connection the rule belonged to was removed. */
  numberRemoved?: boolean;
  /** Last event that came in through this rule's own (old) URL. */
  oldUrlLastDeliveryAt?: string | null;
  /** Provider that sends the events (to tell where to change the URL). */
  providerName?: string | null;
};

// ---------------------------------------------------------------------------
// "Todos os números": números que ainda não enviam
// ---------------------------------------------------------------------------

export type PendingNumberView = {
  channelId: string;
  /** Nome do número na tela (na falta, o telefone). */
  label: string;
  /** O que o bloqueia, em uma frase. */
  detail: string;
  /**
   * activate: "Ativar envio neste número";
   * integrations: precisa de algo em Integrações (WhatsApp, rota Meta ou
   * conexão pausada);
   * null: nada a fazer aqui (o envio da própria regra está desligado).
   */
  action: "activate" | "integrations" | null;
};

/** Motivo de um número pendente, em português simples. */
export function pendingNumberDetail(
  number: Pick<
    ProviderConversionRulePendingNumberDto,
    "reason" | "channelStatus" | "connectionStatus"
  >,
): string {
  switch (number.reason) {
    case "whatsapp_connection_inactive":
      return "A conexão WhatsApp deste número não está ativa (suspensa ou removida). Reative-a em Integrações.";
    case "meta_route_missing":
      return "Falta uma rota Meta válida para este número. Configure em Integrações.";
    case "channel_not_active":
      return number.channelStatus === "paused"
        ? "O envio deste número está pausado."
        : "O envio deste número ainda não foi ativado.";
    case "connection_not_production":
      return "O envio da conexão deste número está desligado. Ative em Integrações.";
    case "connection_paused":
      return "A conexão deste número foi pausada em Integrações. Retome por lá se quiser voltar a enviar.";
  }
}

export function pendingNumberViews(
  pending: readonly ProviderConversionRulePendingNumberDto[],
  numbers: readonly ConversionNumber[],
  ruleMode: "observation" | "production" | null,
): PendingNumberView[] {
  const numbersById = new Map(numbers.map((number) => [number.id, number]));
  return pending.map((number) => ({
    channelId: number.channelId,
    label:
      numbersById.get(number.channelId)?.label ??
      number.label ??
      number.phone ??
      "Número sem nome",
    detail: pendingNumberDetail(number),
    action: number.activatable
      ? ruleMode === "production"
        ? "activate"
        : null
      : "integrations",
  }));
}

/** Título do aviso numa regra para todos os números. */
export function pendingNumbersTitle(
  count: number,
  ruleMode: "observation" | "production" | null,
): string {
  const numbers = count === 1 ? "1 número" : `${count} números`;
  return ruleMode === "production"
    ? `Esta regra ainda não envia eventos em ${numbers}`
    : `Ao ativar o envio, ${numbers} ainda ${count === 1 ? "precisa" : "precisam"} de atenção`;
}

// ---------------------------------------------------------------------------
// Provider rules
// ---------------------------------------------------------------------------

export function providerRuleOrigin(
  rule: ProviderConversionRuleDto,
  connectionsById: ReadonlyMap<string, ConversionConnection>,
): ProviderConversionRuleOriginDto {
  if (rule.origin) return rule.origin;
  if (rule.automationSource === "payt") return "automation_payt";
  if (rule.automationSource === "braip") return "automation_braip";
  if (rule.automationSource === "roichat") return "automation_roichat";

  switch (rule.conversionRule.triggerType) {
    case "message_phrase":
      return "message_phrase";
    case "structured_catalog":
      return "structured_catalog";
    default: {
      const provider = rule.connectionId
        ? connectionsById.get(rule.connectionId)?.provider
        : null;
      if (provider === "umbler") return "automation_umbler";
      if (provider === "unnichat") return "automation_unnichat";
      if (provider === "roichat") return "automation_roichat";
      return "whatsapp_label";
    }
  }
}

export function providerRuleStatus(
  rule: ProviderConversionRuleDto,
  numbersById?: ReadonlyMap<string, ConversionNumber>,
): RuleStatus {
  if (!rule.conversionRule.active) {
    return rule.unifiedIntoRuleId ? "unified" : "paused";
  }
  if (providerRuleNumberRemoved(rule, numbersById)) return "number_removed";

  return rule.mode === "production" ? "production" : "observation";
}

/**
 * The rule's number was removed: the API says so (numberRemoved); older
 * APIs: a specific rule none of whose numbers is connected any more.
 */
export function providerRuleNumberRemoved(
  rule: ProviderConversionRuleDto,
  numbersById?: ReadonlyMap<string, ConversionNumber>,
): boolean {
  if (rule.numberRemoved !== undefined) return rule.numberRemoved;
  return (
    numbersById !== undefined &&
    (rule.scope ?? "specific_numbers") === "specific_numbers" &&
    rule.channelIds.length > 0 &&
    rule.channelIds.every((id) => !numbersById.has(id))
  );
}

/** "Recepção, Comercial e mais 2" (unknown ids read "número removido"). */
export function numberNames(
  ids: readonly string[],
  numbersById: ReadonlyMap<string, ConversionNumber>,
  max = 3,
): string {
  const names = ids.map((id) => numbersById.get(id)?.label ?? "número removido");

  if (names.length <= max) {
    return joinNames(names);
  }

  return `${names.slice(0, max).join(", ")} e mais ${names.length - max}`;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
}

const executionLabels: Record<
  NonNullable<ProviderConversionRuleDto["lastExecution"]>["status"],
  { label: string; tone: RuleRowExecution["tone"] }
> = {
  observed: { label: "Reconhecida sem envio", tone: "neutral" },
  eligible: { label: "Na fila de envio", tone: "neutral" },
  materialized: { label: "Evento enviado", tone: "ok" },
  duplicate: { label: "Repetida, não reenviada", tone: "warn" },
  blocked: { label: "Bloqueada", tone: "warn" },
  failed: { label: "Falhou", tone: "bad" },
};

/**
 * Avisos de uma regra de provedor. Um só ponto para somar avisos novos que a
 * API passar a informar (ex.: telefone cujo canal principal está em
 * observação enquanto outro canal do mesmo telefone já envia).
 */
export function providerRuleWarnings(input: {
  status: RuleStatus;
  numberIds: readonly string[];
  observationCanonicalChannels?: ReadonlyArray<{ canonicalChannelId: string }>;
  numbersById?: ReadonlyMap<string, ConversionNumber>;
}): string[] {
  const warnings: string[] = [];

  if (
    input.status !== "paused" &&
    input.status !== "unified" &&
    input.observationCanonicalChannels?.length
  ) {
    warnings.push(
      observationCanonicalWarning(
        input.observationCanonicalChannels.map((item) => item.canonicalChannelId),
        input.numbersById ?? new Map(),
      ),
    );
  }

  if (
    (input.status === "production" || input.status === "observation") &&
    input.numberIds.length === 0
  ) {
    warnings.push(
      "Esta regra não vale em nenhum número agora: conecte um número compatível ou ajuste o alcance.",
    );
  }

  return warnings;
}

/** Telefone cuja regra global roda num canal sem envio enquanto outro canal já envia. */
export function observationCanonicalWarning(
  channelIds: readonly string[],
  numbersById: ReadonlyMap<string, ConversionNumber>,
): string {
  const where = numberNames(channelIds, numbersById);
  return `Em ${where}: a regra global roda num canal com o envio desligado; outro canal do mesmo número já envia.`;
}

function triggerDetailForProviderRule(
  rule: ProviderConversionRuleDto,
  origin: ProviderConversionRuleOriginDto,
): string | null {
  const phrases = rule.triggerPhrases;
  const firstWithMore = (prefix: string) =>
    phrases.length === 0
      ? null
      : `${prefix}“${phrases[0]}”${phrases.length > 1 ? ` +${phrases.length - 1}` : ""}`;

  switch (origin) {
    case "message_phrase":
      return firstWithMore("Frase ");
    case "whatsapp_label":
      return firstWithMore("Etiqueta ");
    case "structured_catalog":
      return rule.catalog
        ? `Catálogo “${rule.catalog.name}”`
        : firstWithMore("Frase ");
    case "automation_umbler":
    case "automation_unnichat": {
      const own =
        origin === "automation_umbler"
          ? "Endereço da automação criado"
          : "URL da regra criada";
      // Fase 6.1a (#159): a rule for every connection is called through the
      // event URL (or, while it still has one, its own address, which also
      // serves every number of the provider).
      if ((rule.scope ?? "specific_numbers") === "all_numbers" && rule.crossConnectionScope)
        return rule.endpoint && !rule.endpoint.publicUrlDisabledAt
          ? `${own} (todas as conexões)`
          : "URL do evento (todas as conexões)";
      return rule.endpoint ? own : null;
    }
    case "automation_payt":
      return rule.endpoint ? "URL de postback criada" : null;
    case "automation_braip":
      // Só pela URL única da Braip (uma para a conta toda).
      return "URL única da Braip";
    case "automation_roichat":
      // Fase 6.8: a compra chega pela URL de cada número do ROI Chat.
      return rule.conversionRule.defaultValueCents
        ? `Valor de cada compra do ROI Chat (reserva: ${formatMoney(rule.conversionRule.defaultValueCents, rule.conversionRule.defaultCurrency ?? "BRL")})`
        : "Valor de cada compra vem do ROI Chat";
  }
}

/** Every number of the origin (optionally of one connection only). */
function originNumberIds(
  definition: RuleOriginDefinition,
  numbers: readonly ConversionNumber[],
  connectionId: string | null,
  capabilities: ProviderConversionRuleCapabilitiesDto | null,
): string[] {
  const providers = originChannelProviders(definition.id, capabilities);

  return numbers
    .filter(
      (number) =>
        providers.includes(number.provider) &&
        (connectionId === null || number.connectionId === connectionId),
    )
    .map((number) => number.id);
}

function platformForNumbers(
  ids: readonly string[],
  numbersById: ReadonlyMap<string, ConversionNumber>,
): { label: string | null; logo: RuleLogo | null } {
  const providers = [
    ...new Set(
      ids
        .map((id) => numbersById.get(id)?.provider)
        .filter((provider): provider is string => Boolean(provider)),
    ),
  ];

  if (providers.length === 1) {
    const hubId = hubProviderForInbound(providers[0]!);
    if (hubId) {
      const logo = providerLogo(hubId);
      return { label: logo.name, logo };
    }
  }

  return { label: providers.length > 1 ? "Vários canais" : null, logo: null };
}

export function buildProviderRuleRows(
  rules: readonly ProviderConversionRuleDto[],
  numbers: readonly ConversionNumber[],
  connections: readonly ConversionConnection[],
  capabilities: ProviderConversionRuleCapabilitiesDto | null = null,
): ConversionRuleRow[] {
  const numbersById = new Map(numbers.map((number) => [number.id, number]));
  const connectionsById = new Map(
    connections.map((connection) => [connection.id, connection]),
  );
  const origins = new Map(
    rules.map((rule) => [rule.id, providerRuleOrigin(rule, connectionsById)]),
  );
  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
  const unifyTargetIds = new Set(
    rules.flatMap((rule) => (rule.unifiedIntoRuleId ? [rule.unifiedIntoRuleId] : [])),
  );

  return rules.map((rule) => {
    const origin = origins.get(rule.id)!;
    const definition = ruleOriginDefinition(origin);
    const scope = rule.scope ?? "specific_numbers";
    const status = providerRuleStatus(rule, numbersById);
    const eventName = rule.conversionRule.eventName;
    const connection = rule.connectionId
      ? connectionsById.get(rule.connectionId)
      : undefined;
    const notes: string[] = [];
    let numberIds: string[];
    let scopeLabel: string;

    if (scope === "all_numbers") {
      const covered = [
        ...(rule.effectiveChannelIds ?? []),
        ...(rule.overriddenChannelIds ?? []),
        ...(rule.duplicatePhoneChannelIds ?? []),
      ];
      // Umbler/Unnichat: "todas as conexões" only when the rule says so;
      // otherwise the historical "all numbers of the rule's connection".
      const automationOnConnection =
        definition.connection === "provider_anchor" && !rule.crossConnectionScope;
      numberIds =
        covered.length > 0 || rule.conversionRule.active
          ? [...new Set(covered)]
          : originNumberIds(
              definition,
              numbers,
              automationOnConnection ? rule.connectionId : null,
              capabilities,
            );
      scopeLabel =
        definition.connection !== "provider_anchor" || !definition.logoProvider
          ? "Todos os números"
          : automationOnConnection
            ? `Todos os números de ${connection?.displayName ?? "conexão removida"}`
            : `Todos os números ${automationPlatformOf(origin)} (todas as conexões)`;
      if (automationOnConnection && rule.conversionRule.active && connection) {
        notes.push(
          `Vale só para os números de ${connection.displayName}. Para valer em todas as conexões, use Gerenciar > “Ampliar para todas as conexões”.`,
        );
      }
      if (definition.connection === "provider_anchor" && rule.conversionRule.active) {
        const mine = new Set(rule.effectiveChannelIds ?? []);
        const shared = rules
          .filter(
            (other) =>
              other.id !== rule.id &&
              (other.scope ?? "specific_numbers") === "all_numbers" &&
              other.conversionRule.active &&
              other.conversionRule.eventName === eventName &&
              origins.get(other.id) === origin,
          )
          .flatMap((other) => other.effectiveChannelIds ?? [])
          .filter((channelId) => mine.has(channelId));
        if (shared.length > 0) {
          notes.push(
            duplicateEventRuleNote(numberNames([...new Set(shared)], numbersById)),
          );
        }
      }

      if (rule.overriddenChannelIds?.length) {
        notes.push(
          `Substituída em ${numberNames(rule.overriddenChannelIds, numbersById)}: ali vale a regra específica do número.`,
        );
      }
      if (rule.duplicatePhoneChannelIds?.length) {
        notes.push(
          `${numberNames(rule.duplicatePhoneChannelIds, numbersById)} tem o mesmo telefone de outro número conectado: o evento sai uma vez só.`,
        );
      }
    } else {
      numberIds = [...rule.channelIds];
      // Two specific Umbler/Unnichat rules of the same event on one number
      // (legacy duplicates: the oldest keeps receiving the event URL).
      if (definition.connection === "provider_anchor" && rule.conversionRule.active) {
        const mine = new Set(rule.channelIds);
        const shared = rules
          .filter(
            (other) =>
              other.id !== rule.id &&
              (other.scope ?? "specific_numbers") === "specific_numbers" &&
              other.conversionRule.active &&
              other.conversionRule.eventName === eventName &&
              origins.get(other.id) === origin,
          )
          .flatMap((other) => other.channelIds)
          .filter((channelId) => mine.has(channelId));
        if (shared.length > 0) {
          notes.push(
            duplicateEventRuleNote(numberNames([...new Set(shared)], numbersById)),
          );
        }
      }
      scopeLabel =
        rule.channelIds.length > 0
          ? numberNames(rule.channelIds, numbersById)
          : "Nenhum número";

      if (rule.conversionRule.active) {
        const replaced = rules
          .filter(
            (other) =>
              other.id !== rule.id &&
              other.scope === "all_numbers" &&
              other.conversionRule.active &&
              other.conversionRule.eventName === eventName &&
              origins.get(other.id) === origin,
          )
          .flatMap((other) => other.overriddenChannelIds ?? [])
          .filter((channelId) => rule.channelIds.includes(channelId));
        if (replaced.length > 0) {
          notes.push(
            `Vale no lugar da regra para todos os números em ${numberNames([...new Set(replaced)], numbersById)}.`,
          );
        }
      }
    }


    if (status === "unified" && rule.unifiedIntoRuleId) {
      const target = rulesById.get(rule.unifiedIntoRuleId);
      notes.push(
        target
          ? `Unificada em “${target.conversionRule.name}”, que vale para todos os números.`
          : "Unificada em uma regra para todos os números.",
      );
    }

    const platform = definition.logoProvider
      ? {
          label: providerLogo(definition.logoProvider).name,
          logo: providerLogo(definition.logoProvider),
        }
      : platformForNumbers(
          scope === "all_numbers"
            ? originNumberIds(definition, numbers, null, capabilities)
            : rule.channelIds,
          numbersById,
        );
    const execution = rule.lastExecution;

    return {
      key: `provider:${rule.id}`,
      kind: "provider",
      id: rule.id,
      name: rule.conversionRule.name,
      origin,
      originLabel: definition.label,
      // Specific Umbler/Unnichat rules show their connection; a rule for
      // all numbers spans every connection of the provider.
      platformLabel:
        definition.connection === "provider_anchor" &&
        (scope === "specific_numbers" || !rule.crossConnectionScope) &&
        connection
          ? connection.displayName
          : platform.label,
      logo: platform.logo,
      eventName,
      eventLabel: ruleEventLabelForOrigin(origin, eventName),
      eventBeta: originBetaEvents(origin, capabilities).includes(eventName),
      triggerDetail: triggerDetailForProviderRule(rule, origin),
      scope,
      scopeLabel,
      numberIds,
      appliesToAllNumbers: false,
      status,
      statusLabel: ruleStatusLabels[status],
      notes,
      warnings: providerRuleWarnings({
        status,
        numberIds,
        observationCanonicalChannels: rule.observationCanonicalChannels,
        numbersById,
      }),
      warning: status === "number_removed" ? numberRemovedWarning : null,
      lastExecution: execution
        ? {
            // Porte do SaaS #155: a deferred entry receipt is not "na fila de envio".
            label: isDeferredToRuleReason(execution.reasonCode)
              ? leadSubmittedOverrideCopy.deferredChip
              : executionLabels[execution.status].label,
            tone: isDeferredToRuleReason(execution.reasonCode)
              ? "neutral"
              : executionLabels[execution.status].tone,
            occurredAt: execution.occurredAt,
          }
        : null,
      manageHref: null,
      connectionId: rule.connectionId,
      mode: rule.mode,
      active: rule.conversionRule.active,
      pendingNumbers:
        scope === "all_numbers" && rule.conversionRule.active
          ? (rule.pendingNumbers ?? [])
          : [],
      unifiedIntoRuleId: rule.unifiedIntoRuleId ?? null,
      isUnifyTarget: unifyTargetIds.has(rule.id),
      numberRemoved: providerRuleNumberRemoved(rule, numbersById),
      oldUrlLastDeliveryAt: rule.endpoint?.lastDeliveryAt ?? null,
      providerName: definition.logoProvider
        ? providerLogo(definition.logoProvider).name
        : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Regras do CRM (só leitura aqui; editadas na janela do CRM no Hub)
// ---------------------------------------------------------------------------

export type CrmRulesInput = {
  kommo: KommoConnectionDetailDto[];
  pipedrive: PipedriveConnectionDetailDto[];
};

function authorizedNumberIds(
  allowedIds: readonly string[],
  numbers: readonly ConversionNumber[],
): string[] {
  return numbers
    .filter(
      (number) =>
        allowedIds.includes(number.id) ||
        number.routeIds.some((routeId) => allowedIds.includes(routeId)),
    )
    .map((number) => number.id);
}

function crmStatus(input: {
  active: boolean;
  mode: "observation" | "production";
  connectionActive: boolean;
}): RuleStatus {
  if (!input.active || !input.connectionActive) return "paused";
  return input.mode === "production" ? "production" : "observation";
}

function crmRow(input: {
  origin: CrmRuleOrigin;
  id: string;
  name: string;
  eventName: ConversionEventNameDto;
  triggerDetail: string | null;
  status: RuleStatus;
  mode: "observation" | "production" | null;
  active: boolean;
  scope: RuleScopeKind;
  scopeLabel: string;
  numberIds: string[];
  appliesToAllNumbers: boolean;
  connectionName: string | null;
}): ConversionRuleRow {
  const definition = ruleOriginDefinition(input.origin);
  const logo = definition.logoProvider
    ? providerLogo(definition.logoProvider)
    : null;

  return {
    key: `${input.origin}:${input.id}`,
    kind: "crm",
    id: input.id,
    name: input.name,
    origin: input.origin,
    originLabel: definition.label,
    platformLabel: input.connectionName ?? logo?.name ?? null,
    logo,
    eventName: input.eventName,
    eventLabel: ruleEventLabel(input.eventName),
    triggerDetail: input.triggerDetail,
    scope: input.scope,
    scopeLabel: input.scopeLabel,
    numberIds: input.numberIds,
    appliesToAllNumbers: input.appliesToAllNumbers,
    status: input.status,
    statusLabel: ruleStatusLabels[input.status],
    notes: [],
    warnings: [],
    lastExecution: null,
    manageHref: crmManageHref(input.origin),
    connectionId: null,
    mode: input.mode,
    active: input.active,
  };
}

function crmScope(
  allowedIds: readonly string[],
  numbers: readonly ConversionNumber[],
): Pick<ConversionRuleRow, "scope" | "scopeLabel" | "numberIds"> {
  const ids = authorizedNumberIds(allowedIds, numbers);
  const numbersById = new Map(numbers.map((number) => [number.id, number]));

  return {
    scope: "specific_numbers",
    scopeLabel:
      ids.length > 0
        ? numberNames(ids, numbersById)
        : "Nenhum número autorizado ainda",
    numberIds: ids,
  };
}

export function buildCrmRuleRows(
  crm: CrmRulesInput,
  numbers: readonly ConversionNumber[],
): ConversionRuleRow[] {
  const rows: ConversionRuleRow[] = [];

  for (const connection of crm.kommo) {
    const scope = crmScope(connection.allowedChannelRouteIds, numbers);
    for (const rule of connection.rules) {
      const stage = connection.pipelines.find(
        (row) => row.id === rule.pipelineId && row.status.id === rule.statusId,
      );
      rows.push(
        crmRow({
          origin: "kommo",
          id: rule.id,
          name: rule.name,
          eventName: rule.eventName,
          triggerDetail: stage
            ? `Etapa “${stage.status.name}” em ${stage.name}`
            : null,
          status: crmStatus({
            active: rule.active,
            mode: rule.mode,
            connectionActive: connection.status === "active",
          }),
          mode: rule.mode,
          active: rule.active,
          ...scope,
          appliesToAllNumbers: false,
          connectionName: connection.displayName,
        }),
      );
    }
  }

  for (const connection of crm.pipedrive) {
    const scope = crmScope(connection.allowedChannelRouteIds, numbers);
    for (const rule of connection.rules) {
      const pipeline = connection.pipelines.find(
        (item) => item.id === rule.pipelineId,
      );
      const stage = pipeline?.stages.find((item) => item.id === rule.stageId);
      rows.push(
        crmRow({
          origin: "pipedrive",
          id: rule.id,
          name: rule.name,
          eventName: rule.eventName,
          triggerDetail:
            rule.trigger === "deal_won"
              ? "Negócio ganho"
              : stage
                ? `Etapa “${stage.name}”${pipeline ? ` em ${pipeline.name}` : ""}`
                : null,
          status: crmStatus({
            active: rule.active,
            mode: rule.mode,
            connectionActive: connection.status === "active",
          }),
          mode: rule.mode,
          active: rule.active,
          ...scope,
          appliesToAllNumbers: false,
          connectionName: connection.displayName,
        }),
      );
    }
  }

  return rows;
}

const statusOrder: Record<RuleStatus, number> = {
  production: 0,
  observation: 1,
  number_removed: 2,
  paused: 3,
  unified: 4,
};

/**
 * Live rules first, then paused/unified/number removed; inside each, by
 * origin then name.
 */
export function sortRuleRows(rows: readonly ConversionRuleRow[]): ConversionRuleRow[] {
  const originOrder = new Map(
    ruleOriginDefinitions.map((definition, index) => [definition.id, index]),
  );
  const live = (row: ConversionRuleRow) =>
    row.status === "paused" ||
    row.status === "unified" ||
    row.status === "number_removed"
      ? 1
      : 0;

  return [...rows].sort(
    (left, right) =>
      live(left) - live(right) ||
      (originOrder.get(left.origin) ?? 0) - (originOrder.get(right.origin) ?? 0) ||
      statusOrder[left.status] - statusOrder[right.status] ||
      left.name.localeCompare(right.name, "pt-BR"),
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type RuleStatusFilter =
  | "all"
  | "production"
  | "observation"
  | "paused"
  | "unified";

export type RuleFilters = {
  origin: RuleOriginId | "all";
  numberId: string;
  eventName: string;
  status: RuleStatusFilter;
  /** "Ocultar regras unificadas" (pausadas e já cobertas por outra regra). */
  hideUnified: boolean;
};

export const emptyRuleFilters: RuleFilters = {
  origin: "all",
  numberId: "all",
  eventName: "all",
  status: "all",
  hideUnified: false,
};

export function filterRuleRows(
  rows: readonly ConversionRuleRow[],
  filters: RuleFilters,
): ConversionRuleRow[] {
  return rows.filter(
    (row) =>
      !(filters.hideUnified && row.status === "unified") &&
      (filters.origin === "all" || row.origin === filters.origin) &&
      (filters.eventName === "all" || row.eventName === filters.eventName) &&
      (filters.numberId === "all" ||
        row.appliesToAllNumbers ||
        row.numberIds.includes(filters.numberId)) &&
      (filters.status === "all" ||
        // nod: "Unificadas" keeps its own filter; "Pausadas ou sem número"
        // also lists the rules whose number was removed (Fase 6.1a, #159).
        (filters.status === "paused"
          ? row.status === "paused" || row.status === "number_removed"
          : row.status === filters.status)),
  );
}

export function activeFilterCount(filters: RuleFilters): number {
  return (Object.keys(emptyRuleFilters) as Array<keyof RuleFilters>).filter(
    (key) => filters[key] !== emptyRuleFilters[key],
  ).length;
}

// ---------------------------------------------------------------------------
// "Nova regra": which origins can be offered
// ---------------------------------------------------------------------------

export type OriginOfferInput = {
  numbers: readonly ConversionNumber[];
  connections: readonly ConversionConnection[];
  /** GET providers/capabilities; null: não deu para confirmar o que a API aceita. */
  capabilities: ProviderConversionRuleCapabilitiesDto | null;
  /**
   * Porte do SaaS #164: os números de alguma conexão não puderam ser lidos
   * (o /channels dela falhou): `numbers` pode estar incompleta, até vazia.
   */
  numbersPartial?: boolean;
  crm: Record<CrmRuleOrigin, boolean>;
};

/**
 * Só origens que a API diz que aceita (capabilities) E que têm uma integração
 * ativa por trás: frase e catálogo precisam de um número que lê mensagens,
 * etiqueta de um número Uazapi, automação da Umbler daquela conexão, CRM de
 * uma conexão. Sem resposta das capacidades, nada é oferecido.
 */
export function offeredRuleOrigins(input: OriginOfferInput): RuleOriginId[] {
  return ruleOriginDefinitions
    .filter((definition) => {
      if (definition.kind === "crm") {
        return input.crm[definition.id as CrmRuleOrigin];
      }
      if (!input.capabilities) return false;
      if (
        !input.capabilities.origins.some((item) => item.origin === definition.id)
      ) {
        return false;
      }
      const providers = originChannelProviders(definition.id, input.capabilities);
      if (definition.connection === "provider_anchor") {
        return input.connections.some(
          (connection) =>
            providers.includes(connection.provider) &&
            connection.status !== "paused",
        );
      }
      if (definition.connection === "any") {
        // Plataformas de venda (Payt, Braip; porte do SaaS #164): precisam de
        // um número de WhatsApp de qualquer provedor para atribuir a venda.
        // Um número lido prova; uma conexão de WhatsApp ou uma leitura
        // incompleta também: um /channels que falhou nunca esconde a origem.
        return (
          input.numbers.some((number) => providers.includes(number.provider)) ||
          Boolean(input.numbersPartial) ||
          input.connections.some((connection) =>
            providers.includes(connection.provider),
          )
        );
      }
      return input.numbers.some((number) => providers.includes(number.provider));
    })
    .map((definition) => definition.id);
}

/**
 * Números onde a origem roda: Umbler/Unnichat em todas as conexões do
 * provedor (opcionalmente só uma conexão, ex.: editar uma regra ligada a
 * ela). `authorScope` "contact" restringe aos provedores que leem mensagens
 * do contato (hoje só a Umbler).
 */
export function numbersForOrigin(
  origin: RuleOriginId,
  numbers: readonly ConversionNumber[],
  connectionId: string | null = null,
  capabilities: ProviderConversionRuleCapabilitiesDto | null = null,
  authorScope: "team" | "contact" | "both" = "team",
): ConversionNumber[] {
  const definition = ruleOriginDefinition(origin);
  const providers =
    origin === "message_phrase" && authorScope === "contact"
      ? contactMessageProviders(capabilities)
      : originChannelProviders(origin, capabilities);

  return numbers.filter(
    (number) =>
      providers.includes(number.provider) &&
      (definition.connection !== "provider_anchor" ||
        connectionId === null ||
        number.connectionId === connectionId),
  );
}

/** Conexões de uma automação Umbler/Unnichat (por endereço). */
export function connectionsForOrigin(
  origin: RuleOriginId,
  connections: readonly ConversionConnection[],
  capabilities: ProviderConversionRuleCapabilitiesDto | null = null,
): ConversionConnection[] {
  const definition = ruleOriginDefinition(origin);
  if (definition.connection !== "provider_anchor") return [];
  const providers = originChannelProviders(origin, capabilities);

  return connections.filter((connection) =>
    providers.includes(connection.provider),
  );
}

/**
 * Números conectados que NENHUMA origem avalia ainda (Gupshup, Data Crazy,
 * WhatsApp Cloud API: só geram leads pelo webhook de entrada). Aparecem como
 * nota neutra no alcance (as conversões chegam pelo webhook do provedor),
 * nunca como escolha e nunca como "Em breve".
 */
export function ineligibleNumbers(
  numbers: readonly ConversionNumber[],
  capabilities: ProviderConversionRuleCapabilitiesDto | null,
  /**
   * A venda da Payt roda em qualquer número de WhatsApp, então ela não conta
   * como "origem que avalia o número" na nota geral; na própria regra da
   * Payt vale a lista dela.
   */
  origin: RuleOriginId | null = null,
): ConversionNumber[] {
  if (!capabilities) return [];
  const supported = new Set(
    origin === "automation_payt" || origin === "automation_braip"
      ? originChannelProviders(origin, capabilities)
      : capabilities.origins
          .filter(
            (item) =>
              item.origin !== "automation_payt" &&
              item.origin !== "automation_braip",
          )
          .flatMap((item) => item.channelProviders),
  );

  return numbers.filter((number) => !supported.has(number.provider));
}
