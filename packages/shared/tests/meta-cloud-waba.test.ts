import { describe, expect, it } from "vitest";
import {
  metaCloudWabaSubscriptionLookupInputSchema,
  metaCloudWabaSubscriptionStatusSchema,
  metaCloudWabaSubscriptionSubscribeInputSchema,
} from "../src";

const token = "EAAG" + "x".repeat(60);

describe("Meta Cloud WABA subscription contracts", () => {
  it("accepts a numeric WABA ID and a token, trimming spaces", () => {
    expect(
      metaCloudWabaSubscriptionLookupInputSchema.parse({
        wabaId: " 102290129340398 ",
        accessToken: ` ${token} `,
      }),
    ).toEqual({ wabaId: "102290129340398", accessToken: token });
  });

  it("rejects non-numeric WABA IDs, short tokens and extra fields", () => {
    expect(
      metaCloudWabaSubscriptionLookupInputSchema.safeParse({
        wabaId: "act_123",
        accessToken: token,
      }).success,
    ).toBe(false);
    expect(
      metaCloudWabaSubscriptionLookupInputSchema.safeParse({
        wabaId: "102290129340398",
        accessToken: "curto",
      }).success,
    ).toBe(false);
    expect(
      metaCloudWabaSubscriptionLookupInputSchema.safeParse({
        wabaId: "102290129340398",
        accessToken: token,
        workspaceId: "outro",
      }).success,
    ).toBe(false);
  });

  it("requires explicit confirm: true to subscribe", () => {
    const base = { wabaId: "102290129340398", accessToken: token };
    expect(
      metaCloudWabaSubscriptionSubscribeInputSchema.safeParse(base).success,
    ).toBe(false);
    expect(
      metaCloudWabaSubscriptionSubscribeInputSchema.safeParse({
        ...base,
        confirm: "true",
      }).success,
    ).toBe(false);
    expect(
      metaCloudWabaSubscriptionSubscribeInputSchema.safeParse({
        ...base,
        confirm: true,
      }).success,
    ).toBe(true);
  });

  it("status carries no token field", () => {
    const status = metaCloudWabaSubscriptionStatusSchema.parse({
      connectionId: "c1",
      wabaId: "102290129340398",
      thisAppId: "1234567890",
      thisAppSubscribed: true,
      apps: [{ appId: "1234567890", name: "Meu app", isThisApp: true }],
      phoneNumbers: [],
      channelCheck: { status: "no_real_channel", mismatchedChannels: 0 },
      outcome: "lookup",
      checkedAt: "2026-10-24T12:00:00.000Z",
    });
    expect(JSON.stringify(status)).not.toContain("accessToken");
  });
});
