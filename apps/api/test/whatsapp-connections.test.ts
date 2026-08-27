import "reflect-metadata";
import { NotFoundException } from "@nestjs/common";
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
      findFirst: async ({ where }: { where: { id: string; workspaceId: string } }) =>
        records.find(
          (item) => item.id === where.id && item.workspaceId === where.workspaceId,
        ) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const created = record({
          id: `connection-${records.length + 1}`,
          workspaceId: data.workspaceId as string,
          name: data.name as string,
          displayName: (data.displayName as string | null) ?? null,
          provider: data.provider as string,
          providerInstanceId: (data.providerInstanceId as string | null) ?? null,
          configEncrypted: data.configEncrypted as string,
          configIv: data.configIv as string,
          configTag: data.configTag as string,
          status: data.status as RecordShape["status"],
        });
        records.push(created);
        return created;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const found = records.find((item) => item.id === where.id);
        if (!found) throw new Error("missing record");
        Object.assign(found, data, { updatedAt: new Date() });
        return found;
      },
    },
    auditLog: { create: async ({ data }: { data: unknown }) => audits.push(data) },
  };
}

function adapter(
  provider: WhatsappProviderAdapter["id"],
  getHealth: WhatsappProviderAdapter["getHealth"],
): WhatsappProviderAdapter {
  return { id: provider, getHealth };
}

function service(
  prisma = fakePrisma(),
  registry = new WhatsappProviderRegistry(),
  env: Record<string, string | undefined> = {},
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
    await expect(connections.listConnections(owner.workspaceId)).resolves.toEqual([
      expect.objectContaining({ id: created.id, provider: "waha" }),
    ]);
  });

  it("returns 404 rather than leaking a connection from another workspace", async () => {
    const { service: connections } = service(
      fakePrisma([record({ workspaceId: "workspace-b" })]),
    );
    await expect(
      connections.updateConnection(owner, "connection-1", { name: "Novo nome" }),
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
    registry.register(adapter("waha", async () => { throw new Error("provider unavailable"); }));

    await expect(connections.testConnection(owner, "connection-1")).resolves.toEqual(
      expect.objectContaining({ status: "error" }),
    );
    await expect(connections.listConnections(owner.workspaceId)).resolves.toHaveLength(1);
  });

  it("fails closed when a nod_api connection is requested without a configured broker", async () => {
    const { service: connections } = service();

    await expect(
      connections.createConnection(owner, { provider: "nod_api", name: "NOD" }),
    ).rejects.toThrow("NOD_API_BROKER_URL");
  });
});

describe("WhatsApp provider module graph", () => {
  const previousWebOrigin = process.env.WEB_ORIGIN;

  beforeAll(() => {
    process.env.WEB_ORIGIN = "https://app.example.test";
  });

  afterAll(() => {
    if (previousWebOrigin === undefined) {
      delete process.env.WEB_ORIGIN;
    } else {
      process.env.WEB_ORIGIN = previousWebOrigin;
    }
  });

  it("compiles WhatsappProvidersModule without a database", async () => {
    const module = await Test.createTestingModule({
      imports: [WhatsappProvidersModule],
    }).compile();
    await module.close();
  });

  it("compiles AppModule without a database", async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await module.close();
  });
});
