import { describe, expect, it } from "vitest";
import { InboundWebhookParserRegistry } from "../../../src/inbound-webhooks/providers/inbound-webhook-parser.registry";

describe("InboundWebhookParserRegistry", () => {
  it.each([
    ["umbler", "v1"],
    ["gupshup", "v1"],
    ["waha", "v1"],
    ["zapi", "v1"],
  ])("resolves the default %s %s parser", (provider, parserVersion) => {
    const parser = new InboundWebhookParserRegistry().resolve({
      provider,
      parserVersion,
    });

    expect(parser.provider).toBe(provider);
    expect(parser.parserVersion).toBe(parserVersion);
  });
});
