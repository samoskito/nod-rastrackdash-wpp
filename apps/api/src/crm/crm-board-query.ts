import { Prisma } from "@prisma/client";
import {
  CRM_PANEL_ONLY_MANUAL_STATUS,
  CRM_VALID_CONVERSION_STATUSES,
  MANUAL_CONVERSION_TRIGGER,
} from "@wpptrack/shared";
import { IMPORTED_MANUAL_CONVERSION_STATUS } from "../conversion-events/lead-lifetime-conversion-guard";
import { DEFERRED_ENTRY_ERROR_CODE } from "../leads/lead-cohort";

/**
 * SQL of the CRM board (design §12). The stage of every lead is computed in
 * the database: one aggregated query per request, whose parameters never grow
 * with the number of leads/logs and whose output is bounded by the page size.
 *
 * Shape:
 *   stage_def    the board stages (eventName -> rank), one unnest() param pair
 *   period_leads the CTWA leads that arrived in the period (+ number/campaign)
 *   valid        DISTINCT ON (leadId): the most advanced valid conversion
 *   deferred     (override mode only) leads with a deferred entry receipt
 *   placed       one row per lead: rank of its column, when it entered it
 * Indexes used: Lead(workspaceId, firstMessageAt), Lead(workspaceId,
 * createdAt), ConversionEventLog(leadId). No migration.
 */

/** Rank of the "Conversas iniciadas" column (override mode). */
export const CRM_CONVERSATIONS_RANK = 0;
/** Rank of the base column (LeadSubmitted, "Leads novos"). */
export const CRM_BASE_RANK = 1;

export type CrmStageRank = { eventName: string; rank: number };

export type CrmPlacementInput = {
  workspaceId: string;
  /** Stages with rank >= CRM_BASE_RANK (the base stage included). */
  stages: CrmStageRank[];
  ruleOverride: boolean;
  /** Lead arrival range (inclusive); null = every lead (single-lead check). */
  range: { gte: Date; lte: Date } | null;
  whatsappInstanceId?: string | null;
  /** First-contact campaign filter (lead-cohort corrections included). */
  campaign?: {
    campaignId: string;
    excludeIds: string[];
    includeIds: string[];
  } | null;
  /** Only this lead (forward-only check of a kanban move). */
  leadId?: string | null;
  /** Only CTWA (ad-attributed) leads. Default true. */
  ctwaOnly?: boolean;
};

export type CrmPlacedRow = {
  leadId: string;
  stageRank: number;
  enteredAt: Date;
  arrivedAt: Date;
  valueCents: number | null;
  currency: string | null;
};

const ts = (date: Date) => Prisma.sql`CAST(${date.toISOString()} AS timestamp(3))`;

/**
 * Valid conversion (design §2): sent or on its way, or a panel-only manual,
 * or a manual conversion with status "imported" (already sent to Meta outside
 * this installation; rows of the 1.3.0 import, removed in 1.3.1).
 */
export function crmValidConversionSql(alias = "c"): Prisma.Sql {
  const column = (name: string) => Prisma.raw(`${alias}."${name}"`);
  return Prisma.sql`(${column("status")} IN (${Prisma.join([
    ...CRM_VALID_CONVERSION_STATUSES,
  ])}) OR (${column("status")} IN (${Prisma.join([
    CRM_PANEL_ONLY_MANUAL_STATUS,
    IMPORTED_MANUAL_CONVERSION_STATUS,
  ])}) AND ${column("sourceTrigger")} = ${MANUAL_CONVERSION_TRIGGER}))`;
}

function periodLeadsSql(input: CrmPlacementInput): Prisma.Sql {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`l."workspaceId" = ${input.workspaceId}`,
  ];
  if (input.range) {
    conditions.push(
      Prisma.sql`((l."firstMessageAt" >= ${ts(input.range.gte)} AND l."firstMessageAt" <= ${ts(
        input.range.lte,
      )}) OR (l."firstMessageAt" IS NULL AND l."createdAt" >= ${ts(
        input.range.gte,
      )} AND l."createdAt" <= ${ts(input.range.lte)}))`,
    );
  }
  if (input.ctwaOnly !== false) {
    conditions.push(
      Prisma.sql`(l."campaignId" IS NOT NULL OR l."adSetId" IS NOT NULL OR l."adId" IS NOT NULL OR l."ctwaClid" IS NOT NULL)`,
    );
  }
  if (input.whatsappInstanceId) {
    conditions.push(
      Prisma.sql`l."whatsappInstanceId" = ${input.whatsappInstanceId}`,
    );
  }
  if (input.leadId) {
    conditions.push(Prisma.sql`l.id = ${input.leadId}`);
  }
  if (input.campaign) {
    // One array parameter each: the corrections never become an IN list.
    conditions.push(
      Prisma.sql`((l."campaignId" = ${input.campaign.campaignId} AND NOT (l.id = ANY(${input.campaign.excludeIds}::text[]))) OR l.id = ANY(${input.campaign.includeIds}::text[]))`,
    );
  }
  return Prisma.sql`SELECT l.id, COALESCE(l."firstMessageAt", l."createdAt") AS arrived_at
    FROM "Lead" l
    WHERE ${Prisma.join(conditions, " AND ")}`;
}

