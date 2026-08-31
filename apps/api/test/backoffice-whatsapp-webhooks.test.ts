import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { backofficeWhatsappWebhookHistoryQuerySchema } from "@wpptrack/shared";
import { AuthService } from "../src/auth/auth.service";
import { PlatformAdminService } from "../src/auth/platform-admin.service";
import { BackofficeWhatsappWebhooksController } from "../src/backoffice-whatsapp-webhooks/backoffice-whatsapp-webhooks.controller";
import { BackofficeWhatsappWebhooksService } from "../src/backoffice-whatsapp-webhooks/backoffice-whatsapp-webhooks.service";

const receivedAt = new Date("2026-08-31T10:00:00.000Z");

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "connection_1",
    name: "Atendimento",
    provider: "uazapi_byo",
    status: "active",
    webhookUrl: "https://api.example.test/webhooks/whatsapp/connection_1",
    webhookTokenHash: "never-exposed-token-hash",
    ...overrides,
  };
}

function webhook(overrides: Record<string, unknown> = {}) {
  return {
    id: "webhook_1",
    receivedAt,
    status: "received",
    source: "uazapi",
    eventType: "messages.upsert",
    externalEventId: "provider-event-1",
    leadId: "lead_1",
    errorCode: null,
    summaryPayload: {
      authorization: "Bearer never-expose",
      tokenHash: "never-expose-token-hash",
      phone: "+5511999999999",
      email: "person@example.test",
      nested: {
        apiKey: "never-expose-api-key",
        message: "Contato person@example.test no +55 (11) 99999-9999",
        event: "safe",
      },
    },
    ...overrides,
  };
}

describe("BackofficeWhatsappWebhooksService", () => {
  it("lists only BYO connections in the workspace and never returns token hashes", async () => {
    const prisma: any = {
      whatsappInstance: {
        findMany: vi.fn(async () => [connection()]),
      },
    };
    const service = new BackofficeWhatsappWebhooksService(prisma);

    await expect(service.listConnections("workspace_1")).resolves.toEqual([
      {
        id: "connection_1",
        name: "Atendimento",
        provider: "uazapi_byo",
        status: "active",
        webhookConfigured: true,
      },
    ]);
    expect(prisma.whatsappInstance.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: "workspace_1" }),
      }),
    );
  });

  it("paginates logs by a connection scoped to its workspace", async () => {
    const prisma: any = {
      whatsappInstance: { findFirst: vi.fn(async () => connection()) },
      webhookLog: {
        count: vi.fn(async () => 3),
        findMany: vi.fn(async () => [webhook()]),
      },
    };
    const service = new BackofficeWhatsappWebhooksService(prisma);

    await expect(
      service.listHistory("workspace_1", "connection_1", {
        page: 2,
        pageSize: 1,
      }),
    ).resolves.toEqual({
      items: [
        {
          id: "webhook_1",
          receivedAt: "2026-08-31T10:00:00.000Z",
          status: "received",
          source: "uazapi",
          provider: "uazapi_byo",
          eventType: "messages.upsert",
          externalEventId: "provider-event-1",
          leadId: "lead_1",
          errorCode: null,
        },
      ],
      pagination: { page: 2, pageSize: 1, total: 3, totalPages: 3 },
    });
    expect(prisma.whatsappInstance.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "connection_1",
          workspaceId: "workspace_1",
        }),
      }),
    );
    expect(prisma.webhookLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "workspace_1", whatsappInstanceId: "connection_1" },
        skip: 1,
        take: 1,
      }),
    );
  });

  it("does not disclose a webhook that is outside the current connection and redacts payload PII", async () => {
    const prisma: any = {
      whatsappInstance: { findFirst: vi.fn(async () => connection()) },
      webhookLog: { findFirst: vi.fn(async () => webhook()) },
    };
    const service = new BackofficeWhatsappWebhooksService(prisma);

    await expect(
      service.getWebhookDetail("workspace_1", "connection_1", "webhook_1"),
    ).resolves.toMatchObject({
      webhook: { id: "webhook_1", provider: "uazapi_byo" },
      payloadAvailable: true,
      payload: {
        nested: {
          event: "safe",
          message: "Contato [redacted-email] no [redacted-phone]",
        },
      },
    });
    expect(prisma.webhookLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "webhook_1",
          workspaceId: "workspace_1",
          whatsappInstanceId: "connection_1",
        },
      }),
    );

    prisma.webhookLog.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.getWebhookDetail("workspace_1", "connection_1", "other_workspace_log"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("BackofficeWhatsappWebhooksController", () => {
  it("requires platform admin and resolves the support workspace before listing", async () => {
    const platformAdmin = {
      assertPlatformAdmin: vi.fn(async () => ({ id: "admin_1" })),
    } as unknown as PlatformAdminService;
    const auth = {
      getSession: vi.fn(async () => ({
        activeWorkspaceId: "member_workspace",
        supportContext: { workspaceId: "support_workspace" },
      })),
    } as unknown as AuthService;
    const webhooks = {
      listConnections: vi.fn(async () => []),
    } as unknown as BackofficeWhatsappWebhooksService;
    const controller = new BackofficeWhatsappWebhooksController(
      platformAdmin,
      auth,
      webhooks,
    );

    await controller.listConnections("refresh-token");
    expect(webhooks.listConnections).toHaveBeenCalledWith("support_workspace");

    (platformAdmin.assertPlatformAdmin as any).mockRejectedValueOnce(
      new ForbiddenException(),
    );
    await expect(controller.listConnections("non-admin-token")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("rejects a request with no selected workspace and strict invalid pagination", async () => {
    const platformAdmin = {
      assertPlatformAdmin: vi.fn(async () => ({ id: "admin_1" })),
    } as unknown as PlatformAdminService;
    const auth = {
      getSession: vi.fn(async () => ({ activeWorkspaceId: null, supportContext: null })),
    } as unknown as AuthService;
    const webhooks = {} as BackofficeWhatsappWebhooksService;
    const controller = new BackofficeWhatsappWebhooksController(
      platformAdmin,
      auth,
      webhooks,
    );

    await expect(controller.listConnections("refresh-token")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(
      backofficeWhatsappWebhookHistoryQuerySchema.safeParse({ page: "1", extra: "no" }).success,
    ).toBe(false);
  });
});
