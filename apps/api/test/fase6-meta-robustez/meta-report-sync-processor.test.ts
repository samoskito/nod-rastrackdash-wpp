import { ConflictException } from "@nestjs/common";
import { DelayedError, UnrecoverableError } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import {
  MetaCredentialInvalidError,
  metaGraphErrorFromPayload,
} from "../../src/integrations/meta/meta-graph-error";
import { MetaReportSyncProcessor } from "../../src/reporting/meta-report-sync.processor";

function createPrismaHarness() {
  return {
    jobAttempt: {
      create: vi.fn(async ({ data }) => ({ id: "job_attempt_1", ...data })),
    },
  };
}

describe("meta report sync processor", () => {
  it("runs Meta reporting sync and records the worker attempt", async () => {
    const metaReportingService = {
      syncWorkspaceMetaStructure: vi.fn(async () => ({
        workspaceId: "workspace_1",
        accountsSynced: 1,
        accountsFailed: 0,
        campaignsSynced: 1,
        adSetsSynced: 1,
        adsSynced: 1,
      })),
    };
    const prisma = createPrismaHarness();
    const processor = new MetaReportSyncProcessor(
      metaReportingService as never,
      prisma as never,
    );

    await expect(
      processor.process({
        id: "bull_job_1",
        name: "sync-meta-reporting",
        attemptsMade: 0,
        data: {
          workspaceId: "workspace_1",
          businessConnectionId: null,
          reportingAccountId: null,
          since: "2026-07-01",
          until: "2026-07-02",
        },
      } as never),
    ).resolves.toEqual({
      workspaceId: "workspace_1",
      accountsSynced: 1,
      accountsFailed: 0,
      campaignsSynced: 1,
      adSetsSynced: 1,
      adsSynced: 1,
    });

    expect(
      metaReportingService.syncWorkspaceMetaStructure,
    ).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      businessConnectionId: null,
      reportingAccountId: null,
      since: "2026-07-01",
      until: "2026-07-02",
    });
    expect(prisma.jobAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace_1",
        queueName: "meta-report-sync",
        jobId: "bull_job_1",
        jobName: "sync-meta-reporting",
        attemptNumber: 1,
        status: "completed",
        source: "meta",
        relatedEntityType: "Workspace",
        relatedEntityId: "workspace_1",
        errorCode: null,
        errorMessage: null,
        summaryPayload: expect.objectContaining({
          workspaceId: "workspace_1",
          accountsSynced: 1,
          accountsFailed: 0,
          campaignsSynced: 1,
          adSetsSynced: 1,
          adsSynced: 1,
          resultStatus: "completed",
        }),
      }),
    });
  });

  it("does not fail a completed Meta sync when attempt logging fails", async () => {
    const metaReportingService = {
      syncWorkspaceMetaStructure: vi.fn(async () => ({
        workspaceId: "workspace_1",
        accountsSynced: 1,
        accountsFailed: 0,
        campaignsSynced: 1,
        adSetsSynced: 1,
        adsSynced: 1,
      })),
    };
    const prisma = {
      jobAttempt: {
        create: vi.fn(async () => {
          throw new Error("database unavailable");
        }),
      },
    };
    const processor = new MetaReportSyncProcessor(
      metaReportingService as never,
      prisma as never,
    );

    await expect(
      processor.process({
        id: "bull_job_1",
        name: "sync-meta-reporting",
        attemptsMade: 0,
        data: {
          workspaceId: "workspace_1",
          businessConnectionId: null,
          reportingAccountId: null,
          since: "2026-07-01",
          until: "2026-07-02",
        },
      } as never),
    ).resolves.toEqual({
      workspaceId: "workspace_1",
      accountsSynced: 1,
      accountsFailed: 0,
      campaignsSynced: 1,
      adSetsSynced: 1,
      adsSynced: 1,
    });

    expect(
      metaReportingService.syncWorkspaceMetaStructure,
    ).toHaveBeenCalledTimes(1);
    expect(prisma.jobAttempt.create).toHaveBeenCalledTimes(1);
  });

  it("records failed Meta sync attempts and rethrows the error", async () => {
    const metaReportingService = {
      syncWorkspaceMetaStructure: vi.fn(async () => {
        throw new Error("Meta insights timeout");
      }),
    };
    const prisma = createPrismaHarness();
    const processor = new MetaReportSyncProcessor(
      metaReportingService as never,
      prisma as never,
    );

    await expect(
      processor.process({
        id: "bull_job_2",
        name: "sync-meta-reporting",
        attemptsMade: 1,
        data: {
          workspaceId: "workspace_1",
          businessConnectionId: null,
          reportingAccountId: null,
          since: "2026-07-01",
          until: "2026-07-02",
        },
      } as never),
    ).rejects.toThrow("Meta insights timeout");

    expect(prisma.jobAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace_1",
        queueName: "meta-report-sync",
        jobId: "bull_job_2",
        jobName: "sync-meta-reporting",
        attemptNumber: 2,
        status: "failed",
        source: "meta",
        relatedEntityType: "Workspace",
        relatedEntityId: "workspace_1",
        errorCode: null,
        errorMessage: "Meta insights timeout",
        summaryPayload: expect.objectContaining({
          workspaceId: "workspace_1",
          since: "2026-07-01",
          until: "2026-07-02",
        }),
      }),
    });
  });

  it("forwards the exact manual connection and account IDs to reporting", async () => {
    const metaReportingService = {
      syncWorkspaceMetaStructure: vi.fn(async () => ({
        workspaceId: "workspace_1",
        accountsSynced: 1,
        accountsFailed: 0,
        campaignsSynced: 1,
        adSetsSynced: 1,
        adsSynced: 1,
      })),
    };
    const prisma = createPrismaHarness();
    const processor = new MetaReportSyncProcessor(
      metaReportingService as never,
      prisma as never,
    );

    await processor.process({
      id: "bull_job_manual_1",
      name: "sync-meta-reporting",
      attemptsMade: 0,
      data: {
        workspaceId: "workspace_1",
        businessConnectionId: "connection_1",
        reportingAccountId: "reporting_1",
        since: "2026-07-01",
        until: "2026-07-02",
      },
    } as never);

    expect(
      metaReportingService.syncWorkspaceMetaStructure,
    ).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      businessConnectionId: "connection_1",
      reportingAccountId: "reporting_1",
      since: "2026-07-01",
      until: "2026-07-02",
    });
    expect(prisma.jobAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        summaryPayload: expect.objectContaining({
          businessConnectionId: "connection_1",
          reportingAccountId: "reporting_1",
        }),
      }),
    });
  });
});

