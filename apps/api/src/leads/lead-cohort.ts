/**
 * One definition of "lead novo" and "lead que voltou", shared by the Leads
 * page/export and the reports so their numbers always agree.
 *
 * - Lead novo: the person's first contact (Lead.firstMessageAt, or createdAt
 *   when no message time is known) falls inside the period. A person is a lead
 *   novo once ever, on that day; later conversations never make them new again.
 * - Lead que voltou: first contact before the period start and at least one
 *   paid LeadSubmitted (a new CTWA conversation sent to Meta) inside it.
 *
 * Periods are calendar days in the reporting timezone (America/Sao_Paulo).
 */

import { leadSubmittedRuleOverrideEnabled } from "../config/lead-submitted-rule-override-flag";

export type LeadPeriodRange = { gte?: Date; lte?: Date };

/** Tarefa 20: rule override report mode (resolveRuleOverrideReportMode). */
export type CohortOptions = { ruleOverride?: boolean };

/** Lead rows whose first contact falls inside `range`. */
export function leadFirstContactInRangeWhere(range: LeadPeriodRange) {
  return {
    OR: [{ firstMessageAt: range }, { firstMessageAt: null, createdAt: range }],
  };
}

/** Lead rows whose first contact happened before `start`. */
export function leadFirstContactBeforeWhere(start: Date) {
  return {
    OR: [
      { firstMessageAt: { lt: start } },
      { firstMessageAt: null, createdAt: { lt: start } },
    ],
  };
}

/**
 * sourceTrigger suffixes of a LeadSubmitted sent by a provider conversion rule
 * ("inbound_webhook:<provider>:<trigger>"): phrase, catalog, label/automation.
 * Such a log is NOT a conversation: the conversation is the entry receipt.
 */
export const RULE_LEAD_SUBMITTED_TRIGGER_SUFFIXES = [
  ":message_phrase",
  ":structured_catalog",
  ":provider_automation",
] as const;

/**
 * sourceTrigger of a manual lead conversion (tarefa 21). A manual
 * LeadSubmitted is NOT a new conversation either: it is treated exactly like
 * a rule-sent one (excluded from conversations, and with the rule override it
 * makes a deferred lead "novo" on the day it was sent).
 */
export const MANUAL_CONVERSION_SOURCE_TRIGGER = "manual_conversion";

export function isRuleOriginatedTrigger(
  sourceTrigger: string | null | undefined,
): boolean {
  return Boolean(
    sourceTrigger &&
      (sourceTrigger === MANUAL_CONVERSION_SOURCE_TRIGGER ||
        RULE_LEAD_SUBMITTED_TRIGGER_SUFFIXES.some((suffix) =>
          sourceTrigger.endsWith(suffix),
        )),
  );
}

const ruleOriginatedTriggerWhere = [
  ...RULE_LEAD_SUBMITTED_TRIGGER_SUFFIXES.map((suffix) => ({
    sourceTrigger: { endsWith: suffix } as {
      endsWith?: string;
      equals?: string;
    },
  })),
  { sourceTrigger: { equals: MANUAL_CONVERSION_SOURCE_TRIGGER } },
];

/**
 * A new paid conversation: the LeadSubmitted event sent to Meta for each CTWA
 * conversation. Skipped events never count; organic ones are not "por anuncio".
 * A manual LeadSubmitted (tarefa 21) is never a conversation.
 */
export const paidLeadSubmittedEventWhere = {
  eventName: "LeadSubmitted",
  status: { not: "skipped" },
  businessSource: { not: "organic" },
  NOT: { sourceTrigger: { equals: MANUAL_CONVERSION_SOURCE_TRIGGER } },
} as const;

/**
 * Tarefa 20 (rule override mode only): the ENTRY LeadSubmitted of each CTWA
 * conversation. A LeadSubmitted sent later by a provider rule is not a new
 * conversation (the entry receipt, even deferred/not_eligible, counts it).
 */
export const paidEntryLeadSubmittedEventWhere = {
  ...paidLeadSubmittedEventWhere,
  NOT: ruleOriginatedTriggerWhere,
} as const;

