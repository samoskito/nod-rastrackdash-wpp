import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { MetaTokenEncryptionService } from "../../src/integrations/meta/meta-token-encryption.service";
import { WhatsappConnectionsService } from "../../src/integrations/whatsapp-providers/whatsapp-connections.service";
import { WhatsappProviderRegistry } from "../../src/integrations/whatsapp-providers/whatsapp-provider.registry";
import { WorkspaceAccessPolicyService } from "../../src/workspaces/workspace-access-policy.service";

const owner = {
  workspaceId: "workspace-a",
  userId: "user-a",
  role: "owner" as const,
};

function service() {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    whatsappInstance: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return {
          id: "connection-1",
          ...data,
          lastHealthStatus: null,
          lastHealthCheckedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
    },
    auditLog: { create: async () => undefined },
  };

  return {
    created,
    connections: new WhatsappConnectionsService(
      prisma as never,
      new MetaTokenEncryptionService({ META_TOKEN_ENCRYPTION_KEY: "test-key" }),
      new WhatsappProviderRegistry(),
      new WorkspaceAccessPolicyService(),
      {},
    ),
  };
}

describe("WhatsappConnectionsService provider URL validation", () => {
  it.each([
    ["uazapi_byo", { baseUrl: "http://127.0.0.1:3000", token: "token" }],
    ["waha", { baseUrl: "http://169.254.169.254", apiKey: "key" }],
    [
      "zapi",
      {
        baseUrl: "https://user:password@zapi.example.com",
        instanceId: "instance",
        token: "token",
      },
    ],
  ] as const)(
    "rejects unsafe persisted %s base URLs before encryption",
    async (provider, credentials) => {
      const { connections, created } = service();

      await expect(
        connections.createConnection(owner, {
          provider,
          name: "WhatsApp",
          credentials,
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(created).toEqual([]);
    },
  );

  it("permits an RFC1918 self-hosted BYO endpoint", async () => {
    const { connections, created } = service();

    await connections.createConnection(owner, {
      provider: "waha",
      name: "WhatsApp",
      credentials: { baseUrl: "http://10.0.0.8:3000", apiKey: "key" },
    });

    expect(created).toHaveLength(1);
    expect(created[0]?.configEncrypted).toBeTruthy();
  });
});
