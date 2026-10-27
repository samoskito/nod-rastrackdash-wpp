import { afterEach, describe, expect, it, vi } from "vitest";
import {
  META_PALMUP_CREDENTIAL_LABEL,
  MetaGraphUsageMonitor,
  currentMetaGraphAppScope,
  metaGraphAppScopeForCredentialLabel,
  runWithMetaGraphAppScope,
} from "../../src/integrations/meta/meta-graph-usage";
import { MetaGraphError } from "../../src/integrations/meta/meta-graph-error";
import { MetaReportAutoSyncService } from "../../src/reporting/meta-report-auto-sync.service";
import { MetaReportSyncProcessor } from "../../src/reporting/meta-report-sync.processor";
import { MetaReportSyncThrottleService } from "../../src/reporting/meta-report-sync-throttle.service";

// nod (Fase 6.4): o app Meta do aluno pode ser o da PalmUP ("Conectar Meta
// (PalmUP)") ou o próprio. O limite de uso do app (X-App-Usage) é por app, então
// o uso alto de um app não pausa a sincronização do outro. Sem Redis aqui: só
// o monitor do processo. Dados sintéticos.

const headers = (appPercent: number) =>
  new Headers({ "x-app-usage": JSON.stringify({ call_count: appPercent }) });

const throttleWith = (monitor: MetaGraphUsageMonitor) =>
  new MetaReportSyncThrottleService({ client: undefined } as never, monitor);

describe("Meta app scope (PalmUP login vs own app)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("maps only the PalmUP social login credential to the palmup scope", () => {
    expect(metaGraphAppScopeForCredentialLabel(META_PALMUP_CREDENTIAL_LABEL)).toBe(
      "palmup",
    );
    expect(metaGraphAppScopeForCredentialLabel(" Login social PalmUP ")).toBe(
      "palmup",
    );
    expect(metaGraphAppScopeForCredentialLabel("Token do meu app")).toBe("own");
    expect(metaGraphAppScopeForCredentialLabel(null)).toBe("own");
  });

  it("records app usage per scope and keeps the default entry for unscoped calls", () => {
    const monitor = new MetaGraphUsageMonitor();

    runWithMetaGraphAppScope("palmup", () => monitor.record(headers(90)));
    runWithMetaGraphAppScope("own", () => monitor.record(headers(10)));
    monitor.record(headers(40));

    expect(monitor.snapshot(Date.now(), "palmup").app?.percent).toBe(90);
    expect(monitor.snapshot(Date.now(), "own").app?.percent).toBe(10);
    expect(monitor.snapshot(Date.now(), null).app?.percent).toBe(40);
    expect(currentMetaGraphAppScope()).toBeNull();
  });

  it("defers only the jobs of the hot app", async () => {
    const monitor = new MetaGraphUsageMonitor();
    const throttle = throttleWith(monitor);

    runWithMetaGraphAppScope("palmup", () => monitor.record(headers(95)));

    await expect(
      runWithMetaGraphAppScope("palmup", () => throttle.deferralFor([])),
    ).resolves.toMatchObject({ reason: "app_usage", percent: 95 });
    await expect(
      runWithMetaGraphAppScope("own", () => throttle.deferralFor([])),
    ).resolves.toBeNull();
  });

  it("records an app throttle (code 4) only in the scope that received it", async () => {
    const monitor = new MetaGraphUsageMonitor();
    const throttle = throttleWith(monitor);
    const error = new MetaGraphError("Application request limit reached", {
      httpStatus: 400,
      code: 4,
      subcode: null,
      type: "OAuthException",
      isTransient: true,
    });

    await runWithMetaGraphAppScope("own", () =>
      throttle.recordRateLimitError(error, ["act_1"]),
    );

    expect(await throttle.deferralFor([], 0, Date.now(), "own")).not.toBeNull();
    expect(await throttle.deferralFor([], 0, Date.now(), "palmup")).toBeNull();
  });

  it("auto-sync skips the sweep only when every app scope is hot", async () => {
    vi.stubEnv("WPPTRACK_META_AUTO_SYNC_ENABLED", "true");
    const monitor = new MetaGraphUsageMonitor();
    const throttle = throttleWith(monitor);
    vi.spyOn(throttle, "acquireAutoSyncLock").mockResolvedValue(true);
    const prisma = { workspace: { findMany: vi.fn(async () => []) } };
    const service = new MetaReportAutoSyncService(
      prisma as never,
      { enqueueWorkspaceSync: vi.fn() } as never,
      undefined,
      throttle,
    );

    runWithMetaGraphAppScope("palmup", () => monitor.record(headers(99)));
    const onlyPalmupHot = await service.syncDueWorkspaces();
    expect(onlyPalmupHot.skipped).toBeUndefined();
    expect(prisma.workspace.findMany).toHaveBeenCalled();

    runWithMetaGraphAppScope("own", () => monitor.record(headers(99)));
    const bothHot = await service.syncDueWorkspaces();
    expect(bothHot.skipped).toBe("rate_limited");
  });

  it("runs the report-sync job in the scope of its credential", async () => {
    const monitor = new MetaGraphUsageMonitor();
    const throttle = throttleWith(monitor);
    const seenScopes: Array<string | null> = [];
    const prisma = {
      metaBusinessConnection: {
        findFirst: vi.fn(async () => ({
          credential: { label: META_PALMUP_CREDENTIAL_LABEL },
        })),
      },
      metaReportingAccount: {
        findMany: vi.fn(async () => [{ adAccountId: "act_1" }]),
      },
      jobAttempt: { create: vi.fn(async () => undefined) },
    };
    const reporting = {
      syncWorkspaceMetaStructure: vi.fn(async () => {
        seenScopes.push(currentMetaGraphAppScope());
        return {
          workspaceId: "workspace_1",
          accountsSynced: 1,
          accountsFailed: 0,
          campaignsSynced: 0,
          adSetsSynced: 0,
          adsSynced: 0,
        };
      }),
    };
    const processor = new MetaReportSyncProcessor(
      reporting as never,
      prisma as never,
      throttle,
    );

    await processor.process({
      id: "job_1",
      name: "sync-meta-reporting",
      data: {
        workspaceId: "workspace_1",
        businessConnectionId: "bc_1",
        reportingAccountId: "ra_1",
        since: "2026-10-01",
        until: "2026-10-07",
      },
    } as never);

    expect(seenScopes).toEqual(["palmup"]);
    expect(prisma.metaBusinessConnection.findFirst).toHaveBeenCalledWith({
      where: { id: "bc_1", workspaceId: "workspace_1" },
      select: { credential: { select: { label: true } } },
    });
    expect(currentMetaGraphAppScope()).toBeNull();
  });
});
