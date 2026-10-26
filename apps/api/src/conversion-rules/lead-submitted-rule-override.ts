import type { Prisma } from "@prisma/client";
import type { PrismaService } from "../common/prisma/prisma.service";
import { parseInboundWebhooksConfig } from "../config/deployment-config";
import {
  LEAD_SUBMITTED_RULE_OVERRIDE_FLAG,
  leadSubmittedRuleOverrideEnabled,
} from "../config/lead-submitted-rule-override-flag";
import { isBridgedWhatsappProvider } from "../inbound-webhooks/bridged-whatsapp-providers";
import { inboundParserProductionEligible } from "../inbound-webhooks/inbound-webhook-parser-eligibility";
import { InboundWebhookMetaRouteReaderService } from "../inbound-webhooks/inbound-webhook-meta-route-reader.service";
import {
  providerRuleCandidateWhere,
  resolveApplicableProviderRules,
  type ScopedChannel,
  type ScopedProviderRule,
} from "./provider-rule-scope";

/**
 * "Lead recebido pela regra" (porte do SaaS #155, tarefa 20).
 *
 * Default: the CTWA entry (first ad message) sends LeadSubmitted to Meta.
 * When a provider conversion rule with event LeadSubmitted is ACTIVE, in
 * PRODUCTION (sending) and covers the number (specific or all_numbers, with
 * the usual scope/precedence), the entry does NOT send: it writes a
 * non-sending receipt (proof of origin, conversation in the reports) and the
 * LeadSubmitted is sent when the rule triggers (once per lead per pixel,
 * lead-lifetime guard).
 *
 * nod: the flag is ON by default (produção direta: validated in the SaaS
 * production). The SaaS seat/contract gate becomes the student-edition gates
 * the rule send itself needs: a usable license and, for bridged numbers
 * (Uazapi BYO and WAHA, connected by server URL + token), the WhatsApp
 * connection (WhatsappInstance) `active`.
 *
 * Fail-closed towards the default: any doubt (flag off, rule not sending,
 * connection/parser not production-ready, legacy engine, config off, license
 * blocked, connection suspended, lookup error) answers null and the entry
 * sends as before. Kommo, Pipedrive and legacy ConversionRule rows without a
 * provider config never suppress.
 *
 * No retroactive send: if the rule is paused/removed after an entry was
 * deferred, that entry is not sent later (owner decision B).
 */

export { LEAD_SUBMITTED_RULE_OVERRIDE_FLAG, leadSubmittedRuleOverrideEnabled };

/** errorCode of the entry receipt whose LeadSubmitted the rule will send. */
export const LEAD_SUBMITTED_DEFERRED_TO_RULE =
  "lead_submitted_deferred_to_rule" as const;

/** "N leads aguardando a regra": deferred entries older than this. */
export const LEAD_SUBMITTED_AWAITING_RULE_DAYS = 3;
/** Bound of deferred receipts read for that count. */
export const LEAD_SUBMITTED_AWAITING_RULE_SCAN = 1_000;

export const LEAD_SUBMITTED_DEFERRED_TO_RULE_MESSAGE =
  "Lead recebido será enviado pela regra de conversão (não enviado na entrada)";

export type LeadSubmittedRuleOverride = {
  ruleIds: string[];
  ruleNames: string[];
};

type OverrideClient = Pick<
  Prisma.TransactionClient,
  "providerConversionRuleConfig" | "inboundWebhookChannel"
>;

const parserReleaseSelect = {
  select: { provider: true, version: true, status: true },
} as const;

const ruleSelect = {
  id: true,
  scope: true,
  crossConnectionScope: true,
  connectionId: true,
  removedAt: true,
  mode: true,
  productionActivatedAt: true,
  parserReleaseId: true,
  conversionRule: {
    select: { triggerType: true, eventName: true, active: true, name: true },
  },
  parserRelease: parserReleaseSelect,
  connection: {
    select: {
      id: true,
      provider: true,
      status: true,
      removedAt: true,
      parserReleaseId: true,
      parserRelease: parserReleaseSelect,
    },
  },
  channels: { select: { channelId: true } },
} satisfies Prisma.ProviderConversionRuleConfigSelect;

type ParserReleaseGate = { provider: string; version: string; status: string };

type GateConnection = {
  id: string;
  provider: string;
  status: string;
  removedAt: Date | null;
  parserReleaseId: string;
  parserRelease: ParserReleaseGate;
};

type OverrideRule = ScopedProviderRule & {
  mode: string;
  productionActivatedAt: Date | null;
  parserReleaseId: string | null;
  conversionRule: ScopedProviderRule["conversionRule"] & { name: string };
  parserRelease: ParserReleaseGate | null;
  connection: GateConnection | null;
};

