import { Prisma } from "@prisma/client";
import {
  CRM_BASE_STAGE_EVENT,
  CRM_OVERVIEW_EXCLUDED_STATUS,
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
 *   period_leads the CTWA leads that arrived or converted in the period
 *   valid        DISTINCT ON (leadId): the most advanced valid conversion
 *   deferred     (override mode only) leads with a deferred entry receipt
 *   placed       one row per lead: rank of its column, when it entered it
 * Period rule: a lead is in the first columns (rank <= base) when it ARRIVED
 * in the period; in a later column when the conversion that put it there
 * (eventOccurredAt, same field and day boundaries as the Visão geral) happened
 * in the period. The stage looks at conversions up to the end of the period,
 * so "Leads novos" of yesterday does not jump to a purchase made today.
 * Indexes used: Lead(workspaceId, firstMessageAt), Lead(workspaceId,
 * createdAt), ConversionEventLog(leadId) and, with a period,
 * ConversionEventLog(workspaceId, eventName, eventOccurredAt). No migration.
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
  /**
   * Period (inclusive): lead arrival for the first columns, conversion date
   * for the later ones; null = every lead (single-lead check).
   */
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
  /** The stage came from a rule in observation (nothing sent to Meta). */
  observed?: boolean;
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

/**
 * Conversion that places a lead in a stage column: a valid CRM conversion, or
 * (stages after the base) any status but skipped, exactly what the Visão geral
 * counts. Same rule with or without a period, so the kanban move check agrees
 * with the board.
 */
function stageConversionSql(alias: string): Prisma.Sql {
  const column = (name: string) => Prisma.raw(`${alias}."${name}"`);
  return Prisma.sql`(${crmValidConversionSql(alias)} OR (${column("eventName")} <> ${CRM_BASE_STAGE_EVENT} AND ${column("status")} <> ${CRM_OVERVIEW_EXCLUDED_STATUS}))`;
}

function periodLeadsSql(input: CrmPlacementInput): Prisma.Sql {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`l."workspaceId" = ${input.workspaceId}`,
  ];
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
  const select = (extra?: Prisma.Sql) =>
    Prisma.sql`SELECT l.id, COALESCE(l."firstMessageAt", l."createdAt") AS arrived_at
    FROM "Lead" l
    WHERE ${Prisma.join(extra ? [...conditions, extra] : conditions, " AND ")}`;
  if (!input.range) return select();
  // Arrived in the period, or has a board conversion in the period. One
  // index-friendly select each (Lead(workspaceId, firstMessageAt) / createdAt /
  // ConversionEventLog), united, instead of a top-level OR. No deliveryChannel
  // filter: without the Formulários Meta every log here is business messaging.
  const { gte, lte } = input.range;
  return Prisma.sql`${select(
    Prisma.sql`l."firstMessageAt" >= ${ts(gte)} AND l."firstMessageAt" <= ${ts(lte)}`,
  )}
    UNION
    ${select(
      Prisma.sql`l."firstMessageAt" IS NULL AND l."createdAt" >= ${ts(gte)} AND l."createdAt" <= ${ts(lte)}`,
    )}
    UNION
    ${select(
      Prisma.sql`l.id IN (
        SELECT c2."leadId" FROM "ConversionEventLog" c2
        WHERE c2."workspaceId" = ${input.workspaceId}
          AND c2."eventName" = ANY(${input.stages.map((stage) => stage.eventName)}::text[])
          AND c2."eventOccurredAt" >= ${ts(gte)}
          AND c2."eventOccurredAt" <= ${ts(lte)}
          AND ${stageConversionSql("c2")})`,
    )}
    UNION
    ${select(
      Prisma.sql`l.id IN (
        SELECT e2."leadId" FROM "ProviderConversionRuleExecution" e2
        JOIN "ProviderConversionDecisionAudit" d2
          ON d2."workspaceId" = e2."providerDecisionWorkspaceId" AND d2.id = e2."providerDecisionId"
        WHERE e2."workspaceId" = ${input.workspaceId}
          AND ${observedExecutionSql("e2")}
          AND d2."eventName" = ANY(${input.stages.map((stage) => stage.eventName)}::text[])
          AND e2."occurredAt" >= ${ts(gte)}
          AND e2."occurredAt" <= ${ts(lte)})`,
    )}`;
}

