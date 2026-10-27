import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  DiagnosticAuditLogDto,
  DiagnosticAuditLogListQueryDto,
  DiagnosticConversionEventLogDto,
  DiagnosticConversionEventLogListQueryDto,
  DiagnosticSourceDto,
  DiagnosticEventCreateDto,
  DiagnosticEventDetailDto,
  DiagnosticEventDto,
  DiagnosticEventListQueryDto,
  DiagnosticIntegrationLogDto,
  DiagnosticIntegrationLogListQueryDto,
  DiagnosticJobAttemptDto,
  DiagnosticJobAttemptListQueryDto,
  DiagnosticWebhookLogDto,
  DiagnosticWebhookLogListQueryDto,
  DiagnosticWebhookPayloadDto,
  DiagnosticTimelineItemDto,
  DiagnosticRetryInputDto,
  DiagnosticRetryResultDto,
  DiagnosticSummaryDto,
  DiagnosticSummaryQueryDto
} from "@wpptrack/shared";
import { authorizedCtwaDestinationSchema } from "@wpptrack/shared";
import { safeErrorName } from "../common/errors/safe-error-name";
import { isCrmCtwaContext } from "../crm-channels/crm-ctwa-context";
import { resolveCtwaDestination } from "../inbound-webhooks/authorized-ctwa-destination";
import { inboundMetaRouteMatches } from "../inbound-webhooks/inbound-webhook-meta-route-eligibility";
import { InboundWebhookMetaRouteReaderService } from "../inbound-webhooks/inbound-webhook-meta-route-reader.service";
import { PrismaService } from "../common/prisma/prisma.service";
import { ConversionEventsQueueService } from "../common/queue/conversion-events-queue.service";
import { DiagnosticsQueueService } from "../common/queue/diagnostics-queue.service";
import { createBullJobId } from "../common/queue/job-id";
import { CONVERSION_EVENTS_QUEUE } from "../common/queue/queue.constants";
import {
  BLOCKED_CONVERSION_RETRY_LIMIT,
  canRetryConversionEvent,
  isConfigurationBlockedConversionEvent,
  isFixableMetaRejectionConversionEvent,
  isMetaAuthFailureConversionEvent,
  isOutsideMetaEventTimeWindow
} from "../conversion-events/conversion-event-retry";
import {
  findPriorLeadLifetimeConversion,
  isLeadLifetimeEvent,
  MANUAL_CONVERSION_TRIGGER,
  pipelineOf,
  resolveLeadConversionIdentity,
  UAZAPI_AUTO_LEAD_TRIGGER
} from "../conversion-events/lead-lifetime-conversion-guard";
import { isBridgedWhatsappProvider } from "../inbound-webhooks/bridged-whatsapp-providers";
import { CTWA_DESTINATION_PROVIDER } from "../inbound-webhooks/authorized-ctwa-destination";
import { effectiveUnnichatMetaRouting } from "../inbound-webhooks/inbound-webhook-effective-meta-routing";

/** Meta login failure older than Meta's 7-day event_time window: never resent. */
class MetaEventTimeExpiredRetryError extends BadRequestException {
  constructor() {
    super(
      "Evento com mais de 7 dias: a Meta não aceita mais este event_time"
    );
  }
}

/**
 * 1.3.1: "Reenviar recusados" de um evento cuja rota Meta atual (do número
 * ou do anúncio) não está pronta. Fica de fora por configuração, não por já
 * ter sido reenviado; o lote conta à parte (notReady).
 */
class RouteNotReadyRetryError extends BadRequestException {}

/**
 * 1.3.1: o destino atual do reenvio já recebeu este evento de uma vez por
 * lead (LeadSubmitted, QualifiedLead) por outro log do mesmo lead: reenviar
 * mandaria uma segunda conversão. O lote conta à parte (alreadyConverted).
 */
class LeadAlreadyConvertedRetryError extends ConflictException {
  constructor() {
    super(
      "Lead já convertido para este pixel por outro evento: o recusado não é reenviado"
    );
  }
}

const ROUTE_NOT_READY_MESSAGE =
  "A rota Meta do número ainda não está pronta (página e pixel). Corrija em Integrações e reenvie";
const ACCOUNT_ROUTE_NOT_READY_MESSAGE =
  "A conta Meta deste evento está sem destino de conversão pronto (anúncio, conta ou conexão). Corrija em Integrações e reenvie";

const sensitiveKeyPattern =
  /(authorization|cookie|secret|token|api.?key|refresh|password)/i;

type DiagnosticEventRecord = {
  id: string;
  workspaceId: string | null;
  source: DiagnosticEventDto["source"];
  eventType: string;
  severity: DiagnosticEventDto["severity"];
  status: string;
  occurredAt: Date;
  title: string;
  message: string;
  leadId: string | null;
  phoneHash: string | null;
  campaignId: string | null;
  adSetId: string | null;
  adId: string | null;
  jobId: string | null;
  errorCode: string | null;
  summaryPayload?: unknown;
  webhookLogId?: string | null;
  integrationLogId?: string | null;
  conversionEventLogId?: string | null;
  jobAttemptId?: string | null;
};

type WebhookLogRecord = {
  id: string;
  workspaceId: string | null;
  whatsappInstanceId: string | null;
  source: DiagnosticSourceDto;
  eventType: string;
  externalEventId: string | null;
  status: string;
  receivedAt: Date;
  processedAt: Date | null;
  leadId: string | null;
  phoneHash: string | null;
  campaignId: string | null;
  adSetId: string | null;
  adId: string | null;
  jobId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  payloadHash: string | null;
  summaryPayload?: unknown;
};

type AuditLogRecord = {
  id: string;
  workspaceId: string | null;
  actorUserId: string | null;
  actorType: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string | null;
  sourceIp: string | null;
  resultStatus: string;
  createdAt: Date;
  beforeSummary?: unknown;
  afterSummary?: unknown;
};

type JobAttemptRecord = {
  id: string;
  workspaceId: string | null;
  queueName: string;
  jobId: string;
  jobName: string;
  attemptNumber: number;
  status: string;
  scheduledAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  nextRetryAt: Date | null;
  source: DiagnosticSourceDto;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  summaryPayload?: unknown;
};

type IntegrationLogRecord = {
  id: string;
  workspaceId: string | null;
  source: DiagnosticSourceDto;
  operation: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  httpStatus: number | null;
  providerRequestId: string | null;
  providerErrorCode: string | null;
  providerErrorMessage: string | null;
  leadId: string | null;
  campaignId: string | null;
  adSetId: string | null;
  adId: string | null;
  jobId: string | null;
};

type ConversionEventLogRecord = {
  id: string;
  workspaceId: string | null;
  leadId: string | null;
  phoneHash: string | null;
  sourceTrigger: string;
  eventId: string | null;
  eventName: string;
  status: string;
  pixelId: string | null;
  pageId?: string | null;
  sourcePayload?: unknown;
  metaAccountId: string | null;
  metaBusinessConnectionId?: string | null;
  metaConversionDestinationId?: string | null;
  campaignId: string | null;
  adSetId: string | null;
  adId: string | null;
  attributionStatus: string | null;
  dedupeKey: string | null;
  ctwaClid: string | null;
  valueCents: number | null;
  valueSource: "actual" | "configured_average" | "manual" | null;
  currency: string | null;
  contentName: string | null;
  customData?: unknown;
  sentAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  jobId: string | null;
  createdAt: Date;
  eventOccurredAt?: Date | null;
  providerResponseSummary?: unknown;
};

export type ConversionEventRetryContext = {
  workspaceId?: string;
  actorUserId?: string | null;
  actorType?: string;
  transientOnly?: boolean;
  allowConfigurationBlocked?: boolean;
  requesterLabel?: string;
};

export type BulkConversionRetryResult = {
  claimed: number;
  enqueued: number;
  /** Not resent; includes `expired`. */
  skipped: number;
  /** Skipped because the event is older than Meta's 7-day window. */
  expired: number;
  /**
   * Part of skipped (Reenviar recusados): the current Meta route of the
   * number or of the ad is not ready, so it stays out by configuration.
   */
  notReady: number;
  /**
   * Part of skipped (Reenviar recusados): the current destination already has
   * this once-per-lead event from another log of the same lead.
   */
  alreadyConverted: number;
  failed: number;
};

export type WebhookLogInput = {
  workspaceId?: string;
  whatsappInstanceId?: string;
  source: DiagnosticSourceDto;
  eventType: string;
  externalEventId?: string;
  idempotencyKey?: string;
  /**
   * Canonical SHA-256 fingerprint of the received payload. Only the
   * WAHA/Z-API receiver computes and sends this today; when absent (Meta,
   * Uazapi), idempotencyKey collisions are always treated as a plain
   * replay, exactly as before this field existed.
   */
  payloadHash?: string;
  leadId?: string;
  phoneHash?: string;
  campaignId?: string;
  adSetId?: string;
  adId?: string;
  summaryPayload?: Record<string, unknown>;
};

export type WebhookLogResult = {
  webhookLogId: string;
  diagnosticEventId: string;
  /**
   * "received" means the caller now owns the delivery and must settle it
   * with markWebhookLogProcessed/markWebhookLogFailed. It covers both a
   * brand-new row and a retry that reclaimed a previously failed one.
   *
   * "duplicate" means the delivery must not be processed: it either
   * already completed, or another request is holding the claim right now.
   *
   * "conflict" means the same idempotencyKey/externalEventId arrived with a
   * divergent payloadHash: the delivery was quarantined as its own
   * WebhookLog row and the original record was left untouched.
   */
  status: "received" | "duplicate" | "conflict";
};

type DiagnosticActorContext = {
  actorUserId: string | null;
  sourceIp?: string | null;
};

const failedStatuses = ["error", "failed"];

