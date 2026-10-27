import { Processor, WorkerHost } from "@nestjs/bullmq";
import { HttpException, Inject, Logger, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { DelayedError, UnrecoverableError, type Job } from "bullmq";
import {
  META_REPORT_SYNC_QUEUE,
  type MetaReportSyncJobPayload,
} from "../common/queue/queue.constants";
import { PrismaService } from "../common/prisma/prisma.service";
import { createBullJobId } from "../common/queue/job-id";
import {
  MetaCredentialInvalidError,
  isMetaCredentialFatalError,
  isMetaRateLimitError,
  sanitizedMetaGraphReason,
} from "../integrations/meta/meta-graph-error";
import {
  metaGraphAppScopeForCredentialLabel,
  runWithMetaGraphAppScope,
  type MetaGraphAppScope,
} from "../integrations/meta/meta-graph-usage";
import { MetaReportSyncThrottleService } from "./meta-report-sync-throttle.service";
import { MetaReportingService } from "./meta-reporting.service";

const DEFAULT_MAX_DEFERRALS = 12;

@Processor(META_REPORT_SYNC_QUEUE)
export class MetaReportSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(MetaReportSyncProcessor.name);

  constructor(
    @Inject(MetaReportingService)
    private readonly metaReportingService: MetaReportingService,
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(MetaReportSyncThrottleService)
    private readonly throttle?: MetaReportSyncThrottleService,
  ) {
    super();
  }

  async process(job: Job<MetaReportSyncJobPayload>, token?: string) {
    // nod: Meta's app-level limit is per app (PalmUP login vs own app), so the
    // job's Graph calls and throttle decisions run in its credential's scope.
    const appScope = this.throttle ? await this.jobAppScope(job) : null;

    return runWithMetaGraphAppScope(appScope, () =>
      this.processInScope(job, token),
    );
  }

  private async processInScope(
    job: Job<MetaReportSyncJobPayload>,
    token?: string,
  ) {
    const deferrals = job.data.deferrals ?? 0;
    const adAccountIds = this.throttle ? await this.jobAdAccountIds(job) : [];

    if (this.throttle) {
      const deferral = await this.throttle.deferralFor(adAccountIds, deferrals);

      if (deferral) {
        return this.defer(job, token, deferral.untilMs, deferral.reason);
      }
    }

    try {
      const result = await this.metaReportingService.syncWorkspaceMetaStructure(
        {
          workspaceId: job.data.workspaceId,
          businessConnectionId: job.data.businessConnectionId,
          reportingAccountId: job.data.reportingAccountId,
          since: job.data.since,
          until: job.data.until,
          ...(job.data.totalsSince
            ? { totalsSince: job.data.totalsSince }
            : {}),
        },
      );

      await this.recordAttempt(job, "completed", {
        workspaceId: result.workspaceId,
        businessConnectionId: job.data.businessConnectionId,
        reportingAccountId: job.data.reportingAccountId,
        accountsSynced: result.accountsSynced,
        accountsFailed: result.accountsFailed,
        campaignsSynced: result.campaignsSynced,
        adSetsSynced: result.adSetsSynced,
        adsSynced: result.adsSynced,
        resultStatus: "completed",
      });
      // Share what this run observed with other replicas.
      await this.throttle?.deferralFor(adAccountIds, 0);

      return result;
    } catch (error) {
      if (this.throttle && isMetaRateLimitError(error)) {
        await this.throttle.recordRateLimitError(
          error,
          adAccountIds,
          deferrals,
        );

        return this.defer(
          job,
          token,
          Date.now() + this.throttle.backoffMs(deferrals),
          "rate_limited",
        );
      }

      const unrecoverable = this.isUnrecoverable(error);

      await this.recordAttempt(
        job,
        "failed",
        {
          workspaceId: job.data.workspaceId,
          businessConnectionId: job.data.businessConnectionId,
          reportingAccountId: job.data.reportingAccountId,
          since: job.data.since,
          until: job.data.until,
          ...(unrecoverable ? { retry: "disabled" } : {}),
        },
        error,
      );

      if (unrecoverable) {
        // Retrying a dead credential or a deterministic state error only
        // burns the Meta application rate limit.
        throw new UnrecoverableError(
          error instanceof Error ? error.message : "Meta sync unrecoverable",
        );
      }

      throw error;
    }
  }

  private isUnrecoverable(error: unknown): boolean {
    if (
      error instanceof MetaCredentialInvalidError ||
      isMetaCredentialFatalError(error)
    ) {
      return true;
    }

    if (error instanceof HttpException) {
      const status = error.getStatus();

      return status >= 400 && status < 500;
    }

    return false;
  }

  private async defer(
    job: Job<MetaReportSyncJobPayload>,
    token: string | undefined,
    untilMs: number,
    reason: string,
  ): Promise<{ skipped: true; reason: string }> {
    const deferrals = (job.data.deferrals ?? 0) + 1;
    const summary = {
      workspaceId: job.data.workspaceId,
      businessConnectionId: job.data.businessConnectionId,
      reportingAccountId: job.data.reportingAccountId,
      since: job.data.since,
      until: job.data.until,
      deferrals,
      reason,
    };

    if (deferrals > this.maxDeferrals()) {
      // Give up quietly: the next scheduled sweep covers the period again.
      await this.recordAttempt(job, "skipped", {
        ...summary,
        resultStatus: "skipped_rate_limited",
      });
      this.logger.warn(`META_REPORT_SYNC_SKIPPED_RATE_LIMIT reason=${reason}`);

      return { skipped: true, reason };
    }

    if (!token || typeof job.moveToDelayed !== "function") {
      // Without a worker lock token BullMQ cannot delay in place.
      throw new Error("Meta rate limit active; sync deferred");
    }

    await job.updateData({ ...job.data, deferrals });
    await job.moveToDelayed(Math.ceil(untilMs), token);
    await this.recordAttempt(job, "deferred", {
      ...summary,
      resumeAt: new Date(untilMs).toISOString(),
    });
    this.logger.warn(
      `META_REPORT_SYNC_DEFERRED reason=${reason} deferrals=${deferrals} delayMs=${Math.max(0, Math.round(untilMs - Date.now()))}`,
    );

    // Tells BullMQ the job was moved to delayed (no attempt consumed).
    throw new DelayedError();
  }

  private maxDeferrals(): number {
    const parsed = Number.parseInt(
      process.env.WPPTRACK_META_SYNC_MAX_DEFERRALS ?? "",
      10,
    );

    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_MAX_DEFERRALS;
  }

  private async jobAdAccountIds(
    job: Job<MetaReportSyncJobPayload>,
  ): Promise<string[]> {
    try {
      const accounts = await this.prisma.metaReportingAccount.findMany({
        where: {
          workspaceId: job.data.workspaceId,
          active: true,
          ...(job.data.reportingAccountId
            ? { id: job.data.reportingAccountId }
            : {}),
          ...(job.data.businessConnectionId
            ? { businessConnectionId: job.data.businessConnectionId }
            : {}),
        },
        select: { adAccountId: true },
      });

      return accounts.map((account) => account.adAccountId);
    } catch {
      return [];
    }
  }

  /**
   * PalmUP social login credentials share the PalmUP Meta app; any other
   * token (own app, legacy OAuth) is the "own" scope. Unknown -> null, which
   * keeps the single installation-wide app entry (SaaS behaviour).
   */
  private async jobAppScope(
    job: Job<MetaReportSyncJobPayload>,
  ): Promise<MetaGraphAppScope | null> {
    if (!job.data.businessConnectionId) {
      return "own";
    }

    try {
      const connection = (await this.prisma.metaBusinessConnection.findFirst({
        where: {
          id: job.data.businessConnectionId,
          workspaceId: job.data.workspaceId,
        },
        select: { credential: { select: { label: true } } },
      })) as { credential: { label: string | null } | null } | null;

      return connection?.credential
        ? metaGraphAppScopeForCredentialLabel(connection.credential.label)
        : null;
    } catch {
      return null;
    }
  }

  private async recordAttempt(
    job: Job<MetaReportSyncJobPayload>,
    status: string,
    summaryPayload: Record<string, unknown>,
    error?: unknown,
  ) {
    const now = new Date();

    try {
      await this.prisma.jobAttempt.create({
        data: {
          workspaceId: job.data.workspaceId,
          queueName: META_REPORT_SYNC_QUEUE,
          jobId: String(
            job.id ?? createBullJobId("meta-report-sync", job.data.workspaceId),
          ),
          jobName: job.name || "sync-meta-reporting",
          attemptNumber: (job.attemptsMade ?? 0) + 1,
          status,
          scheduledAt:
            typeof job.timestamp === "number" ? new Date(job.timestamp) : null,
          startedAt: now,
          finishedAt: now,
          nextRetryAt: null,
          source: "meta",
          relatedEntityType: "Workspace",
          relatedEntityId: job.data.workspaceId,
          errorCode:
            error &&
            (isMetaCredentialFatalError(error) || isMetaRateLimitError(error))
              ? sanitizedMetaGraphReason(error)
              : error instanceof MetaCredentialInvalidError
                ? error.reason
                : null,
          errorMessage: error instanceof Error ? error.message : null,
          summaryPayload: this.toJsonSummary(summaryPayload),
        },
      });
    } catch {
      // Observability failure must not abort a completed Meta sync.
    }
  }

  private toJsonSummary(
    summaryPayload: Record<string, unknown>,
  ): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(summaryPayload)) as Prisma.InputJsonValue;
  }
}