/** The conversation filter of a report: today's, or the override one. */
export function paidLeadSubmittedWhereFor(ruleOverride: boolean) {
  return ruleOverride
    ? paidEntryLeadSubmittedEventWhere
    : paidLeadSubmittedEventWhere;
}

/**
 * errorCode of an entry receipt whose LeadSubmitted was deferred to a provider
 * rule (mirrors conversion-rules/lead-submitted-rule-override.ts).
 */
export const DEFERRED_ENTRY_ERROR_CODE = "lead_submitted_deferred_to_rule";

// LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED: same parser as the rules (on by default).

/**
 * How far before the period a deferred entry receipt is still looked for: a
 * deferred lead whose rule sends inside the period normally entered a few
 * days before it. Bounds every lookup to a window of receipts.
 */
export const DEFERRED_LOOKBACK_DAYS = 60;
/** Hard bound of deferred receipts / rule sends read per report. */
export const DEFERRED_SCAN_LIMIT = 20_000;

function deferredWindow(range: LeadPeriodRange | null) {
  if (!range) return undefined;
  return {
    ...(range.gte
      ? {
          gte: new Date(
            range.gte.getTime() - DEFERRED_LOOKBACK_DAYS * 24 * 3600_000,
          ),
        }
      : {}),
    ...(range.lte ? { lte: range.lte } : {}),
  };
}

/**
 * Report mode of tarefa 20: ON only with LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED (on by default)
 * and a deferred entry receipt in the workspace around the period (one
 * indexed findFirst). Flag off: no query and every report is exactly today's.
 */
export async function resolveRuleOverrideReportMode(
  client: { conversionEventLog: { findFirst(args: unknown): Promise<unknown> } },
  workspaceId: string,
  range: LeadPeriodRange | null,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  if (!leadSubmittedRuleOverrideEnabled(env)) return false;
  const window = deferredWindow(range);
  const found = await client.conversionEventLog.findFirst({
    where: {
      workspaceId,
      eventName: "LeadSubmitted",
      errorCode: DEFERRED_ENTRY_ERROR_CODE,
      ...(window ? { eventOccurredAt: window } : {}),
    },
    select: { id: true },
  });
  return Boolean(found);
}

/** Log statuses that never reached and never will reach Meta. */
const NON_SENDING_STATUSES = [
  "shadow_observed",
  "imported",
  "not_eligible",
  "skipped",
];

type DeferredClient = {
  conversionEventLog: { findMany(args: unknown): Promise<unknown> };
};

/**
 * "Leads novos" with the rule override (tarefa 20). A lead whose entry was
 * deferred to a provider rule (and that never had an entry LeadSubmitted sent)
 * becomes a lead novo when the rule's LeadSubmitted is sent, on that day, and
 * never before. Returns, for the candidate leads that are such "deferred
 * leads", the time of their first rule LeadSubmitted (null = not sent yet).
 * Leads without a deferred receipt are absent: their rule stays first contact.
 * Workspaces without deferred receipts pay one indexed query per chunk.
 */
export async function resolveDeferredLeadNovoTimes(
  client: DeferredClient,
  workspaceId: string,
  candidateLeadIds: string[],
): Promise<Map<string, Date | null>> {
  const result = new Map<string, Date | null>();

  for (const ids of chunked([...new Set(candidateLeadIds)])) {
    const deferred = (await client.conversionEventLog.findMany({
      where: {
        workspaceId,
        eventName: "LeadSubmitted",
        errorCode: DEFERRED_ENTRY_ERROR_CODE,
        leadId: { in: ids },
      },
      select: { leadId: true },
    })) as Array<{ leadId: string | null }>;
    const deferredIds = [
      ...new Set(deferred.flatMap((row) => (row.leadId ? [row.leadId] : []))),
    ];

    if (deferredIds.length === 0) {
      continue;
    }

    const logs = (await client.conversionEventLog.findMany({
      where: {
        workspaceId,
        eventName: "LeadSubmitted",
        leadId: { in: deferredIds },
        status: { notIn: NON_SENDING_STATUSES },
      },
      select: { leadId: true, sourceTrigger: true, eventOccurredAt: true },
    })) as Array<{
      leadId: string | null;
      sourceTrigger: string;
      eventOccurredAt: Date | string;
    }>;
    // An entry LeadSubmitted that was sent (another conversation, before the
    // override) keeps the lead on the regular first-contact rule.
    const entrySent = new Set(
      logs.flatMap((log) =>
        log.leadId && !isRuleOriginatedTrigger(log.sourceTrigger)
          ? [log.leadId]
          : [],
      ),
    );

    for (const leadId of deferredIds) {
      if (entrySent.has(leadId)) {
        continue;
      }

      const first = logs
        .filter(
          (log) =>
            log.leadId === leadId && isRuleOriginatedTrigger(log.sourceTrigger),
        )
        .map((log) => new Date(log.eventOccurredAt))
        .sort((left, right) => left.getTime() - right.getTime())[0];

      result.set(leadId, first ?? null);
    }
  }

  return result;
}

