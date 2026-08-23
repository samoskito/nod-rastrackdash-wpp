import { sign, verify, type KeyLike } from "node:crypto";

/**
 * Payload embedded in the license server's `cacheToken`. Mirrors the claims
 * the private `LicenseCryptoService.signCache` actually signs — not every
 * field of `LicenseActionResult` (see .claude-task-f4-1-license-client.md)
 * ends up in the signed payload; some (e.g. `usable`, `bound`, `keyPrefix`)
 * only ever travel on the HTTP body. `[key: string]: unknown` keeps this
 * forward-compatible with server fields we don't otherwise care about.
 */
export interface LicenseCachePayload {
  status: "active" | "grace" | "blocked";
  softLock: boolean;
  hardLock: boolean;
  expiresAt: string | null;
  validUntil: string;
  iat: number;
  exp?: number;
  licenseKeyHash?: string;
  issuedAt?: string;
  accountIdentityHash?: string;
  [key: string]: unknown;
}

export interface VerifyCompactTokenResult {
  valid: boolean;
  payload?: LicenseCachePayload;
  reason?: "malformed" | "invalid_signature" | "expired";
}

/**
 * Canonicalize a JSON-serializable value the same way the private license
 * server's `canonicalizeJson` does: object keys sorted recursively,
 * `undefined` object values omitted, `undefined` array elements become
 * `null`. Signatures are computed over `Buffer.from(canonicalizeJson(x),
 * "utf8")`, never over the base64url segment, so both sides must produce
 * byte-identical output for a given payload.
 */
export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : canonicalize(item)));
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      const entryValue = (value as Record<string, unknown>)[key];
      if (entryValue !== undefined) {
        acc[key] = canonicalize(entryValue);
      }
      return acc;
    }, {});
  return entries;
}

/**
 * Sign a payload into a compact token: `base64url(canonicalJsonBytes).base64url(signature)`.
 * Only used by our own tests to fabricate server-shaped fixtures — the real
 * private key lives on the (private) license server, never in this repo.
 */
export function signCompactToken(payload: LicenseCachePayload, privateKey: KeyLike): string {
  const bodyBytes = Buffer.from(canonicalizeJson(payload), "utf8");
  const signature = sign(null, bodyBytes, privateKey);
  return `${bodyBytes.toString("base64url")}.${signature.toString("base64url")}`;
}

/**
 * Verify a compact token issued by the license server.
 *
 * Primary path is the server's 2-segment `body.signature` form: `body` is
 * base64url of the UTF-8 canonical JSON bytes that were actually signed (no
 * header needed, since the algorithm is fixed to Ed25519 and the key is
 * fetched out of band from `GET /license/public-key`). A legacy 3-segment
 * `header.payload.signature` JWS form is kept as a fallback in case the
 * server ever adopts one.
 */
export function verifyCompactToken(token: string, publicKey: KeyLike): VerifyCompactTokenResult {
  const segments = token.split(".");

  if (segments.length === 2) {
    return verifyTwoSegmentToken(segments[0], segments[1], publicKey);
  }
  if (segments.length === 3) {
    return verifyThreeSegmentToken(segments[0], segments[1], segments[2], publicKey);
  }
  return { valid: false, reason: "malformed" };
}

function verifyTwoSegmentToken(
  bodySegment: string,
  signatureSegment: string,
  publicKey: KeyLike,
): VerifyCompactTokenResult {
  const bodyBytes = Buffer.from(bodySegment, "base64url");

  let signatureValid: boolean;
  try {
    signatureValid = verify(null, bodyBytes, publicKey, Buffer.from(signatureSegment, "base64url"));
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (!signatureValid) {
    return { valid: false, reason: "invalid_signature" };
  }

  let payload: LicenseCachePayload;
  try {
    payload = JSON.parse(bodyBytes.toString("utf8"));
  } catch {
    return { valid: false, reason: "malformed" };
  }

  // Fail closed if the signed bytes weren't already canonical JSON — matches
  // server semantics and rules out any ambiguity between what was signed and
  // what we parsed.
  if (canonicalizeJson(payload) !== bodyBytes.toString("utf8")) {
    return { valid: false, reason: "malformed" };
  }

  return checkExpiry(payload);
}

function verifyThreeSegmentToken(
  headerSegment: string,
  payloadSegment: string,
  signatureSegment: string,
  publicKey: KeyLike,
): VerifyCompactTokenResult {
  const signingInput = Buffer.from(`${headerSegment}.${payloadSegment}`);

  let payload: LicenseCachePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
  } catch {
    return { valid: false, reason: "malformed" };
  }

  let signatureValid: boolean;
  try {
    signatureValid = verify(null, signingInput, publicKey, Buffer.from(signatureSegment, "base64url"));
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (!signatureValid) {
    return { valid: false, reason: "invalid_signature" };
  }

  return checkExpiry(payload);
}

function checkExpiry(payload: LicenseCachePayload): VerifyCompactTokenResult {
  const nowSeconds = Date.now() / 1000;
  if (typeof payload.exp === "number" && payload.exp < nowSeconds) {
    return { valid: false, reason: "expired", payload };
  }
  if (payload.validUntil && new Date(payload.validUntil).getTime() < Date.now()) {
    return { valid: false, reason: "expired", payload };
  }
  return { valid: true, payload };
}
