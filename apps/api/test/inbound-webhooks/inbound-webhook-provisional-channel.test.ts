import { describe, expect, it } from "vitest";
import {
  isProvisionalProviderChannelId,
  provisionalChannelOrganizationId,
  provisionalChannelProviderChannelId,
} from "../../src/inbound-webhooks/inbound-webhook-provisional-channel";

describe("inbound webhook provisional channel identity (P0.2)", () => {
  it("derives a connection-scoped organization placeholder", () => {
    expect(provisionalChannelOrganizationId("connection_1")).toBe(
      "provisional:connection_1",
    );
    expect(provisionalChannelOrganizationId("connection_2")).toBe(
      "provisional:connection_2",
    );
  });

  it("derives a phone-scoped providerChannelId placeholder", () => {
    expect(provisionalChannelProviderChannelId("11999998888")).toBe(
      "provisional:11999998888",
    );
  });

  it("recognizes only placeholder providerChannelId values", () => {
    expect(
      isProvisionalProviderChannelId(
        provisionalChannelProviderChannelId("11999998888"),
      ),
    ).toBe(true);
    expect(isProvisionalProviderChannelId("umbler-channel-9")).toBe(false);
  });
});
