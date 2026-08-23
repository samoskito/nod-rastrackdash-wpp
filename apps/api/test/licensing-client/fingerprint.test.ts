import { describe, expect, it } from "vitest";
import { computeFingerprint } from "../../src/licensing-client/fingerprint";

describe("computeFingerprint", () => {
  it("is stable across calls for the same app origin", () => {
    const first = computeFingerprint("https://demo.rastrackdash.test");
    const second = computeFingerprint("https://demo.rastrackdash.test");

    expect(first).toBe(second);
  });

  it("returns a 64-character sha256 hex digest", () => {
    const fingerprint = computeFingerprint("https://demo.rastrackdash.test");

    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the app origin changes", () => {
    const a = computeFingerprint("https://a.example.test");
    const b = computeFingerprint("https://b.example.test");

    expect(a).not.toBe(b);
  });
});
