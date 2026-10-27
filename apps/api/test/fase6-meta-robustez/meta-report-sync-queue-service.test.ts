import { describe, expect, it, vi } from "vitest";
import { MetaReportSyncQueueService } from "../../src/reporting/meta-report-sync-queue.service";

describe("meta report sync queue service", () => {
  it("expands a manual workspace into account-scoped jobs", async () => {
    const queue = {
      add: vi.fn(
        async (_name: string, _data: unknown, options: { jobId: string }) => ({
          id: options.jobId,
        }),
      ),
    };
    const resolver = {
      listReportingSyncTargets: vi.fn(async () => [
        {
          workspaceId: "workspace_1",
          businessConnectionId: "connection_1",
          reportingAccountId: "reporting_1",
        },
        {
          workspaceId: "workspace_1",
          businessConnectionId: "connection_2",
          reportingAccountId: "reporting_2",
        },
      ]),
    };
    const service = new MetaReportSyncQueueService(
      queue as never,
      resolver as never,
    );

    const result = await service.enqueueWorkspaceSync({
      workspaceId: "workspace_1",
      since: "2026-07-01",
      until: "2026-07-02",
    });

    expect(result).toMatchObject({
      workspaceId: "workspace_1",
      status: "queued",
      jobs: [
        {
          businessConnectionId: "connection_1",
          reportingAccountId: "reporting_1",
        },
        {
          businessConnectionId: "connection_2",
          reportingAccountId: "reporting_2",
        },
      ],
    });
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it("propagates an enqueue failure instead of reporting the workspace sync as queued", async () => {
    const queue = {
      add: vi.fn(async () => {
        throw new Error("Redis indisponivel");
      }),
    };
    const resolver = {
      listReportingSyncTargets: vi.fn(async () => [
        {
          workspaceId: "workspace_1",
          businessConnectionId: "connection_1",
          reportingAccountId: "reporting_1",
        },
      ]),
    };
    const service = new MetaReportSyncQueueService(
      queue as never,
      resolver as never,
    );

    await expect(
      service.enqueueWorkspaceSync({
        workspaceId: "workspace_1",
        since: "2026-08-26",
        until: "2026-09-01",
      }),
    ).rejects.toThrow("Redis indisponivel");
  });

  it("collapses identical sync requests inside the dedupe window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T15:01:00.000Z"));

    try {
      const queue = {
        add: vi.fn(
          async (
            _name: string,
            _data: unknown,
            options: { jobId: string },
          ) => ({
            id: options.jobId,
          }),
        ),
      };
      const service = new MetaReportSyncQueueService(queue as never);
      const payload = {
        workspaceId: "workspace_1",
        businessConnectionId: null,
        reportingAccountId: null,
        since: "2026-07-01",
        until: "2026-07-02",
      };

      const first = await service.enqueueSync(payload);
      vi.setSystemTime(new Date("2026-07-09T15:14:00.000Z"));
      const second = await service.enqueueSync(payload);
      vi.setSystemTime(new Date("2026-07-09T15:16:00.000Z"));
      const nextWindow = await service.enqueueSync(payload);

      expect(first).toEqual({
        ...payload,
        jobId: expect.stringMatching(
          /^meta-report-sync_workspace_1_legacy_workspace_2026-07-01_2026-07-02_w\d+$/,
        ),
        status: "queued",
      });
      expect(first.jobId).not.toContain(":");
      // Same 15-minute window: BullMQ ignores the duplicate jobId.
      expect(second.jobId).toBe(first.jobId);
      expect(nextWindow.jobId).not.toBe(first.jobId);
      expect(queue.add).toHaveBeenNthCalledWith(
        1,
        "sync-meta-reporting",
        payload,
        expect.objectContaining({
          jobId: first.jobId,
          attempts: 3,
          removeOnComplete: { age: 900 },
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keys jobs by account and period so different imports still run", async () => {
    const queue = {
      add: vi.fn(
        async (_name: string, _data: unknown, options: { jobId: string }) => ({
          id: options.jobId,
        }),
      ),
    };
    const service = new MetaReportSyncQueueService(queue as never);
    const base = {
      workspaceId: "workspace_1",
      businessConnectionId: "connection_1",
      reportingAccountId: "reporting_1",
      since: "2026-07-03",
      until: "2026-07-09",
    };

    const weekly = await service.enqueueSync(base);
    const history = await service.enqueueSync({
      ...base,
      since: "2026-04-11",
    });
    const otherAccount = await service.enqueueSync({
      ...base,
      reportingAccountId: "reporting_2",
    });

    expect(
      new Set([weekly.jobId, history.jobId, otherAccount.jobId]).size,
    ).toBe(3);
  });
});

describe("meta report sync dedupe states", () => {
  const payload = {
    workspaceId: "workspace_1",
    businessConnectionId: "connection_1",
    reportingAccountId: "reporting_1",
    since: "2026-07-03",
    until: "2026-07-09",
  };

  function queueWith(state: string | null) {
    const existing = state
      ? {
          getState: vi.fn(async () => state),
          remove: vi.fn(async () => undefined),
        }
      : null;
    const queue = {
      getJob: vi.fn(async () => existing),
      add: vi.fn(
        async (_name: string, _data: unknown, options: { jobId: string }) => ({
          id: options.jobId,
        }),
      ),
    };

    return { queue, existing };
  }

  it("re-enqueues a manual sync after a failed job with the same id", async () => {
    const { queue, existing } = queueWith("failed");
    const service = new MetaReportSyncQueueService(queue as never);

    await expect(service.enqueueSync(payload, "manual")).resolves.toMatchObject(
      { status: "queued" },
    );
    expect(existing!.remove).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it("re-enqueues a manual sync after a completed job in the window", async () => {
    const { queue, existing } = queueWith("completed");
    const service = new MetaReportSyncQueueService(queue as never);

    await expect(service.enqueueSync(payload, "manual")).resolves.toMatchObject(
      { status: "queued" },
    );
    expect(existing!.remove).toHaveBeenCalled();
  });

  it("reports already_queued instead of queued while the same job is pending", async () => {
    for (const state of ["waiting", "delayed", "active"]) {
      const { queue, existing } = queueWith(state);
      const service = new MetaReportSyncQueueService(queue as never);

      await expect(
        service.enqueueSync(payload, "manual"),
      ).resolves.toMatchObject({ status: "already_queued" });
      expect(existing!.remove).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    }
  });

  it("reports recent for an automatic sweep after a finished job in the window", async () => {
    const { queue, existing } = queueWith("failed");
    const service = new MetaReportSyncQueueService(queue as never);

    await expect(service.enqueueSync(payload)).resolves.toMatchObject({
      status: "recent",
    });
    expect(existing!.remove).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("does not report queued for a workspace whose jobs were all deduped", async () => {
    const { queue } = queueWith("delayed");
    const resolver = {
      listReportingSyncTargets: vi.fn(async () => [
        { ...payload },
        { ...payload, reportingAccountId: "reporting_2" },
      ]),
    };
    const service = new MetaReportSyncQueueService(
      queue as never,
      resolver as never,
    );

    await expect(
      service.enqueueWorkspaceSync(
        {
          workspaceId: "workspace_1",
          since: payload.since,
          until: payload.until,
        },
        "manual",
      ),
    ).resolves.toMatchObject({ status: "already_queued" });
  });

  it("fails loudly when Redis is down instead of reporting a queued sync", async () => {
    const queue = {
      getJob: vi.fn(async () => {
        throw new Error("Connection is closed.");
      }),
      add: vi.fn(),
    };
    const service = new MetaReportSyncQueueService(queue as never);

    await expect(service.enqueueSync(payload, "manual")).rejects.toThrow(
      "Connection is closed.",
    );
    expect(queue.add).not.toHaveBeenCalled();
  });
});
