import { describe, expect, it } from "vitest";
import {
  effectiveInboundParserStatus,
  inboundParserProductionEligible,
} from "../../src/inbound-webhooks/inbound-webhook-parser-eligibility";

describe("Data Crazy parser certified by migration (validated in the SaaS)", () => {
  it("is production-eligible only once the release is certified, never while observation-only or retired", () => {
    const release = { provider: "data_crazy", version: "v1" };
    expect(inboundParserProductionEligible({ ...release, status: "certified" })).toBe(true);
    expect(inboundParserProductionEligible({ ...release, status: "observation_only" })).toBe(false);
    expect(inboundParserProductionEligible({ ...release, status: "retired" })).toBe(false);
    expect(effectiveInboundParserStatus({ ...release, status: "observation_only" })).toBe(
      "observation_only",
    );
  });
});
