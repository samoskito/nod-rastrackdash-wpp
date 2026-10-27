import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaReportAutoSyncService } from "../../src/reporting/meta-report-auto-sync.service";
import { MetaReportSyncQueueService } from "../../src/reporting/meta-report-sync-queue.service";

// Fase 6.3a: ported from the SaaS meta-report-auto-sync-service suite (#83:
// fixed diagnostic codes, never the error text; #157: the report day is
// resolved in America/Sao_Paulo). The nod has no incremental window (6.4),
// so the #157 case runs on the lookback window.

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("meta report auto sync: safe diagnostics", () => {
  it("continues enqueueing other workspaces when one workspace fails", async () => {
    vi.stubEnv("WPPTRACK_META_AUTO_SYNC_ENABLED", "true");
    vi.stubEnv("WPPTRACK_META_AUTO_SYNC_LOOKBACK_DAYS", "7");
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    const secret = "synthetic-secret-meta-token";
    const prisma = {
      workspace: {
        findMany: vi.fn(async () => [{ id: "workspace_1" }, { id: "workspace_2" }]),
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
      { now: () => new Date("2026-07-09T15:00:00.000Z") },
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
    expect(warn.mock.calls.flat().join(" ")).not.toContain("workspace_1");
  });

  it("uses a safe diagnostic when bootstrap sync fails", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WPPTRACK_META_AUTO_SYNC_ENABLED", "true");
    // nod: the first run never happens before 10 minutes (max 30).
    vi.stubEnv("WPPTRACK_META_AUTO_SYNC_INITIAL_DELAY_SECONDS", "600");
    vi.stubEnv("WPPTRACK_META_AUTO_SYNC_INTERVAL_MINUTES", "999");
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
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

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(600_000);
    service.onModuleDestroy();

    expect(prisma.workspace.findMany).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("META_REPORT_AUTO_SYNC_BOOTSTRAP_FAILED");
    expect(warn.mock.calls.flat().join(" ")).not.toContain(secret);
  });

  it.each([
    ["2026-10-21T01:30:00.000Z", "2026-10-14", "2026-10-20"],
    ["2026-10-21T15:00:00.000Z", "2026-10-15", "2026-10-21"],
  ])(
    "resolves the report day in America/Sao_Paulo at %s",
    async (now, since, until) => {
      vi.stubEnv("WPPTRACK_META_AUTO_SYNC_ENABLED", "true");
      vi.stubEnv("WPPTRACK_META_AUTO_SYNC_LOOKBACK_DAYS", "7");
      vi.stubEnv("WPPTRACK_REPORT_TIMEZONE", "America/Sao_Paulo");
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

describe("meta report sync queue service (#83)", () => {
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
});
