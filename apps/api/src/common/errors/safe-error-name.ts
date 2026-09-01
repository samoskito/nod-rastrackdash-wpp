/**
 * The only part of a failure that is safe to persist or log.
 *
 * Provider and ORM errors routinely quote whatever they choked on - phone
 * numbers, message text, tokens - and both WebhookLog.errorMessage and the
 * receiver's structured logs are read by humans, so nothing but the error
 * class name gets through. Anything that is not a plain class name (a
 * dynamically built name, a thrown string, a name long enough to be carrying
 * data) is reported as unknown rather than pattern-scrubbed: scrubbing what
 * we failed to anticipate is how secrets leak.
 */
export function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "";

  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "UnknownError";
}
