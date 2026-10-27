import { createHash } from "node:crypto";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import {
  RUNTIME_FETCH,
  type RuntimeFetch,
} from "../../common/runtime/runtime.module";
import type { IntegrationEnv } from "../integration.types";
import { INTEGRATION_ENV } from "../integration.types";
import { isMetaCdnHost, metaCdnUrlExpiresAt } from "./meta-cdn-url";
import {
  MetaGraphError,
  sanitizedMetaGraphReason,
} from "./meta-graph-error";
import { currentMetaGraphAppScope } from "./meta-graph-usage";
import { MetaAdapter } from "./meta.adapter";

/** Rendered size requested from Meta (px, square box). */
export const META_CREATIVE_THUMBNAIL_SIZE = 320;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULTS = {
  maxPerRun: 150,
  maxBytes: 100 * 1024,
  downloadTimeoutMs: 3_000,
  downloadConcurrency: 4,
  /** Total wall-clock budget of one refresh (Graph lookup + downloads). */
  stageBudgetMs: 30_000,
  /** Pause after a Meta rate-limit error (covers the rest of the sync). */
  rateLimitPauseMs: 15 * 60 * 1000,
} as const;
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);
/** Graph rate-limit codes: app (4), user (17), page (32), API-specific (613). */
const META_RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

export type MetaCreativeThumbnailStatus =
  | "ready"
  | "url_only"
  | "missing"
  | "failed";

export type MetaCreativeThumbnailState = {
  creativeId: string;
  status: string;
  byteSize: number | null;
  fetchedAt: Date | null;
  nextAttemptAt: Date | null;
  sourceUrlExpiresAt: Date | null;
  attemptCount: number;
};

export type MetaCreativeThumbnailRefreshResult = {
  requested: number;
  due: number;
  fetched: number;
  stored: number;
  urlOnly: number;
  missing: number;
  failed: number;
  deferred: number;
  rateLimited: boolean;
  budgetExhausted: boolean;
};

export type StoredCreativeThumbnail = {
  bytes: Buffer;
  contentType: string;
  version: string;
};

type ThumbnailWrite = {
  status: MetaCreativeThumbnailStatus;
  source?: "image" | "video" | null;
  sourceUrl?: string | null;
  sourceUrlExpiresAt?: Date | null;
  contentType?: string | null;
  imageBytes?: Uint8Array<ArrayBuffer> | null;
  byteSize?: number | null;
  version?: string | null;
  fetchedAt?: Date | null;
  nextAttemptAt: Date | null;
  attemptCount: number;
  lastError: string | null;
};

/**
 * Decides whether a creative needs a Meta call. Meta creatives are
 * immutable, so a stored image is never refetched; rows without bytes
 * (url_only/missing/failed) are retried only after their backoff. The stored
 * signed URL is never served, so its expiry does not trigger a refetch.
 */
export function creativeThumbnailNeedsRefresh(
  row: MetaCreativeThumbnailState | undefined,
  now: Date,
): boolean {
  if (!row) {
    return true;
  }

  if (row.status === "ready" && (row.byteSize ?? 0) > 0) {
    return false;
  }

  return !row.nextAttemptAt || row.nextAttemptAt.getTime() <= now.getTime();
}

/** 1d, 2d, 4d ... capped at 7d. */
export function creativeThumbnailBackoffMs(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(attemptCount - 1, 3));

  return Math.min(7 * DAY_MS, DAY_MS * 2 ** exponent);
}

/**
 * True for Meta Graph throttling errors: a numeric code (4/17/32/613) on the
 * thrown error (`code`, `metaCode`, `graphCode`, `errorCode`, or nested
 * `error.code`), or the code/limit wording in the message.
 */
export function isMetaRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const record = error as Record<string, unknown>;
  const nested =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>).code
      : undefined;
  const codes = [
    record.code,
    record.metaCode,
    record.graphCode,
    record.errorCode,
    nested,
  ]
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value));

  if (codes.some((code) => META_RATE_LIMIT_CODES.has(code))) {
    return true;
  }

  const message = error instanceof Error ? error.message : "";

  return (
    /\(#(4|17|32|613)\)/u.test(message) ||
    /(request limit reached|rate limit|too many calls)/iu.test(message)
  );
}

class StageTimeoutError extends Error {
  constructor() {
    super("thumbnail_stage_budget_exhausted");
  }
}

