import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { conversionEventDedupeMode } from "@wpptrack/shared";
import {
  hashPhoneIdentityVariants,
  phoneIdentityKey,
} from "../common/phone/phone-identity";

/**
 * "Once per lead" conversions across numbers and pipelines.
 *
 * Owner rule: a lead produces a once-per-lead event (catalog dedupeMode
 * "lifetime": LeadSubmitted, QualifiedLead) ONCE per Meta destination
 * (pixel/dataset) in the workspace, whichever WhatsApp number observed it and
 * whether it came from the CTWA entry (LeadSubmitted written on the first ad
 * message) or from a provider conversion rule (phrase, catalog, label,
 * automation). Different pixels may each receive the lead once. Purchases and
 * the other +-24h events are NOT covered: different purchases on different
 * numbers are real sales; they keep their per-number / per-order dedupe.
 *
 * Historical behavior kept on purpose: a repeat on the SAME number by the SAME
 * pipeline is decided by that pipeline exactly as before (provider rules by
 * their per-number business key, CTWA entries by their per-connection event
 * key). This guard only adds what those checks could not see: another number,
 * or the other pipeline.
 *
 * Covered conversion logs: sourceTrigger "inbound_webhook:<provider>" (CTWA
 * entry) and "inbound_webhook:<provider>:<trigger>" (provider rules). Logs of
 * Kommo, Pipedrive, Guimo, XMax and external events are neither checked nor
 * guarded (they keep their own dedupe).
 */

export const LEAD_CONVERTED_ON_ANOTHER_NUMBER =
  "lead_already_converted_other_number";
export const LEAD_CONVERTED_BY_ANOTHER_SOURCE =
  "lead_already_converted_other_source";

export type LeadConversionPipeline = "ctwa_entry" | "provider_rule";

/**
 * Statuses of a log that never reached and never will reach Meta: they do not
 * make the lead "converted". Everything else (queued, dispatching, sent,
 * waiting for context or value, technical error still retryable) counts.
 */
const NON_CONVERTING_LOG_STATUSES = [
  "shadow_observed",
  "imported",
  "not_eligible",
  "skipped",
];
/** Bound of sibling leads (phone variants) and of prior logs inspected. */
const IDENTITY_LEAD_LIMIT = 20;
const PRIOR_LOG_SCAN_LIMIT = 50;

type GuardClient = Pick<Prisma.TransactionClient, "lead" | "conversionEventLog"> &
  Partial<Pick<Prisma.TransactionClient, "$queryRaw">>;

export function isLeadLifetimeEvent(eventName: string): boolean {
  try {
    return (
      conversionEventDedupeMode(eventName as never) === "lifetime"
    );
  } catch {
    return false;
  }
}

export type LeadConversionIdentity = {
  /** The lead plus every older Lead row of an equivalent phone form. */
  leadIds: string[];
  /** Canonical phone line (or the lead id): the advisory lock identity. */
  lockIdentity: string;
};

/**
 * Lead identity across the BR phone forms (with/without 55, with/without the
 * mobile 9th digit). The current resolver never creates a second Lead for the
 * same line, but rows created before it may exist: all of them count as the
 * same person. Uses the (workspaceId, phoneHash) unique index; bounded.
 */
export async function resolveLeadConversionIdentity(
  client: Pick<Prisma.TransactionClient, "lead">,
  workspaceId: string,
  leadId: string,
): Promise<LeadConversionIdentity> {
  const lead = await client.lead.findFirst({
    where: { workspaceId, id: leadId },
    select: { id: true, phoneHash: true, phoneDisplay: true },
  });
  if (!lead) return { leadIds: [leadId], lockIdentity: `lead:${leadId}` };
  const canonical = phoneIdentityKey(lead.phoneDisplay);
  const hashes = [
    ...new Set([
      lead.phoneHash,
      ...hashPhoneIdentityVariants([lead.phoneDisplay]),
    ]),
  ];
  const siblings =
    hashes.length > 1
      ? await client.lead.findMany({
          where: { workspaceId, phoneHash: { in: hashes } },
          select: { id: true },
          take: IDENTITY_LEAD_LIMIT,
        })
      : [];
  return {
    leadIds: [...new Set([lead.id, ...siblings.map((row) => row.id)])],
    lockIdentity: canonical
      ? `phone:${createHash("sha256").update(canonical).digest("hex")}`
      : `lead:${lead.id}`,
  };
}

