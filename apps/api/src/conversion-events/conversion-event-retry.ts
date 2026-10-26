import type { Prisma } from "@prisma/client";

type ConversionEventRetryState = {
  status: string;
  errorCode: string | null;
  createdAt?: Date | null;
  sourceTrigger?: string | null;
  eventOccurredAt?: Date | null;
  providerResponseSummary?: unknown;
};

/**
 * errorCode kept on a ready_to_send log whose CTWA send was refused before the
 * dispatch claim (errorMessage carries "<reason>: <texto>"). Retryable: the
 * sender's ready_to_send -> dispatching claim remains the single-send fence.
 */
export const CTWA_SEND_SKIPPED_ERROR_CODE = "CtwaSendSkipped";

/** A ready_to_send event older than this without a send is considered stuck. */
export const STALLED_READY_TO_SEND_MS = 10 * 60_000;

export const BLOCKED_CONVERSION_RETRY_LIMIT = 500;

const configurationErrorCodes = [
  "MissingAccessToken",
  "MissingMetaDestination",
];

export const configurationBlockedConversionEventWhere = {
  status: "not_configured",
  OR: [{ errorCode: { in: configurationErrorCodes } }, { errorCode: null }],
} satisfies Prisma.ConversionEventLogWhereInput;

export function isConfigurationBlockedConversionEvent(
  event: ConversionEventRetryState,
): boolean {
  return (
    event.status === "not_configured" &&
    (event.errorCode === null ||
      configurationErrorCodes.includes(event.errorCode))
  );
}

/**
 * ready_to_send that the sender refused (CtwaSendSkipped) or that never left
 * the queue for STALLED_READY_TO_SEND_MS. Requeueing is safe: the sender's
 * ready_to_send -> dispatching claim remains the single-send fence.
 */
export function isStalledReadyToSendConversionEvent(
  event: ConversionEventRetryState,
  now = Date.now(),
): boolean {
  if (event.status !== "ready_to_send") return false;
  if (event.errorCode === CTWA_SEND_SKIPPED_ERROR_CODE) return true;
  return (
    event.errorCode === null &&
    event.createdAt instanceof Date &&
    now - event.createdAt.getTime() >= STALLED_READY_TO_SEND_MS
  );
}

/** Meta accepts event_time up to 7 days in the past; resends keep the original. */
export const META_EVENT_TIME_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * Graph error codes of a dead login/token: 190 (any subcode: expired/invalid
 * token, 459 login checkpoint, 460 password changed...) and 102 (session).
 * Same set as CREDENTIAL_CODES in integrations/meta/meta-graph-error.ts.
 */
export const META_AUTH_FAILURE_GRAPH_CODES = [190, 102] as const;

/**
 * Kommo/Pipedrive stage sends own a single-dispatch ledger (senderAttempts 0
 * -> 1 that never resets): requeueing a rejected one would park it in
 * ready_to_send without a send, so they stay out of this class.
 */
const singleDispatchLedgerSourceTriggers = ["kommo_stage", "pipedrive_stage"];

/** error.code of a stored Meta response ({"error":{"code":190,...}}). */
export function metaGraphErrorCodeFromResponse(
  summary: unknown,
): number | null {
  if (!summary || typeof summary !== "object" || Array.isArray(summary))
    return null;
  const error = (summary as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "number") return Number.isInteger(code) ? code : null;
  if (typeof code === "string" && /^\d{1,9}$/u.test(code.trim()))
    return Number(code.trim());
  return null;
}

export function isMetaAuthFailureResponse(summary: unknown): boolean {
  const code = metaGraphErrorCodeFromResponse(summary);
  return (
    code !== null &&
    (META_AUTH_FAILURE_GRAPH_CODES as readonly number[]).includes(code)
  );
}

/**
 * "Falha de autenticacao da Meta": the event was refused (MetaCapiRejected)
 * and the stored Meta response says the login/token was dead. It is not an
 * event problem: after reconnecting it can be sent again with the same
 * event_id. Reads the response already stored, so old rows qualify too.
 */
export function isMetaAuthFailureConversionEvent(
  event: ConversionEventRetryState,
): boolean {
  return (
    event.status === "error" &&
    event.errorCode === "MetaCapiRejected" &&
    !singleDispatchLedgerSourceTriggers.includes(event.sourceTrigger ?? "") &&
    isMetaAuthFailureResponse(event.providerResponseSummary)
  );
}

/** The resend keeps the original event_time (eventOccurredAt). */
export function isOutsideMetaEventTimeWindow(
  event: ConversionEventRetryState,
  now = Date.now(),
): boolean {
  return (
    !(event.eventOccurredAt instanceof Date) ||
    !Number.isFinite(event.eventOccurredAt.getTime()) ||
    now - event.eventOccurredAt.getTime() > META_EVENT_TIME_WINDOW_MS
  );
}

export function canRetryMetaAuthFailureConversionEvent(
  event: ConversionEventRetryState,
  now = Date.now(),
): boolean {
  return (
    isMetaAuthFailureConversionEvent(event) &&
    !isOutsideMetaEventTimeWindow(event, now)
  );
}

const metaAuthFailureResponseWhere = META_AUTH_FAILURE_GRAPH_CODES.flatMap(
  (code) => [
    { providerResponseSummary: { path: ["error", "code"], equals: code } },
    // Defensive: a code stored as a JSON string.
    {
      providerResponseSummary: {
        path: ["error", "code"],
        equals: String(code),
      },
    },
  ],
) satisfies Prisma.ConversionEventLogWhereInput[];

/** SQL side of isMetaAuthFailureConversionEvent (no time window). */
export const metaAuthFailureConversionEventWhere = {
  status: "error",
  errorCode: "MetaCapiRejected",
  sourceTrigger: { notIn: singleDispatchLedgerSourceTriggers },
  OR: metaAuthFailureResponseWhere,
} satisfies Prisma.ConversionEventLogWhereInput;

/** Candidates of "Reenviar bloqueados": configuration blocks + Meta login failures. */
export const retryBlockedConversionEventWhere = {
  OR: [
    configurationBlockedConversionEventWhere,
    metaAuthFailureConversionEventWhere,
  ],
} satisfies Prisma.ConversionEventLogWhereInput;

/** Button count: Meta login failures still inside Meta's 7-day window. */
export function retryableMetaAuthFailureConversionEventWhere(
  now = Date.now(),
): Prisma.ConversionEventLogWhereInput {
  return {
    ...metaAuthFailureConversionEventWhere,
    eventOccurredAt: { gte: new Date(now - META_EVENT_TIME_WINDOW_MS) },
  };
}

export function canRetryConversionEvent(
  event: ConversionEventRetryState,
  now = Date.now(),
): boolean {
  return (
    (event.status === "error" && event.errorCode === "MetaCapiNetworkError") ||
    isConfigurationBlockedConversionEvent(event) ||
    isStalledReadyToSendConversionEvent(event, now) ||
    canRetryMetaAuthFailureConversionEvent(event, now)
  );
}
