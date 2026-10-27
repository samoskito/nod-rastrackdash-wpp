const META_SYNC_LOG_MESSAGE_LIMIT = 240;
const REDACTED_ERROR_MESSAGE = "Error message redacted";
const SAFE_ERROR_NAMES = new Set([
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

export function sanitizeMetaReportingSyncError(error: unknown) {
  const type = error instanceof Error ? "Error" : typeof error;

  try {
    // Error messages routinely include request configuration and response bodies.
    // Do not parse or partially redact them: a new credential or payload format
    // would otherwise be logged before a sanitizer can recognize it.
    const name =
      error instanceof Error && SAFE_ERROR_NAMES.has(error.name)
        ? error.name
        : "UnknownError";

    return {
      type,
      name,
      // Keep this bounded fixed text rather than any part of Error.message.
      // This prevents payloads, relative/absolute query strings, Authorization
      // values (of every scheme), cookies, and unknown future credentials from
      // reaching the logger.
      message: REDACTED_ERROR_MESSAGE.slice(0, META_SYNC_LOG_MESSAGE_LIMIT),
    };
  } catch {
    return { type, name: "UnknownError", message: REDACTED_ERROR_MESSAGE };
  }
}

export function logMetaReportingSyncEnqueueFailure(error: unknown) {
  console.error(
    "Meta reporting sync enqueue failed",
    sanitizeMetaReportingSyncError(error),
  );
}
