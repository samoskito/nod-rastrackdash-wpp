import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { inboundWebhookParserContext } from "../../src/inbound-webhooks/providers/inbound-webhook-parser";

const srcRoot = resolve(__dirname, "..", "..", "src");
const callSites = [
  "inbound-webhooks/inbound-webhook-observation.service.ts",
  "inbound-webhook-production/inbound-webhook-production.service.ts",
  "inbound-webhook-production/provider-conversion-production.service.ts",
  "inbound-webhook-replay/inbound-webhook-replay.service.ts",
];

describe("inbound webhook parser context", () => {
  it("derives organizationId only from the workspace id", () => {
    expect(inboundWebhookParserContext("ws_1")).toEqual({
      organizationId: "ws_1",
    });
  });

  it.each(callSites)(
    "%s never calls parse without the workspace context",
    (file) => {
      const source = readFileSync(resolve(srcRoot, file), "utf8");

      expect(source).not.toMatch(/parser\.parse\(payload\)/u);
      expect(source).toMatch(
        /parser\.parse\(\s*payload,\s*inboundWebhookParserContext\(/u,
      );
    },
  );
});