const channelSelect = {
  id: true,
  status: true,
  conversionEngineMode: true,
  productionActivatedAt: true,
  whatsappInstance: { select: { status: true } },
  connection: {
    select: {
      id: true,
      provider: true,
      status: true,
      removedAt: true,
      parserReleaseId: true,
      parserRelease: parserReleaseSelect,
    },
  },
} satisfies Prisma.InboundWebhookChannelSelect;

type GateChannel = {
  id: string;
  status: string;
  conversionEngineMode: string;
  productionActivatedAt: Date | null;
  whatsappInstance?: { status: string } | null;
  connection: GateConnection | null;
};

function productionPipelineEnabled(
  env: Record<string, string | undefined>,
): boolean {
  try {
    const config = parseInboundWebhooksConfig(env);
    return (
      config.enabled &&
      config.productionEnabled &&
      config.conversionRulesEnabled &&
      config.conversionProductionEnabled
    );
  } catch {
    return false;
  }
}

/**
 * Same production gates the rule pipelines apply (Umbler/Unnichat
 * observation service, Uazapi/WAHA bridge disposition), evaluated for the
 * channel the rule will run on. Pure.
 */
export function ruleWillSendOnChannel(
  rule: Pick<
    OverrideRule,
    | "mode"
    | "productionActivatedAt"
    | "parserReleaseId"
    | "parserRelease"
    | "connection"
    | "conversionRule"
  >,
  channel: GateChannel,
): boolean {
  if (rule.mode !== "production" || !rule.productionActivatedAt) return false;
  const connection = rule.connection ?? channel.connection;
  if (!connection || !channel.connection) return false;
  const ruleParser = rule.parserRelease ?? connection.parserRelease;
  if (!inboundParserProductionEligible(ruleParser)) return false;
  if (!inboundParserProductionEligible(connection.parserRelease)) return false;
  if (!inboundParserProductionEligible(channel.connection.parserRelease))
    return false;
  if (
    rule.conversionRule.triggerType !== "provider_automation" &&
    rule.parserReleaseId !== null &&
    rule.parserReleaseId !== channel.connection.parserReleaseId
  )
    return false;
  if (connection.status !== "production" || connection.removedAt !== null)
    return false;
  if (
    channel.connection.status !== "production" ||
    channel.connection.removedAt !== null
  )
    return false;
  // nod: a bridged number (Uazapi BYO / WAHA) only sends while its WhatsApp
  // connection is active (the SaaS "vaga" becomes the connection).
  if (
    isBridgedWhatsappProvider(channel.connection.provider) &&
    channel.whatsappInstance?.status !== "active"
  )
    return false;
  return (
    channel.status === "active" &&
    channel.productionActivatedAt !== null &&
    channel.conversionEngineMode === "canonical"
  );
}

export type LeadSubmittedOverrideDestination =
  | { kind: "ad_route"; adId: string }
  | { kind: "ctwa_destination"; destinationId: string };

type RoutePreview = {
  status: string;
  reportingAccountId?: string | null;
  adAccountId?: string | null;
  businessConnectionId?: string | null;
  conversionDestinationId?: string | null;
};

/** The license read the rule send depends on (LicenseClientService). */
export type LeadSubmittedOverrideLicense = {
  getLockState(): Promise<{ inert: boolean; locked: boolean }>;
};

export type LeadSubmittedOverrideDeps = {
  env?: Record<string, string | undefined>;
  /**
   * nod: the license gate of the rule send (background sends stop with the
   * license blocked). Absent: never defer (fail closed towards the entry
   * send, which keeps its own license check).
   */
  license?: LeadSubmittedOverrideLicense | null;
  /** Ad route resolver (defaults to InboundWebhookMetaRouteReaderService on the client). */
  previewRoute?: (input: { workspaceId: string; adId: string }) => Promise<RoutePreview>;
};

async function licenseUsable(
  license: LeadSubmittedOverrideLicense,
): Promise<boolean> {
  try {
    const decision = await license.getLockState();
    return decision.inert || !decision.locked;
  } catch {
    return false;
  }
}

/**
 * The rule send resolves the Meta destination like this: lead with an ad ->
 * previewRoute(ad) must resolve completely (Uazapi, WAHA, Meta Cloud and the
 * other webhook providers); CTWA lead without an ad (Unnichat page/pixel) ->
 * the entry receipt being written is the proof (resolveCtwaLeadProof), so the
 * authorized destination the entry carries is enough.
 */
