import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Job } from "bullmq";
import { ConversionEventsService } from "../../conversion-events/conversion-events.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  CONVERSION_EVENTS_QUEUE,
  type ConversionEventJobPayload
} from "./queue.constants";

type LegacyConversionEventJobPayload = Omit<
  ConversionEventJobPayload,
  "workspaceId"
> & { workspaceId?: undefined };
type ConversionEventWorkerPayload =
  ConversionEventJobPayload | LegacyConversionEventJobPayload;

/**
 * Worker concurrency (default 1, previous behavior). Meta CAPI micro-batching
 * (META_CAPI_BATCH_ENABLED) only coalesces events that are in flight at the
 * same time, so it needs concurrency > 1 to save requests.
 */
export function conversionEventWorkerConcurrency(
  env: Record<string, string | undefined> = process.env
): number {
  const parsed = Number.parseInt(
    env.WPPTRACK_CONVERSION_WORKER_CONCURRENCY ?? "",
    10
  );

  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 50) : 1;
}

@Processor(CONVERSION_EVENTS_QUEUE, {
  concurrency: conversionEventWorkerConcurrency()
})
export class ConversionEventProcessor extends WorkerHost {
  constructor(
    @Inject(ConversionEventsService)
    private readonly conversionEventsService: ConversionEventsService,
    @Inject(PrismaService)
    private readonly prisma: PrismaService
  ) {
    super();
  }

  async process(job: Job<ConversionEventWorkerPayload>) {
    let result: Awaited<ReturnType<ConversionEventsService["sendReadyEvent"]>>;
    let workspaceId = job.data.workspaceId;

    try {
      workspaceId = await this.resolveWorkspaceId(job);
      result = await this.conversionEventsService.sendReadyEvent(
        job.data.conversionEventLogId,
        // 1.3.1: numa nova tentativa, uma falha passageira (rede ou limite
        // de uso da Meta) volta a ser enviada.
        { workspaceId, queueRetry: (job.attemptsMade ?? 0) > 0 }
      );
    } catch (error) {
      await this.recordAttempt(
        job,
        "failed",
        {
          conversionEventLogId: job.data.conversionEventLogId,
          workspaceId
        },
        error
      );

      throw error;
    }

    if (
      result.status === "error" &&
      result.errorCode === "MetaCapiNetworkError"
    ) {
      const error = new Error(
        result.errorMessage ?? "Meta CAPI network request failed"
      );

      await this.recordAttempt(
        job,
        "failed",
        {
          conversionEventLogId: result.conversionEventLogId,
          workspaceId: result.workspaceId,
          resultStatus: result.status,
          errorCode: result.errorCode
        },
        error
      );

      throw error;
    }

    await this.recordAttempt(job, result.status, {
      conversionEventLogId: result.conversionEventLogId,
      workspaceId: result.workspaceId,
      resultStatus: result.status
    });

    return result;
  }

  private async resolveWorkspaceId(
    job: Job<ConversionEventWorkerPayload>
  ): Promise<string> {
    const declaredWorkspaceId = job.data.workspaceId?.trim();
    if (declaredWorkspaceId) {
      return declaredWorkspaceId;
    }

    const log = await this.prisma.conversionEventLog.findUnique({
      where: { id: job.data.conversionEventLogId },
      select: { workspaceId: true }
    });

    if (!log?.workspaceId) {
      throw new NotFoundException("Evento de conversão não encontrado");
    }

    const scopedData: ConversionEventJobPayload = {
      ...job.data,
      workspaceId: log.workspaceId
    };
    job.data = scopedData;

    if (typeof job.updateData === "function") {
      await job.updateData(scopedData);
    }

    return log.workspaceId;
  }

  private async recordAttempt(
    job: Job<ConversionEventWorkerPayload>,
    status: string,
    summaryPayload: Record<string, unknown>,
    error?: unknown
  ) {
    const now = new Date();

    try {
      await this.prisma.jobAttempt.create({
        data: {
          workspaceId:
            typeof summaryPayload.workspaceId === "string"
              ? summaryPayload.workspaceId
              : (job.data.workspaceId ?? null),
          queueName: CONVERSION_EVENTS_QUEUE,
          jobId: String(job.id ?? job.data.conversionEventLogId),
          jobName: job.name || "send-conversion-event",
          attemptNumber: (job.attemptsMade ?? 0) + 1,
          status,
          scheduledAt:
            typeof job.timestamp === "number" ? new Date(job.timestamp) : null,
          startedAt: now,
          finishedAt: now,
          nextRetryAt: null,
          source: "meta",
          relatedEntityType: "ConversionEventLog",
          relatedEntityId: job.data.conversionEventLogId,
          errorCode: null,
          errorMessage: error instanceof Error ? error.message : null,
          summaryPayload: this.toJsonSummary(summaryPayload)
        }
      });
    } catch {
      // Observability failure must not duplicate external provider side effects.
    }
  }

  private toJsonSummary(
    summaryPayload: Record<string, unknown>
  ): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(summaryPayload)) as Prisma.InputJsonValue;
  }
}
