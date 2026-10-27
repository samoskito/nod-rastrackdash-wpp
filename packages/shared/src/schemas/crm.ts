import { z } from "zod";
import { conversionEventNameSchema } from "./conversion-events";

/**
 * CRM Kanban (docs/plans/2026-10-24-crm-kanban-design.md): a simple view of
 * the leads by conversion stage. Columns are the visible stages of the
 * Jornada; a lead sits once, in the most advanced stage with a valid
 * conversion. Moving a card registers a manual conversion (source "kanban").
 */

/** Cards per column on the board and per "Carregar mais". */
export const CRM_COLUMN_PAGE_SIZE = 20;
/** Default period: the last 30 days of lead arrival. */
export const CRM_DEFAULT_PERIOD_DAYS = 30;
/** Longest period accepted (bounds the aggregated query). */
export const CRM_MAX_PERIOD_DAYS = 180;
export const CRM_MAX_PERIOD_MESSAGE = `Escolha um período de até ${CRM_MAX_PERIOD_DAYS} dias.`;
/** Short server cache of GET /crm/board (light auto-refresh). */
export const CRM_BOARD_CACHE_TTL_MS = 15_000;

/** Days of a "YYYY-MM-DD" period, both ends included (NaN if invalid). */
export function crmPeriodDays(since: string, until: string): number {
  return (
    Math.round(
      (Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) /
        (24 * 3600_000),
    ) + 1
  );
}
/** Key of the extra first column of the rule override mode (not a conversion). */
export const CRM_CONVERSATIONS_COLUMN_KEY = "conversations";
export const CRM_CONVERSATIONS_COLUMN_LABEL = "Conversas iniciadas";
/** The base stage: every lead without a later valid conversion lands here. */
export const CRM_BASE_STAGE_EVENT = "LeadSubmitted";

export const CRM_BACKWARD_MOVE_MESSAGE =
  "Não é possível voltar etapa: a conversão já foi enviada à Meta";
export const CRM_SAME_STAGE_MESSAGE = "O lead já está nesta etapa.";
export const CRM_INVALID_TARGET_MESSAGE =
  "Esta coluna não recebe cards: escolha uma etapa da Jornada.";
/** 409 codes of a refused kanban move (manual conversion source "kanban"). */
export const CRM_MOVE_ERROR_CODES = {
  backward: "crm_backward_move",
  sameStage: "crm_same_stage",
  invalidTarget: "crm_invalid_target",
} as const;

/**
 * ConversionEventLog statuses that place a card (sent or on its way to
 * Meta). A manual conversion registered only in the panel (status
 * not_eligible + sourceTrigger manual_conversion) also counts. Canceled,
 * blocked, duplicate, skipped and failed never count.
 */
export const CRM_VALID_CONVERSION_STATUSES = [
  "sent",
  "queued",
  "ready_to_send",
  "dispatching",
  "delivery_unknown",
] as const;
export const CRM_PANEL_ONLY_MANUAL_STATUS = "not_eligible";

/** Lead origins: only CTWA today; new origins are added here. */
export const crmLeadOrigins = ["ctwa"] as const;
export const crmLeadOriginSchema = z.enum(crmLeadOrigins);
export type CrmLeadOriginDto = z.infer<typeof crmLeadOriginSchema>;
export const crmLeadOriginLabels: Record<CrmLeadOriginDto, string> = {
  ctwa: "CTWA",
};

const dateParam = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/);

export const crmBoardQuerySchema = z.object({
  since: dateParam.optional(),
  until: dateParam.optional(),
  whatsappInstanceId: z.string().trim().min(1).max(191).optional(),
  campaignId: z.string().trim().min(1).max(120).optional(),
  /** "Atualizar": skip the short server cache. */
  fresh: z.enum(["1", "true"]).optional(),
});
export type CrmBoardQueryDto = z.infer<typeof crmBoardQuerySchema>;

export const crmColumnQuerySchema = crmBoardQuerySchema.extend({
  cursor: z.string().trim().min(1).max(400).optional(),
});
export type CrmColumnQueryDto = z.infer<typeof crmColumnQuerySchema>;

