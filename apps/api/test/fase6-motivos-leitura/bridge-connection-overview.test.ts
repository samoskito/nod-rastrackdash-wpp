import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { InboundWebhookConnectionsService } from "../../src/inbound-webhooks/inbound-webhook-connections.service";

/**
 * Fase 6.1b — porte do #103 (`4787a8f3`) e do #105 (`e69a5e91`) do SaaS, com
 * a ponte WAHA: o resumo da conexão-ponte Uazapi/WAHA conta os leads CTWA da
 * instância e "Gerar nova URL" é recusado (409) sem trocar o segredo.
 * Dados fictícios.
 */

const now = new Date("2026-10-26T12:00:00.000Z");

function connection(provider: string) {
  return {
    id: `connection_${provider}`,
    workspaceId: "workspace_1",
    provider,
    displayName: `Ponte ${provider}`,
    parserReleaseId: `release_${provider}`,
    secretHash: "hash_original",
    status: "observation" as const,
    productionActivatedAt: null,
    lastDeliveryAt: null,
    lastSuccessfulParseAt: null,
    removedAt: null,
    createdAt: now,
    updatedAt: now,
    createdByUserId: "user_1",
    parserRelease: {
      id: `release_${provider}`,
      provider,
      version: provider === "waha" ? "v2" : "v1",
      status: "certified" as const,
      createdAt: now,
      updatedAt: now,
      certifiedAt: now,
      certifiedByUserId: null,
    },
  };
}

function fixture(provider: string) {
  const row = connection(provider);
  const prisma = {
    inboundWebhookConnection: {
      findFirst: vi.fn(async () => row),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    inboundWebhookChannel: {
      findFirst: vi.fn(async () => ({ whatsappInstanceId: "instance_1" })),
    },
    inboundWebhookEvent: { groupBy: vi.fn(async () => []) },
    inboundWebhookDelivery: { findMany: vi.fn(async () => []) },
    lead: { count: vi.fn(async () => 7) },
    webhookLog: {
      findFirst: vi.fn(async () => ({
        receivedAt: new Date("2026-10-26T11:00:00.000Z"),
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
  return { prisma, service, row };
}

describe("resumo da conexão-ponte (porte do #103, com WAHA)", () => {
  it.each(["uazapi", "waha"])(
    "%s: CTWA roteado = leads CTWA da instância; última entrega = último WebhookLog",
    async (provider) => {
      const { prisma, service } = fixture(provider);
      const overview = await service.getOverview(
        "workspace_1",
        `connection_${provider}`,
      );

      expect(overview.counters).toEqual({
        eligibleRouted: 7,
        eligibleUnresolved: 0,
        ignoredNoCtwa: 0,
        duplicate: 0,
        invalid: 0,
      });
      expect(overview.connection.lastDeliveryAt).toBe(
        "2026-10-26T11:00:00.000Z",
      );
      expect(prisma.lead.count).toHaveBeenCalledWith({
        where: {
          workspaceId: "workspace_1",
          whatsappInstanceId: "instance_1",
          source: provider,
          ctwaClid: { not: null },
        },
      });
      expect(prisma.inboundWebhookEvent.groupBy).not.toHaveBeenCalled();
    },
  );

  it("Meta Cloud e Umbler seguem lendo os eventos observados", async () => {
    const { prisma, service } = fixture("meta_cloud");
    await service.getOverview("workspace_1", "connection_meta_cloud");
    expect(prisma.inboundWebhookEvent.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.lead.count).not.toHaveBeenCalled();
  });
});

describe("“Gerar nova URL” na ponte (porte do #105, com WAHA)", () => {
  it.each(["uazapi", "waha"])(
    "%s: recusa com 409 e não troca o segredo",
    async (provider) => {
      const { prisma, service } = fixture(provider);
      await expect(
        service.rotateSecret("workspace_1", `connection_${provider}`, "user_1"),
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("Não gere URL aqui"),
      });
      expect(prisma.inboundWebhookConnection.updateMany).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    },
  );
});