/**
 * Event recognized by a provider rule in observation for the lead (execution
 * "observed", see leads/observed-lead-conversions): it places the card as it
 * would in production, flagged "Em observação". Never a ConversionEventLog,
 * so the Visão geral and the reports never count it.
 */
function observedExecutionSql(alias: string): Prisma.Sql {
  return Prisma.raw(`${alias}."status" = 'observed' AND ${alias}."leadId" IS NOT NULL`);
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

  // With a period only the conversions inside it place the lead (the most
  // advanced of them; one column per lead). Earlier or later ones never count.
  const inPeriod = input.range
    ? Prisma.sql`AND c."eventOccurredAt" >= ${ts(input.range.gte)} AND c."eventOccurredAt" <= ${ts(input.range.lte)}`
    : Prisma.empty;
  const observedInPeriod = input.range
    ? Prisma.sql`AND e."occurredAt" >= ${ts(input.range.gte)} AND e."occurredAt" <= ${ts(input.range.lte)}`
    : Prisma.empty;
  const periodFilter = input.range
    ? Prisma.sql`WHERE (a.stage_rank <= ${CRM_BASE_RANK}::int AND a.arrived_at >= ${ts(input.range.gte)} AND a.arrived_at <= ${ts(input.range.lte)})
      OR (a.stage_rank > ${CRM_BASE_RANK}::int AND a.entered_at >= ${ts(input.range.gte)} AND a.entered_at <= ${ts(input.range.lte)})`
    : Prisma.empty;

  return Prisma.sql`WITH stage_def AS (
    SELECT * FROM unnest(${events}::text[], ${ranks}::int[]) AS s(event_name, stage_rank)
  ),
  period_leads AS (
    ${periodLeadsSql(input)}
  ),
  valid AS (
    SELECT DISTINCT ON (x.lead_id)
      x.lead_id, x.stage_rank, x.entered_at, x.value_cents, x.currency, x.observed
    FROM (
      SELECT
        c."leadId" AS lead_id,
        s.stage_rank,
        c."eventOccurredAt" AS entered_at,
        c."valueCents" AS value_cents,
        c."currency" AS currency,
        false AS observed,
        c.id AS row_id
      FROM period_leads p
      JOIN "ConversionEventLog" c ON c."leadId" = p.id
      JOIN stage_def s ON s.event_name = c."eventName"
      WHERE c."workspaceId" = ${input.workspaceId}
        AND ${stageConversionSql("c")}
        ${inPeriod}
      UNION ALL
      SELECT
        e."leadId" AS lead_id,
        s.stage_rank,
        e."occurredAt" AS entered_at,
        e."valueCents" AS value_cents,
        e."currency" AS currency,
        true AS observed,
        e.id AS row_id
      FROM period_leads p
      JOIN "ProviderConversionRuleExecution" e ON e."leadId" = p.id
      JOIN "ProviderConversionDecisionAudit" d
        ON d."workspaceId" = e."providerDecisionWorkspaceId" AND d.id = e."providerDecisionId"
      JOIN stage_def s ON s.event_name = d."eventName"
      WHERE e."workspaceId" = ${input.workspaceId}
        AND ${observedExecutionSql("e")}
        ${observedInPeriod}
    ) x
    -- Same stage: the real conversion wins over the observed one.
    ORDER BY x.lead_id, x.stage_rank DESC, x.observed ASC, x.entered_at ASC, x.row_id ASC
  )${deferredCte},
  placed_all AS (
    SELECT
      p.id AS lead_id,
      p.arrived_at,
      CASE WHEN v.lead_id IS NOT NULL THEN v.stage_rank ELSE ${fallbackRank} END AS stage_rank,
      CASE WHEN v.lead_id IS NOT NULL THEN v.entered_at ELSE p.arrived_at END AS entered_at,
      v.value_cents,
      v.currency,
      COALESCE(v.observed, false) AS observed
    FROM period_leads p
    LEFT JOIN valid v ON v.lead_id = p.id
    ${deferredJoin}
  ),
  placed AS (
    SELECT a.* FROM placed_all a
    ${periodFilter}
  )`;
}

const placedColumns = Prisma.sql`x.lead_id AS "leadId", x.stage_rank AS "stageRank", x.entered_at AS "enteredAt", x.arrived_at AS "arrivedAt", x.value_cents AS "valueCents", x.currency AS "currency", x.observed AS "observed"`;

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
