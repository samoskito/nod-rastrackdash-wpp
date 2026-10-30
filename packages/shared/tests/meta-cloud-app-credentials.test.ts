import { describe, expect, it } from "vitest";
import {
  inboundWebhookConnectionSchema,
  metaCloudAppCredentialsInputSchema,
} from "../src";

const SECRET = "0123456789abcdef0123456789abcdef";
const at = "2026-10-30T12:00:00.000Z";

describe("App do Meta por conexão (Meta Cloud)", () => {
  it("aceita App ID numérico e App Secret sem espaços, aparando as bordas", () => {
    expect(
      metaCloudAppCredentialsInputSchema.parse({
        appId: " 1234567890123456 ",
        appSecret: ` ${SECRET}\n`,
      }),
    ).toEqual({ appId: "1234567890123456", appSecret: SECRET });
  });

  it.each([
    ["App ID com letras", { appId: "12ab", appSecret: SECRET }],
    ["segredo vazio", { appId: "1234567890", appSecret: "   " }],
    ["segredo curto", { appId: "1234567890", appSecret: "abc" }],
    ["segredo com espaço", { appId: "1234567890", appSecret: "0123456789 abcdef012345" }],
    ["campo extra", { appId: "1234567890", appSecret: SECRET, workspaceId: "x" }],
  ])("recusa %s", (_label, input) => {
    expect(metaCloudAppCredentialsInputSchema.safeParse(input).success).toBe(false);
  });

  it("o DTO da conexão expõe só metaApp (sem segredo) e continua aceitando conexões sem ele", () => {
    const base = {
      id: "conn",
      workspaceId: "ws",
      provider: "meta_cloud",
      displayName: "Meta oficial",
      parserVersion: "v1",
      status: "observation",
      productionActivatedAt: null,
      lastDeliveryAt: null,
      lastSuccessfulParseAt: null,
      createdAt: at,
      updatedAt: at,
    };
    expect(inboundWebhookConnectionSchema.safeParse(base).success).toBe(true);
    const parsed = inboundWebhookConnectionSchema.parse({
      ...base,
      metaApp: {
        appId: "1234567890",
        appSecretConfigured: true,
        appSecretSource: "connection",
        appSecretUpdatedAt: at,
        appSecret: SECRET,
      },
    });
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
    expect(
      inboundWebhookConnectionSchema.safeParse({
        ...base,
        metaApp: { appId: null, appSecretConfigured: false, appSecretSource: "other", appSecretUpdatedAt: null },
      }).success,
    ).toBe(false);
  });
});