async function destinationWillResolve(
  client: OverrideClient,
  workspaceId: string,
  destination: LeadSubmittedOverrideDestination,
  deps: LeadSubmittedOverrideDeps,
): Promise<boolean> {
  if (destination.kind === "ctwa_destination")
    return Boolean(destination.destinationId);
  const adId = destination.adId.trim();
  if (!adId) return false;
  try {
    const preview = deps.previewRoute
      ? deps.previewRoute
      : (routeInput: { workspaceId: string; adId: string }) =>
          new InboundWebhookMetaRouteReaderService(
            client as unknown as PrismaService,
          ).previewRoute(routeInput);
    const route = await preview({ workspaceId, adId });
    return Boolean(
      route.status === "resolved" &&
        route.reportingAccountId &&
        route.adAccountId &&
        route.businessConnectionId &&
        route.conversionDestinationId,
    );
  } catch {
    return false;
  }
}

/**
 * Whether an active production LeadSubmitted provider rule covers this entry
 * channel. Runs on the entry's client (inside its transaction when it has
 * one). Returns the covering rules, or null (entry sends as today).
 */
export async function resolveLeadSubmittedRuleOverride(
  client: OverrideClient,
  input: {
    workspaceId: string;
    channel: { id: string; connectionId: string; provider: string };
    /**
     * How the rule send will reach Meta for this lead: the lead's ad route
     * (previewRoute of that ad must resolve) or the CTWA page/pixel
     * destination proven by this entry's own receipt. null = unknown: the
     * entry keeps sending.
     */
    destination: LeadSubmittedOverrideDestination | null;
  },
  deps: LeadSubmittedOverrideDeps,
): Promise<LeadSubmittedRuleOverride | null> {
  const env = deps.env ?? process.env;
  if (!leadSubmittedRuleOverrideEnabled(env)) return null;
  if (!productionPipelineEnabled(env)) return null;
  // Fail closed: without the license gate the rule send uses, never defer.
  if (!deps.license || !input.destination) return null;
  try {
    const rules = (await client.providerConversionRuleConfig.findMany({
      where: {
        workspaceId: input.workspaceId,
        removedAt: null,
        unifiedIntoProviderRuleId: null,
        conversionRule: { active: true, eventName: "LeadSubmitted" },
        ...providerRuleCandidateWhere({
          connectionId: input.channel.connectionId,
          channelIds: [input.channel.id],
        }),
      },
      select: ruleSelect,
      orderBy: { createdAt: "asc" },
      take: 100,
    })) as OverrideRule[];
    if (rules.length === 0) return null;
    // Every active rule takes part in precedence, the ones not sending
    // included: a specific rule that is not sending replaces the global one
    // on its number, so that number keeps the entry send (decision A).
    const scopedChannel: ScopedChannel = {
      id: input.channel.id,
      connectionId: input.channel.connectionId,
      provider: input.channel.provider,
    };
    const applicability = await resolveApplicableProviderRules(client, {
      workspaceId: input.workspaceId,
      rules,
      channel: scopedChannel,
    });
    const candidates: Array<{ rule: OverrideRule; channelId: string }> = [
      ...applicability.applicable.map((rule) => ({
        rule,
        channelId: input.channel.id,
      })),
      ...applicability.duplicatePhone.map((entry) => ({
        rule: entry.rule,
        channelId: entry.canonicalChannelId,
      })),
    ].filter(
      ({ rule }) =>
        rule.mode === "production" && rule.productionActivatedAt !== null,
    );
    if (candidates.length === 0) return null;
    const channelIds = [...new Set(candidates.map((c) => c.channelId))];
    const channels = (await client.inboundWebhookChannel.findMany({
      where: { workspaceId: input.workspaceId, id: { in: channelIds } },
      select: channelSelect,
    })) as GateChannel[];
    const channelById = new Map(channels.map((c) => [c.id, c]));
    const covering = candidates.filter(({ rule, channelId }) => {
      const channel = channelById.get(channelId);
      return Boolean(channel && ruleWillSendOnChannel(rule, channel));
    });
    if (covering.length === 0) return null;
    // nod: the rule send needs a usable license (instead of the SaaS seat).
    if (!(await licenseUsable(deps.license))) return null;
    if (
      !(await destinationWillResolve(client, input.workspaceId, input.destination, deps))
    )
      return null;
    const unique = [
      ...new Map(covering.map(({ rule }) => [rule.id, rule])).values(),
    ];
    return {
      ruleIds: unique.map((rule) => rule.id),
      ruleNames: unique.map((rule) => rule.conversionRule.name),
    };
  } catch {
    // Scope lookup refused (e.g. channel limit): keep the default (send). A
    // database error inside an interactive transaction still aborts the
    // caller's transaction on its next statement, exactly as before.
    return null;
  }
}