export const crmLeadCardSchema = z.object({
  leadId: z.string().min(1),
  name: z.string().min(1).nullable(),
  /** Full phone (owner decision); masked by the presentation mode. */
  phoneDisplay: z.string().min(1).nullable(),
  origin: crmLeadOriginSchema,
  campaignId: z.string().min(1).nullable(),
  campaignName: z.string().min(1).nullable(),
  adId: z.string().min(1).nullable(),
  adName: z.string().min(1).nullable(),
  creative: z.object({
    thumbnailUrl: z.string().url().nullable(),
    thumbnailVersion: z.string().min(1).nullable(),
  }),
  /** When the lead entered the column (first valid conversion, or arrival). */
  enteredStageAt: z.string().datetime(),
  arrivedAt: z.string().datetime(),
  /** Value of the conversion that placed the card (value columns only). */
  valueCents: z.number().int().nullable(),
  currency: z.string().min(3).max(3).nullable(),
  whatsappInstance: z
    .object({ id: z.string().min(1), name: z.string().min(1) })
    .nullable(),
});
export type CrmLeadCardDto = z.infer<typeof crmLeadCardSchema>;

export const crmColumnKindSchema = z.enum(["conversations", "stage"]);

export const crmColumnSchema = z.object({
  /** eventName of the stage, or "conversations". */
  key: z.string().min(1),
  kind: crmColumnKindSchema,
  eventName: conversionEventNameSchema.nullable(),
  label: z.string().min(1),
  /** Board order (0 = "Conversas iniciadas", 1 = Leads novos, ...). */
  rank: z.number().int().nonnegative(),
  /** Never a drop target ("Conversas iniciadas"). */
  readOnly: z.boolean(),
  /** Purchase-like events: value, currency and order number required. */
  requiresValue: z.boolean(),
  defaultValueCents: z.number().int().positive().nullable(),
  defaultCurrency: z.string().min(3).max(3).nullable(),
  defaultContentName: z.string().min(1).nullable(),
  total: z.number().int().nonnegative(),
  cards: z.array(crmLeadCardSchema),
  /** null when the column has no more cards. */
  nextCursor: z.string().min(1).nullable(),
});
export type CrmColumnDto = z.infer<typeof crmColumnSchema>;

export const crmBoardSchema = z.object({
  mode: z.enum(["default", "rule_override"]),
  range: z.object({ since: dateParam, until: dateParam }),
  /** false: the Jornada has no visible stage ("Configure a Jornada"). */
  journeyConfigured: z.boolean(),
  columns: z.array(crmColumnSchema),
  /** Same permission as the manual conversion (owner/admin). */
  canMoveCards: z.boolean(),
  /** The workspace has more than one active WhatsApp number. */
  showWhatsappNumber: z.boolean(),
  generatedAt: z.string().datetime(),
});
export type CrmBoardDto = z.infer<typeof crmBoardSchema>;

export const crmColumnPageSchema = z.object({
  key: z.string().min(1),
  cards: z.array(crmLeadCardSchema),
  nextCursor: z.string().min(1).nullable(),
  /** Cards after this page (the column total comes with the board). */
  remaining: z.number().int().nonnegative(),
});
export type CrmColumnPageDto = z.infer<typeof crmColumnPageSchema>;

export type CrmMoveCheck =
  | { ok: true; skipped: number }
  | { ok: false; reason: "same" | "backward" | "read_only"; message: string };

/**
 * Forward-only rule of a card move, shared by the board (drop feedback) and
 * the API (source "kanban"). `skipped` = intermediate stages not sent.
 */
export function crmMoveCheck(
  from: Pick<CrmColumnDto, "rank">,
  to: Pick<CrmColumnDto, "rank" | "readOnly">,
): CrmMoveCheck {
  if (to.readOnly)
    return {
      ok: false,
      reason: "read_only",
      message: CRM_INVALID_TARGET_MESSAGE,
    };
  if (to.rank === from.rank)
    return { ok: false, reason: "same", message: CRM_SAME_STAGE_MESSAGE };
  if (to.rank < from.rank)
    return {
      ok: false,
      reason: "backward",
      message: CRM_BACKWARD_MOVE_MESSAGE,
    };
  return { ok: true, skipped: Math.max(0, to.rank - from.rank - 1) };
}

/** "há 3 dias nesta etapa". */
export function crmDaysInStageLabel(
  enteredStageAt: string | Date,
  now: Date = new Date(),
): string {
  const days = Math.floor(
    (now.getTime() - new Date(enteredStageAt).getTime()) / (24 * 3600_000),
  );
  if (!Number.isFinite(days) || days < 1)
    return "há menos de 1 dia nesta etapa";
  return days === 1 ? "há 1 dia nesta etapa" : `há ${days} dias nesta etapa`;
}
