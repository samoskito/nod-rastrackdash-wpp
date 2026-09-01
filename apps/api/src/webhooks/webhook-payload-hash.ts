import { createHash } from "node:crypto";

/**
 * Deterministic SHA-256 fingerprint of a webhook payload, independent of
 * object key order. WAHA/Z-API deliveries arrive as parsed JSON, and a
 * provider retry of what is logically the same event can reorder fields
 * without changing its meaning; canonicalizing key order before hashing
 * keeps identical replays dedupeable and only flags payloads that actually
 * diverged.
 */
export function computeCanonicalPayloadHash(payload: unknown): string {
  return createHash("sha256")
    .update(canonicalize(payload), "utf8")
    .digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value === undefined ? null : value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }

  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalize(
          (value as Record<string, unknown>)[key],
        )}`,
    );

  return `{${entries.join(",")}}`;
}
