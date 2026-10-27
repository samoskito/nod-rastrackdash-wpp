import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { Queue } from "bullmq";
import { META_REPORT_SYNC_QUEUE } from "../common/queue/queue.constants";
import {
  MetaGraphError,
  isMetaRateLimitError,
} from "../integrations/meta/meta-graph-error";
import {
  META_GRAPH_USAGE_TTL_MS,
  MetaGraphUsageMonitor,
  currentMetaGraphAppScope,
  type MetaGraphAppScope,
  type MetaGraphUsageEntry,
} from "../integrations/meta/meta-graph-usage";

type RedisLike = {
  get(key: string): Promise<string | null>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<unknown>;
};

export type MetaSyncDeferral = {
  untilMs: number;
  reason: "app_usage" | "account_usage";
  percent: number;
};

const APP_KEY = "wpptrack:meta-graph-usage:app";
/** nod: app-level usage is shared per Meta app scope (PalmUP vs own app). */
const appKey = (appScope: MetaGraphAppScope | null) =>
  appScope ? `${APP_KEY}:${appScope}` : APP_KEY;
const ACCOUNT_KEY_PREFIX = "wpptrack:meta-graph-usage:account:";
export const META_AUTO_SYNC_LOCK_KEY = "wpptrack:meta-report-auto-sync:lock";
export const META_AUTO_SYNC_FULL_DATE_KEY =
  "wpptrack:meta-report-auto-sync:full-date";
const REDIS_TIMEOUT_MS = 2_000;
const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;
/** Codes where Meta throttles the whole app (also hurts customer login). */
const APP_SCOPE_THROTTLE_CODES = new Set([4, 341]);

/**
 * Background-sync yield policy for Meta rate limits. Usage observed by any
 * process is shared through Redis (the BullMQ connection); when Redis is
 * unavailable the in-process monitor still protects this worker.
 */
@Injectable()
export class MetaReportSyncThrottleService {
  private readonly logger = new Logger(MetaReportSyncThrottleService.name);

  constructor(
    @InjectQueue(META_REPORT_SYNC_QUEUE)
    private readonly queue: Pick<Queue, "client">,
    @Optional()
    @Inject(MetaGraphUsageMonitor)
    private readonly monitor?: MetaGraphUsageMonitor,
  ) {}

  pauseThresholdPercent(): number {
    const parsed = Number.parseFloat(
      process.env.WPPTRACK_META_USAGE_PAUSE_PERCENT ?? "",
    );

    return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : 75;
  }

  backoffMs(deferrals: number, random = Math.random): number {
    const exponential = Math.min(
      BACKOFF_BASE_MS * 2 ** Math.max(0, deferrals),
      BACKOFF_MAX_MS,
    );

    // Jitter spreads resumed jobs so they do not hit Meta in a burst.
    return Math.round(exponential * (1 + random() * 0.2));
  }

  /**
   * Returns when a sync touching these ad accounts should resume, or null
   * when it can run now.
   */
  async deferralFor(
    adAccountIds: string[],
    deferrals = 0,
    nowMs = Date.now(),
    appScope: MetaGraphAppScope | null = currentMetaGraphAppScope(),
  ): Promise<MetaSyncDeferral | null> {
    const local = this.monitor?.snapshot(nowMs, appScope) ?? {
      app: null,
      accounts: {},
    };
    const shared = await this.readShared(adAccountIds, nowMs, appScope);
    const app = this.newest(local.app, shared.app);
    const accounts = adAccountIds.map((id) => ({
      id,
      local: local.accounts[id] ?? null,
      entry: this.newest(local.accounts[id] ?? null, shared.accounts[id]),
    }));

    await this.publish(
      [
        { key: appKey(appScope), local: local.app, shared: shared.app },
        ...accounts.map((account) => ({
          key: `${ACCOUNT_KEY_PREFIX}${account.id}`,
          local: account.local,
          shared: shared.accounts[account.id] ?? null,
        })),
      ],
      nowMs,
    );

    const threshold = this.pauseThresholdPercent();
    const blocking = [
      app ? { reason: "app_usage" as const, entry: app } : null,
      ...accounts.map((account) =>
        account.entry
          ? { reason: "account_usage" as const, entry: account.entry }
          : null,
      ),
    ]
      .filter(
        (
          item,
        ): item is {
          reason: "app_usage" | "account_usage";
          entry: MetaGraphUsageEntry;
        } =>
          Boolean(item) &&
          ((item as { entry: MetaGraphUsageEntry }).entry.percent >=
            threshold ||
            ((item as { entry: MetaGraphUsageEntry }).entry.regainAtMs ?? 0) >
              nowMs),
      )
      .sort((left, right) => right.entry.percent - left.entry.percent);

    if (blocking.length === 0) {
      return null;
    }

    const regainAtMs = Math.max(
      ...blocking.map((item) => item.entry.regainAtMs ?? 0),
    );

    return {
      untilMs: Math.max(regainAtMs, nowMs + this.backoffMs(deferrals)),
      reason: blocking[0].reason,
      percent: blocking[0].entry.percent,
    };
  }

