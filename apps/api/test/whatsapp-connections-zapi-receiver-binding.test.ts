import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { MetaTokenEncryptionService } from "../src/integrations/meta/meta-token-encryption.service";
import { WhatsappConnectionsService } from "../src/integrations/whatsapp-providers/whatsapp-connections.service";
import { WhatsappProviderRegistry } from "../src/integrations/whatsapp-providers/whatsapp-provider.registry";
import { WorkspaceAccessPolicyService } from "../src/workspaces/workspace-access-policy.service";
import { WebhooksController } from "../src/webhooks/webhooks.controller";

// Same coherence check as whatsapp-connections-waha-receiver-binding.test.ts,
// mirrored for Z-API: WhatsappConnectionsService persists
// credentials.instanceId into providerInstanceId (write path), and
// WebhooksController binds an inbound delivery's top-level `instanceId`
// against that same persisted providerInstanceId (read path). Both sides are
// exercised for real against one shared fake `whatsappInstance` table so a
// regression in either side's field name/semantics fails this test instead
// of only surfacing in production as every Z-API webhook being rejected.

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
  const now = new Date("2026-09-01T12:00:00.000Z");
  return {
    id: "connection-1",
    workspaceId: "workspace-a",
    name: "Vendas",
    displayName: null,
    provider: "zapi",
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

function sharedFakeDb(initial: RecordShape[] = []) {
  const records = [...initial];
  const audits: unknown[] = [];
  return {
    records,
    // Consumed by WhatsappConnectionsService.
    connectionsPrisma: {
      whatsappInstance: {
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
    },
    // Consumed by WebhooksController: real receiver code path, same table.
    webhooksPrisma: {
      whatsappInstance: {
        findFirst: async ({ where }: { where: { id: string } }) =>
          records.find((item) => item.id === where.id) ?? null,
      },
      metaAd: { findFirst: async () => null },
    },
  };
}

function organicZapiPayload(instanceId: string) {
  return {
    instanceId,
    connectedPhone: "5511888888888",
    phone: "5511999999999",
    timestamp: 1_700_000_000,
    fromMe: false,
    isGroup: false,
    message: "Ola",
    messageId: "zapi-msg-1",
  };
}

function webhooksServices() {
  return {
    diagnosticsService: {
      recordWebhookLog: vi.fn(async () => ({
        webhookLogId: "webhook-log-1",
        diagnosticEventId: "diagnostic-event-1",
        status: "received",
      })),
    },
    conversionRulesService: { evaluateTriggers: vi.fn(async () => []) },
    conversionEventsService: {
      recordAutomaticLeadSubmitted: vi.fn(async () => ({
        created: [],
        duplicates: [],
      })),
      recordRuleMatches: vi.fn(async () => ({ created: [], duplicates: [] })),
      listReadyLogIds: vi.fn(async () => []),
    },
    conversionEventsQueueService: { enqueueSend: vi.fn(async () => ({ queued: true })) },
    leadsService: {
      upsertFromWhatsappWebhook: vi.fn(async () => ({ id: "lead-1" })),
    },
  };
}

const owner = {
  workspaceId: "workspace-a",
  userId: "user-a",
  role: "owner" as const,
};

describe("Z-API connection persistence <-> receiver binding coherence", () => {
  it("accepts a webhook whose instanceId matches the instanceId persisted at creation, and rejects a mismatched one", async () => {
    const db = sharedFakeDb();
    const connections = new WhatsappConnectionsService(
      db.connectionsPrisma as never,
      new MetaTokenEncryptionService({ META_TOKEN_ENCRYPTION_KEY: "test-key" }),
      new WhatsappProviderRegistry(),
      new WorkspaceAccessPolicyService(),
      { API_PUBLIC_URL: "https://api.example.test", NODE_ENV: "test" },
    );

    const created = await connections.createConnection(owner, {
      provider: "zapi",
      name: "Suporte",
      credentials: {
        baseUrl: "https://zapi.example.test",
        instanceId: "instance-live",
        token: "zapi-secret",
      },
    });
    const { webhookToken } = await connections.rotateWebhookToken(
      owner,
      created.id,
    );

    const services = webhooksServices();
    const controller = new WebhooksController(
      services.diagnosticsService as never,
      services.conversionRulesService as never,
      services.conversionEventsService as never,
      services.conversionEventsQueueService as never,
      services.leadsService as never,
      {} as never,
      db.webhooksPrisma as never,
    );

    await expect(
      controller.recordWhatsappConnection(
        created.id,
        organicZapiPayload("instance-live"),
        webhookToken,
      ),
    ).resolves.toBeDefined();
    expect(services.diagnosticsService.recordWebhookLog).toHaveBeenCalledTimes(
      1,
    );

    await expect(
      controller.recordWhatsappConnection(
        created.id,
        organicZapiPayload("some-other-instance"),
        webhookToken,
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(services.diagnosticsService.recordWebhookLog).toHaveBeenCalledTimes(
      1,
    );
  });

  it("rebinds the receiver to the new instanceId after editConnection rotates it, and stops accepting the old one", async () => {
    const db = sharedFakeDb();
    const connections = new WhatsappConnectionsService(
      db.connectionsPrisma as never,
      new MetaTokenEncryptionService({ META_TOKEN_ENCRYPTION_KEY: "test-key" }),
      new WhatsappProviderRegistry(),
      new WorkspaceAccessPolicyService(),
      { API_PUBLIC_URL: "https://api.example.test", NODE_ENV: "test" },
    );

    const created = await connections.createConnection(owner, {
      provider: "zapi",
      name: "Suporte",
      credentials: {
        baseUrl: "https://zapi.example.test",
        instanceId: "instance-old",
        token: "zapi-secret",
      },
    });
    const { webhookToken } = await connections.rotateWebhookToken(
      owner,
      created.id,
    );

    await connections.editConnection(owner, created.id, {
      provider: "zapi",
      name: "Suporte",
      displayName: null,
      credentials: {
        baseUrl: "https://zapi.example.test",
        instanceId: "instance-new",
        token: "zapi-secret",
      },
    });

    const services = webhooksServices();
    const controller = new WebhooksController(
      services.diagnosticsService as never,
      services.conversionRulesService as never,
      services.conversionEventsService as never,
      services.conversionEventsQueueService as never,
      services.leadsService as never,
      {} as never,
      db.webhooksPrisma as never,
    );

    await expect(
      controller.recordWhatsappConnection(
        created.id,
        organicZapiPayload("instance-old"),
        webhookToken,
      ),
    ).rejects.toMatchObject({ status: 401 });

    await expect(
      controller.recordWhatsappConnection(
        created.id,
        organicZapiPayload("instance-new"),
        webhookToken,
      ),
    ).resolves.toBeDefined();
    expect(services.diagnosticsService.recordWebhookLog).toHaveBeenCalledTimes(
      1,
    );
  });

  it("rebinds the receiver to the new instanceId after updateCredentials rotates it, and stops accepting the old one", async () => {
    const db = sharedFakeDb();
    const connections = new WhatsappConnectionsService(
      db.connectionsPrisma as never,
      new MetaTokenEncryptionService({ META_TOKEN_ENCRYPTION_KEY: "test-key" }),
      new WhatsappProviderRegistry(),
      new WorkspaceAccessPolicyService(),
      { API_PUBLIC_URL: "https://api.example.test", NODE_ENV: "test" },
    );

    const created = await connections.createConnection(owner, {
      provider: "zapi",
      name: "Suporte",
      credentials: {
        baseUrl: "https://zapi.example.test",
        instanceId: "instance-old",
        token: "zapi-secret",
      },
    });
    const { webhookToken } = await connections.rotateWebhookToken(
      owner,
      created.id,
    );

    await connections.updateCredentials(owner, created.id, {
      provider: "zapi",
      credentials: {
        baseUrl: "https://zapi.example.test",
        instanceId: "instance-new",
        token: "zapi-secret",
      },
    });

    const services = webhooksServices();
    const controller = new WebhooksController(
      services.diagnosticsService as never,
      services.conversionRulesService as never,
      services.conversionEventsService as never,
      services.conversionEventsQueueService as never,
      services.leadsService as never,
      {} as never,
      db.webhooksPrisma as never,
    );

    await expect(
      controller.recordWhatsappConnection(
        created.id,
        organicZapiPayload("instance-old"),
        webhookToken,
      ),
    ).rejects.toMatchObject({ status: 401 });

    await expect(
      controller.recordWhatsappConnection(
        created.id,
        organicZapiPayload("instance-new"),
        webhookToken,
      ),
    ).resolves.toBeDefined();
    expect(services.diagnosticsService.recordWebhookLog).toHaveBeenCalledTimes(
      1,
    );
  });
});