describe("meta report sync processor rate limits and dead credentials", () => {
  const jobData = {
    workspaceId: "workspace_1",
    businessConnectionId: "connection_1",
    reportingAccountId: "reporting_1",
    since: "2026-07-01",
    until: "2026-07-07",
  };

  function createJob(data: Record<string, unknown> = jobData) {
    const job = {
      id: "bull_job_rl",
      name: "sync-meta-reporting",
      attemptsMade: 0,
      data: { ...data },
      updateData: vi.fn(async (next: Record<string, unknown>) => {
        job.data = next as typeof job.data;
      }),
      moveToDelayed: vi.fn(async () => undefined),
    };

    return job;
  }

  function createPrisma() {
    return {
      ...createPrismaHarness(),
      metaReportingAccount: {
        findMany: vi.fn(async () => [{ adAccountId: "act_1" }]),
      },
    };
  }

  it("delays the job without calling Meta while usage is above the threshold", async () => {
    const metaReportingService = { syncWorkspaceMetaStructure: vi.fn() };
    const throttle = {
      deferralFor: vi.fn(async () => ({
        untilMs: 1_900_000_000_000,
        reason: "app_usage",
        percent: 91,
      })),
      recordRateLimitError: vi.fn(),
      backoffMs: vi.fn(() => 300_000),
    };
    const prisma = createPrisma();
    const processor = new MetaReportSyncProcessor(
      metaReportingService as never,
      prisma as never,
      throttle as never,
    );
    const job = createJob();

    await expect(
      processor.process(job as never, "worker-token"),
    ).rejects.toBeInstanceOf(DelayedError);

    expect(
      metaReportingService.syncWorkspaceMetaStructure,
    ).not.toHaveBeenCalled();
    expect(throttle.deferralFor).toHaveBeenCalledWith(["act_1"], 0);
    expect(job.moveToDelayed).toHaveBeenCalledWith(
      1_900_000_000_000,
      "worker-token",
    );
    expect(job.data).toMatchObject({ deferrals: 1 });
    expect(prisma.jobAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "deferred" }),
    });
  });

  it("turns a Meta throttle response into a delayed job instead of a retry", async () => {
    const throttleError = metaGraphErrorFromPayload(
      { error: { message: "Application request limit reached", code: 4 } },
      400,
      "Meta Graph HTTP 400",
    );
    const metaReportingService = {
      syncWorkspaceMetaStructure: vi.fn(async () => {
        throw throttleError;
      }),
    };
    const throttle = {
      deferralFor: vi.fn(async () => null),
      recordRateLimitError: vi.fn(async () => undefined),
      backoffMs: vi.fn(() => 600_000),
    };
    const processor = new MetaReportSyncProcessor(
      metaReportingService as never,
      createPrisma() as never,
      throttle as never,
    );
    const job = createJob({ ...jobData, deferrals: 2 });

    await expect(
      processor.process(job as never, "worker-token"),
    ).rejects.toBeInstanceOf(DelayedError);

    expect(throttle.recordRateLimitError).toHaveBeenCalledWith(
      throttleError,
      ["act_1"],
      2,
    );
    expect(throttle.backoffMs).toHaveBeenCalledWith(2);
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    expect(job.data).toMatchObject({ deferrals: 3 });
  });

  it("stops deferring after the configured limit and completes as skipped", async () => {
    vi.stubEnv("WPPTRACK_META_SYNC_MAX_DEFERRALS", "2");

    try {
      const throttle = {
        deferralFor: vi.fn(async () => ({
          untilMs: Date.now() + 60_000,
          reason: "account_usage",
          percent: 100,
        })),
        recordRateLimitError: vi.fn(),
        backoffMs: vi.fn(() => 300_000),
      };
      const prisma = createPrisma();
      const processor = new MetaReportSyncProcessor(
        { syncWorkspaceMetaStructure: vi.fn() } as never,
        prisma as never,
        throttle as never,
      );
      const job = createJob({ ...jobData, deferrals: 2 });

      await expect(
        processor.process(job as never, "worker-token"),
      ).resolves.toEqual({ skipped: true, reason: "account_usage" });
      expect(job.moveToDelayed).not.toHaveBeenCalled();
      expect(prisma.jobAttempt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ status: "skipped" }),
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not let BullMQ retry a parked credential", async () => {
    const metaReportingService = {
      syncWorkspaceMetaStructure: vi.fn(async () => {
        throw new MetaCredentialInvalidError(
          "Reconecte a conta Meta",
          "meta_graph code=190 subcode=460 http=400",
        );
      }),
    };
    const prisma = createPrisma();
    const processor = new MetaReportSyncProcessor(
      metaReportingService as never,
      prisma as never,
    );

    await expect(
      processor.process(createJob() as never, "worker-token"),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(prisma.jobAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "failed",
        errorCode: "meta_graph code=190 subcode=460 http=400",
      }),
    });
  });

  it("does not retry deterministic routing errors such as a paused connection", async () => {
    const processor = new MetaReportSyncProcessor(
      {
        syncWorkspaceMetaStructure: vi.fn(async () => {
          throw new ConflictException(
            "O token desta conexao Meta esta pausado ou requer validacao",
          );
        }),
      } as never,
      createPrisma() as never,
    );

    await expect(
      processor.process(createJob() as never, "worker-token"),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("keeps normal retries for transient Meta failures", async () => {
    const transient = metaGraphErrorFromPayload(
      { error: { message: "An unexpected error has occurred", code: 2 } },
      500,
      "Meta Graph HTTP 500",
    );
    const processor = new MetaReportSyncProcessor(
      {
        syncWorkspaceMetaStructure: vi.fn(async () => {
          throw transient;
        }),
      } as never,
      createPrisma() as never,
    );

    const failure = await processor
      .process(createJob() as never, "worker-token")
      .catch((error: unknown) => error);

    expect(failure).toBe(transient);
    expect(failure).not.toBeInstanceOf(UnrecoverableError);
  });
});