/** Leads with a rule-sent LeadSubmitted inside `range` (deferred candidates). */
export async function ruleLeadSubmittedLeadIdsInRange(
  client: DeferredClient,
  workspaceId: string,
  range: LeadPeriodRange,
): Promise<string[]> {
  const logs = (await client.conversionEventLog.findMany({
    where: {
      workspaceId,
      eventName: "LeadSubmitted",
      leadId: { not: null },
      status: { notIn: NON_SENDING_STATUSES },
      eventOccurredAt: range,
      OR: ruleOriginatedTriggerWhere,
    },
    select: { leadId: true },
    take: DEFERRED_SCAN_LIMIT,
  })) as Array<{ leadId: string | null }>;

  return [...new Set(logs.flatMap((log) => (log.leadId ? [log.leadId] : [])))];
}

export function inLeadPeriod(date: Date, range: LeadPeriodRange): boolean {
  return (
    (!range.gte || date.getTime() >= range.gte.getTime()) &&
    (!range.lte || date.getTime() <= range.lte.getTime())
  );
}

/**
 * Leads novos of a period with the rule override applied: deferred leads
 * leave the first-contact set and join it on the day their rule sent the
 * LeadSubmitted (their `firstMessageAt` then carries that time, for the daily
 * counts). `loadLeads` loads the extra leads by id with the caller's filters.
 * Without any deferred receipt the input comes back unchanged.
 */
export async function applyDeferredLeadNovoTiming<
  T extends { id: string; firstMessageAt: Date | null },
>(
  client: DeferredClient,
  workspaceId: string,
  leads: T[],
  range: LeadPeriodRange,
  loadLeads: (ids: string[]) => Promise<T[]>,
): Promise<T[]> {
  const ruleSent = await ruleLeadSubmittedLeadIdsInRange(
    client,
    workspaceId,
    range,
  );
  const deferred = await resolveDeferredLeadNovoTimes(client, workspaceId, [
    ...leads.map((lead) => lead.id),
    ...ruleSent,
  ]);

  if (deferred.size === 0) {
    return leads;
  }

  const novoAt = new Map(
    [...deferred].flatMap(([leadId, at]) =>
      at && inLeadPeriod(at, range) ? [[leadId, at] as const] : [],
    ),
  );
  const kept = leads.filter((lead) => !deferred.has(lead.id));
  const loadedIds = new Set(leads.map((lead) => lead.id));
  const missing = [...novoAt.keys()].filter((id) => !loadedIds.has(id));
  const extra: T[] = [];

  for (const ids of chunked(missing)) {
    extra.push(...(await loadLeads(ids)));
  }

  const included = [
    ...leads.filter((lead) => novoAt.has(lead.id)),
    ...extra.filter((lead) => novoAt.has(lead.id)),
  ].map((lead) => ({ ...lead, firstMessageAt: novoAt.get(lead.id)! }));

  return [...kept, ...included];
}

/**
 * Prisma filter version for the Leads page ("Leads novos" of a period): the
 * first-contact filter without the deferred leads, plus the deferred leads
 * whose rule LeadSubmitted was sent in the period. null = no deferred lead
 * involved (use the plain first-contact filter). Call it only in the rule
 * override mode (resolveRuleOverrideReportMode). Bounded: candidates are the
 * deferred receipts of the lookback window and the rule sends of the period
 * (never every lead of the period).
 */