@Injectable()
export class MetaCreativeThumbnailService {
  private readonly logger = new Logger(MetaCreativeThumbnailService.name);
  /** Process-wide pause after a Meta rate-limit error (epoch ms). */
  /** nod: pause per Meta app scope (PalmUP login vs own app). */
  private readonly rateLimitedUntilMs = new Map<string, number>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MetaAdapter) private readonly metaAdapter: MetaAdapter,
    @Optional()
    @Inject(INTEGRATION_ENV)
    private readonly env: IntegrationEnv = process.env,
    @Optional()
    @Inject(RUNTIME_FETCH)
    private readonly fetchImpl: RuntimeFetch = fetch,
  ) {}

  /**
   * Persists thumbnails for the given creatives, calling Meta only for new
   * creatives or rows whose backoff elapsed, at most `maxPerRun` per call and
   * within a total time budget. After a Meta rate-limit error the refresh is
   * paused process-wide (rest of the sync and the following minutes). Never
   * throws: thumbnails are cosmetic and must not fail a report sync.
   */
  async refreshCreatives(input: {
    workspaceId: string;
    accessToken: string;
    creativeIds: Array<string | null | undefined>;
    now?: Date;
  }): Promise<MetaCreativeThumbnailRefreshResult> {
    const startedAtMs = Date.now();
    const deadlineMs =
      startedAtMs +
      this.numberEnv(
        "META_CREATIVE_THUMBNAIL_STAGE_BUDGET_MS",
        DEFAULTS.stageBudgetMs,
      );
    const now = input.now ?? new Date();
    const creativeIds = [
      ...new Set(
        input.creativeIds.filter(
          (id): id is string => typeof id === "string" && /^\d{1,32}$/u.test(id),
        ),
      ),
    ];
    const result: MetaCreativeThumbnailRefreshResult = {
      requested: creativeIds.length,
      due: 0,
      fetched: 0,
      stored: 0,
      urlOnly: 0,
      missing: 0,
      failed: 0,
      deferred: 0,
      rateLimited: false,
      budgetExhausted: false,
    };

    if (creativeIds.length === 0) {
      return result;
    }

    const pauseKey = currentMetaGraphAppScope() ?? "default";

    if (now.getTime() < (this.rateLimitedUntilMs.get(pauseKey) ?? 0)) {
      result.rateLimited = true;
      return result;
    }

    try {
      const existing = (await this.prisma.metaCreativeThumbnail.findMany({
        where: {
          workspaceId: input.workspaceId,
          creativeId: { in: creativeIds },
        },
        select: {
          creativeId: true,
          status: true,
          byteSize: true,
          fetchedAt: true,
          nextAttemptAt: true,
          sourceUrlExpiresAt: true,
          attemptCount: true,
        },
      })) as MetaCreativeThumbnailState[];
      const existingById = new Map(
        existing.map((row) => [row.creativeId, row]),
      );
      const due = creativeIds.filter((creativeId) =>
        creativeThumbnailNeedsRefresh(existingById.get(creativeId), now),
      );
      // New creatives first, then the oldest attempts.
      due.sort((left, right) => {
        const leftRow = existingById.get(left);
        const rightRow = existingById.get(right);

        if (!leftRow || !rightRow) {
          return Number(Boolean(leftRow)) - Number(Boolean(rightRow));
        }

        return (
          (leftRow.fetchedAt?.getTime() ?? 0) -
          (rightRow.fetchedAt?.getTime() ?? 0)
        );
      });
      const maxPerRun = this.numberEnv(
        "META_CREATIVE_THUMBNAIL_MAX_PER_SYNC",
        DEFAULTS.maxPerRun,
      );
      const batch = due.slice(0, Math.max(0, maxPerRun));
      result.due = due.length;
      result.deferred = due.length - batch.length;

      if (batch.length === 0) {
        return result;
      }

      let candidates;

      try {
        candidates = await this.withDeadline(
          this.metaAdapter.getCreativeThumbnails({
            accessToken: input.accessToken,
            creativeIds: batch,
            size: META_CREATIVE_THUMBNAIL_SIZE,
          }),
          deadlineMs,
        );
      } catch (error) {
        if (error instanceof StageTimeoutError) {
          // Rows untouched: they stay due for the next sync.
          result.budgetExhausted = true;
          result.deferred += batch.length;
          return result;
        }

        const message = this.errorMessage(error);

        if (isMetaRateLimitError(error)) {
          // Stop for the rest of this sync (and a cooldown) without burning
          // attempts: rows stay due once the pause ends.
          this.rateLimitedUntilMs.set(
            pauseKey,
            now.getTime() +
              this.numberEnv(
                "META_CREATIVE_THUMBNAIL_RATE_LIMIT_PAUSE_MS",
                DEFAULTS.rateLimitPauseMs,
              ),
          );
          result.rateLimited = true;
          result.deferred += batch.length;
          this.logger.warn(
            `creative thumbnail refresh paused after Meta rate limit: ${message}`,
          );
          return result;
        }

        // Other Meta failure: back off every creative of the batch instead
        // of retrying on the next sync.
        await this.writeAll(
          input.workspaceId,
          batch.map((creativeId) => {
            const attemptCount =
              (existingById.get(creativeId)?.attemptCount ?? 0) + 1;

            return [
              creativeId,
              {
                status: "failed",
                nextAttemptAt: new Date(
                  now.getTime() + creativeThumbnailBackoffMs(attemptCount),
                ),
                attemptCount,
                lastError: message,
              },
            ] as const;
          }),
          existingById,
        );
        result.failed = batch.length;
        this.logger.warn(
          `creative thumbnail lookup failed for ${batch.length} creatives: ${message}`,
        );
        return result;
      }

      result.fetched = candidates.size;
      const downloadTimeoutMs = this.numberEnv(
        "META_CREATIVE_THUMBNAIL_DOWNLOAD_TIMEOUT_MS",
        DEFAULTS.downloadTimeoutMs,
      );
      const writes = await this.mapWithConcurrency(
        batch,
        this.numberEnv(
          "META_CREATIVE_THUMBNAIL_DOWNLOAD_CONCURRENCY",
          DEFAULTS.downloadConcurrency,
        ),
        async (creativeId): Promise<readonly [string, ThumbnailWrite] | null> => {
          const attemptCount =
            (existingById.get(creativeId)?.attemptCount ?? 0) + 1;
          const backoff = new Date(
            now.getTime() + creativeThumbnailBackoffMs(attemptCount),
          );
          const candidate = candidates.get(creativeId);

          if (!candidate) {
            result.missing += 1;
            return [
              creativeId,
              {
                status: "missing",
                fetchedAt: now,
                nextAttemptAt: backoff,
                attemptCount,
                lastError: "no_thumbnail_candidate",
              },
            ] as const;
          }

          const remainingMs = deadlineMs - Date.now();

          if (remainingMs <= 0) {
            // Budget spent: leave the row due for the next sync.
            result.budgetExhausted = true;
            result.deferred += 1;
            return null;
          }

          const sourceUrlExpiresAt = metaCdnUrlExpiresAt(candidate.url);

          try {
            const image = await this.downloadImage(
              candidate.url,
              Math.min(downloadTimeoutMs, remainingMs),
            );
            result.stored += 1;

            return [
              creativeId,
              {
                status: "ready",
                source: candidate.source,
                sourceUrl: candidate.url,
                sourceUrlExpiresAt,
                contentType: image.contentType,
                imageBytes: new Uint8Array(image.bytes),
                byteSize: image.bytes.length,
                version: createHash("sha256")
                  .update(image.bytes)
                  .digest("hex")
                  .slice(0, 16),
                fetchedAt: now,
                nextAttemptAt: null,
                attemptCount: 0,
                lastError: null,
              },
            ] as const;
          } catch (error) {
            result.urlOnly += 1;

            return [
              creativeId,
              {
                status: "url_only",
                source: candidate.source,
                sourceUrl: candidate.url,
                sourceUrlExpiresAt,
                fetchedAt: now,
                nextAttemptAt: backoff,
                attemptCount,
                lastError: this.errorMessage(error),
              },
            ] as const;
          }
        },
      );

      await this.writeAll(
        input.workspaceId,
        writes.filter(
          (write): write is readonly [string, ThumbnailWrite] => write !== null,
        ),
        existingById,
      );
      return result;
    } catch (error) {
      this.logger.warn(
        `creative thumbnail refresh skipped: ${this.errorMessage(error)}`,
      );
      return result;
    }
  }

  private async withDeadline<T>(promise: Promise<T>, deadlineMs: number) {
    // The losing promise keeps running; swallow its late rejection.
    promise.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new StageTimeoutError()),
            Math.max(0, deadlineMs - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Workspace-scoped lookup used by the authenticated image endpoint. */
  async findStoredThumbnailForAd(
    workspaceId: string,
    adId: string,
  ): Promise<StoredCreativeThumbnail | null> {
    const ad = (await this.prisma.metaAd.findFirst({
      where: { workspaceId, adId },
      select: { creativeId: true },
    })) as { creativeId: string | null } | null;

    if (!ad?.creativeId) {
      return null;
    }

    const row = (await this.prisma.metaCreativeThumbnail.findFirst({
      where: {
        workspaceId,
        creativeId: ad.creativeId,
        status: "ready",
      },
      select: { imageBytes: true, contentType: true, version: true },
    })) as {
      imageBytes: Uint8Array | null;
      contentType: string | null;
      version: string | null;
    } | null;

    if (!row?.imageBytes || row.imageBytes.length === 0) {
      return null;
    }

    return {
      bytes: Buffer.from(row.imageBytes),
      contentType: row.contentType ?? "image/jpeg",
      version: row.version ?? "",
    };
  }

  private async downloadImage(
    url: string,
    timeoutMs: number,
  ): Promise<{ bytes: Buffer; contentType: string }> {
    const parsed = new URL(url);

    if (parsed.protocol !== "https:" || !isMetaCdnHost(parsed.hostname)) {
      throw new Error("thumbnail_host_not_allowed");
    }

    const maxBytes = this.numberEnv(
      "META_CREATIVE_THUMBNAIL_MAX_BYTES",
      DEFAULTS.maxBytes,
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchImpl(parsed.toString(), {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`thumbnail_http_${response.status}`);
      }

      const contentType = (response.headers.get("content-type") ?? "")
        .split(";")[0]!
        .trim()
        .toLowerCase();

      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        throw new Error("thumbnail_content_type_not_allowed");
      }

      const declaredLength = Number(response.headers.get("content-length"));

      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error("thumbnail_too_large");
      }

      const bytes = await this.readLimited(response, maxBytes);

      if (bytes.length === 0) {
        throw new Error("thumbnail_empty");
      }

      return {
        bytes,
        contentType: contentType === "image/jpg" ? "image/jpeg" : contentType,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readLimited(
    response: Response,
    maxBytes: number,
  ): Promise<Buffer> {
    const reader = response.body?.getReader();

    if (!reader) {
      const buffer = Buffer.from(await response.arrayBuffer());

      if (buffer.length > maxBytes) {
        throw new Error("thumbnail_too_large");
      }

      return buffer;
    }

    const chunks: Uint8Array[] = [];
    let total = 0;

    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      total += value.length;

      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("thumbnail_too_large");
      }

      chunks.push(value);
    }

    return Buffer.concat(chunks);
  }

  private async writeAll(
    workspaceId: string,
    writes: ReadonlyArray<readonly [string, ThumbnailWrite]>,
    existingById: Map<string, MetaCreativeThumbnailState>,
  ): Promise<void> {
    for (const [creativeId, write] of writes) {
      const previous = existingById.get(creativeId);
      // Never discard previously stored bytes because a refresh failed.
      const keepStoredImage =
        write.status !== "ready" &&
        previous?.status === "ready" &&
        (previous.byteSize ?? 0) > 0;
      const data = keepStoredImage
        ? {
            fetchedAt: write.fetchedAt ?? previous!.fetchedAt,
            nextAttemptAt: write.nextAttemptAt,
            attemptCount: write.attemptCount,
            lastError: write.lastError,
          }
        : write;

      try {
        await this.prisma.metaCreativeThumbnail.upsert({
          where: { workspaceId_creativeId: { workspaceId, creativeId } },
          create: {
            workspaceId,
            creativeId,
            ...write,
          },
          update: data,
        });
      } catch (error) {
        this.logger.warn(
          `creative thumbnail ${creativeId} not persisted: ${this.errorMessage(error)}`,
        );
      }
    }
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const workers = Array.from(
      { length: Math.max(1, Math.min(concurrency, items.length)) },
      async () => {
        while (next < items.length) {
          const index = next;
          next += 1;
          results[index] = await mapper(items[index]!);
        }
      },
    );

    await Promise.all(workers);
    return results;
  }

  private numberEnv(name: string, fallback: number): number {
    const raw = this.env?.[name];
    const value = raw === undefined || raw === "" ? Number.NaN : Number(raw);

    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  private errorMessage(error: unknown): string {
    // nod: Graph errors keep only code/subcode/http (no provider text).
    const message =
      error instanceof MetaGraphError
        ? sanitizedMetaGraphReason(error)
        : error instanceof Error
          ? error.message
          : "thumbnail_unknown_error";

    return message.slice(0, 300);
  }
}