  /** Converts a 4/17/32/613/80000+ response into a shared cooldown. */
  async recordRateLimitError(
    error: unknown,
    adAccountIds: string[],
    deferrals = 0,
    nowMs = Date.now(),
    metaApp: MetaGraphAppScope | null = currentMetaGraphAppScope(),
  ): Promise<void> {
    if (!isMetaRateLimitError(error)) {
      return;
    }

    const cooldownMs = this.backoffMs(deferrals);
    const code = (error as MetaGraphError).details.code;
    const appScope =
      (code !== null && APP_SCOPE_THROTTLE_CODES.has(code)) ||
      adAccountIds.length === 0;
    const entry: MetaGraphUsageEntry = {
      percent: 100,
      regainAtMs: nowMs + cooldownMs,
      observedAtMs: nowMs,
    };

    if (appScope) {
      this.monitor?.recordThrottle("app", null, cooldownMs, nowMs, metaApp);
      await this.writeEntries([[appKey(metaApp), entry]], nowMs);
      return;
    }

    for (const id of adAccountIds) {
      this.monitor?.recordThrottle("account", id, cooldownMs, nowMs);
    }

    await this.writeEntries(
      adAccountIds.map((id) => [`${ACCOUNT_KEY_PREFIX}${id}`, entry]),
      nowMs,
    );
  }

  /**
   * Single-runner guard across replicas. The key doubles as a "last run"
   * marker, so restarts inside the interval do not trigger another sweep.
   * Returns null when Redis cannot be reached.
   */
  async acquireAutoSyncLock(ttlMs: number): Promise<boolean | null> {
    const redis = await this.redis();

    if (!redis) {
      return null;
    }

    try {
      const result = await this.withTimeout(
        redis.set(
          META_AUTO_SYNC_LOCK_KEY,
          `${process.pid}:${Date.now()}`,
          "PX",
          Math.max(1_000, Math.round(ttlMs)),
          "NX",
        ),
      );

      return result === "OK";
    } catch {
      return null;
    }
  }

  /**
   * Report date (YYYY-MM-DD) of the last full-lookback auto-sync sweep.
   * null when unknown or Redis is unreachable (callers then run full).
   */
  async readAutoSyncFullDate(): Promise<string | null> {
    const redis = await this.redis();

    if (!redis) {
      return null;
    }

    try {
      const value = await this.withTimeout(
        redis.get(META_AUTO_SYNC_FULL_DATE_KEY),
      );

      return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
    } catch {
      return null;
    }
  }

  async markAutoSyncFullDate(date: string): Promise<void> {
    const redis = await this.redis();

    if (!redis || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return;
    }

    try {
      await this.withTimeout(
        redis.set(META_AUTO_SYNC_FULL_DATE_KEY, date, "PX", 48 * 3_600_000),
      );
    } catch {
      // Missing marker only means the next sweep is full again.
    }
  }

