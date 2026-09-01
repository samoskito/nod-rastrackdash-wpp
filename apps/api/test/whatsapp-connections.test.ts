import "reflect-metadata";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { MetaTokenEncryptionService } from "../src/integrations/meta/meta-token-encryption.service";
import { WhatsappConnectionsService } from "../src/integrations/whatsapp-providers/whatsapp-connections.service";
import { WhatsappProviderRegistry } from "../src/integrations/whatsapp-providers/whatsapp-provider.registry";
import { WhatsappProvidersModule } from "../src/integrations/whatsapp-providers/whatsapp-providers.module";
import type { WhatsappProviderAdapter } from "../src/integrations/whatsapp-providers/whatsapp-provider.types";
import { WorkspaceAccessPolicyService } from "../src/workspaces/workspace-access-policy.service";

type RecordShape = {
  id: string;
  workspaceId: string;
  name: string;
  displayName: string | null;
  provider: string;
  providerInstanceId: string | null;
  configEncrypted: string | null;
  configIv: string | null;
  configTag: string | null;
  webhookUrl: string | null;
  webhookTokenHash: string | null;
  status: "pending_payment" | "active" | "disconnected" | "suspended" | "error";
  lastHealthStatus: string | null;
  lastHealthCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function record(overrides: Partial<RecordShape> = {}): RecordShape {
  const now = new Date("2026-08-27T12:00:00.000Z");
  return {
    id: "connection-1",
    workspaceId: "workspace-a",
    name: "Vendas",
    displayName: null,
    provider: "waha",
    providerInstanceId: null,
    configEncrypted: null,
    configIv: null,
    configTag: null,
    webhookUrl: null,
    webhookTokenHash: null,
    status: "active",
    lastHealthStatus: null,
    lastHealthCheckedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fakePrisma(initial: RecordShape[] = []) {
  const records = [...initial];
  const audits: unknown[] = [];
  return {
    records,
    audits,
    whatsappInstance: {
      findMany: async ({ where }: { where: { workspaceId: string } }) =>
        records.filter((item) => item.workspaceId === where.workspaceId),
      findFirst: async ({
        where,
      }: {
        where: { id: string; workspaceId: string };
      }) =>
        records.find(
          (item) =>
            item.id === where.id && item.workspaceId === where.workspaceId,
        ) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const created = record({
          id: `connection-${records.length + 1}`,
          workspaceId: data.workspaceId as string,
          name: data.name as string,
          displayName: (data.displayName as string | null) ?? null,
          provider: data.provider as string,
          providerInstanceId:
            (data.providerInstanceId as string | null) ?? null,
          configEncrypted: data.configEncrypted as string,
          configIv: data.configIv as string,
          configTag: data.configTag as string,
          webhookUrl: (data.webhookUrl as string | null) ?? null,
          webhookTokenHash: (data.webhookTokenHash as string | null) ?? null,
          status: data.status as RecordShape["status"],
        });
        records.push(created);
        return created;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const found = records.find((item) => item.id === where.id);
        if (!found) throw new Error("missing record");
        Object.assign(found, data, { updatedAt: new Date() });
        return found;
      },
    },
    auditLog: {
      create: async ({ data }: { data: unknown }) => audits.push(data),
    },
  };
}

function service(
  prisma = fakePrisma(),
  registry = new WhatsappProviderRegistry(),
  env: Record<string, string | undefined> = {
    API_PUBLIC_URL: "https://api.example.test",
    NODE_ENV: "test",
  },
) {
  return {
    prisma,
    registry,
    service: new WhatsappConnectionsService(
      prisma as never,
      new MetaTokenEncryptionService({ META_TOKEN_ENCRYPTION_KEY: "test-key" }),
      registry,
      new WorkspaceAccessPolicyService(),
      env,
    ),
  };
}

function adapter(
  provider: WhatsappProviderAdapter["id"],
  getHealth: WhatsappProviderAdapter["getHealth"],
): WhatsappProviderAdapter {
  return { id: provider, getHealth };
}

const owner = {
  workspaceId: "workspace-a",
  userId: "user-a",
  role: "owner" as const,
};

describe("WhatsappConnectionsService", () => {
  it("creates and lists encrypted credentials without returning or auditing plaintext", async () => {
    const { service: connections, prisma } = service();
    const token = "waha-secret-never-returned";
    const created = await connections.createConnection(owner, {
      provider: "waha",
      name: "Suporte",
      displayName: "WhatsApp Suporte",
      credentials: {
        baseUrl: "https://waha.example.test",
        apiKey: token,
        session: "support",
      },
    });

    expect(JSON.stringify(prisma.records[0])).not.toContain(token);
    expect(prisma.records[0]?.configEncrypted).toBeTruthy();
    expect(prisma.records[0]?.configIv).toBeTruthy();
    expect(prisma.records[0]?.configTag).toBeTruthy();
    expect(JSON.stringify(created)).not.toContain(token);
    expect(JSON.stringify(prisma.audits)).not.toContain(token);
    await expect(
      connections.listConnections(owner.workspaceId),
    ).resolves.toEqual([
      expect.objectContaining({ id: created.id, provider: "waha" }),
    ]);
  });

  it("returns 404 rather than leaking a connection from another workspace", async () => {
    const { service: connections } = service(
      fakePrisma([record({ workspaceId: "workspace-b" })]),
    );
    await expect(
      connections.updateConnection(owner, "connection-1", {
        name: "Novo nome",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("uses the environment-backed adapter when an existing connection has no saved config", async () => {
    const { service: connections, registry } = service(fakePrisma([record()]));
    let receivedConfig: unknown = "not-called";
    registry.register(
      adapter("waha", async (config) => {
        receivedConfig = config;
        return {
          provider: "waha",
          status: "connected",
          checkedAt: "2026-08-27T12:01:00.000Z",
        };
      }),
    );

    const result = await connections.testConnection(owner, "connection-1");

    expect(receivedConfig).toBeUndefined();
    expect(result.status).toBe("connected");
  });

  it("records a failed health check while list remains available", async () => {
    const { service: connections, registry } = service(fakePrisma([record()]));
    registry.register(
      adapter("waha", async () => {
        throw new Error("provider unavailable");
      }),
    );

    await expect(
      connections.testConnection(owner, "connection-1"),
    ).resolves.toEqual(expect.objectContaining({ status: "error" }));
    await expect(
      connections.listConnections(owner.workspaceId),
    ).resolves.toHaveLength(1);
  });

  it("does not provision NOD API while preserving the Testar contract", async () => {
    const registry = new WhatsappProviderRegistry();
    let managedInstanceCalls = 0;
    const createManagedInstance = async () => {
      managedInstanceCalls += 1;
      throw new Error("createManagedInstance must not be called by onboarding");
    };
    registry.register({
      id: "nod_api",
      createManagedInstance,
      getHealth: async (config) => {
        expect(config).toEqual({
          provider: "nod_api",
          config: {
            enabled: true,
            instanceId: "configured-instance",
            instanceToken: "configured-token",
          },
        });
        return {
          provider: "nod_api",
          status: "connected",
          checkedAt: "2026-08-27T12:01:00.000Z",
        };
      },
    });
    const { service: connections, prisma } = service(undefined, registry);
    const created = await connections.createConnection(owner, {
      provider: "nod_api",
      name: "NOD",
      credentials: {
        instanceId: "configured-instance",
        instanceToken: "configured-token",
      },
    });

    expect(prisma.records[0]?.providerInstanceId).toBe("configured-instance");
    expect(managedInstanceCalls).toBe(0);
    await expect(
      connections.testConnection(owner, created.id),
    ).resolves.toEqual(
      expect.objectContaining({ provider: "nod_api", status: "connected" }),
    );
  });

  it("persists WAHA credentials.session as providerInstanceId on create", async () => {
    const { service: connections, prisma } = service();
    const created = await connections.createConnection(owner, {
      provider: "waha",
      name: "Suporte",
      credentials: {
        baseUrl: "https://waha.example.test",
        apiKey: "waha-secret",
        session: "session-abc",
      },
    });

    expect(prisma.records[0]?.providerInstanceId).toBe("session-abc");
    expect(created.id).toBe(prisma.records[0]?.id);
  });

  it("rejects creating a WAHA connection without a session, and persists nothing", async () => {
    const { service: connections, prisma } = service();

    await expect(
      connections.createConnection(owner, {
        provider: "waha",
        name: "Suporte",
        credentials: {
          baseUrl: "https://waha.example.test",
          apiKey: "waha-secret",
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.records).toHaveLength(0);
  });

  it("rotates a hash-only webhook token without exposing it in persistence or audit", async () => {
    const { service: connections, prisma } = service();
    const created = await connections.createConnection(owner, {
      provider: "waha",
      name: "Suporte",
      credentials: {
        baseUrl: "https://waha.example.test",
        apiKey: "waha-secret",
        session: "support",
      },
    });

    const first = await connections.rotateWebhookToken(owner, created.id);
    const second = await connections.rotateWebhookToken(owner, created.id);

    expect(first.webhookEndpoint).toBe(
      `https://api.example.test/webhooks/whatsapp/${created.id}`,
    );
    expect(first.webhookEndpoint).not.toContain("token=");
    expect(second.webhookToken).not.toBe(first.webhookToken);
    expect(JSON.stringify(prisma.records)).not.toContain(first.webhookToken);
    expect(JSON.stringify(prisma.records)).not.toContain(second.webhookToken);
    expect(JSON.stringify(prisma.audits)).not.toContain(first.webhookToken);
    expect(JSON.stringify(prisma.audits)).not.toContain(second.webhookToken);
    await expect(
      connections.rotateWebhookToken(
        { ...owner, workspaceId: "workspace-b" },
        created.id,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("loads editable metadata without the provider secret", async () => {
    const { service: connections } = service();
    const created = await connections.createConnection(owner, {
      provider: "waha",
      name: "Suporte",
      displayName: "WhatsApp Suporte",
      credentials: {
        baseUrl: "https://waha.example.test",
        apiKey: "waha-secret-never-returned",
        session: "support",
      },
    });

    const edit = await connections.getEditableConnection(owner, created.id);

    expect(edit).toEqual({
      id: created.id,
      provider: "waha",
      name: "Suporte",
      displayName: "WhatsApp Suporte",
      baseUrl: "https://waha.example.test",
      instanceId: null,
      session: "support",
    });
    expect(JSON.stringify(edit)).not.toContain("waha-secret-never-returned");
  });

  it("updates providerInstanceId when editConnection changes the WAHA session", async () => {
    const { service: connections, prisma } = service();
    const created = await connections.createConnection(owner, {
      provider: "waha",
      name: "Suporte",
      credentials: {
        baseUrl: "https://waha.example.test",
        apiKey: "waha-secret",
        session: "session-old",
      },
    });
    expect(prisma.records[0]?.providerInstanceId).toBe("session-old");

    await connections.editConnection(owner, created.id, {
      provider: "waha",
      name: "Suporte",
      displayName: null,
      credentials: {
        baseUrl: "https://waha.example.test",
        apiKey: "waha-secret",
        session: "session-new",
      },
    });

    expect(prisma.records[0]?.providerInstanceId).toBe("session-new");
  });

  it("returns 404 for edit metadata of a connection from another workspace", async () => {
    const { service: connections } = service(
      fakePrisma([record({ workspaceId: "workspace-b" })]),
    );
    await expect(
      connections.getEditableConnection(owner, "connection-1"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("keeps the current secret when the edit payload omits it", async () => {
    const { service: connections, registry } = service();
    const created = await connections.createConnection(owner, {
      provider: "waha",
      name: "Suporte",
      credentials: {
        baseUrl: "https://waha.example.test",
        apiKey: "original-secret",
        session: "support",
      },
    });

    await connections.editConnection(owner, created.id, {
      provider: "waha",
      name: "Suporte renomeado",
      displayName: null,
      credentials: {
        baseUrl: "https://waha-novo.example.test",
        session: "support",
      },
    });

    let receivedConfig: unknown;
    registry.register(
      adapter("waha", async (config) => {
        receivedConfig = config;
        return {
          provider: "waha",
          status: "connected",
          checkedAt: "2026-08-27T12:01:00.000Z",
        };
      }),
    );
    await connections.testConnection(owner, created.id);

    expect(receivedConfig).toEqual({
      provider: "waha",
      config: {
        baseUrl: "https://waha-novo.example.test",
        apiKey: "original-secret",
        session: "support",
      },
    });
  });

  it("rejects an edit payload that omits the WAHA session, without mutating the stored connection", async () => {
    const { service: connections, prisma } = service();
    const created = await connections.createConnection(owner, {
      provider: "waha",
      name: "Suporte",
      credentials: {
        baseUrl: "https://waha.example.test",
        apiKey: "original-secret",
        session: "support",
      },
    });
    const before = { ...prisma.records[0] };

    await expect(
      connections.editConnection(owner, created.id, {
        provider: "waha",
        name: "Suporte renomeado",
        displayName: null,
        credentials: {
          baseUrl: "https://waha-novo.example.test",
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.records[0]).toEqual(before);
  });

  it("replaces the secret when the edit payload provides a new one", async () => {
    const { service: connections, registry } = service();
    const created = await connections.createConnection(owner, {
      provider: "waha",
      name: "Suporte",
      credentials: {
        baseUrl: "https://waha.example.test",
        apiKey: "original-secret",
        session: "support",
      },
    });

    await connections.editConnection(owner, created.id, {
      provider: "waha",
      name: "Suporte",
      displayName: null,
      credentials: {
        baseUrl: "https://waha.example.test",
        apiKey: "rotated-secret",
        session: "support",
      },
    });

    let receivedConfig: unknown;
    registry.register(
      adapter("waha", async (config) => {
        receivedConfig = config;
        return {
          provider: "waha",
          status: "connected",
          checkedAt: "2026-08-27T12:01:00.000Z",
        };
      }),
    );
    await connections.testConnection(owner, created.id);

    expect(receivedConfig).toMatchObject({
      config: { apiKey: "rotated-secret" },
    });
  });

  it("rejects an edit that changes the provider", async () => {
    const { service: connections } = service();
    const created = await connections.createConnection(owner, {
      provider: "waha",
      name: "Suporte",
      credentials: {
        baseUrl: "https://waha.example.test",
        apiKey: "secret",
        session: "support",
      },
    });

    await expect(
      connections.editConnection(owner, created.id, {
        provider: "zapi",
        name: "Suporte",
        displayName: null,
        credentials: {
          baseUrl: "https://zapi.example.test",
          instanceId: "instance-1",
          token: "token",
        },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("returns 404 rather than editing a connection from another workspace", async () => {
    const { service: connections } = service(
      fakePrisma([record({ workspaceId: "workspace-b" })]),
    );
    await expect(
      connections.editConnection(owner, "connection-1", {
        provider: "waha",
        name: "Novo nome",
        displayName: null,
        credentials: { baseUrl: "https://waha.example.test" },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("does not leak the secret in the edit audit trail", async () => {
    const { service: connections, prisma } = service();
    const created = await connections.createConnection(owner, {
      provider: "waha",
      name: "Suporte",
      credentials: {
        baseUrl: "https://waha.example.test",
        apiKey: "secret",
        session: "support",
      },
    });

    await connections.editConnection(owner, created.id, {
      provider: "waha",
      name: "Suporte",
      displayName: null,
      credentials: {
        baseUrl: "https://waha.example.test",
        apiKey: "rotated-secret",
        session: "support",
      },
    });

    expect(JSON.stringify(prisma.audits)).not.toContain("secret");
    expect(JSON.stringify(prisma.audits)).not.toContain("rotated-secret");
  });
});

describe("WhatsApp provider module graph", () => {
  const previousWebOrigin = process.env.WEB_ORIGIN;

  beforeAll(() => {
    process.env.WEB_ORIGIN = "https://app.example.test";
  });

  afterAll(() => {
    if (previousWebOrigin === undefined) delete process.env.WEB_ORIGIN;
    else process.env.WEB_ORIGIN = previousWebOrigin;
  });

  it("compiles WhatsappProvidersModule without a database", async () => {
    const module = await Test.createTestingModule({
      imports: [WhatsappProvidersModule],
    }).compile();
    await module.close();
  });

  it("compiles AppModule without a database", async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await module.close();
  });
});
