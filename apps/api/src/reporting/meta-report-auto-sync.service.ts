import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { MetaReportSyncQueueService } from "./meta-report-sync-queue.service";
import { MetaReportSyncThrottleService } from "./meta-report-sync-throttle.service";

type MetaReportAutoSyncClock = {
  now(): Date;
};

type MetaReportAutoSyncResult = {
  enabled: boolean;
  workspacesFound: number;
  enqueued: number;
  failed: number;
  since: string | null;
  until: string | null;
  skipped?: "running" | "locked" | "lock_unavailable" | "rate_limited";
  /** incremental: daily rows only for the last N days (see config()). */
  window?: "full" | "incremental";
  totalsSince?: string | null;
};

export const META_REPORT_AUTO_SYNC_CLOCK = Symbol(
  "META_REPORT_AUTO_SYNC_CLOCK",
);

/**
 * First automatic sync after boot. A redeploy must not hit Meta right away
 * (installations using the PalmUP Meta app share its app-level rate limit),
 * so the default is a random delay between 10 and 30 minutes. An explicit
 * WPPTRACK_META_AUTO_SYNC_INITIAL_DELAY_SECONDS below the minimum (e.g. the
 * old .env.example value 60) is ignored in favour of the random default.
 * nod: this replaces the SaaS boot jitter (60 s + up to 30 min).
 */
export const META_AUTO_SYNC_MIN_INITIAL_DELAY_MS = 10 * 60_000;
export const META_AUTO_SYNC_MAX_INITIAL_DELAY_MS = 30 * 60_000;

export function resolveMetaAutoSyncInitialDelayMs(
  configuredSeconds: string | undefined,
  random: () => number = Math.random,
): number {
  const parsed = Number.parseInt(configuredSeconds ?? "", 10);

  if (
    Number.isFinite(parsed) &&
    parsed * 1_000 >= META_AUTO_SYNC_MIN_INITIAL_DELAY_MS
  ) {
    return parsed * 1_000;
  }

  const span =
    META_AUTO_SYNC_MAX_INITIAL_DELAY_MS - META_AUTO_SYNC_MIN_INITIAL_DELAY_MS;
  const factor = Math.min(Math.max(random(), 0), 1);

  return META_AUTO_SYNC_MIN_INITIAL_DELAY_MS + Math.round(span * factor);
}