export async function deferredLeadNovoPeriodWhere(
  client: DeferredClient,
  workspaceId: string,
  range: LeadPeriodRange,
) {
  const receipts = (await client.conversionEventLog.findMany({
    where: {
      workspaceId,
      eventName: "LeadSubmitted",
      errorCode: DEFERRED_ENTRY_ERROR_CODE,
      leadId: { not: null },
      eventOccurredAt: deferredWindow(range),
    },
    select: { leadId: true },
    take: DEFERRED_SCAN_LIMIT,
  })) as Array<{ leadId: string | null }>;
  const ruleSent = await ruleLeadSubmittedLeadIdsInRange(
    client,
    workspaceId,
    range,
  );
  const deferred = await resolveDeferredLeadNovoTimes(client, workspaceId, [
    ...receipts.flatMap((row) => (row.leadId ? [row.leadId] : [])),
    ...ruleSent,
  ]);

  if (deferred.size === 0) {
    return null;
  }

  const included = [...deferred].flatMap(([leadId, at]) =>
    at && inLeadPeriod(at, range) ? [leadId] : [],
  );

  return {
    OR: [
      {
        AND: [
          leadFirstContactInRangeWhere(range),
          { id: { notIn: [...deferred.keys()] } },
        ],
      },
      ...(included.length ? [{ id: { in: included } }] : []),
    ],
  };
}

/** Splits large `in` lists so a query never exceeds the bind-parameter limit. */
export function chunked<T>(values: T[], size = 5000): T[][] {
  const chunks: T[][] = [];

  for (let start = 0; start < values.length; start += size) {
    chunks.push(values.slice(start, start + size));
  }

  return chunks;
}

export type LeadAttribution = {
  campaignId: string | null;
  adSetId: string | null;
  adId: string | null;
};

export type LeadAttributionField = keyof LeadAttribution;

const attributionFields: LeadAttributionField[] = [
  "campaignId",
  "adSetId",
  "adId",
];

type AttributionEvent = LeadAttribution & {
  leadId: string | null;
  eventName?: string | null;
  status?: string | null;
  businessSource?: string | null;
  eventOccurredAt: Date | string;
};

type FindManyClient = {
  conversionEventLog: { findMany(args: unknown): Promise<unknown> };
  lead: { findMany(args: unknown): Promise<unknown> };
};

function hasAnyAttribution(item: LeadAttribution): boolean {
  return Boolean(item.campaignId || item.adSetId || item.adId);
}

function isPaidLeadSubmitted(
  event: Pick<AttributionEvent, "eventName" | "status" | "businessSource"> & {
    sourceTrigger?: string | null;
  },
): boolean {
  return (
    event.eventName === "LeadSubmitted" &&
    event.status !== "skipped" &&
    event.businessSource?.trim().toLowerCase() !== "organic" &&
    !isRuleOriginatedTrigger(event.sourceTrigger)
  );
}

/**
 * The ad that brought the person in: the earliest paid LeadSubmitted that
 * names an ad. Fields that event lacks are filled from later events (then
 * the Lead row) only when they agree with what it does name, so a partial
 * first event (e.g. campaign only) never drops the lead from ad set/ad
 * reports nor mixes two hierarchies. Without such an event the Lead row
 * attribution stands. Lead rows keep the LATEST ad (upserts overwrite it),
 * which is why the row alone cannot answer this.
 */
export function firstContactAttribution(
  lead: LeadAttribution,
  events: AttributionEvent[],
): LeadAttribution {
  const withAd = events
    .filter((event) => isPaidLeadSubmitted(event) && hasAnyAttribution(event))
    .sort(
      (left, right) =>
        new Date(left.eventOccurredAt).getTime() -
        new Date(right.eventOccurredAt).getTime(),
    );
  const first = withAd[0];

  if (!first) {
    return {
      campaignId: lead.campaignId,
      adSetId: lead.adSetId,
      adId: lead.adId,
    };
  }

  const result: LeadAttribution = {
    campaignId: first.campaignId ?? null,
    adSetId: first.adSetId ?? null,
    adId: first.adId ?? null,
  };
  const compatible = (candidate: LeadAttribution) =>
    attributionFields.every(
      (field) =>
        !result[field] ||
        !candidate[field] ||
        candidate[field] === result[field],
    );

  for (const candidate of [...withAd.slice(1), lead]) {
    if (attributionFields.every((field) => result[field])) {
      break;
    }

    if (!compatible(candidate)) {
      continue;
    }

    for (const field of attributionFields) {
      result[field] = result[field] ?? candidate[field] ?? null;
    }
  }

  return result;
}

