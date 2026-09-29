import "reflect-metadata";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InboundWebhookChannelRoutesService } from "../../src/inbound-webhooks/inbound-webhook-channel-routes.service";
import { InboundWebhookConnectionsService } from "../../src/inbound-webhooks/inbound-webhook-connections.service";
import { InboundWebhookDiagnosticsService } from "../../src/inbound-webhooks/inbound-webhook-diagnostics.service";

const now = new Date("2026-09-29T12:00:00.000Z");

function dataCrazyConnection() {
  return {
    id: "connection_data_crazy_1",
    workspaceId: "workspace_1",
    provider: "data_crazy" as const,
    displayName: "Data Crazy Comercial",
    parserReleaseId: "inbound_parser_data_crazy_v1",
    secretHash: "pending",
    status: "observation" as const,
    productionActivatedAt: null,
    lastDeliveryAt: null,
    lastSuccessfulParseAt: null,
    removedAt: null,
    createdAt: now,
    updatedAt: now,
    createdByUserId: "user_1",
    parserRelease: {
      id: "inbound_parser_data_crazy_v1",
      provider: "data_crazy" as const,
      version: "v1",
      status: "observation_only" as const,
      createdAt: now,
      updatedAt: now,
      certifiedAt: null,
      certifiedByUserId: null,
    },
  };
}

function connectionsFixture() {
  const connection = dataCrazyConnection();
  const release = connection.parserRelease;
  const prisma = {
    inboundWebhookParserRelease: {
      findMany: vi.fn(async () => [release]),
      findFirst: vi.fn(async () => release),
    },
    inboundWebhookConnection: {
      create: vi.fn(async ({ data }: { data: { secretHash: string } }) => ({
        ...connection,
        secretHash: data.secretHash,
      })),
    },
    auditLog: { create: vi.fn(async () => undefined) },
    $transaction: vi.fn(
      async (fn: (transaction: unknown) => Promise<unknown>) => fn(prisma),
    ),
  };
  const service = new InboundWebhookConnectionsService(prisma as never, {
    INBOUND_WEBHOOKS_ENABLED: "true",
    API_PUBLIC_URL: "https://api.example.test",
    INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  });

  return { service, prisma };
}

describe("Data Crazy inbound webhook connections", () => {
  it("creates a Data Crazy callback with the query token contract", async () => {
    const { service, prisma } = connectionsFixture();

    const result = await service.createConnection(
      "workspace_1",
      { provider: "data_crazy", displayName: "Data Crazy Comercial" },
      "user_1",
    );
    const url = new URL(result.webhookUrl);

    expect(result.connection.provider).toBe("data_crazy");
    expect(url.pathname).toBe(
      `/webhooks/inbound/${result.connection.id}`,
    );
    expect(url.searchParams.get("token")).toBe(result.secret);
    expect(prisma.inboundWebhookConnection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          secretHash: createHash("sha256")
            .update(result.secret, "utf8")
            .digest("hex"),
        }),
      }),
    );
  });

  it("exposes Data Crazy as creatable when its v1 release is enabled", async () => {
    const { service } = connectionsFixture();

    const capabilities = await service.getCapabilities();

    expect(capabilities.providers).toContainEqual({
      provider: "data_crazy",
      parserVersion: "v1",
      parserReleaseStatus: "observation_only",
      creationEnabled: true,
    });
  });

  it("rejects provisional channels for Data Crazy connections", async () => {
    const prisma = {
      inboundWebhookConnection: {
        findFirst: vi.fn(async () => ({
          id: "connection_data_crazy_1",
          provider: "data_crazy",
        })),
      },
    };
    const service = new InboundWebhookChannelRoutesService(
      prisma as never,
      {} as never,
    );

    await expect(
      service.createProvisionalChannel(
        "workspace_1",
        "connection_data_crazy_1",
        { connectedPhone: "5511999999999", channelName: null },
        "user_1",
      ),
    ).rejects.toThrow("Este provedor cadastra o canal automaticamente");
  });

  it("records Data Crazy observations under the dedicated diagnostic source", async () => {
    const webhookLogCreate = vi.fn(async () => ({ id: "webhook_log_1" }));
    const diagnosticEventCreate = vi.fn(async () => ({
      id: "diagnostic_event_1",
    }));
    const prisma = {
      webhookLog: {
        findUnique: vi.fn(async () => null),
        create: webhookLogCreate,
      },
      diagnosticEvent: { create: diagnosticEventCreate },
      $transaction: undefined as unknown as ReturnType<typeof vi.fn>,
    };
    prisma.$transaction = vi.fn(
      async (fn: (transaction: typeof prisma) => Promise<unknown>) =>
        fn(prisma),
    );
    const service = new InboundWebhookDiagnosticsService(prisma as never);

    await service.recordObservation({
      workspaceId: "workspace_1",
      deliveryId: "delivery_1",
      connectionId: "connection_data_crazy_1",
      provider: "data_crazy",
      eventType: "message.received",
      parserVersion: "v1",
      classification: "eligible_route_unresolved",
      routeStatus: "unresolved",
      processingStatus: "processed",
      eventCount: 1,
      errorCode: null,
      events: [
        {
          channelId: "instance_fixture_1",
          connectedPhoneSuffix: null,
          adId: "ad_fixture_1",
          hasCtwa: true,
          classification: "eligible_route_unresolved",
          routeStatus: "unresolved",
        },
      ],
    });

    expect(webhookLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ source: "data_crazy" }),
      }),
    );
    expect(diagnosticEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ source: "data_crazy" }),
      }),
    );
  });
});