/**
 * Batched resolveLeadConversionIdentity (lead ids only, no lock identity) for
 * read-only previews over many executions: two indexed queries in total.
 */
export async function resolveLeadConversionIdentities(
  client: Pick<Prisma.TransactionClient, "lead">,
  workspaceId: string,
  leadIds: string[],
): Promise<Map<string, string[]>> {
  const unique = [...new Set(leadIds)];
  const result = new Map<string, string[]>(unique.map((id) => [id, [id]]));
  if (unique.length === 0) return result;
  const leads = await client.lead.findMany({
    where: { workspaceId, id: { in: unique } },
    select: { id: true, phoneHash: true, phoneDisplay: true },
  });
  const hashesByLead = new Map(
    leads.map((lead) => [
      lead.id,
      [
        ...new Set([
          lead.phoneHash,
          ...hashPhoneIdentityVariants([lead.phoneDisplay]),
        ]),
      ],
    ]),
  );
  const allHashes = [...new Set([...hashesByLead.values()].flat())];
  const siblings = allHashes.length
    ? await client.lead.findMany({
        where: { workspaceId, phoneHash: { in: allHashes } },
        select: { id: true, phoneHash: true },
        take: unique.length * IDENTITY_LEAD_LIMIT,
      })
    : [];
  for (const [leadId, hashes] of hashesByLead) {
    result.set(leadId, [
      ...new Set([
        leadId,
        ...siblings
          .filter((row) => hashes.includes(row.phoneHash))
          .map((row) => row.id),
      ]),
    ]);
  }
  return result;
}

/**
 * Transaction-scoped advisory lock of one lead identity + event. Every
 * covered path takes it LAST (after its own locks), so it never inverts a
 * lock order; the second of two concurrent writers then re-reads the logs
 * the first one committed (READ COMMITTED, one snapshot per statement).
 */
export async function lockLeadConversionIdentity(
  client: Pick<Prisma.TransactionClient, "$queryRaw">,
  workspaceId: string,
  identity: LeadConversionIdentity,
  eventName: string,
): Promise<void> {
  const digest = createHash("sha256")
    .update(
      `lead-lifetime-conversion\0${workspaceId}\0${identity.lockIdentity}\0${eventName}`,
      "utf8",
    )
    .digest();
  const first = digest.readInt32BE(0);
  const second = digest.readInt32BE(4);
  await client.$queryRaw`SELECT pg_advisory_xact_lock(CAST(${first} AS integer), CAST(${second} AS integer))::text`;
}

function pipelineOf(sourceTrigger: string): LeadConversionPipeline {
  return sourceTrigger.split(":").length <= 2 ? "ctwa_entry" : "provider_rule";
}

function channelOf(sourcePayload: Prisma.JsonValue | null): string | null {
  return sourcePayload &&
    typeof sourcePayload === "object" &&
    !Array.isArray(sourcePayload) &&
    typeof sourcePayload.channelId === "string"
    ? sourcePayload.channelId
    : null;
}

export type PriorLeadConversion = {
  conversionEventLogId: string;
  reasonCode:
    | typeof LEAD_CONVERTED_ON_ANOTHER_NUMBER
    | typeof LEAD_CONVERTED_BY_ANOTHER_SOURCE;
};