/** First-contact attribution of each lead, loaded in chunks. */
export async function loadFirstContactAttributions(
  client: FindManyClient,
  workspaceId: string,
  leads: Array<LeadAttribution & { id: string }>,
  options: CohortOptions = {},
): Promise<Map<string, LeadAttribution>> {
  const eventsByLead = new Map<string, AttributionEvent[]>();

  for (const ids of chunked(leads.map((lead) => lead.id))) {
    const wanted = new Set(ids);
    const events = (await client.conversionEventLog.findMany({
      where: {
        workspaceId,
        ...paidLeadSubmittedWhereFor(options.ruleOverride === true),
        leadId: { in: ids },
      },
      select: {
        leadId: true,
        eventName: true,
        status: true,
        businessSource: true,
        campaignId: true,
        adSetId: true,
        adId: true,
        eventOccurredAt: true,
      },
    })) as AttributionEvent[];

    for (const event of events) {
      if (!event.leadId || !wanted.has(event.leadId)) {
        continue;
      }

      const list = eventsByLead.get(event.leadId) ?? [];
      list.push(event);
      eventsByLead.set(event.leadId, list);
    }
  }

  return new Map(
    leads.map((lead) => [
      lead.id,
      firstContactAttribution(lead, eventsByLead.get(lead.id) ?? []),
    ]),
  );
}

/** Replaces each lead's campaign/ad set/ad with its first-contact ones. */
export async function withFirstContactAttribution<
  T extends LeadAttribution & { id: string },
>(
  client: FindManyClient,
  workspaceId: string,
  leads: T[],
  options: CohortOptions = {},
): Promise<T[]> {
  if (leads.length === 0) {
    return leads;
  }

  const attributions = await loadFirstContactAttributions(
    client,
    workspaceId,
    leads,
    options,
  );

  return leads.map((lead) => ({ ...lead, ...attributions.get(lead.id) }));
}

/**
 * Leads filter "campaign/ad set/ad = value" by FIRST-contact attribution, the
 * same rule the reports use. Returned as the row filter plus two short
 * corrections (leads whose ad changed since), so the list/count query never
 * carries the whole campaign as an id list.
 */
export async function firstContactScopeWhere(
  client: FindManyClient,
  workspaceId: string,
  field: LeadAttributionField,
  value: string,
  options: CohortOptions = {},
) {
  const { movedAway, movedIn } = await firstContactScopeCorrections(
    client,
    workspaceId,
    field,
    value,
    options,
  );

  return {
    OR: [
      {
        [field]: value,
        ...(movedAway.length ? { id: { notIn: movedAway } } : {}),
      },
      ...(movedIn.length ? [{ id: { in: movedIn } }] : []),
    ],
  };
}

/**
 * The two corrections of `firstContactScopeWhere`: leads whose row names
 * `value` but whose first contact was another one (movedAway), and leads
 * whose first contact named `value` but whose row moved on (movedIn). Also
 * used by the CRM board query (SQL), so both select the same leads.
 */
