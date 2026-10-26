import type { Prisma } from "@prisma/client";
import { providerConversionDecisionSchema } from "@wpptrack/shared";
import {
  COVERED_CONVERTING_LOG_WHERE,
  COVERED_LOG_SELECT,
  isLeadLifetimeEvent,
  pickPriorLeadLifetimeConversion,
  resolveLeadConversionIdentities,
} from "../conversion-events/lead-lifetime-conversion-guard";
import { BRIDGED_WHATSAPP_PROVIDERS } from "../inbound-webhooks/bridged-whatsapp-providers";

/**
 * "Reprocessar bloqueadas" (Últimas execuções): which executions of a rule
 * are retried once their number is in production.
 *
 *  - blocked with `connection_not_production` / `channel_not_active`: the
 *    number was not live when the conversation happened (the global-rule
 *    incident: QR numbers never promoted by a "Todos os números" rule);
 *  - observed with `before_production_activation`: the rule WAS in production
 *    but the number had not been activated yet. Observations of a rule that
 *    was itself in observation (`*_observation`) are NOT retried: the operator
 *    chose not to send those, and reprocessing must not change that decision.
 *
 * Meta CAPI refuses event_time older than 7 days (meta-capi.adapter.ts), so
 * the retry window is 7 days minus a one-hour margin for the queue; older
 * executions are reported as expired and never retried.
 */
export const BLOCKED_REPROCESS_REASONS = [
  "connection_not_production",
  "channel_not_active",
] as const;
export const OBSERVED_REPROCESS_REASONS = ["before_production_activation"] as const;
export const BLOCKED_REPROCESS_WINDOW_DAYS = 7;
const SAFETY_MARGIN_MS = 60 * 60 * 1_000;
/** Executions retried per click; the rest is reported as `remaining`. */
export const BLOCKED_REPROCESS_BATCH = 50;
/** Minimum interval between two runs for the same rule. */
export const BLOCKED_REPROCESS_COOLDOWN_MS = 30 * 1_000;
export const BLOCKED_REPROCESS_AUDIT_ACTION =
  "provider_conversion_rule.blocked_reprocessed";

export function blockedReprocessCutoff(now: Date): Date {
  return new Date(
    now.getTime() -
      BLOCKED_REPROCESS_WINDOW_DAYS * 24 * 60 * 60 * 1_000 +
      SAFETY_MARGIN_MS,
  );
}

export function blockedReprocessWhere(
  workspaceId: string,
  providerRuleId: string,
): Prisma.ProviderConversionRuleExecutionWhereInput {
  return {
    workspaceId,
    providerRuleId,
    OR: [
      {
        status: "blocked",
        reasonCode: { in: [...BLOCKED_REPROCESS_REASONS] },
      },
      {
        status: "observed",
        reasonCode: { in: [...OBSERVED_REPROCESS_REASONS] },
      },
    ],
  };
}

export const BLOCKED_REPROCESS_STARTED_ACTION =
  "provider_conversion_rule.blocked_reprocess_started";
/** A started run without its completion audit blocks new runs this long. */
export const BLOCKED_REPROCESS_RUN_TTL_MS = 10 * 60 * 1_000;
/** Bound of executions inspected per summary/run (ready is capped by it). */
export const BLOCKED_REPROCESS_SCAN_LIMIT = 500;
const SCAN_PAGE = 100;

/**
 * Operator decisions that, when they happened BEFORE a conversation, make
 * its block deliberate: the gate connection had already been promoted,
 * paused or sent back to observation, or the channel had been paused. Such
 * a conversation belongs to a period the operator chose not to send, so it
 * is never resent, even after the number is live again.
 */
const DELIBERATE_CONNECTION_ACTIONS = [
  "inbound_webhook.connection_promoted",
  "inbound_webhook.connection_paused",
  "inbound_webhook.connection_observation",
] as const;
const DELIBERATE_CHANNEL_ACTIONS = ["inbound_webhook.channel_paused"] as const;
/** A `channel_not_active` block after the channel had already been live. */
const CHANNEL_ACTIVATED_ACTION = "inbound_webhook.channel_activated";