/**
 * A covered conversion of this once-per-lead event, for the same lead
 * identity and the same Meta destination, made by ANOTHER number or by the
 * OTHER pipeline. A prior log whose destination can no longer be read counts
 * as the same destination (the safe side is not to send twice). The caller's
 * own log (same dedupe key: idempotent retry) never blocks it.
 */
export async function findPriorLeadLifetimeConversion(
  client: Pick<Prisma.TransactionClient, "conversionEventLog">,
  input: {
    workspaceId: string;
    identity: LeadConversionIdentity;
    eventName: string;
    conversionDestinationId: string;
    channelId: string | null;
    pipeline: LeadConversionPipeline;
    ownDedupeKey: string | null;
  },
): Promise<PriorLeadConversion | null> {
  if (!isLeadLifetimeEvent(input.eventName)) return null;
  const logs = await client.conversionEventLog.findMany({
    where: {
      workspaceId: input.workspaceId,
      leadId: { in: input.identity.leadIds },
      eventName: input.eventName,
      ...COVERED_CONVERTING_LOG_WHERE,
    },
    select: COVERED_LOG_SELECT,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: PRIOR_LOG_SCAN_LIMIT,
  });
  return pickPriorLeadLifetimeConversion(logs, input);
}

/** Covered conversion logs that made the lead "converted" (see header). */
export const COVERED_CONVERTING_LOG_WHERE = {
  sourceTrigger: { startsWith: "inbound_webhook:" },
  status: { notIn: NON_CONVERTING_LOG_STATUSES },
};
export const COVERED_LOG_SELECT = {
  id: true,
  leadId: true,
  eventName: true,
  dedupeKey: true,
  sourceTrigger: true,
  sourcePayload: true,
  metaConversionDestinationId: true,
} as const;

export type CoveredLog = {
  id: string;
  dedupeKey: string | null;
  sourceTrigger: string;
  sourcePayload: Prisma.JsonValue | null;
  metaConversionDestinationId: string | null;
};

/** Pure decision over already-loaded covered logs of one identity+event. */
export function pickPriorLeadLifetimeConversion(
  logs: CoveredLog[],
  input: {
    conversionDestinationId: string;
    channelId: string | null;
    pipeline: LeadConversionPipeline;
    ownDedupeKey: string | null;
  },
): PriorLeadConversion | null {
  if (
    input.ownDedupeKey &&
    logs.some((log) => log.dedupeKey === input.ownDedupeKey)
  )
    return null;
  for (const log of logs) {
    if (
      log.metaConversionDestinationId &&
      log.metaConversionDestinationId !== input.conversionDestinationId
    )
      continue;
    const otherNumber = channelOf(log.sourcePayload) !== input.channelId;
    const otherPipeline = pipelineOf(log.sourceTrigger) !== input.pipeline;
    if (!otherNumber && !otherPipeline) continue;
    return {
      conversionEventLogId: log.id,
      reasonCode: otherNumber
        ? LEAD_CONVERTED_ON_ANOTHER_NUMBER
        : LEAD_CONVERTED_BY_ANOTHER_SOURCE,
    };
  }
  return null;
}

/** resolve identity + lock (last) + find, inside the caller's transaction. */
export async function guardLeadLifetimeConversion(
  client: GuardClient & Pick<Prisma.TransactionClient, "$queryRaw">,
  input: {
    workspaceId: string;
    leadId: string;
    eventName: string;
    conversionDestinationId: string;
    channelId: string | null;
    pipeline: LeadConversionPipeline;
    ownDedupeKey: string | null;
  },
): Promise<PriorLeadConversion | null> {
  if (!isLeadLifetimeEvent(input.eventName)) return null;
  const identity = await resolveLeadConversionIdentity(
    client,
    input.workspaceId,
    input.leadId,
  );
  await lockLeadConversionIdentity(
    client,
    input.workspaceId,
    identity,
    input.eventName,
  );
  return findPriorLeadLifetimeConversion(client, { ...input, identity });
}
