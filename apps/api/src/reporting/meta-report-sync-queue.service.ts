import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, NotFoundException, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import {
  META_REPORT_SYNC_QUEUE,
  type MetaReportSyncJobPayload,
} from "../common/queue/queue.constants";
import { createBullJobId } from "../common/queue/job-id";
import { MetaConnectionResolverService } from "../integrations/meta/meta-connection-resolver.service";

export type MetaReportSyncQueuedResult = MetaReportSyncJobPayload & {
  jobId: string;
  status: "queued";
};

@Injectable()
export class MetaReportSyncQueueService {
  constructor(
    @InjectQueue(META_REPORT_SYNC_QUEUE)
    private readonly queue: Queue<MetaReportSyncJobPayload>,
    @Optional()
    private readonly connectionResolver?: MetaConnectionResolverService,
  ) {}

  async enqueueWorkspaceSync(input: {
    workspaceId: string;
    since: string;
    until: string;
  }): Promise<
    | MetaReportSyncQueuedResult
    | {
        workspaceId: string;
        since: string;
        until: string;
        status: "queued";
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
        this.enqueueSync({
          ...input,
          ...target,
        }),
      ),
    );

    if (jobs.length === 1) {
      return jobs[0];
    }

    return {
      workspaceId: input.workspaceId,
      since: input.since,
      until: input.until,
      status: "queued",
      jobId: createBullJobId(
        "meta-report-sync-batch",
        input.workspaceId,
        randomUUID(),
      ),
      jobs,
    };
  }

  async enqueueSync(
    input: MetaReportSyncJobPayload,
  ): Promise<MetaReportSyncQueuedResult> {
    const jobId = createBullJobId(
      "meta-report-sync",
      input.workspaceId,
      input.businessConnectionId ?? "legacy",
      input.reportingAccountId ?? "workspace",
      input.since,
      input.until,
      randomUUID(),
    );
    const job = await this.queue.add("sync-meta-reporting", input, {
      jobId,
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 60_000,
      },
      removeOnComplete: true,
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
}