type ReprocessRule = {
  id: string;
  mode: string;
  removedAt?: Date | null;
  unifiedIntoProviderRuleId?: string | null;
  connectionId: string | null;
  connection: { status: string; removedAt: Date | null } | null;
  conversionRule: { active: boolean };
};

/**
 * Only a rule that sends right now is reprocessed: paused (the pause keeps
 * mode/productionActivatedAt), in observation, unified into a global rule
 * or removed rules never resend anything.
 */
export function ruleAcceptsReprocess(rule: ReprocessRule): boolean {
  return (
    !rule.removedAt &&
    rule.conversionRule.active &&
    rule.mode === "production" &&
    !rule.unifiedIntoProviderRuleId
  );
}

type ReprocessClient = Pick<
  Prisma.TransactionClient,
  "providerConversionRuleExecution" | "auditLog"
>;

export type ReprocessableExecution = {
  id: string;
  providerDecisionId: string;
  channelId?: string | null;
  eventName?: string | null;
};

type PreviewRoute = (input: { workspaceId: string; adId: string }) => Promise<{
  status: string;
  conversionDestinationId: string | null;
}>;

/** Distinct ad routes previewed per call; beyond it the destination is unknown. */
const PARTITION_ROUTE_LIMIT = 20;
/** Covered logs loaded per call (one query for every lead of the batch). */
const PARTITION_LOG_LIMIT = 5_000;

/**
 * Splits what a reprocess would retry into what it would really send and
 * what the production job would only mark as duplicate because the same
 * lead already converted this once-per-lead event for the same Meta
 * destination on another number or through the CTWA entry (same rule as
 * ProviderConversionProductionService, lead-lifetime-conversion-guard.ts).
 * Those are left untouched ("ficam como estão") and never re-enqueued.
 *
 * Runs on every Execuções summary, so it is batched: nothing at all when no
 * candidate is a once-per-lead event; otherwise one decision query, two lead
 * identity queries, one log query and at most PARTITION_ROUTE_LIMIT distinct
 * ad route previews. When the destination cannot be predicted the execution
 * stays ready (production decides, as before).
 */