/** WITH ... placed AS (...): one row per lead of the board. */
export function crmPlacementCte(input: CrmPlacementInput): Prisma.Sql {
  const events = input.stages.map((stage) => stage.eventName);
  const ranks = input.stages.map((stage) => stage.rank);
  const deferredCte = input.ruleOverride
    ? Prisma.sql`,
  deferred AS (
    SELECT DISTINCT c."leadId" AS lead_id
    FROM period_leads p
    JOIN "ConversionEventLog" c ON c."leadId" = p.id
    WHERE c."workspaceId" = ${input.workspaceId}
      AND c."eventName" = 'LeadSubmitted'
      AND c."errorCode" = ${DEFERRED_ENTRY_ERROR_CODE}
  )`
    : Prisma.empty;
  const fallbackRank = input.ruleOverride
    ? Prisma.sql`CASE WHEN d.lead_id IS NOT NULL THEN ${CRM_CONVERSATIONS_RANK}::int ELSE ${CRM_BASE_RANK}::int END`
    : Prisma.sql`${CRM_BASE_RANK}::int`;
  const deferredJoin = input.ruleOverride
    ? Prisma.sql`LEFT JOIN deferred d ON d.lead_id = p.id`
    : Prisma.empty;

  return Prisma.sql`WITH stage_def AS (
    SELECT * FROM unnest(${events}::text[], ${ranks}::int[]) AS s(event_name, stage_rank)
  ),
  period_leads AS (
    ${periodLeadsSql(input)}
  ),
  valid AS (
    SELECT DISTINCT ON (c."leadId")
      c."leadId" AS lead_id,
      s.stage_rank,
      c."eventOccurredAt" AS entered_at,
      c."valueCents" AS value_cents,
      c."currency" AS currency
    FROM period_leads p
    JOIN "ConversionEventLog" c ON c."leadId" = p.id
    JOIN stage_def s ON s.event_name = c."eventName"
    WHERE c."workspaceId" = ${input.workspaceId}
      AND ${crmValidConversionSql("c")}
    ORDER BY c."leadId", s.stage_rank DESC, c."eventOccurredAt" ASC, c.id ASC
  )${deferredCte},
  placed AS (
    SELECT
      p.id AS lead_id,
      p.arrived_at,
      CASE WHEN v.lead_id IS NOT NULL THEN v.stage_rank ELSE ${fallbackRank} END AS stage_rank,
      CASE WHEN v.lead_id IS NOT NULL THEN v.entered_at ELSE p.arrived_at END AS entered_at,
      v.value_cents,
      v.currency
    FROM period_leads p
    LEFT JOIN valid v ON v.lead_id = p.id
    ${deferredJoin}
  )`;
}

const placedColumns = Prisma.sql`x.lead_id AS "leadId", x.stage_rank AS "stageRank", x.entered_at AS "enteredAt", x.arrived_at AS "arrivedAt", x.value_cents AS "valueCents", x.currency AS "currency"`;

/**
 * Board: the first `limit` cards of every column plus each column's total,
 * in one query (row_number/count windows partitioned by column).
 */
export function crmBoardSql(input: CrmPlacementInput, limit: number): Prisma.Sql {
  return Prisma.sql`${crmPlacementCte(input)}
  SELECT ${placedColumns}, x.total::int AS "total"
  FROM (
    SELECT p.*,
      row_number() OVER (PARTITION BY p.stage_rank ORDER BY p.entered_at DESC, p.lead_id DESC) AS rn,
      count(*) OVER (PARTITION BY p.stage_rank) AS total
    FROM placed p
  ) x
  WHERE x.rn <= ${limit}
  ORDER BY x.stage_rank ASC, x.entered_at DESC, x.lead_id DESC`;
}

/**
 * "Carregar mais": the next `limit` cards of one column after the cursor,
 * plus how many cards follow the cursor (count window before the LIMIT).
 */
export function crmColumnSql(
  input: CrmPlacementInput,
  stageRank: number,
  cursor: { enteredAt: Date; leadId: string } | null,
  limit: number,
): Prisma.Sql {
  const after = cursor
    ? Prisma.sql`AND (x.entered_at, x.lead_id) < (${ts(cursor.enteredAt)}, ${cursor.leadId})`
    : Prisma.empty;
  return Prisma.sql`${crmPlacementCte(input)}
  SELECT ${placedColumns}, (count(*) OVER ())::int AS "afterCursor"
  FROM placed x
  WHERE x.stage_rank = ${stageRank} ${after}
  ORDER BY x.entered_at DESC, x.lead_id DESC
  LIMIT ${limit}`;
}

/** Current column of one lead (forward-only check). */
export function crmLeadStageSql(input: CrmPlacementInput): Prisma.Sql {
  return Prisma.sql`${crmPlacementCte(input)}
  SELECT ${placedColumns} FROM placed x`;
}

export function encodeCrmCursor(row: {
  enteredAt: Date;
  leadId: string;
}): string {
  return Buffer.from(
    JSON.stringify([row.enteredAt.toISOString(), row.leadId]),
    "utf8",
  ).toString("base64url");
}

export function decodeCrmCursor(
  cursor: string,
): { enteredAt: Date; leadId: string } | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string" ||
      !parsed[1]
    )
      return null;
    const enteredAt = new Date(parsed[0]);
    return Number.isFinite(enteredAt.getTime())
      ? { enteredAt, leadId: parsed[1] }
      : null;
  } catch {
    return null;
  }
}
