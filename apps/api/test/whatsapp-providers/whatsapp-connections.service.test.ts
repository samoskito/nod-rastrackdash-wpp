import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { MetaTokenEncryptionService } from "../../src/integrations/meta/meta-token-encryption.service";
import { WhatsappConnectionsService } from "../../src/integrations/whatsapp-providers/whatsapp-connections.service";
import { WhatsappProviderRegistry } from "../../src/integrations/whatsapp-providers/whatsapp-provider.registry";
import { WorkspaceAccessPolicyService } from "../../src/workspaces/workspace-access-policy.service";

const uazapiByo = {
  testSavedConnection: async () => ({
    health: {
      provider: "uazapi_byo" as const,
      status: "disconnected" as const,
      checkedAt: new Date().toISOString(),
    },
    providerInstanceId: null,
    connectedPhone: null,
  }),
};
const uazapiBridge = { ensureBridge: async () => undefined };

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
      uazapiByo as never,
      uazapiBridge as never,
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
      credentials: {
        baseUrl: "http://10.0.0.8:3000",
        apiKey: "key",
        session: "self-hosted",
      },
    });

    expect(created).toHaveLength(1);
    expect(created[0]?.configEncrypted).toBeTruthy();
  });
});

describe("WhatsappConnectionsService Uazapi trigger provisioning", () => {
  function testConnectionService(input: {
    status: "connected" | "error";
    providerInstanceId: string | null;
    connectedPhone: string | null;
  }) {
    const encryption = new MetaTokenEncryptionService({
      META_TOKEN_ENCRYPTION_KEY: "test-key",
    });
    const encrypted = encryption.encrypt(
      JSON.stringify({
        provider: "uazapi_byo",
        config: { baseUrl: "https://uazapi.example.com", token: "token" },
      }),
    );
    const connection = {
      id: "connection-1",
      workspaceId: owner.workspaceId,
      name: "UAZAPI principal",
      displayName: null,
      provider: "uazapi_byo",
      providerInstanceId: null,
      configEncrypted: encrypted.encryptedAccessToken,
      configIv: encrypted.tokenIv,
      configTag: encrypted.tokenTag,
      webhookUrl: null,
      status: "active" as const,
      lastHealthStatus: null,
      lastHealthCheckedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const updates: Array<Record<string, unknown>> = [];
    const bridgeCalls: Array<Record<string, unknown>> = [];
    const prisma = {
      whatsappInstance: {
        findFirst: async () => connection,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return { ...connection, ...data };
        },
      },
      auditLog: { create: async () => undefined },
    };
    const uazapi = {
      testSavedConnection: async () => ({
        health: {
          provider: "uazapi_byo" as const,
          status: input.status,
          checkedAt: new Date().toISOString(),
        },
        providerInstanceId: input.providerInstanceId,
        connectedPhone: input.connectedPhone,
      }),
    };
    const bridge = {
      ensureBridge: async (instance: Record<string, unknown>) => {
        bridgeCalls.push(instance);
        return { connectionId: "origin-1", channelId: "channel-1" };
      },
    };

    return {
      bridgeCalls,
      updates,
      connections: new WhatsappConnectionsService(
        prisma as never,
        encryption,
        new WhatsappProviderRegistry(),
        new WorkspaceAccessPolicyService(),
        {},
        uazapi as never,
        bridge as never,
      ),
    };
  }

  it("provisions the existing bridge with the tested Uazapi phone identity", async () => {
    const { connections, bridgeCalls, updates } = testConnectionService({
      status: "connected",
      providerInstanceId: "instance-remote",
      connectedPhone: "5511999999999",
    });

    await connections.testConnection(owner, "connection-1");

    expect(updates[0]).toMatchObject({
      lastHealthStatus: "connected",
      providerInstanceId: "instance-remote",
    });
    expect(bridgeCalls).toEqual([
      expect.objectContaining({
        id: "connection-1",
        workspaceId: owner.workspaceId,
        providerInstanceId: "instance-remote",
        connectedPhone: "5511999999999",
      }),
    ]);
  });

  it("does not provision a channel for a failed test or missing phone identity", async () => {
    for (const input of [
      {
        status: "error" as const,
        providerInstanceId: "instance",
        connectedPhone: "5511999999999",
      },
      {
        status: "connected" as const,
        providerInstanceId: "instance",
        connectedPhone: null,
      },
    ]) {
      const { connections, bridgeCalls } = testConnectionService(input);

      await connections.testConnection(owner, "connection-1");

      expect(bridgeCalls).toEqual([]);
    }
  });
});
