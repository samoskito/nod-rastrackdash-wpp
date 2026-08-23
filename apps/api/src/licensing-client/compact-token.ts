import { sign, verify, type KeyLike } from "node:crypto";

/**
 * Payload embedded in the license server's `cacheToken`. Mirrors the fields
 * of `LicenseActionResult` (see .claude-task-f4-1-license-client.md) plus the
 * claims (`iat`/`exp`) that bound the token's own signed lifetime.
 */
export interface LicenseCachePayload {
  status: "active" | "grace" | "blocked";
  softLock: boolean;
  hardLock: boolean;
  usable: boolean;
  expiresAt: string | null;
  validUntil: string;
  bound: boolean;
  keyPrefix: string;
  fingerprint: string;
  iat: number;
  exp: number;
}

export interface VerifyCompactTokenResult {
  valid: boolean;
  payload?: LicenseCachePayload;
  reason?: "malformed" | "invalid_signature" | "expired";
}

/**
 * Sign a payload into a compact token: `base64url(payload).base64url(signature)`.
 * Only used by our own tests to fabricate server-shaped fixtures — the real
 * private key lives on the (private) license server, never in this repo.
 */
export function signCompactToken(payload: LicenseCachePayload, privateKey: KeyLike): string {
  const payloadSegment = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(null, Buffer.from(payloadSegment), privateKey);
  return `${payloadSegment}.${signature.toString("base64url")}`;
}

/**
 * Verify a compact token issued by the license server.
 *
 * Accepts both the 2-segment `payload.signature` form (no header needed,
 * since the algorithm is fixed to Ed25519 and the key is fetched out of band
 * from `GET /license/public-key`) and a standard 3-segment
 * `header.payload.signature` JWS, in case the server later adopts one.
 */
export function verifyCompactToken(token: string, publicKey: KeyLike): VerifyCompactTokenResult {
  const segments = token.split(".");
  let payloadSegment: string;
  let signatureSegment: string;
  let signingInput: string;

  if (segments.length === 2) {
    [payloadSegment, signatureSegment] = segments;
    signingInput = payloadSegment;
  } else if (segments.length === 3) {
    const [headerSegment, middleSegment, lastSegment] = segments;
    payloadSegment = middleSegment;
    signatureSegment = lastSegment;
    signingInput = `${headerSegment}.${payloadSegment}`;
  } else {
    return { valid: false, reason: "malformed" };
  }

  let payload: LicenseCachePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
  } catch {
    return { valid: false, reason: "malformed" };
  }

  let signatureValid: boolean;
  try {
    signatureValid = verify(
      null,
      Buffer.from(signingInput),
      publicKey,
      Buffer.from(signatureSegment, "base64url"),
    );
  } catch {
    return { valid: false, reason: "malformed" };
  }

  if (!signatureValid) {
    return { valid: false, reason: "invalid_signature" };
  }

  const nowSeconds = Date.now() / 1000;
  if (typeof payload.exp === "number" && payload.exp < nowSeconds) {
    return { valid: false, reason: "expired", payload };
  }
  if (payload.validUntil && new Date(payload.validUntil).getTime() < Date.now()) {
    return { valid: false, reason: "expired", payload };
  }

  return { valid: true, payload };
}
