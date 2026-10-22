import { describe, expect, it, vi } from "vitest";
import { UNSUPPORTED_RULE_WHATSAPP_PROVIDERS } from "../../src/conversion-rules/provider-rule-scope";
import { InboundWebhookConnectionsService } from "../../src/inbound-webhooks/inbound-webhook-connections.service";

function service() {
  const prisma = {
    inboundWebhookParserRelease: {
      findMany: vi.fn(async () => [{ provider: "waha", status: "certified" }]),
      findFirst: vi.fn(async () => null),
    },
    $transaction: vi.fn(async () => {
      throw new Error("must not open a transaction");
    }),
  };
  return {
    prisma,
    service: new InboundWebhookConnectionsService(prisma as never, {
      INBOUND_WEBHOOKS_ENABLED: "true",
      API_PUBLIC_URL: "https://api.example.test",
      INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
    }),
  };
}

describe("WAHA has no generic inbound webhook connection", () => {
  it("is left out of the generic connection capabilities", async () => {
    const capabilities = await service().service.getCapabilities();

    expect(capabilities.providers.map((item) => item.provider)).not.toContain(
      "waha",
    );
  });

  it("refuses to create a generic WAHA connection before touching the database", async () => {
    const { prisma, service: connections } = service();

    await expect(
      connections.createConnection(
        "workspace-a",
        { provider: "waha", displayName: "WAHA" } as never,
        "user-a",
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("keeps WAHA phrase rules locked (another phase)", () => {
    expect(UNSUPPORTED_RULE_WHATSAPP_PROVIDERS).toContain("waha");
  });
});