export async function partitionAlreadyConverted(
  client: Pick<
    Prisma.TransactionClient,
    "providerConversionDecisionAudit" | "lead" | "conversionEventLog"
  >,
  input: {
    workspaceId: string;
    executions: ReprocessableExecution[];
    previewRoute: PreviewRoute;
  },
): Promise<{
  ready: ReprocessableExecution[];
  alreadyConverted: ReprocessableExecution[];
}> {
  const lifetime = input.executions.filter(
    (execution) =>
      execution.eventName && isLeadLifetimeEvent(execution.eventName),
  );
  if (lifetime.length === 0) {
    return { ready: input.executions, alreadyConverted: [] };
  }

  const audits = await client.providerConversionDecisionAudit.findMany({
    where: {
      workspaceId: input.workspaceId,
      id: { in: lifetime.map((execution) => execution.providerDecisionId) },
    },
    select: { id: true, decisionJson: true },
  });
  const leadByDecision = new Map<
    string,
    { id: string; adId: string | null; ctwaDestinationId: string | null }
  >();
  for (const audit of audits) {
    const decision = providerConversionDecisionSchema.safeParse(
      audit.decisionJson,
    );
    if (!decision.success || decision.data.decisionCode !== "eligible") continue;
    const lead = decision.data.leadResolution.lead;
    leadByDecision.set(audit.id, {
      id: lead.id,
      adId: lead.adId ?? null,
      ctwaDestinationId: lead.ctwaDestination?.destinationId ?? null,
    });
  }

  const destinationByAd = new Map<string, string | null>();
  const adIds = [
    ...new Set(
      [...leadByDecision.values()]
        .map((lead) => lead.adId)
        .filter((adId): adId is string => Boolean(adId)),
    ),
  ].slice(0, PARTITION_ROUTE_LIMIT);
  for (const adId of adIds) {
    try {
      const route = await input.previewRoute({
        workspaceId: input.workspaceId,
        adId,
      });
      destinationByAd.set(
        adId,
        route.status === "resolved" ? route.conversionDestinationId : null,
      );
    } catch {
      destinationByAd.set(adId, null);
    }
  }

  const identities = await resolveLeadConversionIdentities(
    client,
    input.workspaceId,
    [...leadByDecision.values()].map((lead) => lead.id),
  );
  const allLeadIds = [...new Set([...identities.values()].flat())];
  const eventNames = [
    ...new Set(lifetime.map((execution) => execution.eventName!)),
  ];
  const logs = allLeadIds.length
    ? await client.conversionEventLog.findMany({
        where: {
          workspaceId: input.workspaceId,
          leadId: { in: allLeadIds },
          eventName: { in: eventNames },
          ...COVERED_CONVERTING_LOG_WHERE,
        },
        select: COVERED_LOG_SELECT,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: PARTITION_LOG_LIMIT,
      })
    : [];

  const converted = new Set<string>();
  for (const execution of lifetime) {
    const lead = leadByDecision.get(execution.providerDecisionId);
    if (!lead) continue;
    const destinationId =
      (lead.adId ? destinationByAd.get(lead.adId) : null) ??
      lead.ctwaDestinationId;
    if (!destinationId) continue;
    const leadIds = identities.get(lead.id) ?? [lead.id];
    const prior = pickPriorLeadLifetimeConversion(
      logs.filter(
        (log) =>
          log.eventName === execution.eventName &&
          log.leadId !== null &&
          leadIds.includes(log.leadId),
      ),
      {
        conversionDestinationId: destinationId,
        channelId: execution.channelId ?? null,
        pipeline: "provider_rule",
        ownDedupeKey: `provider-conversion:${execution.id}`,
      },
    );
    if (prior) converted.add(execution.id);
  }
  return {
    ready: input.executions.filter((execution) => !converted.has(execution.id)),
    alreadyConverted: input.executions.filter((execution) =>
      converted.has(execution.id),
    ),
  };
}

/**
 * Executions a reprocess may retry now, oldest first. On top of the reason
 * and window filters:
 *  - frozen decision present, UAZAPI number (the only recovery path wired
 *    here) and number live NOW: anything else would just fail again, and
 *    leaving it in the query would starve the batch forever;
 *  - deliberate pauses are respected (DELIBERATE_* above): a conversation
 *    that happened after the gate connection had been promoted, paused or
 *    sent back to observation, or after its channel had been paused (or,
 *    for `channel_not_active`, activated), is skipped. Only numbers that had
 *    never been live nor held back on purpose (the global-rule incident) are
 *    recovered. Rows older than the audit trail have no audit and count as
 *    never live.
 * Scans at most BLOCKED_REPROCESS_SCAN_LIMIT rows.
 */