@Injectable()
export class MetaReportAutoSyncService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MetaReportAutoSyncService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(MetaReportSyncQueueService)
    private readonly queueService: MetaReportSyncQueueService,
    @Optional()
    @Inject(META_REPORT_AUTO_SYNC_CLOCK)
    private readonly clock: MetaReportAutoSyncClock = {
      now: () => new Date(),
    },
    @Optional()
    @Inject(MetaReportSyncThrottleService)
    private readonly throttle?: MetaReportSyncThrottleService,
  ) {}

  onApplicationBootstrap() {
    const config = this.config();

    if (!this.shouldStartTimer(config.enabled)) {
      return;
    }

    const run = () => {
      void this.syncDueWorkspaces()
        .then((result) => {
          this.logger.log(
            `Meta auto sync checked ${result.workspacesFound} workspaces; enqueued=${result.enqueued}; failed=${result.failed}; skipped=${result.skipped ?? "-"}; period=${result.since ?? "-"}..${result.until ?? "-"}; window=${result.window ?? "full"}`,
          );
        })
        .catch(() => {
          this.logger.warn("META_REPORT_AUTO_SYNC_BOOTSTRAP_FAILED");
        });
    };

    // Deploys/restarts must not sweep every workspace at once: the first run
    // waits a random 10-30 min (resolveMetaAutoSyncInitialDelayMs), and the
    // shared Redis marker (see syncDueWorkspaces) turns it into a no-op when
    // another replica already ran this interval.
    this.logger.log(
      `Meta auto sync: first run in ${Math.round(config.initialDelayMs / 60_000)} min, then every ${Math.round(config.intervalMs / 60_000)} min`,
    );
    this.initialTimer = setTimeout(run, config.initialDelayMs);
    this.timer = setInterval(run, config.intervalMs);
  }

  onModuleDestroy() {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async syncDueWorkspaces(): Promise<MetaReportAutoSyncResult> {
    const config = this.config();

    if (!config.enabled) {
      return {
        enabled: false,
        workspacesFound: 0,
        enqueued: 0,
        failed: 0,
        since: null,
        until: null,
      };
    }

    const period = this.period(config.lookbackDays);
    const skipped = (
      reason: NonNullable<MetaReportAutoSyncResult["skipped"]>,
    ): MetaReportAutoSyncResult => ({
      enabled: true,
      workspacesFound: 0,
      enqueued: 0,
      failed: 0,
      since: period.since,
      until: period.until,
      skipped: reason,
    });

    if (this.running) {
      return skipped("running");
    }

    this.running = true;

    try {
      if (this.throttle) {
        // Background sync yields while the Meta app is near its limit, so
        // customer logins keep working. nod: the limit is per app (PalmUP
        // login vs own app); the sweep is skipped only when every app is
        // hot, otherwise each job yields in its own scope (processor).
        const [palmupHot, ownHot] = await Promise.all(
          (["palmup", "own"] as const).map((scope) =>
            this.throttle!.deferralFor([], 0, Date.now(), scope),
          ),
        );

        if (palmupHot && ownHot) {
          return skipped("rate_limited");
        }

        const lock = await this.throttle.acquireAutoSyncLock(
          Math.max(60_000, config.intervalMs - 60_000),
        );

        if (lock === null) {
          this.logger.warn("META_REPORT_AUTO_SYNC_LOCK_UNAVAILABLE");
          return skipped("lock_unavailable");
        }

        if (!lock) {
          return skipped("locked");
        }
      }

      // Full lookback at most once per report day; every other sweep only
      // refreshes the last `incrementalDays` days (entity totals still cover
      // the full lookback; the sync verifies stored days add up).
      const window = await this.selectWindow(config, period);
      const baseWhere = {
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
      };
      let workspacesFound = 0;
      let enqueued = 0;
      let failed = 0;
      let lastId: string | null = null;

      // Keyset pagination with a stable order: every eligible workspace is
      // visited (the former single `take` starved workspaces beyond it).
      for (;;) {
        const workspaces: Array<{ id: string }> =
          await this.prisma.workspace.findMany({
            where: (lastId
              ? { AND: [baseWhere, { id: { gt: lastId } }] }
              : baseWhere) as never,
            select: {
              id: true,
            },
            orderBy: { id: "asc" },
            take: config.batchLimit,
          });

        workspacesFound += workspaces.length;

        for (const workspace of workspaces) {
          try {
            await this.queueService.enqueueWorkspaceSync({
              workspaceId: workspace.id,
              since: window.since,
              until: period.until,
              ...(window.mode === "incremental"
                ? { totalsSince: period.since }
                : {}),
            });
            enqueued += 1;
          } catch {
            failed += 1;
            this.logger.warn("META_REPORT_AUTO_SYNC_ENQUEUE_FAILED");
          }
        }

        if (workspaces.length < config.batchLimit) {
          break;
        }

        lastId = workspaces[workspaces.length - 1].id;
      }

      // The marker is written when the full sweep is enqueued, not when each
      // job finishes. This is safe by construction: an incremental job only
      // keeps its short window when the stored older days add up (spend and
      // conversations) to Meta's window totals, so a full job that failed or
      // was skipped makes the next incremental job read the full window.
      if (window.mode === "full" && (enqueued > 0 || workspacesFound === 0)) {
        await this.markFullWindow(period.until);
      }

      return {
        enabled: true,
        workspacesFound,
        enqueued,
        failed,
        since: window.since,
        until: period.until,
        ...(window.mode === "incremental"
          ? { window: "incremental" as const, totalsSince: period.since }
          : {}),
      };
    } finally {
      this.running = false;
    }
  }

  /**
   * Pure window choice: incremental only when enabled, shorter than the
   * lookback, and a full sweep already ran for this report date.
   */
  static chooseWindow(input: {
    lookbackSince: string;
    until: string;
    incrementalDays: number;
    lookbackDays: number;
    lastFullDate: string | null;
  }): { mode: "full" | "incremental"; since: string } {
    if (
      input.incrementalDays <= 0 ||
      input.incrementalDays >= input.lookbackDays ||
      input.lastFullDate !== input.until
    ) {
      return { mode: "full", since: input.lookbackSince };
    }

    const since = new Date(`${input.until}T12:00:00.000Z`);
    since.setUTCDate(since.getUTCDate() - (input.incrementalDays - 1));

    return { mode: "incremental", since: since.toISOString().slice(0, 10) };
  }

  private async selectWindow(
    config: ReturnType<MetaReportAutoSyncService["config"]>,
    period: { since: string; until: string },
  ): Promise<{ mode: "full" | "incremental"; since: string }> {
    let lastFullDate: string | null = null;

    try {
      // Without the shared marker (no Redis), every sweep stays full.
      lastFullDate = (await this.throttle?.readAutoSyncFullDate?.()) ?? null;
    } catch {
      lastFullDate = null;
    }

    return MetaReportAutoSyncService.chooseWindow({
      lookbackSince: period.since,
      until: period.until,
      incrementalDays: config.incrementalDays,
      lookbackDays: config.lookbackDays,
      lastFullDate,
    });
  }

  private async markFullWindow(until: string): Promise<void> {
    try {
      await this.throttle?.markAutoSyncFullDate?.(until);
    } catch {
      this.logger.warn("META_REPORT_AUTO_SYNC_FULL_MARK_FAILED");
    }
  }

  private shouldStartTimer(enabled: boolean): boolean {
    if (!enabled) {
      return false;
    }

    if (
      process.env.NODE_ENV === "test" &&
      process.env.WPPTRACK_META_AUTO_SYNC_ENABLED === undefined
    ) {
      return false;
    }

    return true;
  }

  private config() {
    return {
      enabled: this.booleanEnv("WPPTRACK_META_AUTO_SYNC_ENABLED", true),
      intervalMs:
        this.positiveIntegerEnv(
          "WPPTRACK_META_AUTO_SYNC_INTERVAL_MINUTES",
          180,
        ) * 60_000,
      initialDelayMs: resolveMetaAutoSyncInitialDelayMs(
        process.env.WPPTRACK_META_AUTO_SYNC_INITIAL_DELAY_SECONDS,
      ),
      lookbackDays: this.positiveIntegerEnv(
        "WPPTRACK_META_AUTO_SYNC_LOOKBACK_DAYS",
        7,
      ),
      // Recurring sweeps refresh only the last N days of daily rows; 0
      // disables (every sweep reads the full lookback, previous behavior).
      incrementalDays: this.nonNegativeIntegerEnv(
        "WPPTRACK_META_AUTO_SYNC_INCREMENTAL_DAYS",
        3,
      ),
      // Page size of the workspace sweep (no longer a hard cap).
      batchLimit: this.positiveIntegerEnv(
        "WPPTRACK_META_AUTO_SYNC_BATCH_LIMIT",
        100,
      ),
    };
  }

  private booleanEnv(name: string, fallback: boolean): boolean {
    const value = process.env[name]?.trim().toLowerCase();

    if (!value) {
      return fallback;
    }

    return ["1", "true", "yes", "sim", "on"].includes(value);
  }

  private positiveIntegerEnv(name: string, fallback: number): number {
    const parsed = Number.parseInt(process.env[name] ?? "", 10);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private period(lookbackDays: number) {
    const untilDate = this.dateOnlyInReportTimezone(this.clock.now());
    const since = new Date(`${untilDate}T12:00:00.000Z`);
    since.setUTCDate(since.getUTCDate() - (lookbackDays - 1));

    return {
      since: this.dateOnly(since),
      until: untilDate,
    };
  }

  private nonNegativeIntegerEnv(name: string, fallback: number): number {
    const parsed = Number.parseInt(process.env[name] ?? "", 10);

    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  private dateOnlyInReportTimezone(date: Date): string {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: process.env.WPPTRACK_REPORT_TIMEZONE ?? "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const values = new Map(parts.map((part) => [part.type, part.value]));

    return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
  }

  private dateOnly(date: Date): string {
    return date.toISOString().slice(0, 10);
  }
}
