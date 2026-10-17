import { ConflictException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { LeadStatusService } from "../src/leads/lead-status.service";

type Lead = {
  id: string;
  workspaceId: string;
  phoneHash: string;
  campaignId: string | null;
  adSetId: string | null;
  adId: string | null;
  ctwaClid: string | null;
  status?: string;
};

function createHarness(
  lead: Partial<Lead> = {},
  existingLogs: Array<{ leadId: string; eventName: string }> = [],
) {
  const leads: Lead[] = [
    {
      id: "lead_1",
      workspaceId: "workspace_1",
      phoneHash: "phone_hash_1",
      campaignId: "cmp_1",
      adSetId: "adset_1",
      adId: "ad_1",
      ctwaClid: "ctwa_1",
      ...lead,
    },
  ];
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    lead: {
      findFirst: vi.fn(async ({ where }) =>
        leads.find(
          (item) => item.id === where.id && item.workspaceId === where.workspaceId,
        ) ?? null,
      ),
      update: vi.fn(async ({ data }) => {
        updates.push(data);
        return {};
      }),
    },
    conversionEventLog: {
      findFirst: vi.fn(async ({ where }) =>
        existingLogs.find(
          (log) =>
            log.leadId === where.leadId &&
            where.eventName.in.includes(log.eventName),
        ) ?? null,
      ),
      findUnique: vi.fn(async () => ({ errorCode: "MissingAdId" })),
    },
  };
  const conversionEvents = {
    recordManualStatusConversion: vi.fn(async () => ({
      created: ["log_1"],
      duplicates: [] as string[],
    })),
    listReadyLogIds: vi.fn(async (ids: string[]) => ids),
  };
  const queue = { enqueueSend: vi.fn(async () => ({ queued: true })) };
  const service = new LeadStatusService(
    prisma as never,
    conversionEvents as never,
    queue as never,
  );

  return { service, prisma, conversionEvents, queue, updates };
}

const input = {
  workspaceId: "workspace_1",
  leadId: "lead_1",
  actorUserId: "user_1",
} as const;

describe("LeadStatusService", () => {
  it("qualifying records QualifiedLead and queues it for Meta", async () => {
    const h = createHarness();

    const result = await h.service.updateStatus({ ...input, status: "qualified" });

    expect(h.updates[0]).toMatchObject({
      status: "qualified",
      statusChangedByUserId: "user_1",
    });
    expect(h.conversionEvents.recordManualStatusConversion).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_1",
        leadId: "lead_1",
        eventName: "QualifiedLead",
        adId: "ad_1",
        ctwaClid: "ctwa_1",
      }),
    );
    expect(h.queue.enqueueSend).toHaveBeenCalledWith("log_1", "workspace_1");
    expect(result.metaSend).toMatchObject({
      outcome: "queued",
      eventName: "QualifiedLead",
    });
  });

  it("re-qualifying never queues a second event", async () => {
    const h = createHarness();
    h.conversionEvents.recordManualStatusConversion.mockResolvedValueOnce({
      created: [],
      duplicates: ["log_1"],
    });

    const result = await h.service.updateStatus({ ...input, status: "qualified" });

    expect(h.queue.enqueueSend).not.toHaveBeenCalled();
    expect(result.metaSend.outcome).toBe("already_recorded");
  });

  it("reports why Meta cannot receive a lead without ad context", async () => {
    const h = createHarness({ adId: null });
    h.conversionEvents.listReadyLogIds.mockResolvedValueOnce([]);

    const result = await h.service.updateStatus({ ...input, status: "qualified" });

    expect(h.queue.enqueueSend).not.toHaveBeenCalled();
    expect(result.metaSend).toMatchObject({
      outcome: "not_eligible",
      errorCode: "MissingAdId",
    });
  });

  it("other statuses only update the lead", async () => {
    const h = createHarness();

    const result = await h.service.updateStatus({ ...input, status: "active" });

    expect(h.conversionEvents.recordManualStatusConversion).not.toHaveBeenCalled();
    expect(result.metaSend.outcome).toBe("not_applicable");
  });

  it("refuses going back once a qualification event exists", async () => {
    const h = createHarness({}, [{ leadId: "lead_1", eventName: "QualifiedLead" }]);

    await expect(
      h.service.updateStatus({ ...input, status: "lost" }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.prisma.lead.update).not.toHaveBeenCalled();
  });

  it("scopes the lead to the current workspace", async () => {
    const h = createHarness({ workspaceId: "workspace_2" });

    await expect(
      h.service.updateStatus({ ...input, status: "qualified" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