export async function findReprocessableExecutions(
  client: ReprocessClient,
  input: {
    workspaceId: string;
    rule: ReprocessRule;
    cutoff: Date;
    limit: number;
  },
): Promise<ReprocessableExecution[]> {
  if (!ruleAcceptsReprocess(input.rule)) return [];
  const live = blockedReprocessLiveChannelWhere(
    input.rule.connection,
    input.rule.connectionId !== null,
  );
  if (!live) return [];
  const where: Prisma.ProviderConversionRuleExecutionWhereInput = {
    AND: [
      blockedReprocessWhere(input.workspaceId, input.rule.id),
      { occurredAt: { gte: input.cutoff } },
      { providerDecisionId: { not: null } },
      live,
      {
        channel: {
          is: {
            connection: {
              is: { provider: { in: [...BRIDGED_WHATSAPP_PROVIDERS] } },
            },
          },
        },
      },
    ],
  };
  const result: ReprocessableExecution[] = [];
  let scanned = 0;
  let cursor: string | undefined;
  while (result.length < input.limit && scanned < BLOCKED_REPROCESS_SCAN_LIMIT) {
    const page = await client.providerConversionRuleExecution.findMany({
      where,
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: SCAN_PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        providerDecisionId: true,
        status: true,
        reasonCode: true,
        occurredAt: true,
        channelId: true,
        channel: { select: { connectionId: true } },
        providerDecision: { select: { eventName: true } },
      },
    });
    if (page.length === 0) break;
    scanned += page.length;
    cursor = page[page.length - 1]!.id;

    const connectionIds = [
      ...new Set(
        page.map(
          (row) => input.rule.connectionId ?? row.channel?.connectionId ?? "",
        ),
      ),
    ].filter(Boolean);
    const channelIds = [
      ...new Set(page.map((row) => row.channelId ?? "")),
    ].filter(Boolean);
    const latest = page.reduce(
      (max, row) => (row.occurredAt > max ? row.occurredAt : max),
      page[0]!.occurredAt,
    );
    const history = await client.auditLog.findMany({
      where: {
        workspaceId: input.workspaceId,
        createdAt: { lt: latest },
        OR: [
          {
            action: { in: [...DELIBERATE_CONNECTION_ACTIONS] },
            targetType: "InboundWebhookConnection",
            targetId: { in: connectionIds },
          },
          {
            action: {
              in: [...DELIBERATE_CHANNEL_ACTIONS, CHANNEL_ACTIVATED_ACTION],
            },
            targetType: "InboundWebhookChannel",
            targetId: { in: channelIds },
          },
        ],
      },
      select: { action: true, targetId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    // First moment each target was decided on, per kind of decision.
    const firstConnectionDecision = new Map<string, number>();
    const firstChannelPause = new Map<string, number>();
    const firstChannelActivation = new Map<string, number>();
    for (const entry of history) {
      const at = entry.createdAt.getTime();
      const target =
        entry.action === CHANNEL_ACTIVATED_ACTION
          ? firstChannelActivation
          : (DELIBERATE_CHANNEL_ACTIONS as readonly string[]).includes(
                entry.action,
              )
            ? firstChannelPause
            : firstConnectionDecision;
      if (!target.has(entry.targetId)) target.set(entry.targetId, at);
    }
    const before = (map: Map<string, number>, id: string | null, at: Date) =>
      Boolean(id) && (map.get(id!) ?? Infinity) < at.getTime();
    for (const row of page) {
      if (!row.providerDecisionId) continue;
      const connectionId =
        input.rule.connectionId ?? row.channel?.connectionId ?? null;
      const deliberate =
        before(firstConnectionDecision, connectionId, row.occurredAt) ||
        before(firstChannelPause, row.channelId, row.occurredAt) ||
        (row.status === "blocked" &&
          row.reasonCode === "channel_not_active" &&
          before(firstChannelActivation, row.channelId, row.occurredAt));
      if (deliberate) continue;
      result.push({
        id: row.id,
        providerDecisionId: row.providerDecisionId,
        channelId: row.channelId,
        eventName: row.providerDecision?.eventName ?? null,
      });
      if (result.length >= input.limit) break;
    }
    if (page.length < SCAN_PAGE) break;
  }
  return result;
}

/**
 * Filter on the execution channel being live now. `gateConnection`: the rule
 * is bound to a connection, which gates every number; otherwise each number
 * is gated by its own connection. Null: nothing can be live.
 */
export function blockedReprocessLiveChannelWhere(
  gateConnection: { status: string; removedAt: Date | null } | null,
  bound: boolean,
): Prisma.ProviderConversionRuleExecutionWhereInput | null {
  if (bound) {
    if (
      !gateConnection ||
      gateConnection.status !== "production" ||
      gateConnection.removedAt !== null
    ) {
      return null;
    }
    return { channel: { is: { status: "active" } } };
  }
  return {
    channel: {
      is: {
        status: "active",
        connection: { is: { status: "production", removedAt: null } },
      },
    },
  };
}
