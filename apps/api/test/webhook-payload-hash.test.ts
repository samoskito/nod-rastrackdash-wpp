import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeCanonicalPayloadHash } from "../src/webhooks/webhook-payload-hash";

describe("computeCanonicalPayloadHash", () => {
  it("returns a 64-char hex sha256 digest", () => {
    const hash = computeCanonicalPayloadHash({ a: 1 });

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is stable regardless of object key order", () => {
    const first = computeCanonicalPayloadHash({
      instanceId: "a",
      phone: "b",
      message: { text: "ola", id: 1 },
    });
    const second = computeCanonicalPayloadHash({
      message: { id: 1, text: "ola" },
      phone: "b",
      instanceId: "a",
    });

    expect(first).toBe(second);
  });

  it("changes when a value changes", () => {
    const first = computeCanonicalPayloadHash({ phone: "5511999999999" });
    const second = computeCanonicalPayloadHash({ phone: "5511888888888" });

    expect(first).not.toBe(second);
  });

  it("treats arrays as order-sensitive", () => {
    const first = computeCanonicalPayloadHash({ items: [1, 2] });
    const second = computeCanonicalPayloadHash({ items: [2, 1] });

    expect(first).not.toBe(second);
  });

  it("matches a manual canonical hash for a simple payload", () => {
    const expected = createHash("sha256")
      .update('{"a":1,"b":2}', "utf8")
      .digest("hex");

    expect(computeCanonicalPayloadHash({ b: 2, a: 1 })).toBe(expected);
  });
});
