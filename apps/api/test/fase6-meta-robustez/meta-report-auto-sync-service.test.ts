import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaReportAutoSyncService } from "../../src/reporting/meta-report-auto-sync.service";

describe("meta report auto sync service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("enqueues connected active workspaces for the configured lookback window", async () => {
    vi.stubEnv("WPPTRACK_META_AUTO_SYNC_LOOKBACK_DAYS", "14");
    vi.stubEnv("WPPTRACK_META_AUTO_SYNC_BATCH_LIMIT", "50");
    const prisma = {
      workspace: {
        findMany: vi.fn(async () => [
          { id: "workspace_1" },
          { id: "workspace_2" },
        ]),
      },
    };
    const queueService = {
      enqueueWorkspaceSync: vi.fn(async (payload: unknown) => ({
        payload,
        status: "queued",
      })),
    };
    const service = new MetaReportAutoSyncService(
      prisma as never,
      queueService as never,
      {
        now: () => new Date("2026-07-09T15:30:00.000Z"),
      },
    );

    await expect(service.syncDueWorkspaces()).resolves.toEqual({
      enabled: true,
      workspacesFound: 2,
      enqueued: 2,
      failed: 0,
      since: "2026-06-26",
      until: "2026-07-09",
    });

    expect(prisma.workspace.findMany).toHaveBeenCalledWith({
      where: {
        operationalStatus: "active",
        OR: [
          {
            metaIntegration: { is: { status: "connected" } },
            metaReportingAccounts: {
              some: { active: true, reportingSyncBlockedAt: null },
            },
          },
          {
            metaBusinessConnections: {
              some: {
                status: "active",
                credential: { is: { status: "active" } },
                reportingAccounts: {
                  some: { active: true, reportingSyncBlockedAt: null },
                },
              },
            },
          },
        ],
      },
      select: {
        id: true,
      },
      orderBy: { id: "asc" },
      take: 50,
    });
    expect(queueService.enqueueWorkspaceSync).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      since: "2026-06-26",
      until: "2026-07-09",
    });
    expect(queueService.enqueueWorkspaceSync).toHaveBeenCalledWith({
      workspaceId: "workspace_2",
      since: "2026-06-26",
      until: "2026-07-09",
    });
  });

  it("does not enqueue when automatic sync is disabled", async () => {
    vi.stubEnv("WPPTRACK_META_AUTO_SYNC_ENABLED", "false");
    const prisma = {
      workspace: {
        findMany: vi.fn(),
      },
    };
    const queueService = {
      enqueueWorkspaceSync: vi.fn(),
    };
    const service = new MetaReportAutoSyncService(
      prisma as never,
      queueService as never,
      {
        now: () => new Date("2026-07-09T15:30:00.000Z"),
      },
    );

    await expect(service.syncDueWorkspaces()).resolves.toEqual({
      enabled: false,
      workspacesFound: 0,
      enqueued: 0,
      failed: 0,
      since: null,
      until: null,
    });

    expect(prisma.workspace.findMany).not.toHaveBeenCalled();
    expect(queueService.enqueueWorkspaceSync).not.toHaveBeenCalled();
  });

  it("continues enqueueing other workspaces when one workspace fails", async () => {
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    const secret = "synthetic-secret-meta-token";
    const prisma = {
      workspace: {
        findMany: vi.fn(async () => [
          { id: "workspace_1" },
          { id: "workspace_2" },
        ]),
      },
    };
    const queueService = {
      enqueueWorkspaceSync: vi
        .fn()
        .mockRejectedValueOnce(new Error(`Redis unavailable: ${secret}`))
        .mockResolvedValueOnce({ status: "queued" }),
    };
    const service = new MetaReportAutoSyncService(
      prisma as never,
      queueService as never,
      {
        now: () => new Date("2026-07-09T15:30:00.000Z"),
      },
    );

    const result = await service.syncDueWorkspaces();

    expect(result).toMatchObject({
      enabled: true,
      workspacesFound: 2,
      enqueued: 1,
      failed: 1,
      since: "2026-07-03",
      until: "2026-07-09",
    });
    expect(result).not.toHaveProperty("error");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(warn).toHaveBeenCalledWith("META_REPORT_AUTO_SYNC_ENQUEUE_FAILED");
    expect(warn.mock.calls.flat().join(" ")).not.toContain(secret);
  });

  it("uses a safe diagnostic when bootstrap sync fails", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WPPTRACK_META_AUTO_SYNC_ENABLED", "true");
    // nod: the first run waits at least 10 min (values below are ignored).
    vi.stubEnv("WPPTRACK_META_AUTO_SYNC_INITIAL_DELAY_SECONDS", "600");
    vi.stubEnv("WPPTRACK_META_AUTO_SYNC_INTERVAL_MINUTES", "999");
    vi.spyOn(Math, "random").mockReturnValue(0);
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    const secret = "synthetic-secret-bootstrap-token";
    const prisma = {
      workspace: {
        findMany: vi.fn(async () => {
          throw new Error(`connection failed: ${secret}`);
        }),
      },
    };
    const service = new MetaReportAutoSyncService(
      prisma as never,
      { enqueueWorkspaceSync: vi.fn() } as never,
    );

    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(600_000);
    service.onModuleDestroy();

    expect(warn).toHaveBeenCalledWith("META_REPORT_AUTO_SYNC_BOOTSTRAP_FAILED");
    expect(warn.mock.calls.flat().join(" ")).not.toContain(secret);
  });
  it("visits every eligible workspace with stable keyset pagination", async () => {
    vi.stubEnv("WPPTRACK_META_AUTO_SYNC_BATCH_LIMIT", "2");
    const pages = [
      [{ id: "workspace_a" }, { id: "workspace_b" }],
      [{ id: "workspace_c" }, { id: "workspace_d" }],
      [{ id: "workspace_e" }],
    ];
    const prisma = {
      workspace: {
        findMany: vi.fn(async () => pages.shift() ?? []),
      },
    };
    const queueService = {
      enqueueWorkspaceSync: vi.fn(async () => ({ status: "queued" })),
    };
    const service = new MetaReportAutoSyncService(
      prisma as never,
      queueService as never,
      { now: () => new Date("2026-07-09T15:30:00.000Z") },
    );

    await expect(service.syncDueWorkspaces()).resolves.toMatchObject({
      workspacesFound: 5,
      enqueued: 5,
    });
    expect(prisma.workspace.findMany).toHaveBeenCalledTimes(3);
    const secondCall = (
      prisma.workspace.findMany.mock.calls as unknown as Array<
        [{ where: { AND?: unknown[] }; orderBy: unknown; take: number }]
      >
    )[1][0];
    expect(secondCall.orderBy).toEqual({ id: "asc" });
    expect(secondCall.take).toBe(2);
    expect(secondCall.where.AND?.[1]).toEqual({ id: { gt: "workspace_b" } });
  });

  it("runs once per interval across replicas using the shared lock", async () => {
    const prisma = {
      workspace: {
        findMany: vi.fn(async () => [{ id: "workspace_1" }]),
      },
    };
    const queueService = {
      enqueueWorkspaceSync: vi.fn(async () => ({ status: "queued" })),
    };
    const throttle = {
      deferralFor: vi.fn(async () => null),
      acquireAutoSyncLock: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(null),
    };
    const service = new MetaReportAutoSyncService(
      prisma as never,
      queueService as never,
      { now: () => new Date("2026-07-09T15:30:00.000Z") },
      throttle as never,
    );
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

    await expect(service.syncDueWorkspaces()).resolves.toMatchObject({
      enqueued: 1,
    });
    await expect(service.syncDueWorkspaces()).resolves.toMatchObject({
      enqueued: 0,
      skipped: "locked",
    });
    await expect(service.syncDueWorkspaces()).resolves.toMatchObject({
      enqueued: 0,
      skipped: "lock_unavailable",
    });
    expect(throttle.acquireAutoSyncLock).toHaveBeenCalledWith(
      180 * 60_000 - 60_000,
    );
    expect(queueService.enqueueWorkspaceSync).toHaveBeenCalledTimes(1);
  });

  it("skips the sweep while the Meta app usage is above the pause threshold", async () => {
    const prisma = { workspace: { findMany: vi.fn() } };
    const queueService = { enqueueWorkspaceSync: vi.fn() };
    const throttle = {
      deferralFor: vi.fn(async () => ({
        untilMs: Date.now() + 60_000,
        reason: "app_usage",
        percent: 92,
      })),
      acquireAutoSyncLock: vi.fn(),
    };
    const service = new MetaReportAutoSyncService(
      prisma as never,
      queueService as never,
      { now: () => new Date("2026-07-09T15:30:00.000Z") },
      throttle as never,
    );

    await expect(service.syncDueWorkspaces()).resolves.toMatchObject({
      skipped: "rate_limited",
    });
    expect(throttle.acquireAutoSyncLock).not.toHaveBeenCalled();
    expect(prisma.workspace.findMany).not.toHaveBeenCalled();
  });

  // nod: random 10-30 min first run (resolveMetaAutoSyncInitialDelayMs)
  // instead of the SaaS 60 s + up to 30 min jitter.
  it("does not sweep immediately on boot; the first run is randomly spread", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WPPTRACK_META_AUTO_SYNC_ENABLED", "true");
    vi.stubEnv("WPPTRACK_META_AUTO_SYNC_INITIAL_DELAY_SECONDS", "60");
    vi.stubEnv("WPPTRACK_META_AUTO_SYNC_INTERVAL_MINUTES", "180");
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const prisma = {
      workspace: { findMany: vi.fn(async () => []) },
    };
    const service = new MetaReportAutoSyncService(
      prisma as never,
      { enqueueWorkspaceSync: vi.fn() } as never,
    );

    try {
      service.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(19 * 60_000);
      expect(prisma.workspace.findMany).not.toHaveBeenCalled();
      // The old 60 s is ignored: 10 min + 50% of the 20 min span = 20 min.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(prisma.workspace.findMany).toHaveBeenCalledTimes(1);
    } finally {
      service.onModuleDestroy();
      vi.useRealTimers();
    }
  });
});

