import {
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { WhatsappConnectionsService } from "../../src/integrations/whatsapp-providers/whatsapp-connections.service";

/**
 * Fase 6.3b (porte do SaaS #125, adaptado): atividade por conexão no módulo
 * de conexões do nod. Uazapi BYO e WAHA (URL do servidor + token, um número
 * por conexão); sem schemas/billing.
 */
const now = new Date("2026-07-10T12:00:00.000Z");

function connection(provider: "uazapi_byo" | "waha" | "zapi" = "uazapi_byo") {
  return {
    id: "connection_1",
    workspaceId: "workspace_1",
    name: "Vendas",
    displayName: null,
    provider,
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
  };
}

function createPrisma() {
  return {
    whatsappInstance: { findFirst: vi.fn(async () => connection()) },
    lead: {
      count: vi.fn(),
      findFirst: vi.fn(),
    },
    webhookLog: { findFirst: vi.fn() },
  };
}

function serviceFor(prisma: ReturnType<typeof createPrisma>) {
  return new WhatsappConnectionsService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {},
  );
}

const activityError = new InternalServerErrorException(
  "Não foi possível consultar a atividade desta conexão WhatsApp",
);

describe("WhatsappConnectionsService activity (6.3b)", () => {
  it("counts only the connection's CTWA leads within exact effective-time windows", async () => {
    const prisma = createPrisma();
    prisma.lead.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(9);
    prisma.lead.findFirst
      .mockResolvedValueOnce({
        firstMessageAt: new Date("2026-07-09T12:00:00.000Z"),
      })
      .mockResolvedValueOnce({ createdAt: new Date("2026-07-10T11:00:00.000Z") });
    prisma.webhookLog.findFirst.mockResolvedValue({
      receivedAt: new Date("2026-07-10T10:00:00.000Z"),
    });

    await expect(
      serviceFor(prisma).getActivity("workspace_1", "connection_1", now),
    ).resolves.toEqual({
      leads24h: 2,
      leads7d: 4,
      leadsTotal: 9,
      lastLeadAt: "2026-07-10T11:00:00.000Z",
      lastWebhookAt: "2026-07-10T10:00:00.000Z",
    });

    expect(prisma.whatsappInstance.findFirst).toHaveBeenCalledWith({
      where: { id: "connection_1", workspaceId: "workspace_1" },
    });
    const leadScope = {
      workspaceId: "workspace_1",
      whatsappInstanceId: "connection_1",
      source: "uazapi",
      ctwaClid: { not: null },
    };
    const expectedWindow = (since: string) => ({
      ...leadScope,
      OR: [
        { firstMessageAt: { gte: new Date(since), lte: now } },
        {
          firstMessageAt: null,
          createdAt: { gte: new Date(since), lte: now },
        },
      ],
    });

    expect(prisma.lead.count).toHaveBeenNthCalledWith(1, {
      where: expectedWindow("2026-07-09T12:00:00.000Z"),
    });
    expect(prisma.lead.count).toHaveBeenNthCalledWith(2, {
      where: expectedWindow("2026-07-03T12:00:00.000Z"),
    });
    expect(prisma.lead.count).toHaveBeenNthCalledWith(3, {
      where: leadScope,
    });
    expect(prisma.lead.findFirst).toHaveBeenNthCalledWith(1, {
      where: { ...leadScope, firstMessageAt: { not: null } },
      orderBy: { firstMessageAt: "desc" },
      select: { firstMessageAt: true },
    });
    expect(prisma.lead.findFirst).toHaveBeenNthCalledWith(2, {
      where: { ...leadScope, firstMessageAt: null },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    expect(prisma.webhookLog.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_1",
        whatsappInstanceId: "connection_1",
        source: "uazapi",
      },
      orderBy: { receivedAt: "desc" },
      select: { receivedAt: true },
    });
  });

  it("reads a WAHA connection with the WAHA lead and webhook origin", async () => {
    const prisma = createPrisma();
    prisma.whatsappInstance.findFirst.mockResolvedValue(connection("waha"));
    prisma.lead.count.mockResolvedValue(1);
    prisma.lead.findFirst.mockResolvedValue(null);
    prisma.webhookLog.findFirst.mockResolvedValue(null);

    await expect(
      serviceFor(prisma).getActivity("workspace_1", "connection_1", now),
    ).resolves.toMatchObject({ leadsTotal: 1, lastWebhookAt: null });
    expect(prisma.lead.count).toHaveBeenLastCalledWith({
      where: expect.objectContaining({ source: "waha" }),
    });
    expect(prisma.webhookLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ source: "waha" }),
      }),
    );
  });

  it("keeps reading a removed (suspended) connection: its history stays", async () => {
    const prisma = createPrisma();
    prisma.whatsappInstance.findFirst.mockResolvedValue({
      ...connection(),
      status: "suspended",
    });
    prisma.lead.count.mockResolvedValue(3);
    prisma.lead.findFirst.mockResolvedValue(null);
    prisma.webhookLog.findFirst.mockResolvedValue(null);

    await expect(
      serviceFor(prisma).getActivity("workspace_1", "connection_1", now),
    ).resolves.toMatchObject({ leadsTotal: 3 });
  });

  it("returns zeroes and nullable dates when the connection has no data", async () => {
    const prisma = createPrisma();
    prisma.lead.count.mockResolvedValue(0);
    prisma.lead.findFirst.mockResolvedValue(null);
    prisma.webhookLog.findFirst.mockResolvedValue(null);

    await expect(
      serviceFor(prisma).getActivity("workspace_1", "connection_1", now),
    ).resolves.toEqual({
      leads24h: 0,
      leads7d: 0,
      leadsTotal: 0,
      lastLeadAt: null,
      lastWebhookAt: null,
    });
  });

  it("does not turn database failures into fabricated activity", async () => {
    const prisma = createPrisma();
    prisma.lead.count.mockRejectedValue(new Error("database connection details"));

    await expect(
      serviceFor(prisma).getActivity("workspace_1", "connection_1", now),
    ).rejects.toEqual(activityError);
  });

  it("maps ownership database failures to the same opaque activity error", async () => {
    const prisma = createPrisma();
    prisma.whatsappInstance.findFirst.mockRejectedValue(
      new Error("Prisma connection details"),
    );

    await expect(
      serviceFor(prisma).getActivity("workspace_1", "connection_1", now),
    ).rejects.toEqual(activityError);
    expect(prisma.lead.count).not.toHaveBeenCalled();
    expect(prisma.lead.findFirst).not.toHaveBeenCalled();
    expect(prisma.webhookLog.findFirst).not.toHaveBeenCalled();
  });

  it("rejects foreign connections and providers without activity before querying", async () => {
    const foreignPrisma = createPrisma();
    foreignPrisma.whatsappInstance.findFirst.mockResolvedValue(null as never);
    await expect(
      serviceFor(foreignPrisma).getActivity("workspace_1", "foreign", now),
    ).rejects.toEqual(new NotFoundException("Conexão WhatsApp não encontrada"));
    expect(foreignPrisma.lead.count).not.toHaveBeenCalled();

    const zapiPrisma = createPrisma();
    zapiPrisma.whatsappInstance.findFirst.mockResolvedValue(connection("zapi"));
    await expect(
      serviceFor(zapiPrisma).getActivity("workspace_1", "connection_1", now),
    ).rejects.toEqual(
      new ForbiddenException(
        "Atividade disponível apenas para conexões Uazapi e WAHA",
      ),
    );
    expect(zapiPrisma.lead.count).not.toHaveBeenCalled();
  });
});
