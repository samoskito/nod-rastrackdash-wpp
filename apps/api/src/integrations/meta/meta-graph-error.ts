/**
 * Typed Meta Graph API errors and their operational classification.
 *
 * Classification drives three behaviours in background sync:
 * - credential_fatal: the token/permission is dead. Retrying only burns the
 *   application-level rate limit, so the credential is parked until the
 *   customer reconnects/revalidates it.
 * - rate_limited: Meta asked us to slow down. Jobs are delayed, never retried
 *   in a tight loop.
 * - transient: Meta-side hiccup (1/2/5xx). Normal BullMQ retry applies.
 */

export type MetaGraphErrorKind =
  "credential_fatal" | "rate_limited" | "transient" | "other";

/**
 * credential: the token itself looks dead (190/102/401); confirm with a
 * cheap /me probe before blocking every account that shares it.
 * account: permission/ownership problem of one ad account (10, 200-299,
 * 100 "does not belong to"); only that account's reporting is blocked.
 */
export type MetaCredentialFatalScope = "credential" | "account";

export type MetaGraphErrorDetails = {
  httpStatus: number | null;
  code: number | null;
  subcode: number | null;
  type: string | null;
  isTransient: boolean;
};

export class MetaGraphError extends Error {
  override readonly name = "MetaGraphError";

  constructor(
    message: string,
    readonly details: MetaGraphErrorDetails,
  ) {
    super(message);
  }

  /**
   * Graph error code at the top level, as duck-typed by other detectors
   * (e.g. MetaCreativeThumbnailService's rate-limit pause checks `code`).
   */
  get code(): number | null {
    return this.details.code;
  }
}

/** Raised by reporting when report sync was blocked; never retried. */
export class MetaCredentialInvalidError extends Error {
  override readonly name = "MetaCredentialInvalidError";

  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
  }
}

export const META_RECONNECT_MESSAGE =
  "Reconecte a conta Meta: a autorização foi invalidada ou expirou. A sincronização fica pausada até a reconexão.";
export const META_PERMISSION_MESSAGE =
  "Reconecte a conta Meta: esta conta de anúncios perdeu permissão (ex.: ads_read) ou não pertence mais ao Business. A sincronização desta conta fica pausada até a revalidação.";
export const META_RATE_LIMIT_MESSAGE =
  "Aguardando liberação do limite de uso da Meta. A sincronização será retomada automaticamente.";

const RATE_LIMIT_CODES = new Set([4, 17, 32, 341, 613]);
const TRANSIENT_CODES = new Set([1, 2]);
const CREDENTIAL_CODES = new Set([102, 190]);
const BUSINESS_MISMATCH_PATTERN =
  /does not belong to|nao pertence|não pertence/i;

function toInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Builds a MetaGraphError keeping the historical message contract. */
export function metaGraphErrorFromPayload(
  payload: unknown,
  httpStatus: number | null,
  fallbackMessage: string,
): MetaGraphError {
  const error = asRecord(asRecord(payload)?.error);
  const message =
    typeof error?.message === "string" && error.message.trim()
      ? error.message
      : fallbackMessage;

  return new MetaGraphError(message, {
    httpStatus,
    code: toInteger(error?.code),
    subcode: toInteger(error?.error_subcode),
    type: typeof error?.type === "string" ? error.type : null,
    isTransient: error?.is_transient === true,
  });
}

export function isRateLimitCode(code: number | null): boolean {
  return (
    code !== null &&
    (RATE_LIMIT_CODES.has(code) || (code >= 80000 && code <= 80014))
  );
}

export function metaCredentialFatalScope(
  error: unknown,
): MetaCredentialFatalScope | null {
  if (!(error instanceof MetaGraphError)) {
    return null;
  }

  const { code, type, httpStatus } = error.details;

  if (isRateLimitCode(code)) {
    return null;
  }

  if (code !== null && CREDENTIAL_CODES.has(code)) {
    return "credential";
  }

  if (code === 10 || (code !== null && code >= 200 && code <= 299)) {
    return "account";
  }

  if (code === 100 && BUSINESS_MISMATCH_PATTERN.test(error.message)) {
    return "account";
  }

  // OAuthException is also used by Meta for plain parameter errors (#100),
  // so the type alone only counts when no code contradicts it.
  if (type === "OAuthException" && code === null && httpStatus === 401) {
    return "credential";
  }

  return null;
}

export function classifyMetaGraphError(error: unknown): MetaGraphErrorKind {
  if (!(error instanceof MetaGraphError)) {
    return "other";
  }

  const { code, httpStatus, isTransient } = error.details;

  if (isRateLimitCode(code)) {
    return "rate_limited";
  }

  if (metaCredentialFatalScope(error)) {
    return "credential_fatal";
  }

  if (
    isTransient ||
    (code !== null && TRANSIENT_CODES.has(code)) ||
    (httpStatus !== null && httpStatus >= 500)
  ) {
    return "transient";
  }

  return "other";
}

export function isMetaRateLimitError(error: unknown): error is MetaGraphError {
  return classifyMetaGraphError(error) === "rate_limited";
}

export function isMetaCredentialFatalError(
  error: unknown,
): error is MetaGraphError {
  return classifyMetaGraphError(error) === "credential_fatal";
}

/**
 * Field fallbacks (e.g. listAds without object_story_spec) stay valid for
 * parameter, transient and permission errors (object_story_spec needs page
 * permission). A dead token or a throttle fails identically with fewer
 * fields and only burns the app quota.
 */
export function isMetaFieldFallbackEligible(error: unknown): boolean {
  return (
    !isMetaRateLimitError(error) &&
    metaCredentialFatalScope(error) !== "credential"
  );
}

/** Safe, token-free reason for logs and persisted state. */
export function sanitizedMetaGraphReason(error: unknown): string {
  if (!(error instanceof MetaGraphError)) {
    return "meta_error";
  }

  const { code, subcode, httpStatus } = error.details;
  const parts = [
    `code=${code ?? "-"}`,
    subcode !== null ? `subcode=${subcode}` : null,
    httpStatus !== null ? `http=${httpStatus}` : null,
  ].filter(Boolean);

  return `meta_graph ${parts.join(" ")}`;
}