  private newest(
    left: MetaGraphUsageEntry | null | undefined,
    right: MetaGraphUsageEntry | null | undefined,
  ): MetaGraphUsageEntry | null {
    if (!left) {
      return right ?? null;
    }

    if (!right) {
      return left;
    }

    // A live cooldown wins over a newer low reading taken before it expired.
    const leftCooling = (left.regainAtMs ?? 0) > right.observedAtMs;
    const rightCooling = (right.regainAtMs ?? 0) > left.observedAtMs;

    if (leftCooling !== rightCooling) {
      return leftCooling ? left : right;
    }

    return left.observedAtMs >= right.observedAtMs ? left : right;
  }

  private async readShared(
    adAccountIds: string[],
    nowMs: number,
    appScope: MetaGraphAppScope | null,
  ): Promise<{
    app: MetaGraphUsageEntry | null;
    accounts: Record<string, MetaGraphUsageEntry>;
  }> {
    const empty = { app: null, accounts: {} };
    const redis = await this.redis();

    if (!redis) {
      return empty;
    }

    try {
      const keys = [
        appKey(appScope),
        ...adAccountIds.map((id) => `${ACCOUNT_KEY_PREFIX}${id}`),
      ];
      const values = await this.withTimeout(redis.mget(...keys));
      const accounts: Record<string, MetaGraphUsageEntry> = {};

      adAccountIds.forEach((id, index) => {
        const entry = this.parseEntry(values[index + 1], nowMs);

        if (entry) {
          accounts[id] = entry;
        }
      });

      return { app: this.parseEntry(values[0], nowMs), accounts };
    } catch {
      return empty;
    }
  }

  private async publish(
    candidates: Array<{
      key: string;
      local: MetaGraphUsageEntry | null;
      shared: MetaGraphUsageEntry | null;
    }>,
    nowMs: number,
  ): Promise<void> {
    const entries = candidates
      .filter(
        (candidate) =>
          candidate.local &&
          (!candidate.shared ||
            candidate.local.observedAtMs > candidate.shared.observedAtMs),
      )
      .map(
        (candidate) =>
          [candidate.key, candidate.local as MetaGraphUsageEntry] as [
            string,
            MetaGraphUsageEntry,
          ],
      );

    await this.writeEntries(entries, nowMs);
  }

  private async writeEntries(
    entries: Array<[string, MetaGraphUsageEntry]>,
    nowMs: number,
  ): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const redis = await this.redis();

    if (!redis) {
      return;
    }

    try {
      await Promise.all(
        entries.map(([key, entry]) => {
          const ttlMs = Math.max(
            META_GRAPH_USAGE_TTL_MS,
            (entry.regainAtMs ?? 0) - nowMs,
          );

          return this.withTimeout(
            redis.set(key, JSON.stringify(entry), "PX", Math.round(ttlMs)),
          );
        }),
      );
    } catch {
      this.logger.warn("META_GRAPH_USAGE_PUBLISH_FAILED");
    }
  }

  private parseEntry(
    value: string | null | undefined,
    nowMs: number,
  ): MetaGraphUsageEntry | null {
    if (!value) {
      return null;
    }

    try {
      const parsed = JSON.parse(value) as Partial<MetaGraphUsageEntry>;
      const percent = Number(parsed.percent);
      const observedAtMs = Number(parsed.observedAtMs);
      const regainAtMs =
        parsed.regainAtMs === null || parsed.regainAtMs === undefined
          ? null
          : Number(parsed.regainAtMs);

      if (!Number.isFinite(percent) || !Number.isFinite(observedAtMs)) {
        return null;
      }

      const fresh =
        nowMs - observedAtMs <= META_GRAPH_USAGE_TTL_MS ||
        (regainAtMs ?? 0) > nowMs;

      return fresh
        ? {
            percent,
            observedAtMs,
            regainAtMs:
              regainAtMs !== null && Number.isFinite(regainAtMs)
                ? regainAtMs
                : null,
          }
        : null;
    } catch {
      return null;
    }
  }

  private async redis(): Promise<RedisLike | null> {
    try {
      const client = this.queue?.client;

      if (!client) {
        return null;
      }

      return (await this.withTimeout(
        Promise.resolve(client),
      )) as unknown as RedisLike;
    } catch {
      return null;
    }
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("META_THROTTLE_REDIS_TIMEOUT")),
            REDIS_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
