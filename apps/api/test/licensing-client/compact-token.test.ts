import { generateKeyPairSync, sign } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalizeJson,
  signCompactToken,
  verifyCompactToken,
  type LicenseCachePayload,
} from "../../src/licensing-client/compact-token";

function payloadFixture(overrides: Partial<LicenseCachePayload> = {}): LicenseCachePayload {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    status: "active",
    softLock: false,
    hardLock: false,
    usable: true,
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    validUntil: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    bound: true,
    keyPrefix: "RTD-1234",
    fingerprint: "abc123",
    iat: nowSeconds,
    exp: nowSeconds + 6 * 60 * 60,
    ...overrides,
  };
}

describe("compact-token", () => {
  let publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"];
  let privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];

  beforeAll(() => {
    ({ publicKey, privateKey } = generateKeyPairSync("ed25519"));
  });

  it("accepts a validly signed, non-expired token", () => {
    const token = signCompactToken(payloadFixture(), privateKey);

    const result = verifyCompactToken(token, publicKey);

    expect(result.valid).toBe(true);
    expect(result.payload?.status).toBe("active");
  });

  it("signs the UTF-8 canonical JSON body bytes, not the base64url segment (matches PalmUP server)", () => {
    const payload = payloadFixture();
    const token = signCompactToken(payload, privateKey);
    const [bodySegment] = token.split(".");

    const bodyBytes = Buffer.from(bodySegment, "base64url").toString("utf8");

    expect(bodyBytes).toBe(canonicalizeJson(payload));
  });

  it("fails closed when the signed bytes are valid JSON but not canonical", () => {
    // Sign a non-canonical (insertion-order, not sorted-key) encoding of the
    // same payload — this must never verify, even though the signature is
    // technically valid for those exact bytes, because it doesn't match what
    // canonicalizeJson would have produced (mirrors the server's own check).
    const payload = payloadFixture();
    const nonCanonicalBody = Buffer.from(JSON.stringify(payload), "utf8");
    const signature = sign(null, nonCanonicalBody, privateKey);
    const token = `${nonCanonicalBody.toString("base64url")}.${signature.toString("base64url")}`;

    const result = verifyCompactToken(token, publicKey);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("malformed");
  });

  it("rejects a token whose payload was tampered with after signing", () => {
    const token = signCompactToken(payloadFixture({ status: "active" }), privateKey);
    const [payloadSegment, signatureSegment] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...payloadFixture(), status: "blocked" }),
    ).toString("base64url");
    const tampered = `${tamperedPayload}.${signatureSegment}`;
    void payloadSegment;

    const result = verifyCompactToken(tampered, publicKey);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });

  it("rejects a token past its exp claim", () => {
    const expired = payloadFixture({
      iat: Math.floor(Date.now() / 1000) - 10_000,
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    const token = signCompactToken(expired, privateKey);

    const result = verifyCompactToken(token, publicKey);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("expired");
  });

  it("rejects a malformed token", () => {
    const result = verifyCompactToken("not-a-token", publicKey);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("malformed");
  });
});
