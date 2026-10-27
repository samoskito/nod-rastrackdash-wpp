import { createHash } from "node:crypto";
import {
  MANUAL_CONVERSION_CANCELABLE_STATUSES,
  MANUAL_CONVERSION_TRIGGER,
  normalizeManualOrderRef,
} from "@wpptrack/shared";

/**
 * Pure helpers of the manual lead conversion (tarefa 21), shared by the
 * manual service, the lead detail, the Meta audit and the provider
 * production job (Payt/Braip purchase dedupe). No Nest/Prisma dependency.
 */

/** sourcePayload.processingMode of a manual conversion log. */
export const MANUAL_CONVERSION_PROCESSING_MODE = MANUAL_CONVERSION_TRIGGER;
/** AuditLog.action written for every manual conversion (create/cancel). */
export const MANUAL_CONVERSION_AUDIT_CREATE = "manual_conversion.create";
export const MANUAL_CONVERSION_AUDIT_CANCEL = "manual_conversion.cancel";
export const MANUAL_CONVERSION_AUDIT_TARGET = "conversion_event_log";

/** Meta's event_time window: past it a queued manual event "expired". */
export const MANUAL_META_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const MANUAL_EXPIRED_MESSAGE =
  "Expirou antes do envio: a conversão passou de 7 dias na fila e ficou só no painel";

/**
 * errorMessage written when a manual conversion is claimed for dispatch:
 * ConversionEventLog has no updatedAt, so the claim time travels here and
 * the stuck-dispatch recovery reads it back.
 */
const DISPATCHING_SINCE_PREFIX = "Envio à Meta em andamento desde ";

export function manualDispatchingSince(at: Date): string {
  return `${DISPATCHING_SINCE_PREFIX}${at.toISOString()}`;
}

export function readManualDispatchingSince(
  errorMessage: string | null | undefined,
): Date | null {
  if (!errorMessage?.startsWith(DISPATCHING_SINCE_PREFIX)) return null;
  const at = new Date(errorMessage.slice(DISPATCHING_SINCE_PREFIX.length));
  return Number.isFinite(at.getTime()) ? at : null;
}

export type ManualConversionSourcePayload = {
  processingMode: typeof MANUAL_CONVERSION_PROCESSING_MODE;
  createdByUserId: string;
  createdByName: string | null;
  note: string | null;
  orderRef: string | null;
  /** sha(ws, upper(trim(orderRef))): Payt/Braip purchase dedupe key. */
  orderKey: string | null;
  idempotencyKey: string;
  channelId: string | null;
  /** Where it was registered: absent/"lead_detail" or "kanban" (CRM). */
  origin?: "lead_detail" | "kanban";
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function readManualSourcePayload(
  sourcePayload: unknown,
): ManualConversionSourcePayload | null {
  const payload = record(sourcePayload);
  if (
    !payload ||
    payload.processingMode !== MANUAL_CONVERSION_PROCESSING_MODE ||
    typeof payload.createdByUserId !== "string" ||
    typeof payload.idempotencyKey !== "string"
  )
    return null;
  return {
    processingMode: MANUAL_CONVERSION_PROCESSING_MODE,
    createdByUserId: payload.createdByUserId,
    createdByName: optionalString(payload.createdByName),
    note: optionalString(payload.note),
    orderRef: optionalString(payload.orderRef),
    orderKey: optionalString(payload.orderKey),
    idempotencyKey: payload.idempotencyKey,
    channelId: optionalString(payload.channelId),
    ...(payload.origin === "kanban" ? { origin: "kanban" as const } : {}),
  };
}

/**
 * Order identity of a manual sale: the workspace plus the order/sale number
 * normalized by normalizeManualOrderRef (trim, case-insensitive, no inner
 * spaces/hyphens, no leading "#"). Payt, Braip and Yampi compute the same key from the
 * transaction id of their callback, so either side sees the other.
 */
export function manualOrderKey(workspaceId: string, orderRef: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "manual-order-v1",
        workspaceId,
        normalizeManualOrderRef(orderRef),
      ]),
    )
    .digest("hex");
}

export function manualPurchaseDedupeKey(orderKey: string): string {
  return `manual_purchase:${orderKey}`;
}

export function manualPurchaseEventId(orderKey: string): string {
  return `manual_purchase_${orderKey}`;
}

export function manualIdempotentDedupeKey(
  workspaceId: string,
  idempotencyKey: string,
): string {
  return `manual:${workspaceId}:${idempotencyKey}`;
}

export function isManualCancelableStatus(status: string): boolean {
  return (MANUAL_CONVERSION_CANCELABLE_STATUSES as readonly string[]).includes(
    status,
  );
}

/** Lead detail summary of a manual conversion log (null for other logs). */
export function manualConversionSummary(log: {
  sourceTrigger?: string | null;
  status?: string | null;
  sourcePayload?: unknown;
}): {
  createdByName: string | null;
  note: string | null;
  orderRef: string | null;
  canCancel: boolean;
  origin: "lead_detail" | "kanban";
} | null {
  if (log.sourceTrigger !== MANUAL_CONVERSION_TRIGGER) return null;
  const payload = readManualSourcePayload(log.sourcePayload);
  return {
    createdByName: payload?.createdByName ?? null,
    note: payload?.note ?? null,
    orderRef: payload?.orderRef ?? null,
    canCancel: isManualCancelableStatus(log.status ?? ""),
    origin: payload?.origin ?? "lead_detail",
  };
}
