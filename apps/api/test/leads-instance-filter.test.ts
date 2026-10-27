// Fase 6.3b (porte do SaaS #125): filtro de Leads por número WhatsApp.
import { NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { LeadsService } from "../src/leads/leads.service";

function createPrisma() {
  return {
    whatsappInstance: {
      findFirst: vi.fn(),
    },
    lead: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    conversionEventLog: {
      findMany: vi.fn(async () => []),
    },
    metaAd: {
      findMany: vi.fn(async () => []),
    },
  };
}

describe("LeadsService instance filter", () => {
  it("scopes list and page queries to a workspace-owned WhatsApp instance", async () => {
    const prisma = createPrisma();
    prisma.whatsappInstance.findFirst.mockResolvedValue({ id: "instance_1" });
    const service = new LeadsService(prisma as never);

    await service.listLeads("workspace_1", { whatsappInstanceId: "instance_1" });
    await service.listLeadsPage("workspace_1", {
      whatsappInstanceId: "instance_1",
      page: 2,
      pageSize: 10,
    });

    expect(prisma.whatsappInstance.findFirst).toHaveBeenCalledWith({
      where: { id: "instance_1", workspaceId: "workspace_1" },
      select: { id: true },
    });
    expect(prisma.lead.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "workspace_1",
          whatsappInstanceId: "instance_1",
        }),
        skip: 10,
        take: 10,
      }),
    );
    expect(prisma.lead.count).toHaveBeenLastCalledWith({
      where: expect.objectContaining({
        workspaceId: "workspace_1",
        whatsappInstanceId: "instance_1",
      }),
    });
  });

  it("returns the stable instance 404 before an empty event filter can return", async () => {
    const prisma = createPrisma();
    prisma.whatsappInstance.findFirst.mockResolvedValue(null);
    const service = new LeadsService(prisma as never);

    await expect(
      service.listLeadsPage("workspace_1", {
        whatsappInstanceId: "foreign_instance",
        eventName: "Purchase",
      }),
    ).rejects.toEqual(new NotFoundException("Número WhatsApp não encontrado"));

    expect(prisma.conversionEventLog.findMany).not.toHaveBeenCalled();
    expect(prisma.lead.findMany).not.toHaveBeenCalled();
  });

  it("preserves the legacy unfiltered behavior when no instance is supplied", async () => {
    const prisma = createPrisma();
    const service = new LeadsService(prisma as never);

    await service.listLeadsPage("workspace_1", {});

    expect(prisma.whatsappInstance.findFirst).not.toHaveBeenCalled();
    expect(prisma.lead.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "workspace_1" },
      }),
    );
  });
});
