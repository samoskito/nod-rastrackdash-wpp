import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Job } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import { ConversionEventsService } from "../../conversion-events/conversion-events.service";
import {
  DIAGNOSTIC_QUEUE,
  type DiagnosticJobPayload
} from "./queue.constants";

@Processor(DIAGNOSTIC_QUEUE)
export class DiagnosticProcessor extends WorkerHost {
  constructor(
    @Inject(ConversionEventsService)
    private readonly conversionEventsService: ConversionEventsService,
    @Inject(PrismaService)
    private readonly prisma: PrismaService
  ) {
    super();
  }

  async process(job: Job<DiagnosticJobPayload>) {
    const { conversionEventLogId, diagnosticEventId } = job.data;

    try {
      const diagnosticEvent = await this.prisma.diagnosticEvent.findUnique({
        where: {
          id: diagnosticEventId,
          workspaceId: job.data.workspaceId
        },
        select: { id: true }
      });

      if (!diagnosticEvent) {
        throw new NotFoundException("Evento de diagnóstico não encontrado");
      }

      if (conversionEventLogId) {
        const result = await this.conversionEventsService.sendReadyEvent(
          conversionEventLogId,
          { workspaceId: job.data.workspaceId }
        );

        await this.recordAttempt(job, result.status, {
          action: "conversion_event_retry",
          conversionEventLogId,
          resultStatus: result.status,
          retryReason: job.data.retryReason
        });

        return {
          diagnosticEventId,
          action: "conversion_event_retry",
          result
        };
      }

      await this.recordAttempt(job, "skipped", {
        action: "skipped",
        reason: "unsupported_diagnostic_event"
      });

      return {
        diagnosticEventId,
        action: "skipped",
        reason: "unsupported_diagnostic_event"
      };
    } catch (error) {
      await this.recordAttempt(
        job,
        "failed",
        {
          action: conversionEventLogId ? "conversion_event_retry" : "skipped",
          conversionEventLogId
        },
        error
      );

      throw error;
    }
  }

  private async recordAttempt(
    job: Job<DiagnosticJobPayload>,
    status: string,
    summaryPayload: Record<string, unknown>,
    error?: unknown
  ) {
    const now = new Date();

    try {
      await this.prisma.jobAttempt.create({
        data: {
          workspaceId: job.data.workspaceId,
          queueName: DIAGNOSTIC_QUEUE,
          jobId: String(job.id ?? job.data.diagnosticEventId),
          jobName: job.name || "retry-diagnostic-event",
          attemptNumber: (job.attemptsMade ?? 0) + 1,
          status,
          scheduledAt:
            typeof job.timestamp === "number" ? new Date(job.timestamp) : null,
          startedAt: now,
          finishedAt: now,
          nextRetryAt: null,
          source: job.data.source,
          relatedEntityType: "DiagnosticEvent",
          relatedEntityId: job.data.diagnosticEventId,
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