export async function firstContactScopeCorrections(
  client: FindManyClient,
  workspaceId: string,
  field: LeadAttributionField,
  value: string,
  options: CohortOptions = {},
): Promise<{ movedAway: string[]; movedIn: string[] }> {
  const select = { id: true, campaignId: true, adSetId: true, adId: true };
  const rowLeads = (await client.lead.findMany({
    where: { workspaceId, [field]: value },
    select,
  })) as Array<LeadAttribution & { id: string }>;
  const events = (await client.conversionEventLog.findMany({
    where: {
      workspaceId,
      ...paidLeadSubmittedWhereFor(options.ruleOverride === true),
      leadId: { not: null },
      [field]: value,
    },
    select: {
      leadId: true,
      eventName: true,
      status: true,
      businessSource: true,
    },
  })) as Array<
    Pick<AttributionEvent, "leadId" | "eventName" | "status" | "businessSource">
  >;
  const rowIds = new Set(rowLeads.map((lead) => lead.id));
  const otherIds = [
    ...new Set(
      events.flatMap((event) =>
        event.leadId && !rowIds.has(event.leadId) && isPaidLeadSubmitted(event)
          ? [event.leadId]
          : [],
      ),
    ),
  ];
  const otherLeads: Array<LeadAttribution & { id: string }> = [];

  for (const ids of chunked(otherIds)) {
    otherLeads.push(
      ...((await client.lead.findMany({
        where: { workspaceId, id: { in: ids } },
        select,
      })) as Array<LeadAttribution & { id: string }>),
    );
  }

  const attributions = await loadFirstContactAttributions(client, workspaceId, [
    ...rowLeads,
    ...otherLeads,
  ], options);
  const movedAway = rowLeads
    .filter((lead) => attributions.get(lead.id)?.[field] !== value)
    .map((lead) => lead.id);
  const movedIn = otherLeads
    .filter((lead) => attributions.get(lead.id)?.[field] === value)
    .map((lead) => lead.id);

  return { movedAway, movedIn };
}

/** A paid conversation reference: the lead it belongs to, or its phone. */
export type ConversationRef = {
  leadId?: string | null;
  phoneHash?: string | null;
};

/**
 * Conversaram mais de uma vez: one rule for the reports and the Leads page.
 * Each conversation counts for its lead; one without a lead id counts for
 * EVERY lead of its phone (like the returning filter, which takes all leads
 * of a phone). A conversation with no lead behind it is not a person.
 * Returns the ids of the leads with two or more conversations.
 */
export function repeatConversationLeadIds(
  conversations: ConversationRef[],
  leadIdsByPhoneHash: ReadonlyMap<string, readonly string[]>,
): string[] {
  const counts = new Map<string, number>();

  for (const conversation of conversations) {
    const leadIds = conversation.leadId
      ? [conversation.leadId]
      : conversation.phoneHash
        ? (leadIdsByPhoneHash.get(conversation.phoneHash) ?? [])
        : [];

    for (const leadId of new Set(leadIds)) {
      counts.set(leadId, (counts.get(leadId) ?? 0) + 1);
    }
  }

  return [...counts]
    .filter(([, count]) => count >= 2)
    .map(([leadId]) => leadId);
}

/**
 * Every lead of each phone hash (the workspace may hold more than one lead per
 * phone), loaded in chunks. Feeds `repeatConversationLeadIds`.
 */
export async function loadLeadIdsByPhoneHash(
  client: FindManyClient,
  workspaceId: string,
  phoneHashes: string[],
): Promise<Map<string, string[]>> {
  const leadIdsByPhoneHash = new Map<string, string[]>();

  for (const hashes of chunked([...new Set(phoneHashes)])) {
    const rows = (await client.lead.findMany({
      where: { workspaceId, phoneHash: { in: hashes } },
      select: { id: true, phoneHash: true },
    })) as Array<{ id: string; phoneHash: string | null }>;

    for (const row of rows) {
      if (!row.phoneHash) {
        continue;
      }

      const ids = leadIdsByPhoneHash.get(row.phoneHash) ?? [];

      if (!ids.includes(row.id)) {
        ids.push(row.id);
      }

      leadIdsByPhoneHash.set(row.phoneHash, ids);
    }
  }

  return leadIdsByPhoneHash;
}

/** Phone hashes of conversations that carry no lead id (to resolve them). */
export function phoneHashesWithoutLeadId(
  conversations: ConversationRef[],
): string[] {
  return [
    ...new Set(
      conversations.flatMap((conversation) =>
        !conversation.leadId && conversation.phoneHash
          ? [conversation.phoneHash]
          : [],
      ),
    ),
  ];
}