describe("meta report auto sync incremental window", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("chooses the full lookback until a full sweep ran for the report date", () => {
    const base = {
      lookbackSince: "2026-07-03",
      until: "2026-07-09",
      incrementalDays: 3,
      lookbackDays: 7,
    };

    expect(
      MetaReportAutoSyncService.chooseWindow({ ...base, lastFullDate: null }),
    ).toEqual({ mode: "full", since: "2026-07-03" });
    expect(
      MetaReportAutoSyncService.chooseWindow({
        ...base,
        lastFullDate: "2026-07-08",
      }),
    ).toEqual({ mode: "full", since: "2026-07-03" });
    expect(
      MetaReportAutoSyncService.chooseWindow({
        ...base,
        lastFullDate: "2026-07-09",
      }),
    ).toEqual({ mode: "incremental", since: "2026-07-07" });
    expect(
      MetaReportAutoSyncService.chooseWindow({
        ...base,
        incrementalDays: 0,
        lastFullDate: "2026-07-09",
      }),
    ).toEqual({ mode: "full", since: "2026-07-03" });
    expect(
      MetaReportAutoSyncService.chooseWindow({
        ...base,
        incrementalDays: 7,
        lastFullDate: "2026-07-09",
      }),
    ).toEqual({ mode: "full", since: "2026-07-03" });
  });

  function sweep(lastFullDate: string | null) {
    const prisma = {
      workspace: {
        findMany: vi.fn(async () => [{ id: "workspace_1" }]),
      },
    };
    const queueService = {
      enqueueWorkspaceSync: vi.fn(async () => ({ status: "queued" })),
    };
    const throttle = {
      deferralFor: vi.fn(async () => null),
      acquireAutoSyncLock: vi.fn(async () => true),
      readAutoSyncFullDate: vi.fn(async () => lastFullDate),
      markAutoSyncFullDate: vi.fn(async () => undefined),
    };
    const service = new MetaReportAutoSyncService(
      prisma as never,
      queueService as never,
      { now: () => new Date("2026-07-09T15:30:00.000Z") },
      throttle as never,
    );

    return { queueService, service, throttle };
  }

  it("runs the first sweep of the day over the full lookback and marks it", async () => {
    const { queueService, service, throttle } = sweep("2026-07-08");

    await expect(service.syncDueWorkspaces()).resolves.toMatchObject({
      enqueued: 1,
      since: "2026-07-03",
      until: "2026-07-09",
    });
    expect(queueService.enqueueWorkspaceSync).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      since: "2026-07-03",
      until: "2026-07-09",
    });
    expect(throttle.markAutoSyncFullDate).toHaveBeenCalledWith("2026-07-09");
  });

  it("refreshes only the last 3 days on later sweeps of the same day", async () => {
    const { queueService, service, throttle } = sweep("2026-07-09");

    await expect(service.syncDueWorkspaces()).resolves.toMatchObject({
      enqueued: 1,
      since: "2026-07-07",
      until: "2026-07-09",
      window: "incremental",
      totalsSince: "2026-07-03",
    });
    expect(queueService.enqueueWorkspaceSync).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      since: "2026-07-07",
      until: "2026-07-09",
      totalsSince: "2026-07-03",
    });
    expect(throttle.markAutoSyncFullDate).not.toHaveBeenCalled();
  });

  it("keeps every sweep full when incremental sync is disabled", async () => {
    vi.stubEnv("WPPTRACK_META_AUTO_SYNC_INCREMENTAL_DAYS", "0");
    const { queueService, service } = sweep("2026-07-09");

    await service.syncDueWorkspaces();

    expect(queueService.enqueueWorkspaceSync).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      since: "2026-07-03",
      until: "2026-07-09",
    });
  });

  it.each([
    ["2026-10-21T01:30:00.000Z", "2026-10-14", "2026-10-20"],
    ["2026-10-21T15:00:00.000Z", "2026-10-15", "2026-10-21"],
  ])(
    "resolves the report day in America/Sao_Paulo at %s",
    async (now, since, until) => {
      vi.stubEnv("WPPTRACK_META_AUTO_SYNC_INCREMENTAL_DAYS", "0");
      const prisma = { workspace: { findMany: vi.fn(async () => []) } };
      const queueService = { enqueueWorkspaceSync: vi.fn() };
      const service = new MetaReportAutoSyncService(
        prisma as never,
        queueService as never,
        { now: () => new Date(now) },
      );

      await expect(service.syncDueWorkspaces()).resolves.toMatchObject({
        since,
        until,
      });
    },
  );
});
