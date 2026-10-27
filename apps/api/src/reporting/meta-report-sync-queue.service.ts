import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, NotFoundException, Optional } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  META_REPORT_SYNC_QUEUE,
  type MetaReportSyncJobPayload,
} from "../common/queue/queue.constants";
import { createBullJobId } from "../common/queue/job-id";
import { MetaConnectionResolverService } from "../integrations/meta/meta-connection-resolver.service";

/**
 * queued: a new job was added. already_queued: the same job is still waiting,
 * delayed or running. recent: the same job finished inside the dedupe window
 * (automatic triggers only; manual triggers replace it).
 */
export type MetaReportSyncEnqueueStatus =
  "queued" | "already_queued" | "recent";

export type MetaReportSyncTrigger = "manual" | "auto";

export type MetaReportSyncQueuedResult = MetaReportSyncJobPayload & {
  jobId: string;
  status: MetaReportSyncEnqueueStatus;
};

/** Window in which identical sync requests collapse into one BullMQ job. */
export function metaReportSyncDedupeWindowMs(): number {
  const minutes = Number.parseInt(
    process.env.WPPTRACK_META_SYNC_DEDUPE_WINDOW_MINUTES ?? "",
    10,
  );

  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60_000;
}

const PENDING_STATES = new Set([
  "waiting",
  "delayed",
  "active",
  "prioritized",
  "waiting-children",
]);

@Injectable()
export class MetaReportSyncQueueService {
  private readonly now: () => number = () => Date.now();

  constructor(
    @InjectQueue(META_REPORT_SYNC_QUEUE)
    private readonly queue: Queue<MetaReportSyncJobPayload>,
    @Optional()
    private readonly connectionResolver?: MetaConnectionResolverService,
  ) {}

  async enqueueWorkspaceSync(
    input: {
      workspaceId: string;
      since: string;
      until: string;
      totalsSince?: string | null;
    },
    trigger: MetaReportSyncTrigger = "auto",
  ): Promise<
    | MetaReportSyncQueuedResult
    | {
        workspaceId: string;
        since: string;
        until: string;
        status: MetaReportSyncEnqueueStatus;
        jobId: string;
        jobs: MetaReportSyncQueuedResult[];
      }
  > {
    if (!this.connectionResolver) {
      throw new NotFoundException("Roteamento Meta indisponível");
    }

    const targets = await this.connectionResolver.listReportingSyncTargets(
      input.workspaceId,
    );

    if (targets.length === 0) {
      throw new NotFoundException(
        "Nenhuma conta Meta ativa está pronta para sincronização",
      );
    }

    const jobs = await Promise.all(
      targets.map((target) =>
        this.enqueueSync(
          {
            ...input,
            ...target,
          },
          trigger,
        ),
      ),
    );

    if (jobs.length === 1) {
      return jobs[0];
    }

    const statuses = new Set(jobs.map((job) => job.status));

    return {
      workspaceId: input.workspaceId,
      since: input.since,
      until: input.until,
      status: statuses.has("queued")
        ? "queued"
        : statuses.has("already_queued")
          ? "already_queued"
          : "recent",
      jobId: createBullJobId(
        "meta-report-sync-batch",
        input.workspaceId,
        input.since,
        input.until,
        this.windowBucket(),
      ),
      jobs,
    };
  }

  async enqueueSync(
    input: MetaReportSyncJobPayload,
    trigger: MetaReportSyncTrigger = "auto",
  ): Promise<MetaReportSyncQueuedResult> {
    // Deterministic per workspace:account:period:window so auto-sync ticks,
    // restarts and repeated clicks collapse into one job.
    const jobId = createBullJobId(
      "meta-report-sync",
      input.workspaceId,
      input.businessConnectionId ?? "legacy",
      input.reportingAccountId ?? "workspace",
      input.since,
      input.until,
      `w${this.windowBucket()}`,
    );
    const existing = await this.queue.getJob?.(jobId);

    if (existing) {
      const state = await existing.getState();

      if (PENDING_STATES.has(state)) {
        return { ...input, jobId, status: "already_queued" };
      }

      if (trigger !== "manual") {
        return { ...input, jobId, status: "recent" };
      }

      // Manual or post-reconnect request: a finished/failed job with the same
      // id must not swallow it (BullMQ ignores add() for an existing id).
      try {
        await existing.remove();
      } catch {
        return { ...input, jobId, status: "already_queued" };
      }
    }

    const job = await this.queue.add("sync-meta-reporting", input, {
      jobId,
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 60_000,
      },
      // Keep the completed id for the dedupe window so it still collapses.
      removeOnComplete: {
        age: Math.ceil(metaReportSyncDedupeWindowMs() / 1_000),
      },
      removeOnFail: {
        age: 86_400,
        count: 100,
      },
    });

    return {
      ...input,
      jobId: String(job.id ?? jobId),
      status: "queued",
    };
  }

  private windowBucket(): number {
    return Math.floor(this.now() / metaReportSyncDedupeWindowMs());
  }
}