/**
 * WebhookLog lifecycle used by the per-connection receiver.
 *
 * "received" doubles as the in-flight claim: exactly one request holds a row
 * in this state, either by winning the idempotencyKey INSERT or by taking
 * over a previously failed row. It settles on "processed" (downstream work
 * completed) or "failed" (downstream work threw), and only a settled-failed
 * row can be claimed again.
 *
 * Callers that never settle their row (Meta, Uazapi) keep the pre-existing
 * behavior: the row stays "received" and replays are duplicates.
 */
const webhookLogInFlightStatus = "received";
const webhookLogProcessedStatus = "processed";
const webhookLogFailedStatus = "failed";
const webhookReceiverFailureCode = "receiver_processing_failed";

@Injectable()
export class DiagnosticsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional()
    @Inject(DiagnosticsQueueService)
    private readonly diagnosticsQueueService?: DiagnosticsQueueService,
    @Optional()
    @Inject(ConversionEventsQueueService)
    private readonly conversionEventsQueueService?: ConversionEventsQueueService
  ) {}

  async recordEvent(
    input: DiagnosticEventCreateDto
  ): Promise<DiagnosticEventDetailDto> {
    const event = (await this.prisma.diagnosticEvent.create({
      data: {
        workspaceId: input.workspaceId ?? null,
        source: input.source,
        eventType: input.eventType,
        severity: input.severity,
        status: input.status,
        occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
        title: input.title,
        message: input.message,
        leadId: input.leadId ?? null,
        phoneHash: input.phoneHash ?? null,
        campaignId: input.campaignId ?? null,
        adSetId: input.adSetId ?? null,
        adId: input.adId ?? null,
        jobId: input.jobId ?? null,
        errorCode: input.errorCode ?? null,
        summaryPayload: input.summaryPayload
          ? (this.redactSensitive(
              input.summaryPayload
            ) as Prisma.InputJsonValue)
          : undefined
      }
    })) as DiagnosticEventRecord;

    return this.toDetailDto(event, [this.eventTimelineItem(event)]);
  }

  async recordWebhookLog(input: WebhookLogInput): Promise<WebhookLogResult> {
    if (!input.idempotencyKey) {
      return this.persistWebhookLog(input, "received");
    }

    // Create-first, catch-and-refetch on P2002: this makes concurrent
    // deliveries of the same idempotencyKey deterministic. Whichever
    // request's INSERT the database commits first wins the unique
    // constraint and returns "received"; the other necessarily observes a
    // P2002 and resolves against the row that actually persisted, instead
    // of racing a find-then-create check that both requests could pass at
    // once.
    try {
      return await this.persistWebhookLog(input, "received");
    } catch (error) {
      if (!this.isIdempotencyKeyConflict(error)) {
        throw error;
      }

      return this.resolveIdempotencyConflict(input);
    }
  }

  private async resolveIdempotencyConflict(
    input: WebhookLogInput
  ): Promise<WebhookLogResult> {
    const existing = (await this.prisma.webhookLog.findUnique({
      where: { idempotencyKey: input.idempotencyKey! }
    })) as WebhookLogRecord | null;

    if (!existing) {
      // The row that caused the unique violation an instant ago is gone.
      // This should not happen with a durable unique constraint; fail
      // closed instead of silently dropping the delivery.
      throw new ConflictException(
        "Não foi possível resolver a colisão do idempotencyKey"
      );
    }

    if (
      existing.workspaceId !== (input.workspaceId ?? null) ||
      existing.source !== input.source
    ) {
      throw new ConflictException(
        "Webhook idempotency key belongs to another context"
      );
    }

    if (this.payloadHashesDiverge(existing.payloadHash, input.payloadHash)) {
      // Same externalEventId/idempotencyKey, different payload: quarantine
      // the divergent delivery as its own WebhookLog row instead of
      // trusting or overwriting the original. It gets no idempotencyKey of
      // its own, so it can never collide with (or be mistaken for) the
      // original record.
      return this.persistWebhookLog(input, "conflict", {
        idempotencyKey: null,
        errorCode: "idempotency_payload_mismatch",
        errorMessage: `Payload diverge do registro original (webhookLogId=${existing.id})`
      });
    }

    const existingEvents = (await this.prisma.diagnosticEvent.findMany({
      where: { webhookLogId: existing.id },
      orderBy: { occurredAt: "asc" },
      take: 1
    })) as DiagnosticEventRecord[];
    const diagnosticEventId = existingEvents[0]?.id ?? existing.id;

    if (failedStatuses.includes(existing.status)) {
      return this.claimFailedWebhookLog(existing.id, diagnosticEventId);
    }

    return {
      webhookLogId: existing.id,
      diagnosticEventId,
      status: "duplicate"
    };
  }

  /**
   * A delivery whose downstream processing failed must stay reprocessable:
   * the provider's retry carries the same idempotencyKey and would otherwise
   * be answered as a duplicate forever, silently dropping the delivery.
   *
   * The takeover is one conditional UPDATE (still failed -> back in flight),
   * so it is also the concurrency guard: two retries racing the same failed
   * row both issue it, the database serializes them, and only the one whose
   * WHERE still matched reports count 1. The loser is answered as a
   * duplicate rather than processing the delivery a second time in parallel.
   */
  private async claimFailedWebhookLog(
    webhookLogId: string,
    diagnosticEventId: string
  ): Promise<WebhookLogResult> {
    const claimed = await this.prisma.webhookLog.updateMany({
      where: { id: webhookLogId, status: { in: failedStatuses } },
      data: {
        status: webhookLogInFlightStatus,
        processedAt: null,
        errorCode: null,
        errorMessage: null
      }
    });

    return {
      webhookLogId,
      diagnosticEventId,
      status: claimed.count === 1 ? "received" : "duplicate"
    };
  }

  /**
   * Settles an in-flight delivery as processed. Scoped to a row still held
   * by this request, so a late completion can never overwrite a row another
   * retry has already claimed. Returns whether the claim was still held.
   */
  async markWebhookLogProcessed(webhookLogId: string): Promise<boolean> {
    const updated = await this.prisma.webhookLog.updateMany({
      where: { id: webhookLogId, status: webhookLogInFlightStatus },
      data: {
        status: webhookLogProcessedStatus,
        processedAt: new Date(),
        errorCode: null,
        errorMessage: null
      }
    });

    return updated.count === 1;
  }

  /**
   * Settles an in-flight delivery as failed, which is what makes a later
   * retry reclaimable. Same claim scoping as markWebhookLogProcessed, and
   * processedAt stays null: it means "completed successfully at", never
   * "last touched at".
   */
  async markWebhookLogFailed(
    webhookLogId: string,
    error: unknown,
    errorCode: string = webhookReceiverFailureCode
  ): Promise<boolean> {
    const updated = await this.prisma.webhookLog.updateMany({
      where: { id: webhookLogId, status: webhookLogInFlightStatus },
      data: {
        status: webhookLogFailedStatus,
        processedAt: null,
        errorCode,
        errorMessage: this.describeWebhookFailure(error)
      }
    });

    return updated.count === 1;
  }

  /**
   * Downstream failures are recorded by error class only. Provider and ORM
   * errors routinely quote whatever they choked on - phone numbers, message
   * text, tokens - and WebhookLog.errorMessage is surfaced in the
   * diagnostics UI, so the raw message is never persisted.
   */
  private describeWebhookFailure(error: unknown): string {
    return `Falha no processamento do webhook (errorName=${safeErrorName(
      error
    )})`;
  }

  /**
   * Whether an idempotencyKey replay must be treated as divergent rather
   * than a plain replay.
   *
   * A replay is only trustworthy when both sides present the same
   * fingerprint. If exactly one side has one - most importantly a legacy row
   * written before payloadHash existed (NULL) being replayed by a
   * fingerprinted WAHA/Z-API delivery - the payloads cannot be proven equal,
   * so the delivery is quarantined as a conflict instead of being discarded
   * as a duplicate. Failing closed can only cost an extra quarantined row;
   * failing open silently drops a delivery that may not be a replay at all.
   *
   * When neither side has a fingerprint (Meta, Uazapi - the providers that
   * never compute one) there is nothing to compare and nothing new to
   * suspect, so the pre-existing replay behavior is preserved exactly.
   */
  private payloadHashesDiverge(
    existingHash: string | null,
    incomingHash: string | undefined
  ): boolean {
    if (!existingHash && !incomingHash) {
      return false;
    }

    return existingHash !== (incomingHash ?? null);
  }

  private async persistWebhookLog(
    input: WebhookLogInput,
    status: "received" | "conflict",
    overrides: {
      idempotencyKey?: string | null;
      errorCode?: string;
      errorMessage?: string;
    } = {}
  ): Promise<WebhookLogResult> {
    const idempotencyKey =
      "idempotencyKey" in overrides
        ? overrides.idempotencyKey ?? null
        : input.idempotencyKey ?? null;

    // WebhookLog and its DiagnosticEvent must land together: a WebhookLog
    // without a linked event (or vice versa) would leave the diagnostics
    // timeline inconsistent. Writing both inside one transaction also keeps
    // the create-first/P2002 recovery in recordWebhookLog() correct - if the
    // WebhookLog insert violates the idempotencyKey unique constraint, the
    // whole transaction rolls back before any DiagnosticEvent is written,
    // and the P2002 still propagates for the caller to catch.
    const { webhook, event } = await this.prisma.$transaction(async (tx) => {
      const webhook = await tx.webhookLog.create({
        data: {
          workspaceId: input.workspaceId ?? null,
          whatsappInstanceId: input.whatsappInstanceId ?? null,
          source: input.source,
          eventType: input.eventType,
          externalEventId: input.externalEventId ?? null,
          leadId: input.leadId ?? null,
          phoneHash: input.phoneHash ?? null,
          campaignId: input.campaignId ?? null,
          adSetId: input.adSetId ?? null,
          adId: input.adId ?? null,
          status,
          idempotencyKey,
          payloadHash: input.payloadHash ?? null,
          errorCode: overrides.errorCode ?? null,
          errorMessage: overrides.errorMessage ?? null,
          summaryPayload: input.summaryPayload
            ? (this.redactSensitive(
                input.summaryPayload
              ) as Prisma.InputJsonValue)
            : undefined
        }
      });
      const event = await tx.diagnosticEvent.create({
        data: {
          workspaceId: input.workspaceId ?? null,
          source: input.source,
          eventType: input.eventType,
          severity: status === "conflict" ? "warning" : "info",
          status,
          title:
            status === "conflict"
              ? `Webhook ${input.source} em conflito de idempotência`
              : `Webhook ${input.source} recebido`,
          message:
            status === "conflict"
              ? `Evento ${input.eventType} recebido com payload divergente do original para o mesmo identificador externo`
              : `Evento ${input.eventType} recebido para processamento`,
          leadId: input.leadId ?? null,
          phoneHash: input.phoneHash ?? null,
          campaignId: input.campaignId ?? null,
          adSetId: input.adSetId ?? null,
          adId: input.adId ?? null,
          webhookLogId: webhook.id,
          summaryPayload: input.summaryPayload
            ? (this.redactSensitive(
                input.summaryPayload
              ) as Prisma.InputJsonValue)
            : undefined
        }
      });

      return { webhook, event };
    });

    return {
      webhookLogId: webhook.id,
      diagnosticEventId: event.id,
      status
    };
  }

  /**
   * Only the idempotencyKey unique constraint is a "same delivery raced
   * itself" signal we know how to resolve. Any other P2002 (a future unique
   * constraint added to WebhookLog, or one on an unrelated table reached
   * through the same transaction) is a genuine, unrelated failure and must
   * propagate instead of being silently reinterpreted as a replay/conflict.
   */
  private isIdempotencyKeyConflict(error: unknown): boolean {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== "P2002"
    ) {
      return false;
    }

    const target = error.meta?.target;

    if (Array.isArray(target)) {
      return target.includes("idempotencyKey");
    }

    return typeof target === "string" && target.includes("idempotencyKey");
  }

  async getSummary(
    query: DiagnosticSummaryQueryDto
  ): Promise<DiagnosticSummaryDto> {
    const until = query.until ? new Date(query.until) : new Date();
    const since = query.since
      ? new Date(query.since)
      : new Date(until.getTime() - 24 * 60 * 60 * 1000);
    const workspaceFilter = query.workspaceId
      ? { workspaceId: query.workspaceId }
      : {};

    const diagnosticEventWhere: Prisma.DiagnosticEventWhereInput = {
      ...workspaceFilter,
      occurredAt: {
        gte: since,
        lte: until
      }
    };
    const webhookWhere: Prisma.WebhookLogWhereInput = {
      ...workspaceFilter,
      receivedAt: {
        gte: since,
        lte: until
      }
    };
    const jobWhere: Prisma.JobAttemptWhereInput = {
      ...workspaceFilter,
      createdAt: {
        gte: since,
        lte: until
      }
    };
    const integrationWhere: Prisma.IntegrationLogWhereInput = {
      ...workspaceFilter,
      startedAt: {
        gte: since,
        lte: until
      }
    };
    const conversionWhere: Prisma.ConversionEventLogWhereInput = {
      ...workspaceFilter,
      createdAt: {
        gte: since,
        lte: until
      }
    };
    const auditWhere: Prisma.AuditLogWhereInput = {
      ...workspaceFilter,
      createdAt: {
        gte: since,
        lte: until
      }
    };
    const metaReportingAccountWhere: Prisma.MetaReportingAccountWhereInput = {
      ...workspaceFilter
    };
    const metaCampaignWhere: Prisma.MetaCampaignWhereInput = {
      ...workspaceFilter
    };
    const metaConversionDestinationWhere: Prisma.MetaConversionDestinationWhereInput =
      { ...workspaceFilter };

    const [
      diagnosticEvents,
      criticalEvents,
      errorEvents,
      webhooks,
      failedWebhooks,
      jobs,
      failedJobs,
      integrationCalls,
      failedIntegrationCalls,
      conversionEvents,
      failedConversionEvents,
      auditLogs,
      metaReportingAccountsActive,
      metaReportingAccountsError,
      metaWhatsappNeedsReview,
      metaConversionDestinationsConfigured
    ] = await Promise.all([
      this.prisma.diagnosticEvent.count({ where: diagnosticEventWhere }),
      this.prisma.diagnosticEvent.count({
        where: {
          ...diagnosticEventWhere,
          severity: "critical"
        }
      }),
      this.prisma.diagnosticEvent.count({
        where: {
          ...diagnosticEventWhere,
          severity: {
            in: ["error", "critical"]
          }
        }
      }),
      this.prisma.webhookLog.count({ where: webhookWhere }),
      this.prisma.webhookLog.count({
        where: {
          ...webhookWhere,
          status: {
            in: failedStatuses
          }
        }
      }),
      this.prisma.jobAttempt.count({ where: jobWhere }),
      this.prisma.jobAttempt.count({
        where: {
          ...jobWhere,
          status: {
            in: failedStatuses
          }
        }
      }),
      this.prisma.integrationLog.count({ where: integrationWhere }),
      this.prisma.integrationLog.count({
        where: {
          ...integrationWhere,
          status: {
            in: failedStatuses
          }
        }
      }),
      this.prisma.conversionEventLog.count({ where: conversionWhere }),
      this.prisma.conversionEventLog.count({
        where: {
          ...conversionWhere,
          status: {
            in: failedStatuses
          }
        }
      }),
      this.prisma.auditLog.count({ where: auditWhere }),
      this.prisma.metaReportingAccount.count({
        where: {
          ...metaReportingAccountWhere,
          active: true
        }
      }),
      this.prisma.metaReportingAccount.count({
        where: {
          ...metaReportingAccountWhere,
          syncStatus: "error"
        }
      }),
      this.prisma.metaCampaign.count({
        where: {
          ...metaCampaignWhere,
          whatsappClassification: "needs_review"
        }
      }),
      this.prisma.metaConversionDestination.count({
        where: {
          ...metaConversionDestinationWhere,
          status: "configured"
        }
      })
    ]);

    const status =
      criticalEvents > 0 ||
      failedJobs > 0 ||
      failedIntegrationCalls > 0 ||
      failedConversionEvents > 0
        ? "critical"
        : errorEvents > 0 || failedWebhooks > 0
          ? "warning"
          : "healthy";

    return {
      generatedAt: new Date().toISOString(),
      range: {
        since: since.toISOString(),
        until: until.toISOString()
      },
      workspaceId: query.workspaceId ?? null,
      status,
      totals: {
        diagnosticEvents,
        criticalEvents,
        errorEvents,
        webhooks,
        failedWebhooks,
        jobs,
        failedJobs,
        integrationCalls,
        failedIntegrationCalls,
        conversionEvents,
        failedConversionEvents,
        auditLogs,
        metaReportingAccountsActive,
        metaReportingAccountsError,
        metaWhatsappNeedsReview,
        metaConversionDestinationConfigured:
          metaConversionDestinationsConfigured > 0
      }
    };
  }

  async listEvents(
    query: DiagnosticEventListQueryDto
  ): Promise<DiagnosticEventDto[]> {
    const where: Prisma.DiagnosticEventWhereInput = {};

    if (query.workspaceId) {
      where.workspaceId = query.workspaceId;
    }

    if (query.source) {
      where.source = query.source;
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.severity) {
      where.severity = query.severity;
    }

    if (query.eventType) {
      where.eventType = query.eventType;
    }

    if (query.since || query.until) {
      where.occurredAt = {
        ...(query.since ? { gte: new Date(query.since) } : {}),
        ...(query.until ? { lte: new Date(query.until) } : {})
      };
    }

    if (query.leadId) {
      where.leadId = query.leadId;
    }

    if (query.phoneHash) {
      where.phoneHash = query.phoneHash;
    }

    if (query.campaignId) {
      where.campaignId = query.campaignId;
    }

    if (query.adSetId) {
      where.adSetId = query.adSetId;
    }

    if (query.adId) {
      where.adId = query.adId;
    }

    if (query.errorCode) {
      where.errorCode = query.errorCode;
    }

    if (query.q) {
      where.OR = [
        { title: { contains: query.q, mode: "insensitive" } },
        { message: { contains: query.q, mode: "insensitive" } },
        { eventType: { contains: query.q, mode: "insensitive" } },
        { status: { contains: query.q, mode: "insensitive" } },
        { errorCode: { contains: query.q, mode: "insensitive" } }
      ];
    }

    const events = (await this.prisma.diagnosticEvent.findMany({
      where,
      orderBy: {
        occurredAt: "desc"
      },
      take: query.limit
    })) as DiagnosticEventRecord[];

    return events.map((event) => this.toDto(event));
  }

  async listWebhookLogs(
    query: DiagnosticWebhookLogListQueryDto
  ): Promise<DiagnosticWebhookLogDto[]> {
    const where: Prisma.WebhookLogWhereInput = {};
    const combinedFilters: Prisma.WebhookLogWhereInput[] = [];

    if (query.workspaceId) {
      where.workspaceId = query.workspaceId;
    }

    if (query.whatsappInstanceId) {
      combinedFilters.push({
        OR: [
          { whatsappInstanceId: query.whatsappInstanceId },
          { whatsappInstanceId: null }
        ]
      });
    }

    if (query.source) {
      where.source = query.source;
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.eventType) {
      where.eventType = query.eventType;
    }

    if (query.since || query.until) {
      where.receivedAt = {
        ...(query.since ? { gte: new Date(query.since) } : {}),
        ...(query.until ? { lte: new Date(query.until) } : {})
      };
    }

    if (query.leadId) {
      where.leadId = query.leadId;
    }

    if (query.phoneHash) {
      where.phoneHash = query.phoneHash;
    }

    if (query.campaignId) {
      where.campaignId = query.campaignId;
    }

    if (query.adSetId) {
      where.adSetId = query.adSetId;
    }

    if (query.adId) {
      where.adId = query.adId;
    }

    if (query.errorCode) {
      where.errorCode = query.errorCode;
    }

    if (query.q) {
      combinedFilters.push({
        OR: [
          { eventType: { contains: query.q, mode: "insensitive" } },
          { status: { contains: query.q, mode: "insensitive" } },
          { externalEventId: { contains: query.q, mode: "insensitive" } },
          { errorCode: { contains: query.q, mode: "insensitive" } },
          { errorMessage: { contains: query.q, mode: "insensitive" } }
        ]
      });
    }

    if (combinedFilters.length > 0) {
      where.AND = combinedFilters;
    }

    const webhooks = (await this.prisma.webhookLog.findMany({
      where,
      orderBy: {
        receivedAt: "desc"
      },
      skip: query.offset,
      take: query.limit
    })) as WebhookLogRecord[];

    return webhooks.map((webhook) => this.toWebhookLogDto(webhook));
  }

  async getWebhookPayload(
    id: string,
    actor: DiagnosticActorContext
  ): Promise<DiagnosticWebhookPayloadDto> {
    const webhook = (await this.prisma.webhookLog.findUnique({
      where: { id }
    })) as WebhookLogRecord | null;

    if (!webhook) {
      throw new NotFoundException("Webhook não encontrado");
    }

    const payload = this.toWebhookPayloadDto(webhook);

    await this.prisma.auditLog.create({
      data: {
        workspaceId: webhook.workspaceId,
        actorUserId: actor.actorUserId,
        actorType: "platform_operator",
        action: "diagnostic.webhook_payload_viewed",
        targetType: "WebhookLog",
        targetId: webhook.id,
        sourceIp: actor.sourceIp ?? null,
        resultStatus: "success",
        beforeSummary: undefined,
        afterSummary: this.redactSensitive({
          source: webhook.source,
          eventType: webhook.eventType,
          externalEventId: webhook.externalEventId,
          payloadKind: payload.payloadKind,
          payloadAvailable: payload.payloadAvailable
        }) as Prisma.InputJsonValue
      }
    });

    return payload;
  }

  async listJobAttempts(
    query: DiagnosticJobAttemptListQueryDto
  ): Promise<DiagnosticJobAttemptDto[]> {
    const where: Prisma.JobAttemptWhereInput = {};

    if (query.workspaceId) {
      where.workspaceId = query.workspaceId;
    }

    if (query.source) {
      where.source = query.source;
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.queueName) {
      where.queueName = query.queueName;
    }

    if (query.jobName) {
      where.jobName = query.jobName;
    }

    if (query.since || query.until) {
      where.createdAt = {
        ...(query.since ? { gte: new Date(query.since) } : {}),
        ...(query.until ? { lte: new Date(query.until) } : {})
      };
    }

    if (query.q) {
      where.OR = [
        { queueName: { contains: query.q, mode: "insensitive" } },
        { jobName: { contains: query.q, mode: "insensitive" } },
        { jobId: { contains: query.q, mode: "insensitive" } },
        { status: { contains: query.q, mode: "insensitive" } },
        { errorCode: { contains: query.q, mode: "insensitive" } },
        { errorMessage: { contains: query.q, mode: "insensitive" } }
      ];
    }

    const attempts = (await this.prisma.jobAttempt.findMany({
      where,
      orderBy: {
        createdAt: "desc"
      },
      take: query.limit
    })) as JobAttemptRecord[];

    return attempts.map((attempt) => this.toJobAttemptDto(attempt));
  }

  async listIntegrationLogs(
    query: DiagnosticIntegrationLogListQueryDto
  ): Promise<DiagnosticIntegrationLogDto[]> {
    const where: Prisma.IntegrationLogWhereInput = {};

    if (query.workspaceId) {
      where.workspaceId = query.workspaceId;
    }

    if (query.source) {
      where.source = query.source;
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.operation) {
      where.operation = query.operation;
    }

    if (query.since || query.until) {
      where.startedAt = {
        ...(query.since ? { gte: new Date(query.since) } : {}),
        ...(query.until ? { lte: new Date(query.until) } : {})
      };
    }

    if (query.leadId) {
      where.leadId = query.leadId;
    }

    if (query.campaignId) {
      where.campaignId = query.campaignId;
    }

    if (query.adSetId) {
      where.adSetId = query.adSetId;
    }

    if (query.adId) {
      where.adId = query.adId;
    }

    if (query.jobId) {
      where.jobId = query.jobId;
    }

    if (query.providerErrorCode) {
      where.providerErrorCode = query.providerErrorCode;
    }

    if (query.q) {
      where.OR = [
        { operation: { contains: query.q, mode: "insensitive" } },
        { status: { contains: query.q, mode: "insensitive" } },
        { providerRequestId: { contains: query.q, mode: "insensitive" } },
        { providerErrorCode: { contains: query.q, mode: "insensitive" } },
        { providerErrorMessage: { contains: query.q, mode: "insensitive" } }
      ];
    }

    const logs = (await this.prisma.integrationLog.findMany({
      where,
      orderBy: {
        startedAt: "desc"
      },
      take: query.limit
    })) as IntegrationLogRecord[];

    return logs.map((log) => this.toIntegrationLogDto(log));
  }

  async listConversionEventLogs(
    query: DiagnosticConversionEventLogListQueryDto
  ): Promise<DiagnosticConversionEventLogDto[]> {
    const where: Prisma.ConversionEventLogWhereInput = {};

    if (query.workspaceId) {
      where.workspaceId = query.workspaceId;
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.eventName) {
      where.eventName = query.eventName;
    }

    if (query.sourceTrigger) {
      where.sourceTrigger = query.sourceTrigger;
    }

    if (query.pixelId) {
      where.pixelId = query.pixelId;
    }

    if (query.since || query.until) {
      where.createdAt = {
        ...(query.since ? { gte: new Date(query.since) } : {}),
        ...(query.until ? { lte: new Date(query.until) } : {})
      };
    }

    if (query.leadId) {
      where.leadId = query.leadId;
    }

    if (query.phoneHash) {
      where.phoneHash = query.phoneHash;
    }

    if (query.campaignId) {
      where.campaignId = query.campaignId;
    }

    if (query.adSetId) {
      where.adSetId = query.adSetId;
    }

    if (query.adId) {
      where.adId = query.adId;
    }

    if (query.errorCode) {
      where.errorCode = query.errorCode;
    }

    if (query.q) {
      where.OR = [
        { eventName: { contains: query.q, mode: "insensitive" } },
        { status: { contains: query.q, mode: "insensitive" } },
        { sourceTrigger: { contains: query.q, mode: "insensitive" } },
        { errorCode: { contains: query.q, mode: "insensitive" } },
        { errorMessage: { contains: query.q, mode: "insensitive" } }
      ];
    }

    const logs = (await this.prisma.conversionEventLog.findMany({
      where,
      orderBy: {
        createdAt: "desc"
      },
      take: query.limit
    })) as ConversionEventLogRecord[];

    return logs.map((log) => this.toConversionEventLogDto(log));
  }

  async listAuditLogs(
    query: DiagnosticAuditLogListQueryDto
  ): Promise<DiagnosticAuditLogDto[]> {
    const where: Prisma.AuditLogWhereInput = {};

    if (query.workspaceId) {
      where.workspaceId = query.workspaceId;
    }

    if (query.actorUserId) {
      where.actorUserId = query.actorUserId;
    }

    if (query.actorType) {
      where.actorType = query.actorType;
    }

    if (query.action) {
      where.action = query.action;
    }

    if (query.targetType) {
      where.targetType = query.targetType;
    }

    if (query.targetId) {
      where.targetId = query.targetId;
    }

    if (query.resultStatus) {
      where.resultStatus = query.resultStatus;
    }

    if (query.since || query.until) {
      where.createdAt = {
        ...(query.since ? { gte: new Date(query.since) } : {}),
        ...(query.until ? { lte: new Date(query.until) } : {})
      };
    }

    if (query.q) {
      where.OR = [
        { action: { contains: query.q, mode: "insensitive" } },
        { actorType: { contains: query.q, mode: "insensitive" } },
        { targetType: { contains: query.q, mode: "insensitive" } },
        { targetId: { contains: query.q, mode: "insensitive" } },
        { resultStatus: { contains: query.q, mode: "insensitive" } },
        { reason: { contains: query.q, mode: "insensitive" } }
      ];
    }

    const logs = (await this.prisma.auditLog.findMany({
      where,
      orderBy: {
        createdAt: "desc"
      },
      take: query.limit
    })) as AuditLogRecord[];

    return logs.map((log) => this.toAuditLogDto(log));
  }

  async getEvent(id: string): Promise<DiagnosticEventDetailDto> {
    const event = (await this.prisma.diagnosticEvent.findUnique({
      where: { id }
    })) as DiagnosticEventRecord | null;

    if (!event) {
      throw new NotFoundException("Evento diagnóstico não encontrado");
    }

    return this.toDetailDto(event, await this.buildTimeline(event));
  }

  async retryEvent(
    id: string,
    input: DiagnosticRetryInputDto
  ): Promise<DiagnosticRetryResultDto> {
    const event = (await this.prisma.diagnosticEvent.findUnique({
      where: { id }
    })) as DiagnosticEventRecord | null;

    if (!event) {
      throw new NotFoundException("Evento diagnóstico não encontrado");
    }

    const auditLog = await this.prisma.auditLog.create({
      data: {
        workspaceId: event.workspaceId,
        actorType: "platform",
        action: "diagnostic.retry_requested",
        targetType: "DiagnosticEvent",
        targetId: event.id,
        reason: input.reason,
        resultStatus: "queued",
        beforeSummary: this.redactSensitive({
          status: event.status,
          source: event.source,
          eventType: event.eventType,
          jobId: event.jobId,
          errorCode: event.errorCode
        }) as Prisma.InputJsonValue,
        afterSummary: {
          retryStatus: "queued"
        }
      }
    });

    const jobAttempt = await this.prisma.jobAttempt.create({
      data: {
        workspaceId: event.workspaceId,
        queueName: "diagnostics.retry",
        jobId: `diagnostic-retry-${event.id}-${Date.now()}`,
        jobName: "retry-diagnostic-event",
        attemptNumber: 1,
        status: "queued",
        scheduledAt: new Date(),
        source: event.source,
        relatedEntityType: "DiagnosticEvent",
        relatedEntityId: event.id,
        errorCode: event.errorCode,
        summaryPayload: this.redactSensitive({
          diagnosticEventId: event.id,
          originalEventType: event.eventType,
          originalStatus: event.status,
          originalJobId: event.jobId,
          retryReason: input.reason
        }) as Prisma.InputJsonValue
      }
    });

    await this.diagnosticsQueueService?.enqueueRetry({
      diagnosticEventId: event.id,
      workspaceId: event.workspaceId ?? "platform",
      source: event.source,
      message: event.message,
      occurredAt: event.occurredAt.toISOString(),
      conversionEventLogId: event.conversionEventLogId ?? undefined,
      retryReason: input.reason
    });

    return {
      ok: true,
      status: "queued",
      diagnosticEventId: event.id,
      auditLogId: auditLog.id,
      jobAttemptId: jobAttempt.id
    };
  }

  async retryConversionEvent(
    id: string,
    input: DiagnosticRetryInputDto,
    context: ConversionEventRetryContext = {}
  ): Promise<DiagnosticRetryResultDto> {
    return this.performConversionEventRetry(id, input, context);
  }

  /**
   * "Reenviar recusados" de um evento (1.3.1): recusa da Meta com causa
   * corrigível, dentro dos 7 dias. Mesmo event_id; rota e destino
   * recalculados no envio (o pixel e a página da tentativa recusada são
   * apagados antes). A troca error -> ready_to_send é condicional: clique
   * duplo ou envio concorrente responde 409 e nada sai duas vezes.
   */
  async retryRejectedConversionEvent(
    id: string,
    input: DiagnosticRetryInputDto,
    context: ConversionEventRetryContext & { workspaceId: string }
  ): Promise<DiagnosticRetryResultDto> {
    return this.performConversionEventRetry(id, input, context, {
      fixableRejectionOnly: true
    });
  }

  /** "Reenviar recusados" em lote: até 500 por clique, como os bloqueados. */
  async retryRejectedConversionEvents(
    eventIds: string[],
    input: DiagnosticRetryInputDto,
    context: ConversionEventRetryContext & { workspaceId: string }
  ): Promise<BulkConversionRetryResult> {
    return this.retryConversionEventsInBulk(eventIds, input, context, {
      fixableRejectionOnly: true
    });
  }

  async retryBlockedConversionEvents(
    eventIds: string[],
    input: DiagnosticRetryInputDto,
    context: ConversionEventRetryContext & { workspaceId: string }
  ): Promise<BulkConversionRetryResult> {
    return this.retryConversionEventsInBulk(
      eventIds,
      input,
      {
        ...context,
        transientOnly: true,
        allowConfigurationBlocked: true
      },
      { configurationBlockedOnly: true }
    );
  }

  private async retryConversionEventsInBulk(
    eventIds: string[],
    input: DiagnosticRetryInputDto,
    context: ConversionEventRetryContext & { workspaceId: string },
    mode: { configurationBlockedOnly?: boolean; fixableRejectionOnly?: boolean }
  ): Promise<BulkConversionRetryResult> {
    const result = {
      claimed: 0,
      enqueued: 0,
      skipped: 0,
      expired: 0,
      notReady: 0,
      alreadyConverted: 0,
      failed: 0
    };

    for (const id of [...new Set(eventIds)].slice(
      0,
      BLOCKED_CONVERSION_RETRY_LIMIT
    )) {
      let claimed = false;
      try {
        await this.performConversionEventRetry(
          id,
          input,
          context,
          {
            ...mode,
            // Count completed steps even if queueing or audit persistence later fails.
            onClaimed: () => {
              claimed = true;
              result.claimed += 1;
            },
            onEnqueued: () => {
              result.enqueued += 1;
            }
          }
        );
      } catch (error) {
        if (
          !claimed &&
          (error instanceof NotFoundException ||
            error instanceof BadRequestException ||
            error instanceof ConflictException)
        ) {
          result.skipped += 1;
          if (error instanceof MetaEventTimeExpiredRetryError)
            result.expired += 1;
          if (error instanceof RouteNotReadyRetryError) result.notReady += 1;
          if (error instanceof LeadAlreadyConvertedRetryError)
            result.alreadyConverted += 1;
        } else {
          result.failed += 1;
        }
      }
    }

    return result;
  }

  private async performConversionEventRetry(
    id: string,
    input: DiagnosticRetryInputDto,
    context: ConversionEventRetryContext,
    progress: {
      configurationBlockedOnly?: boolean;
      /** 1.3.1: só recusas corrigíveis; rota recalculada no envio. */
      fixableRejectionOnly?: boolean;
      onClaimed?: () => void;
      onEnqueued?: () => void;
    } = {}
  ): Promise<DiagnosticRetryResultDto> {
    const conversionEvent = (await this.prisma.conversionEventLog.findUnique({
      where: { id }
    })) as ConversionEventLogRecord | null;

    if (
      !conversionEvent ||
      (context.workspaceId !== undefined &&
        conversionEvent.workspaceId !== context.workspaceId)
    ) {
      throw new NotFoundException("Conversão não encontrada");
    }

    const metaAuthFailure = isMetaAuthFailureConversionEvent(conversionEvent);
    const fixableRejection = progress.fixableRejectionOnly === true;

    if (fixableRejection) {
      if (!isFixableMetaRejectionConversionEvent(conversionEvent)) {
        throw new BadRequestException(
          "Evento não foi recusado pela Meta por uma causa que dá para corrigir no painel"
        );
      }
      // O reenvio mantém o event_time original; a Meta recusa depois de 7 dias.
      if (isOutsideMetaEventTimeWindow(conversionEvent)) {
        throw new MetaEventTimeExpiredRetryError();
      }
    }

    if (
      progress.configurationBlockedOnly &&
      !isConfigurationBlockedConversionEvent(conversionEvent) &&
      !metaAuthFailure
    ) {
      throw new BadRequestException(
        "Evento não está bloqueado por configuração nem falhou por login da Meta"
      );
    }

    // The resend keeps the original event_time; Meta refuses it after 7 days.
    if (
      context.allowConfigurationBlocked &&
      metaAuthFailure &&
      isOutsideMetaEventTimeWindow(conversionEvent)
    ) {
      throw new MetaEventTimeExpiredRetryError();
    }

    if (
      context.transientOnly === true &&
      !(context.allowConfigurationBlocked
        ? canRetryConversionEvent(conversionEvent)
        : conversionEvent.status === "error" &&
          conversionEvent.errorCode === "MetaCapiNetworkError")
    ) {
      throw new BadRequestException(
        context.allowConfigurationBlocked
          ? "Somente falhas transitórias ou bloqueios de configuração podem ser reenviados"
          : "Somente falhas transitórias de comunicação podem ser reenviadas"
      );
    }

    if (conversionEvent.status === "pending_value") {
      throw new BadRequestException(
        "Evento ainda precisa de valor antes do reenvio"
      );
    }

    if (conversionEvent.status === "pending_meta_context") {
      throw new BadRequestException(
        "Evento ainda precisa de contexto Meta antes do reenvio"
      );
    }

    if (conversionEvent.status === "not_eligible") {
      throw new BadRequestException(
        "Evento sem identificador de clique não é elegível para envio Meta"
      );
    }

    if (!conversionEvent.workspaceId) {
      throw new BadRequestException(
        "Evento sem workspace não pode ser reenviado"
      );
    }

    if (!this.conversionEventsQueueService) {
      throw new Error("ConversionEventsQueueService is required for retries");
    }

    // Recusado e enviado pelo destino CTWA (página + pixel autorizados do
    // número): o destino gravado no evento é refeito com a configuração
    // atual do número, ou o envio recusaria a mesma rota de novo.
    const refreshedSourcePayload = fixableRejection
      ? await this.refreshedCtwaSourcePayload(conversionEvent)
      : undefined;
    // Demais recusados: o destino gravado na tentativa recusada não pode
    // prender o reenvio (o par Página/Pixel é a identidade do destino:
    // corrigir o par cria ou escolhe OUTRO destino). Entradas e regras de
    // URL/número (inbound_webhook:<provedor>) refazem a rota atual; o resto
    // apaga o destino e mantém conta e conexão, e o envio cai no destino
    // atual do anúncio, da conta ou da conexão.
    const refreshedRoute =
      fixableRejection && !refreshedSourcePayload
        ? await this.refreshedRejectedRoute(conversionEvent)
        : undefined;
    // O destino mudou: confere de novo a regra de uma conversão por lead e
    // pixel (o guard só roda na criação do evento). Vale também para o CTWA,
    // cujo destino refeito vem no sourcePayload.
    const refreshedCtwaDestination = authorizedCtwaDestinationSchema.safeParse(
      refreshedSourcePayload?.ctwaDestination
    );
    if (refreshedCtwaDestination.success)
      await this.assertLeadNotConvertedElsewhere(
        conversionEvent,
        refreshedCtwaDestination.data.destinationId
      );
    if (refreshedRoute?.metaConversionDestinationId)
      await this.assertLeadNotConvertedElsewhere(
        conversionEvent,
        refreshedRoute.metaConversionDestinationId
      );

    const claimed = await this.prisma.conversionEventLog.updateMany({
      where: {
        id: conversionEvent.id,
        workspaceId: conversionEvent.workspaceId,
        status: conversionEvent.status,
        errorCode: conversionEvent.errorCode
      },
      data: {
        status: "ready_to_send",
        sentAt: null,
        errorCode: null,
        errorMessage: null,
        // Recusado: o pixel e a página gravados podem ser a causa (ex.: pixel
        // ligado a outra página). O envio resolve rota e destino de novo com
        // a configuração atual e grava os novos.
        ...(fixableRejection ? { pixelId: null, pageId: null } : {}),
        ...(refreshedRoute ?? {}),
        ...(refreshedSourcePayload
          ? { sourcePayload: refreshedSourcePayload as Prisma.InputJsonValue }
          : {})
      }
    });

    if (claimed.count !== 1) {
      throw new ConflictException(
        "O evento já foi alterado ou está aguardando reenvio"
      );
    }
    progress.onClaimed?.();

    let queued: Awaited<ReturnType<ConversionEventsQueueService["retrySend"]>>;

    try {
      queued = await this.conversionEventsQueueService.retrySend(
        conversionEvent.id,
        conversionEvent.workspaceId
      );
      progress.onEnqueued?.();
    } catch (error) {
      await this.prisma.conversionEventLog.updateMany({
        where: {
          id: conversionEvent.id,
          workspaceId: conversionEvent.workspaceId,
          status: "ready_to_send"
        },
        data: {
          status: conversionEvent.status,
          sentAt: conversionEvent.sentAt,
          jobId: conversionEvent.jobId,
          errorCode: conversionEvent.errorCode,
          errorMessage: conversionEvent.errorMessage,
          ...(fixableRejection
            ? {
                pixelId: conversionEvent.pixelId,
                pageId: conversionEvent.pageId ?? null
              }
            : {}),
          ...(refreshedRoute
            ? {
                metaAccountId: conversionEvent.metaAccountId,
                metaBusinessConnectionId:
                  conversionEvent.metaBusinessConnectionId ?? null,
                metaConversionDestinationId:
                  conversionEvent.metaConversionDestinationId ?? null
              }
            : {}),
          ...(refreshedSourcePayload
            ? {
                sourcePayload:
                  conversionEvent.sourcePayload as Prisma.InputJsonValue
              }
            : {})
        }
      });
      throw error;
    }

    const auditLog = await this.prisma.auditLog.create({
      data: {
        workspaceId: conversionEvent.workspaceId,
        actorUserId: context.actorUserId ?? null,
        actorType: context.actorType ?? "platform",
        action: fixableRejection
          ? "diagnostic.conversion_rejected_retry_requested"
          : "diagnostic.conversion_retry_requested",
        targetType: "ConversionEventLog",
        targetId: conversionEvent.id,
        reason: input.reason,
        resultStatus: "queued",
        beforeSummary: this.redactSensitive({
          status: conversionEvent.status,
          eventName: conversionEvent.eventName,
          sourceTrigger: conversionEvent.sourceTrigger,
          pixelId: conversionEvent.pixelId,
          pageId: conversionEvent.pageId ?? null,
          metaAccountId: conversionEvent.metaAccountId,
          metaBusinessConnectionId:
            conversionEvent.metaBusinessConnectionId ?? null,
          metaConversionDestinationId:
            conversionEvent.metaConversionDestinationId ?? null,
          ...(fixableRejection
            ? { sourcePayload: conversionEvent.sourcePayload ?? null }
            : {}),
          campaignId: conversionEvent.campaignId,
          adSetId: conversionEvent.adSetId,
          adId: conversionEvent.adId,
          dedupeKey: conversionEvent.dedupeKey,
          jobId: conversionEvent.jobId,
          errorCode: conversionEvent.errorCode,
          errorMessage: conversionEvent.errorMessage
        }) as Prisma.InputJsonValue,
        afterSummary: {
          retryStatus: "queued"
        }
      }
    });

    const jobId =
      queued.jobId ?? createBullJobId("conversion-send", conversionEvent.id);

    await this.prisma.conversionEventLog.update({
      where: { id: conversionEvent.id },
      data: {
        jobId
      }
    });

    const jobAttempt = await this.prisma.jobAttempt.create({
      data: {
        workspaceId: conversionEvent.workspaceId,
        queueName: CONVERSION_EVENTS_QUEUE,
        jobId,
        jobName: "send-ready-event",
        attemptNumber: 1,
        status: "queued",
        scheduledAt: new Date(),
        source: "meta",
        relatedEntityType: "ConversionEventLog",
        relatedEntityId: conversionEvent.id,
        errorCode: conversionEvent.errorCode,
        errorMessage: conversionEvent.errorMessage,
        summaryPayload: this.redactSensitive({
          conversionEventLogId: conversionEvent.id,
          originalStatus: conversionEvent.status,
          eventName: conversionEvent.eventName,
          sourceTrigger: conversionEvent.sourceTrigger,
          pixelId: conversionEvent.pixelId,
          campaignId: conversionEvent.campaignId,
          adSetId: conversionEvent.adSetId,
          adId: conversionEvent.adId,
          retryReason: input.reason
        }) as Prisma.InputJsonValue
      }
    });

    const diagnosticEvent = (await this.prisma.diagnosticEvent.create({
      data: {
        workspaceId: conversionEvent.workspaceId,
        source: "meta",
        eventType: "conversion.retry_requested",
        severity: "info",
        status: "queued",
        title: "Reenvio Meta CAPI enfileirado",
        message: `Reenvio do evento ${conversionEvent.eventName} solicitado ${context.requesterLabel ?? "pelo backoffice"}.`,
        leadId: conversionEvent.leadId,
        phoneHash: conversionEvent.phoneHash,
        campaignId: conversionEvent.campaignId,
        adSetId: conversionEvent.adSetId,
        adId: conversionEvent.adId,
        jobId,
        conversionEventLogId: conversionEvent.id,
        jobAttemptId: jobAttempt.id,
        summaryPayload: this.redactSensitive({
          previousStatus: conversionEvent.status,
          retryReason: input.reason,
          auditLogId: auditLog.id,
          jobAttemptId: jobAttempt.id
        }) as Prisma.InputJsonValue
      }
    })) as DiagnosticEventRecord;

    return {
      ok: true,
      status: "queued",
      diagnosticEventId: diagnosticEvent.id,
      auditLogId: auditLog.id,
      jobAttemptId: jobAttempt.id
    };
  }

  /**
   * Evento CTWA enviado pela página + pixel autorizados do número: refaz o
   * destino com a configuração atual do número. Sem rota pronta, o reenvio é
   * recusado com o motivo (o evento continua Falhou). Outros eventos: null
   * (a rota é resolvida no envio, pelo destino atual).
   */
  private async refreshedCtwaSourcePayload(
    conversionEvent: ConversionEventLogRecord
  ): Promise<Record<string, unknown> | null> {
    const source = conversionEvent.sourcePayload;
    if (!source || typeof source !== "object" || Array.isArray(source))
      return null;
    const payload = source as Record<string, unknown>;
    const intent = authorizedCtwaDestinationSchema.safeParse(
      payload.ctwaDestination
    );
    if (!intent.success) return null;

    const channel = await this.prisma.inboundWebhookChannel.findFirst({
      where: {
        id: intent.data.channelId,
        workspaceId: intent.data.workspaceId
      },
      include: { connection: true, routes: true }
    });
    if (!channel) {
      throw new RouteNotReadyRetryError(
        "O número deste evento não existe mais; o evento não pode ser reenviado"
      );
    }
    const resolved = await resolveCtwaDestination(
      this.prisma as never,
      channel as never,
      { crmAnyProvider: isCrmCtwaContext(source) }
    );
    if (resolved.kind !== "authorized_ctwa_destination") {
      throw new RouteNotReadyRetryError(ROUTE_NOT_READY_MESSAGE);
    }

    return { ...payload, ctwaDestination: resolved };
  }

  /**
   * Recusado fora do destino CTWA: o destino que o envio deve usar agora,
   * gravado no lugar do destino da tentativa recusada (que nunca é
   * reaproveitado). Sem rota pronta, o reenvio é recusado com o motivo e o
   * evento continua Falhou.
   * - inbound_webhook:<provedor> com anúncio: a rota atual do anúncio, como
   *   na criação. Entrada do número (inboundEventId): rota sem restrição e
   *   exatamente uma rota ativa e válida do número que case com ela. Regra do
   *   número (providerConversionExecutionId): a mesma escolha da compra
   *   (previewPurchaseRoute): ponte UAZAPI/WAHA e Unnichat que herda a rota do
   *   workspace usam a rota do anúncio; os demais, exatamente uma rota do
   *   número que resolva o anúncio.
   * - Demais com destino gravado (conversão manual, entrada da ponte, regras
   *   sem número): a mesma ordem do envio sem destino explícito: destino
   *   atual do anúncio, depois o da conta e por fim o padrão da conexão.
   *   Conta e conexão ficam.
   * - Sem destino gravado (rota antiga): nada muda.
   */
  private async refreshedRejectedRoute(
    conversionEvent: ConversionEventLogRecord
  ): Promise<{
    metaAccountId?: string | null;
    metaBusinessConnectionId?: string | null;
    metaConversionDestinationId?: string | null;
  }> {
    const workspaceId = conversionEvent.workspaceId;
    if (!workspaceId) return {};
    const adId = conversionEvent.adId?.trim() || null;
    const source =
      conversionEvent.sourcePayload &&
      typeof conversionEvent.sourcePayload === "object" &&
      !Array.isArray(conversionEvent.sourcePayload)
        ? (conversionEvent.sourcePayload as Record<string, unknown>)
        : {};

    if (conversionEvent.sourceTrigger.startsWith("inbound_webhook:") && adId) {
      const route = await this.currentInboundRoute(workspaceId, adId, source);
      return {
        metaAccountId: route.adAccountId,
        metaBusinessConnectionId: route.businessConnectionId,
        metaConversionDestinationId: route.conversionDestinationId
      };
    }

    if (!conversionEvent.metaConversionDestinationId) return {};
    if (!conversionEvent.metaAccountId)
      return { metaConversionDestinationId: null };

    const account = await this.prisma.metaReportingAccount.findFirst({
      where: { workspaceId, adAccountId: conversionEvent.metaAccountId },
      select: {
        id: true,
        active: true,
        businessConnectionId: true,
        conversionDestinationId: true
      }
    });
    if (!account?.active || !account.businessConnectionId)
      throw new RouteNotReadyRetryError(ACCOUNT_ROUTE_NOT_READY_MESSAGE);
    const connection = await this.prisma.metaBusinessConnection.findFirst({
      where: { id: account.businessConnectionId, workspaceId },
      select: { defaultConversionDestinationId: true }
    });
    const ad = adId
      ? await this.prisma.metaAd.findFirst({
          where: {
            workspaceId,
            adId,
            adAccountId: conversionEvent.metaAccountId
          },
          select: {
            destinationAssignment: {
              select: { reportingAccountId: true, conversionDestinationId: true }
            }
          }
        })
      : null;
    const adDestinationId =
      ad?.destinationAssignment?.reportingAccountId === account.id
        ? ad.destinationAssignment.conversionDestinationId
        : null;
    const destinationId =
      adDestinationId ??
      account.conversionDestinationId ??
      connection?.defaultConversionDestinationId ??
      null;
    const destination = destinationId
      ? await this.prisma.metaConversionDestination.findFirst({
          where: { id: destinationId, workspaceId, status: "configured" },
          select: { id: true }
        })
      : null;
    if (!destination)
      throw new RouteNotReadyRetryError(ACCOUNT_ROUTE_NOT_READY_MESSAGE);
    return { metaConversionDestinationId: destination.id };
  }

  /** Rota atual de um evento inbound_webhook:<provedor> com anúncio. */
  private async currentInboundRoute(
    workspaceId: string,
    adId: string,
    source: Record<string, unknown>
  ): Promise<{
    adAccountId: string;
    reportingAccountId: string;
    businessConnectionId: string;
    conversionDestinationId: string;
  }> {
    const reader = new InboundWebhookMetaRouteReaderService(
      this.prisma as never
    );
    const channelId =
      typeof source.channelId === "string" ? source.channelId : null;
    const ready = (route: {
      status: string;
      adAccountId: string | null;
      reportingAccountId: string | null;
      businessConnectionId: string | null;
      conversionDestinationId: string | null;
    }) =>
      route.status === "resolved" &&
      !!route.adAccountId &&
      !!route.reportingAccountId &&
      !!route.businessConnectionId &&
      !!route.conversionDestinationId;
    const notReady = () =>
      new RouteNotReadyRetryError(
        "A rota Meta do anúncio deste evento ainda não está pronta (conta, conexão e destino). Corrija em Integrações e reenvie"
      );

    // Regra do número: a mesma escolha da criação da compra.
    if (typeof source.providerConversionExecutionId === "string" && channelId) {
      const channel = await this.prisma.inboundWebhookChannel.findFirst({
        where: { workspaceId, id: channelId },
        include: {
          routes: { where: { active: true, validationStatus: "valid" } },
          connection: true
        }
      });
      if (!channel || channel.connection.workspaceId !== workspaceId)
        throw new RouteNotReadyRetryError(ROUTE_NOT_READY_MESSAGE);
      let inheritsWorkspace = isBridgedWhatsappProvider(
        channel.connection.provider
      );
      if (
        !inheritsWorkspace &&
        String(channel.connection.provider) === CTWA_DESTINATION_PROVIDER
      ) {
        const policy = await effectiveUnnichatMetaRouting(
          this.prisma as never,
          channel as never
        );
        inheritsWorkspace =
          policy.eligible && policy.source === "inherit_workspace";
      }
      if (!inheritsWorkspace) {
        const matches = [];
        for (const route of channel.routes) {
          const preview = await reader.previewRoute({
            workspaceId,
            adId,
            businessConnectionId: route.metaBusinessConnectionId,
            reportingAccountId: route.metaReportingAccountId,
            conversionDestinationId: route.metaConversionDestinationId
          });
          if (
            ready(preview) &&
            preview.businessConnectionId === route.metaBusinessConnectionId &&
            (!route.metaReportingAccountId ||
              preview.reportingAccountId === route.metaReportingAccountId) &&
            (!route.metaConversionDestinationId ||
              preview.conversionDestinationId ===
                route.metaConversionDestinationId)
          )
            matches.push(preview);
        }
        if (matches.length !== 1)
          throw new RouteNotReadyRetryError(ROUTE_NOT_READY_MESSAGE);
        return matches[0] as never;
      }
    }

    const route = await reader.previewRoute({ workspaceId, adId });
    if (!ready(route)) throw notReady();

    // Entrada do número: a rota atual precisa casar com uma rota do número.
    if (typeof source.inboundEventId === "string") {
      const routes = channelId
        ? await this.prisma.inboundWebhookChannelRoute.findMany({
            where: {
              workspaceId,
              channelId,
              active: true,
              validationStatus: "valid"
            }
          })
        : [];
      const resolved = {
        businessConnectionId: route.businessConnectionId,
        reportingAccountId: route.reportingAccountId,
        conversionDestinationId: route.conversionDestinationId
      };
      if (
        routes.filter((candidate) =>
          inboundMetaRouteMatches(candidate, resolved)
        ).length !== 1
      )
        throw new RouteNotReadyRetryError(ROUTE_NOT_READY_MESSAGE);
    }
    return route as never;
  }

  /**
   * Regra de uma conversão por lead e pixel no reenvio: outro log do mesmo
   * lead (variantes do telefone) já levou este evento ao destino do reenvio.
   * Melhor esforço, sem a trava da criação; o lado seguro é não reenviar.
   */
  private async assertLeadNotConvertedElsewhere(
    conversionEvent: ConversionEventLogRecord,
    conversionDestinationId: string
  ): Promise<void> {
    const trigger = conversionEvent.sourceTrigger;
    if (
      !conversionEvent.workspaceId ||
      !conversionEvent.leadId ||
      !isLeadLifetimeEvent(conversionEvent.eventName) ||
      !(
        trigger === MANUAL_CONVERSION_TRIGGER ||
        trigger === UAZAPI_AUTO_LEAD_TRIGGER ||
        trigger.startsWith("inbound_webhook:")
      )
    )
      return;
    const identity = await resolveLeadConversionIdentity(
      this.prisma as never,
      conversionEvent.workspaceId,
      conversionEvent.leadId
    );
    const source = conversionEvent.sourcePayload as
      | { channelId?: unknown }
      | null
      | undefined;
    const prior = await findPriorLeadLifetimeConversion(this.prisma as never, {
      workspaceId: conversionEvent.workspaceId,
      identity,
      eventName: conversionEvent.eventName,
      conversionDestinationId,
      channelId: typeof source?.channelId === "string" ? source.channelId : null,
      pipeline: pipelineOf(trigger),
      ownDedupeKey: null,
      includeAutoLead: true,
      excludeLogId: conversionEvent.id
    });
    if (prior) throw new LeadAlreadyConvertedRetryError();
  }

  private toDto(event: DiagnosticEventRecord): DiagnosticEventDto {
    return {
      id: event.id,
      workspaceId: event.workspaceId,
      source: event.source,
      eventType: event.eventType,
      severity: event.severity,
      status: event.status,
      occurredAt: event.occurredAt.toISOString(),
      title: event.title,
      message: event.message,
      leadId: event.leadId,
      phoneHash: event.phoneHash,
      campaignId: event.campaignId,
      adSetId: event.adSetId,
      adId: event.adId,
      jobId: event.jobId,
      errorCode: event.errorCode
    };
  }

  private toWebhookLogDto(webhook: WebhookLogRecord): DiagnosticWebhookLogDto {
    return {
      id: webhook.id,
      workspaceId: webhook.workspaceId,
      whatsappInstanceId: webhook.whatsappInstanceId,
      source: webhook.source,
      eventType: webhook.eventType,
      externalEventId: webhook.externalEventId,
      status: webhook.status,
      receivedAt: webhook.receivedAt.toISOString(),
      processedAt: webhook.processedAt?.toISOString() ?? null,
      leadId: webhook.leadId,
      phoneHash: webhook.phoneHash,
      campaignId: webhook.campaignId,
      adSetId: webhook.adSetId,
      adId: webhook.adId,
      jobId: webhook.jobId,
      errorCode: webhook.errorCode,
      errorMessage: webhook.errorMessage,
      payloadAvailable:
        webhook.summaryPayload !== null && webhook.summaryPayload !== undefined
    };
  }

  private toWebhookPayloadDto(
    webhook: WebhookLogRecord
  ): DiagnosticWebhookPayloadDto {
    const payload = this.payloadRecord(webhook.summaryPayload);

    return {
      id: webhook.id,
      workspaceId: webhook.workspaceId,
      whatsappInstanceId: webhook.whatsappInstanceId,
      source: webhook.source,
      eventType: webhook.eventType,
      externalEventId: webhook.externalEventId,
      status: webhook.status,
      receivedAt: webhook.receivedAt.toISOString(),
      payloadKind: "summary",
      payloadAvailable: payload !== null,
      payload
    };
  }

  private toJobAttemptDto(attempt: JobAttemptRecord): DiagnosticJobAttemptDto {
    return {
      id: attempt.id,
      workspaceId: attempt.workspaceId,
      queueName: attempt.queueName,
      jobId: attempt.jobId,
      jobName: attempt.jobName,
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      scheduledAt: attempt.scheduledAt?.toISOString() ?? null,
      startedAt: attempt.startedAt?.toISOString() ?? null,
      finishedAt: attempt.finishedAt?.toISOString() ?? null,
      nextRetryAt: attempt.nextRetryAt?.toISOString() ?? null,
      source: attempt.source,
      relatedEntityType: attempt.relatedEntityType,
      relatedEntityId: attempt.relatedEntityId,
      errorCode: attempt.errorCode,
      errorMessage: attempt.errorMessage,
      createdAt: attempt.createdAt.toISOString()
    };
  }

  private toIntegrationLogDto(
    log: IntegrationLogRecord
  ): DiagnosticIntegrationLogDto {
    return {
      id: log.id,
      workspaceId: log.workspaceId,
      source: log.source,
      operation: log.operation,
      status: log.status,
      startedAt: log.startedAt.toISOString(),
      finishedAt: log.finishedAt?.toISOString() ?? null,
      durationMs: log.durationMs,
      httpStatus: log.httpStatus,
      providerRequestId: log.providerRequestId,
      providerErrorCode: log.providerErrorCode,
      providerErrorMessage: log.providerErrorMessage,
      leadId: log.leadId,
      campaignId: log.campaignId,
      adSetId: log.adSetId,
      adId: log.adId,
      jobId: log.jobId
    };
  }

  private toConversionEventLogDto(
    log: ConversionEventLogRecord
  ): DiagnosticConversionEventLogDto {
    return {
      id: log.id,
      workspaceId: log.workspaceId,
      leadId: log.leadId,
      phoneHash: log.phoneHash,
      sourceTrigger: log.sourceTrigger,
      eventId: log.eventId,
      eventName: log.eventName,
      status: log.status,
      pixelId: log.pixelId,
      metaAccountId: log.metaAccountId,
      campaignId: log.campaignId,
      adSetId: log.adSetId,
      adId: log.adId,
      attributionStatus: log.attributionStatus,
      dedupeKey: log.dedupeKey,
      ctwaClid: this.maskCtwaClid(log.ctwaClid),
      valueCents: log.valueCents,
      valueSource: log.valueSource,
      currency: log.currency,
      contentName: log.contentName,
      customData: this.payloadRecord(
        this.stripSensitiveKeys(this.redactSensitive(log.customData))
      ),
      sentAt: log.sentAt?.toISOString() ?? null,
      errorCode: log.errorCode,
      errorMessage: log.errorMessage,
      jobId: log.jobId,
      createdAt: log.createdAt.toISOString()
    };
  }

  private toAuditLogDto(log: AuditLogRecord): DiagnosticAuditLogDto {
    return {
      id: log.id,
      workspaceId: log.workspaceId,
      actorUserId: log.actorUserId,
      actorType: log.actorType,
      action: log.action,
      targetType: log.targetType,
      targetId: log.targetId,
      reason: log.reason,
      sourceIp: log.sourceIp,
      resultStatus: log.resultStatus,
      createdAt: log.createdAt.toISOString(),
      beforeSummary: this.payloadRecord(log.beforeSummary),
      afterSummary: this.payloadRecord(log.afterSummary)
    };
  }

  private toDetailDto(
    event: DiagnosticEventRecord,
    timeline: DiagnosticTimelineItemDto[]
  ): DiagnosticEventDetailDto {
    return {
      ...this.toDto(event),
      summaryPayload:
        event.summaryPayload &&
        typeof event.summaryPayload === "object" &&
        !Array.isArray(event.summaryPayload)
          ? (event.summaryPayload as Record<string, unknown>)
          : null,
      timeline
    };
  }

  private async buildTimeline(
    event: DiagnosticEventRecord
  ): Promise<DiagnosticTimelineItemDto[]> {
    const items: DiagnosticTimelineItemDto[] = [this.eventTimelineItem(event)];

    if (event.webhookLogId) {
      const webhook = (await this.prisma.webhookLog.findUnique({
        where: { id: event.webhookLogId }
      })) as WebhookLogRecord | null;

      if (webhook) {
        items.push({
          id: webhook.id,
          kind: "webhook_log",
          label: `Webhook ${webhook.source} recebido`,
          status: webhook.status,
          occurredAt: webhook.receivedAt.toISOString(),
          summaryPayload: this.payloadRecord(webhook.summaryPayload)
        });
      }
    }

    if (event.conversionEventLogId) {
      const conversionEvent = (await this.prisma.conversionEventLog.findUnique({
        where: { id: event.conversionEventLogId }
      })) as ConversionEventLogRecord | null;

      if (conversionEvent) {
        items.push({
          id: conversionEvent.id,
          kind: "conversion_event_log",
          label: `Conversão ${conversionEvent.eventName}`,
          status: conversionEvent.status,
          occurredAt: (
            conversionEvent.sentAt ?? conversionEvent.createdAt
          ).toISOString(),
          summaryPayload: this.payloadRecord({
            sourceTrigger: conversionEvent.sourceTrigger,
            pixelId: conversionEvent.pixelId,
            metaAccountId: conversionEvent.metaAccountId,
            campaignId: conversionEvent.campaignId,
            adSetId: conversionEvent.adSetId,
            adId: conversionEvent.adId,
            attributionStatus: conversionEvent.attributionStatus,
            dedupeKey: conversionEvent.dedupeKey,
            errorCode: conversionEvent.errorCode,
            errorMessage: conversionEvent.errorMessage,
            jobId: conversionEvent.jobId
          })
        });
      }
    }

    if (event.integrationLogId) {
      const integration = (await this.prisma.integrationLog.findUnique({
        where: { id: event.integrationLogId }
      })) as IntegrationLogRecord | null;

      if (integration) {
        items.push({
          id: integration.id,
          kind: "integration_log",
          label: `${integration.source} ${integration.operation}`,
          status: integration.status,
          occurredAt: (
            integration.finishedAt ?? integration.startedAt
          ).toISOString(),
          summaryPayload: this.payloadRecord({
            httpStatus: integration.httpStatus,
            providerRequestId: integration.providerRequestId,
            providerErrorCode: integration.providerErrorCode,
            providerErrorMessage: integration.providerErrorMessage,
            durationMs: integration.durationMs,
            campaignId: integration.campaignId,
            adSetId: integration.adSetId,
            adId: integration.adId,
            jobId: integration.jobId
          })
        });
      }
    }

    const jobAttemptWhereInputs: Prisma.JobAttemptWhereInput[] = [
      {
        relatedEntityType: "DiagnosticEvent",
        relatedEntityId: event.id
      }
    ];

    if (event.conversionEventLogId) {
      jobAttemptWhereInputs.push({
        relatedEntityType: "ConversionEventLog",
        relatedEntityId: event.conversionEventLogId
      });
    }

    const [auditLogs, jobAttemptGroups] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: {
          targetType: "DiagnosticEvent",
          targetId: event.id
        },
        orderBy: {
          createdAt: "asc"
        },
        take: 20
      }) as Promise<AuditLogRecord[]>,
      Promise.all(
        jobAttemptWhereInputs.map(
          (where) =>
            this.prisma.jobAttempt.findMany({
              where,
              orderBy: {
                createdAt: "asc"
              },
              take: 20
            }) as Promise<JobAttemptRecord[]>
        )
      )
    ]);
    const jobAttempts = Array.from(
      new Map(
        jobAttemptGroups.flat().map((jobAttempt) => [jobAttempt.id, jobAttempt])
      ).values()
    );

    for (const auditLog of auditLogs) {
      items.push({
        id: auditLog.id,
        kind: "audit_log",
        label: auditLog.action,
        status: auditLog.resultStatus,
        occurredAt: auditLog.createdAt.toISOString(),
        summaryPayload: this.payloadRecord({
          before: auditLog.beforeSummary,
          after: auditLog.afterSummary
        })
      });
    }

    for (const jobAttempt of jobAttempts) {
      items.push({
        id: jobAttempt.id,
        kind: "job_attempt",
        label: jobAttempt.jobName,
        status: jobAttempt.status,
        occurredAt: (
          jobAttempt.finishedAt ??
          jobAttempt.startedAt ??
          jobAttempt.scheduledAt ??
          jobAttempt.createdAt
        ).toISOString(),
        summaryPayload: this.payloadRecord(jobAttempt.summaryPayload)
      });
    }

    return items.sort(
      (left, right) =>
        new Date(left.occurredAt).getTime() -
        new Date(right.occurredAt).getTime()
    );
  }

  private eventTimelineItem(
    event: DiagnosticEventRecord
  ): DiagnosticTimelineItemDto {
    return {
      id: event.id,
      kind: "diagnostic_event",
      label: event.title,
      status: event.status,
      occurredAt: event.occurredAt.toISOString(),
      summaryPayload: this.payloadRecord(event.summaryPayload)
    };
  }

  private payloadRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private maskCtwaClid(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }

    if (value.length <= 8) {
      return `${value.slice(0, 2)}***`;
    }

    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }

  private stripSensitiveKeys(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.stripSensitiveKeys(item));
    }

    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !sensitiveKeyPattern.test(key))
          .map(([key, innerValue]) => [
            key,
            this.stripSensitiveKeys(innerValue)
          ])
      );
    }

    return value;
  }

  private redactSensitive(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.redactSensitive(item));
    }

    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, innerValue]) => [
          key,
          sensitiveKeyPattern.test(key)
            ? "[redacted]"
            : this.redactSensitive(innerValue)
        ])
      );
    }

    return value;
  }
}
