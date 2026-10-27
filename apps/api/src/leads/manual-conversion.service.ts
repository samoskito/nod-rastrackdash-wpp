import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  CRM_INVALID_TARGET_MESSAGE,
  CRM_MOVE_ERROR_CODES,
  conversionEventCarriesValue,
  conversionEventMetaEventIdPrefix,
  MANUAL_CONVERSION_ERROR_CODES,
  MANUAL_CONVERSION_RECENT_DUPLICATE_CODE,
  MANUAL_CONVERSION_RECENT_WINDOW_MS,
  MANUAL_CONVERSION_TRIGGER,
  manualConversionAgeState,
  manualConversionMayExpireBeforeSend,
  normalizeManualOrderRef,
  manualConversionEventLabel,
  manualConversionNotSentReasonLabels,
  type ManualConversionCancelResultDto,
  type ManualConversionCrmStageResultDto,
  type ManualConversionInputDto,
  type ManualConversionNotSentReasonDto,
  type ManualConversionPreviewDto,
  type ManualConversionResultDto,
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { CrmBoardService } from "../crm/crm-board.service";
import { ConversionEventsQueueService } from "../common/queue/conversion-events-queue.service";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { ConversionEventsService } from "../conversion-events/conversion-events.service";
import {
  findPriorLeadLifetimeConversion,
  isLeadLifetimeEvent,
  leadLifetimeMetaEventId,
  lockLeadConversionIdentity,
  resolveLeadConversionIdentity,
  type LeadConversionIdentity,
} from "../conversion-events/lead-lifetime-conversion-guard";
import { leadSubmittedRuleOverrideEnabled } from "../conversion-rules/lead-submitted-rule-override";
import { resolveCtwaLeadProof } from "../conversion-rules/ctwa-lead-proof";
import type { AuthorizedCtwaDestination } from "../inbound-webhooks/authorized-ctwa-destination";
import { InboundWebhookMetaRouteReaderService } from "../inbound-webhooks/inbound-webhook-meta-route-reader.service";
import {
  isManualCancelableStatus,
  MANUAL_CONVERSION_AUDIT_CANCEL,
  MANUAL_CONVERSION_AUDIT_CREATE,
  MANUAL_CONVERSION_AUDIT_TARGET,
  MANUAL_CONVERSION_PROCESSING_MODE,
  manualIdempotentDedupeKey,
  manualOrderKey,
  manualPurchaseDedupeKey,
  manualPurchaseEventId,
  readManualSourcePayload,
  type ManualConversionSourcePayload,
} from "./manual-conversion-payload";
import {
  findLegacyProviderPurchaseForOrder,
  findProviderPurchaseForOrder,
  purchaseCustomerLockKeys,
  type ProviderOrderRefReader,
} from "./manual-conversion-purchase";
import { InboundWebhookPayloadEncryptionService } from "../inbound-webhooks/inbound-webhook-payload-encryption.service";
import { isBridgedWhatsappProvider } from "../inbound-webhooks/bridged-whatsapp-providers";
import { manualPurchaseSalesPlatformOf } from "./manual-conversion-sales-platforms";

/**
 * 409 "Lead já convertido" of a once-per-lead event. Its own class so the
 * Fase 6.9 CRM stage (another dataset) can still be recorded once.
 */
export class LeadAlreadyConvertedConflict extends ConflictException {}

/** Rate limit per user (durable: counted on AuditLog, no extra table). */
export const MANUAL_CONVERSION_RATE_LIMIT = {
  windowMs: 60 * 60_000,
  max: 30,
};

/**
 * Who registers the conversion. CRM-ready: a future Kanban "Ganho" calls
 * create(workspaceId, leadId, input, actor) with the user that moved the card.
 */
export type ManualConversionActor = {
  userId: string;
  name: string | null;
};

type LeadRow = {
  id: string;
  workspaceId: string;
  phoneHash: string;
  campaignId: string | null;
  adSetId: string | null;
  adId: string | null;
  ctwaClid: string | null;
  whatsappInstanceId: string | null;
};

export type ManualConversionRoute =
  | {
      kind: "ad";
      adAccountId: string;
      businessConnectionId: string;
      conversionDestinationId: string;
      pixelId: string | null;
      channelId: string | null;
    }
  | {
      kind: "ctwa";
      ctwaDestination: AuthorizedCtwaDestination;
      conversionDestinationId: string;
      pixelId: string | null;
      channelId: string;
    }
  | { kind: "none"; channelId: string | null };

type ManualPlan = {
  lead: LeadRow;
  route: ManualConversionRoute;
  notSentReason: ManualConversionNotSentReasonDto | null;
  dedupeKey: string;
  orderKey: string | null;
};

type Duplicate = NonNullable<ManualConversionPreviewDto["duplicate"]>;

const LEAD_SELECT = {
  id: true,
  workspaceId: true,
  phoneHash: true,
  campaignId: true,
  adSetId: true,
  adId: true,
  ctwaClid: true,
  whatsappInstanceId: true,
} as const;

/** Prior manual log statuses that never count (canceled). */
const CANCELED_STATUSES = ["skipped"];

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

const PROVIDER_NAMES: Record<string, string> = {
  payt: "Payt",
  braip: "Braip",
  umbler: "Umbler",
  unnichat: "Unnichat",
  gupshup: "Gupshup",
  data_crazy: "Data Crazy",
  uazapi: "Uazapi",
  waha: "WAHA",
  meta_cloud: "Meta Cloud",
};

/** Portuguese origin of a prior conversion (409 / warning messages). */
export function manualConversionOriginLabel(sourceTrigger: string): string {
  if (sourceTrigger === MANUAL_CONVERSION_TRIGGER) return "registro manual";
  if (sourceTrigger === "auto_lead") return "entrada do WhatsApp";
  if (sourceTrigger === "keyword") return "palavra-chave";
  if (sourceTrigger === "whatsapp_label") return "etiqueta do WhatsApp";
  if (sourceTrigger === "kommo_stage") return "Kommo";
  if (sourceTrigger.startsWith("pipedrive")) return "Pipedrive";
  if (sourceTrigger.startsWith("external_mysql:")) return "integração externa";
  if (sourceTrigger.startsWith("inbound_webhook:")) {
    const [, provider = "", trigger] = sourceTrigger.split(":");
    const name = PROVIDER_NAMES[provider] ?? provider;
    if (!trigger) return "entrada do anúncio";
    if (provider === "payt" || provider === "braip") return name;
    if (trigger === "message_phrase") return "regra de frase";
    if (trigger === "structured_catalog") return "regra de catálogo";
    if (trigger === "provider_automation") return `automação ${name}`;
    return "regra de conversão";
  }
  return "outra origem";
}

/** Statuses of an event sent or on its way to Meta (+-24h warning). */
const RECENT_SENDING_STATUSES = [
  "sent",
  "queued",
  "ready_to_send",
  "dispatching",
  "delivery_unknown",
];

@Injectable()
export class ManualConversionService {
  private readonly logger = new Logger(ManualConversionService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConversionEventsService)
    private readonly conversions: ConversionEventsService,
    @Inject(InboundWebhookMetaRouteReaderService)
    private readonly routes: InboundWebhookMetaRouteReaderService,
    @Inject(ConversionEventsQueueService)
    private readonly queue: ConversionEventsQueueService,
    @Optional()
    @Inject(RUNTIME_ENV)
    private readonly env: RuntimeEnv = process.env,
    @Optional()
    @Inject(InboundWebhookPayloadEncryptionService)
    private readonly payloadEncryption: InboundWebhookPayloadEncryptionService | null = null,
    @Optional()
    @Inject(CrmBoardService)
    private readonly crm:
      | (Pick<CrmBoardService, "assertKanbanMove"> &
          Partial<Pick<CrmBoardService, "invalidateWorkspace">>)
      | null = null,
  ) {}

  /**
   * CRM Kanban (source "kanban"): only a stage after the lead's current
   * column (forward only, design §9), checked on preview and create. Fails
   * closed when the board service is not wired.
   */
  private async assertKanbanSource(
    workspaceId: string,
    leadId: string,
    input: ManualConversionInputDto,
  ): Promise<void> {
    if (input.source !== "kanban") return;
    if (!this.crm)
      throw new ConflictException({
        message: CRM_INVALID_TARGET_MESSAGE,
        code: CRM_MOVE_ERROR_CODES.invalidTarget,
      });
    // nod: a retry of a move that already registered (same idempotencyKey)
    // must replay the original result, not fail "O lead já está nesta etapa":
    // the card is already in the target column. create() replays it.
    if (await this.hasManualLogForKey(workspaceId, leadId, input.idempotencyKey))
      return;
    await this.crm.assertKanbanMove(workspaceId, leadId, input.eventName);
  }

  /** A manual log of this lead was already written by this click. */
  private async hasManualLogForKey(
    workspaceId: string,
    leadId: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    const existing = await this.prisma.conversionEventLog.findFirst({
      where: {
        workspaceId,
        leadId,
        externalConnectorId: null,
        sourceTrigger: MANUAL_CONVERSION_TRIGGER,
        sourceEventId: `manual:${idempotencyKey}`,
      },
      select: { id: true },
    });
    return Boolean(existing);
  }

  /** Read-only: what create() would do, shown on the confirmation step. */
  async preview(
    workspaceId: string,
    leadId: string,
    input: ManualConversionInputDto,
  ): Promise<ManualConversionPreviewDto> {
    await this.assertKanbanSource(workspaceId, leadId, input);
    const client = this.prisma as unknown as Prisma.TransactionClient;
    const plan = await this.plan(client, workspaceId, leadId, input);
    const identity = await resolveLeadConversionIdentity(
      client,
      workspaceId,
      plan.lead.id,
    );
    const duplicate = await this.findDuplicate(
      client,
      workspaceId,
      input,
      plan,
      identity,
    );
    const recentDuplicate = duplicate
      ? null
      : await this.findRecentSameEvent(client, workspaceId, input, plan, identity);
    const [destination, campaign, ad] = await Promise.all([
      this.routeDestinationId(plan.route)
        ? this.prisma.metaConversionDestination.findFirst({
            where: {
              workspaceId,
              id: this.routeDestinationId(plan.route)!,
            },
            select: { label: true, pixelName: true, pixelId: true },
          })
        : null,
      plan.lead.campaignId
        ? this.prisma.metaCampaign.findFirst({
            where: { workspaceId, campaignId: plan.lead.campaignId },
            select: { name: true },
          })
        : null,
      plan.lead.adId
        ? this.prisma.metaAd.findFirst({
            where: { workspaceId, adId: plan.lead.adId },
            select: { name: true },
          })
        : null,
    ]);
    return {
      eventName: input.eventName,
      eventLabel: manualConversionEventLabel(input.eventName),
      willSendToMeta: !plan.notSentReason && !duplicate,
      notSentReason: plan.notSentReason,
      notSentReasonLabel: plan.notSentReason
        ? manualConversionNotSentReasonLabels[plan.notSentReason]
        : null,
      destination: {
        kind: plan.route.kind,
        pixelId:
          (plan.route.kind === "none" ? null : plan.route.pixelId) ??
          destination?.pixelId ??
          null,
        destinationName: destination
          ? destination.label?.trim() || destination.pixelName
          : null,
      },
      attribution: {
        campaignId: plan.lead.campaignId,
        campaignName: campaign?.name ?? null,
        adId: plan.lead.adId,
        adName: ad?.name ?? null,
      },
      duplicate,
      recentDuplicate,
      mayExpireBeforeSend:
        !plan.notSentReason &&
        manualConversionMayExpireBeforeSend(input.occurredAt),
      crmStage: await this.previewCrmStage(workspaceId, input, identity.leadIds),
    };
  }

  /** Fase 6.9: the CRM stage a QualifiedLead would record (confirmation). */
  private async previewCrmStage(
    workspaceId: string,
    input: ManualConversionInputDto,
    leadIds: string[],
  ): Promise<ManualConversionPreviewDto["crmStage"]> {
    if (input.eventName !== "QualifiedLead") return null;
    if (typeof this.conversions.previewLeadFormCrmStage !== "function") return null;
    try {
      const preview = await this.conversions.previewLeadFormCrmStage(
        workspaceId,
        leadIds,
      );
      if (!preview) return null;
      return input.sendToMeta
        ? preview
        : {
            eventName: preview.eventName,
            willSend: false,
            reason: "Marcado para registrar só no painel (não enviar à Meta).",
          };
    } catch {
      return null;
    }
  }

  async create(
    workspaceId: string,
    leadId: string,
    input: ManualConversionInputDto,
    actor: ManualConversionActor,
  ): Promise<ManualConversionResultDto> {
    await this.assertKanbanSource(workspaceId, leadId, input);
    const result = await this.createInTransaction(workspaceId, leadId, input, actor).catch(
      async (error: unknown) => {
        // Fase 6.9: the lead already has this QualifiedLead (another source),
        // but the CRM stage of its Meta instant form is another dataset: it
        // is still recorded once, and the 409 says so.
        if (error instanceof LeadAlreadyConvertedConflict) {
          const crm = await this.recordCrmStage(workspaceId, leadId, input, actor, null);
          if (crm && crm.outcome !== "already_recorded")
            throw new LeadAlreadyConvertedConflict(`${error.message} ${crm.message}`);
        }
        throw error;
      },
    );

    if (result.replay)
      return this.withCrmStage(
        this.resultOf(result.replay, true),
        await this.recordCrmStage(workspaceId, leadId, input, actor, result.replay.id),
      );
    const created = result.created!;
    // CRM board cache (any source): the card moves on the next refresh.
    this.crm?.invalidateWorkspace?.(workspaceId);
    if (created.status === "ready_to_send") {
      try {
        await this.queue.enqueueSend(created.id, workspaceId);
      } catch (error) {
        // The log stays ready_to_send: the stalled-event retry requeues it.
        this.logger.warn(
          `manual conversion ${created.id} not enqueued: ${
            error instanceof Error ? error.message : "unknown"
          }`,
        );
      }
    }
    return this.withCrmStage(
      this.resultOf(created, false),
      await this.recordCrmStage(workspaceId, leadId, input, actor, created.id),
    );
  }

  private withCrmStage(
    result: ManualConversionResultDto,
    crmStage: ManualConversionCrmStageResultDto | null,
  ): ManualConversionResultDto {
    return crmStage
      ? { ...result, message: `${result.message} ${crmStage.message}`, crmStage }
      : result;
  }

  /**
   * Fase 6.9 (PR #91 do nod, "Qualificado" ligado ao #158/#176): a
   * QualifiedLead registered here (lead detail or Kanban) also records the CRM
   * stage of the lead's latest Meta instant-form submission, on the dataset of
   * its form connection. Not when "Enviar à Meta" is off. Idempotent (its own
   * dedupe key); it never fails the manual conversion itself.
   */
  private async recordCrmStage(
    workspaceId: string,
    leadId: string,
    input: ManualConversionInputDto,
    actor: ManualConversionActor,
    originConversionEventLogId: string | null,
  ): Promise<ManualConversionCrmStageResultDto | null> {
    if (input.eventName !== "QualifiedLead" || !input.sendToMeta) return null;
    if (typeof this.conversions.recordLeadFormCrmStage !== "function") return null;
    try {
      const lead = await this.prisma.lead.findFirst({
        where: { workspaceId, id: leadId },
        select: { id: true, phoneHash: true },
      });
      if (!lead) return null;
      const identity = await resolveLeadConversionIdentity(
        this.prisma as unknown as Prisma.TransactionClient,
        workspaceId,
        lead.id,
      );
      const recorded = await this.conversions.recordLeadFormCrmStage({
        workspaceId,
        leadId: lead.id,
        leadIds: identity.leadIds,
        phoneHash: lead.phoneHash,
        actorUserId: actor.userId,
        qualifiedAt: new Date(input.occurredAt),
        originConversionEventLogId,
      });
      if (!recorded) return null;
      const eventName = recorded.eventName;
      const conversionEventLogId =
        recorded.created[0] ?? recorded.duplicates[0] ?? "";
      if (!conversionEventLogId) return null;
      if (recorded.created.length === 0)
        return {
          outcome: "already_recorded",
          eventName,
          conversionEventLogId,
          message: `A etapa ${eventName} do formulário Meta já estava registrada; nada foi reenviado.`,
        };
      if (recorded.status !== "ready_to_send")
        return {
          outcome: "not_eligible",
          eventName,
          conversionEventLogId,
          message: `A etapa ${eventName} do formulário Meta não foi enviada: ${
            recorded.errorMessage ?? "dados insuficientes"
          }.`,
        };
      try {
        await this.queue.enqueueSend(conversionEventLogId, workspaceId);
      } catch (error) {
        // Stays ready_to_send: the stalled-event retry requeues it.
        this.logger.warn(
          `crm stage ${conversionEventLogId} not enqueued: ${
            error instanceof Error ? error.message : "unknown"
          }`,
        );
      }
      return {
        outcome: "queued",
        eventName,
        conversionEventLogId,
        message: `A etapa ${eventName} do formulário Meta foi enfileirada para o dataset do CRM.`,
      };
    } catch (error) {
      this.logger.warn(
        `crm stage of lead ${leadId} not recorded: ${
          error instanceof Error ? error.message : "unknown"
        }`,
      );
      return null;
    }
  }

  /** The manual conversion itself (one transaction, as before Fase 6.9). */
  private createInTransaction(
    workspaceId: string,
    leadId: string,
    input: ManualConversionInputDto,
    actor: ManualConversionActor,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const tx = transaction as Prisma.TransactionClient;
      // Per-user lock first: concurrent clicks of the same user serialize on
      // the hourly count, so the limit can never be exceeded.
      await this.assertRateLimit(actor, tx);
      const plan = await this.plan(tx, workspaceId, leadId, input);
      const identity = await resolveLeadConversionIdentity(
        tx,
        workspaceId,
        plan.lead.id,
      );
      // Same serialization as the automations: the lead identity + event
      // for once-per-lead events, the customer + event lock for Purchase and
      // every other +-24h event (the key the provider job takes too).
      if (isLeadLifetimeEvent(input.eventName))
        await lockLeadConversionIdentity(
          tx,
          workspaceId,
          identity,
          input.eventName,
        );
      else {
        const lock = purchaseCustomerLockKeys(
          workspaceId,
          plan.lead.phoneHash,
          input.eventName,
        );
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(CAST(${lock.first} AS integer), CAST(${lock.second} AS integer))::text`;
      }

      const replay = await this.findReplay(tx, workspaceId, plan, input);
      if (replay) return { replay, created: null };

      const duplicate = await this.findDuplicate(
        tx,
        workspaceId,
        input,
        plan,
        identity,
      );
      if (duplicate)
        throw duplicate.kind === "lead_already_converted"
          ? new LeadAlreadyConvertedConflict(duplicate.message)
          : new ConflictException(duplicate.message);
      // Decision 1a: the same +-24h event already exists for the lead: only
      // with the explicit "Registrar mesmo assim" (confirmDuplicate).
      const recent = await this.findRecentSameEvent(
        tx,
        workspaceId,
        input,
        plan,
        identity,
      );
      if (recent && !input.confirmDuplicate)
        throw new ConflictException({
          message: recent.message,
          code: MANUAL_CONVERSION_RECENT_DUPLICATE_CODE,
          duplicate: recent,
        });

      const record = await this.conversions.recordExternalConversion(
        this.recordInput(workspaceId, input, plan, identity, actor),
        tx,
      );
      if (record.status === "duplicate") {
        // A concurrent identical click won the dedupe key, or the guard saw
        // a conversion the checks above could not (never expected).
        if (record.duplicateReasonCode)
          throw new LeadAlreadyConvertedConflict(
            "Lead já convertido para este pixel: nada novo foi registrado.",
          );
        const existing = await tx.conversionEventLog.findFirst({
          where: { id: record.conversionEventLogId, workspaceId },
          select: {
            id: true,
            status: true,
            errorCode: true,
            sourcePayload: true,
          },
        });
        if (
          !existing ||
          readManualSourcePayload(existing.sourcePayload)?.idempotencyKey !==
            input.idempotencyKey
        )
          throw new ConflictException(
            "Esta conversão já foi registrada para este lead.",
          );
        return { replay: existing, created: null };
      }

      await tx.auditLog.create({
        data: {
          workspaceId,
          actorUserId: actor.userId,
          actorType: "user",
          action: MANUAL_CONVERSION_AUDIT_CREATE,
          targetType: MANUAL_CONVERSION_AUDIT_TARGET,
          targetId: record.conversionEventLogId,
          resultStatus: "success",
          // No note (free text may hold personal data) in the audit trail.
          afterSummary: {
            leadId: plan.lead.id,
            eventName: input.eventName,
            status: record.deliveryStatus,
            route: plan.route.kind,
            notSentReason: plan.notSentReason,
            valueCents: input.valueCents,
            currency: input.currency,
            orderRef: input.orderRef,
            confirmedDuplicateOf: recent?.conversionEventLogId ?? null,
            origin: input.source ?? "lead_detail",
          },
        },
      });
      const written = await tx.conversionEventLog.findFirst({
        where: { id: record.conversionEventLogId, workspaceId },
        select: { errorCode: true },
      });
      return {
        replay: null,
        created: {
          id: record.conversionEventLogId,
          status: record.deliveryStatus,
          errorCode: written?.errorCode ?? null,
        },
      };
    });
  }

  /** Cancel while nothing reached Meta (decision 8): status -> skipped. */
  async cancel(
    workspaceId: string,
    leadId: string,
    logId: string,
    actor: ManualConversionActor,
  ): Promise<ManualConversionCancelResultDto> {
    const canceled = await this.prisma.$transaction(async (transaction) => {
      const tx = transaction as Prisma.TransactionClient;
      const log = await tx.conversionEventLog.findFirst({
        where: {
          id: logId,
          workspaceId,
          leadId,
          sourceTrigger: MANUAL_CONVERSION_TRIGGER,
        },
        select: { id: true, status: true, dedupeKey: true, eventName: true },
      });
      if (!log) throw new NotFoundException("Conversão manual não encontrada");
      if (log.status === "sent")
        throw new ConflictException("Enviado — não pode ser desfeito");
      if (log.status === "skipped")
        return { conversionEventLogId: log.id, status: "skipped" as const };
      if (!isManualCancelableStatus(log.status))
        throw new ConflictException(
          "Esta conversão já está sendo enviada à Meta e não pode ser cancelada.",
        );
      const updated = await tx.conversionEventLog.updateMany({
        where: {
          id: log.id,
          workspaceId,
          status: log.status,
        },
        data: {
          status: "skipped",
          errorCode: MANUAL_CONVERSION_ERROR_CODES.canceled,
          errorMessage: `Conversão manual cancelada por ${
            actor.name?.trim() || "usuário"
          } antes do envio`,
          // Frees the order/idempotency key: the same order may be
          // registered again after a cancel.
          dedupeKey: log.dedupeKey ? `${log.dedupeKey}:canceled:${log.id}` : null,
        },
      });
      if (updated.count !== 1)
        throw new ConflictException(
          "A conversão mudou de estado enquanto era cancelada. Atualize a página.",
        );
      await tx.auditLog.create({
        data: {
          workspaceId,
          actorUserId: actor.userId,
          actorType: "user",
          action: MANUAL_CONVERSION_AUDIT_CANCEL,
          targetType: MANUAL_CONVERSION_AUDIT_TARGET,
          targetId: log.id,
          resultStatus: "success",
          beforeSummary: { status: log.status, eventName: log.eventName },
          afterSummary: { status: "skipped" },
        },
      });
      return { conversionEventLogId: log.id, status: "skipped" as const };
    });
    this.crm?.invalidateWorkspace?.(workspaceId);
    return canceled;
  }

  /**
   * Per user (any workspace): counted on AuditLog (indexed by actorUserId)
   * under a per-user advisory lock held until the create commits, so two
   * concurrent clicks can never both pass at 29/30.
   */
  async assertRateLimit(
    actor: ManualConversionActor,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const digest = createHash("sha256")
      .update(`manual-conversion-rate\0${actor.userId}`, "utf8")
      .digest();
    const first = digest.readInt32BE(0);
    const second = digest.readInt32BE(4);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(CAST(${first} AS integer), CAST(${second} AS integer))::text`;
    const recent = await tx.auditLog.count({
      where: {
        actorUserId: actor.userId,
        action: MANUAL_CONVERSION_AUDIT_CREATE,
        createdAt: {
          gte: new Date(Date.now() - MANUAL_CONVERSION_RATE_LIMIT.windowMs),
        },
      },
    });
    if (recent >= MANUAL_CONVERSION_RATE_LIMIT.max)
      throw new HttpException(
        `Limite de ${MANUAL_CONVERSION_RATE_LIMIT.max} conversões manuais por hora atingido. Tente novamente mais tarde.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
  }

  /**
   * Destination exactly as the automations resolve it, never chosen by the
   * user: the lead's ad saved Meta route; otherwise (or when it does not
   * resolve) the lead's verified CTWA entry proof; otherwise none.
   */
  async resolveRoute(
    client: Prisma.TransactionClient,
    workspaceId: string,
    lead: LeadRow,
  ): Promise<ManualConversionRoute> {
    if (lead.adId) {
      const route = await this.routes.previewRoute({
        workspaceId,
        adId: lead.adId,
      });
      if (
        route.status === "resolved" &&
        route.adAccountId &&
        route.businessConnectionId &&
        route.conversionDestinationId
      )
        return {
          kind: "ad",
          adAccountId: route.adAccountId,
          businessConnectionId: route.businessConnectionId,
          conversionDestinationId: route.conversionDestinationId,
          pixelId: route.pixelId,
          channelId: await this.leadEntryChannelId(client, workspaceId, lead.id),
        };
    }
    if (lead.ctwaClid) {
      const proof = await resolveCtwaLeadProof(client, {
        workspaceId,
        leadId: lead.id,
        phoneHash: lead.phoneHash,
        ctwaClid: lead.ctwaClid,
      });
      if (proof)
        return {
          kind: "ctwa",
          ctwaDestination: proof,
          conversionDestinationId: proof.destinationId,
          pixelId:
            proof.pixelId ?? null,
          channelId: proof.channelId,
        };
    }
    return {
      kind: "none",
      channelId: await this.leadEntryChannelId(client, workspaceId, lead.id),
    };
  }

  private async plan(
    client: Prisma.TransactionClient,
    workspaceId: string,
    leadId: string,
    input: ManualConversionInputDto,
  ): Promise<ManualPlan> {
    const age = manualConversionAgeState(input.occurredAt);
    if (age === "invalid" || age === "future" || age === "too_old")
      throw new BadRequestException(
        age === "future"
          ? "A data da conversão não pode estar no futuro."
          : "Só é possível registrar conversões dos últimos 90 dias.",
      );
    const lead = (await client.lead.findFirst({
      where: { workspaceId, id: leadId },
      select: LEAD_SELECT,
    })) as LeadRow | null;
    if (!lead) throw new NotFoundException("Lead não encontrado");
    const route = await this.resolveRoute(client, workspaceId, lead);
    let notSentReason: ManualConversionNotSentReasonDto | null = !input.sendToMeta
      ? "send_disabled"
      : route.kind === "none"
        ? "no_destination"
        : !lead.ctwaClid
          ? "missing_click"
          : age === "outside_meta_window"
            ? "outside_meta_window"
            : null;
    if (!notSentReason) {
      // nod (in place of the SaaS seat): the lead's number must still have
      // its WhatsApp connection active. The route's channel, else the channel
      // of the lead's latest conversation, else the lead's own WhatsApp
      // connection. An unknown number is not a blocker here (no seats); the
      // license is enforced by the HTTP guard (423) on every write.
      const channelId =
        route.channelId ??
        (await this.leadConversationChannelId(client, workspaceId, lead));
      if (
        !(await this.connectionActive(client, workspaceId, channelId, lead))
      )
        notSentReason = "connection_inactive";
    }
    const orderKey =
      input.eventName === "Purchase" && input.orderRef
        ? manualOrderKey(workspaceId, input.orderRef)
        : null;
    return {
      lead,
      route,
      notSentReason,
      orderKey,
      dedupeKey: orderKey
        ? manualPurchaseDedupeKey(orderKey)
        : manualIdempotentDedupeKey(workspaceId, input.idempotencyKey),
    };
  }

  /**
   * Whether the lead's number may send: only bridged numbers (Uazapi BYO and
   * WAHA, connected by server URL + token) carry a WhatsApp connection, which
   * must be `active` (not suspended or removed). Webhook providers (Umbler,
   * Gupshup, Unnichat, Meta Cloud...) have none and always may. Same rule as
   * channelConnectable of the rule activation.
   */
  private async connectionActive(
    client: Prisma.TransactionClient,
    workspaceId: string,
    channelId: string | null,
    lead: LeadRow,
  ): Promise<boolean> {
    if (channelId) {
      const channel = await client.inboundWebhookChannel.findFirst({
        where: { id: channelId, workspaceId },
        select: {
          connection: { select: { provider: true, removedAt: true } },
          whatsappInstance: { select: { status: true } },
        },
      });
      if (channel) {
        if (!isBridgedWhatsappProvider(channel.connection.provider))
          return true;
        return (
          channel.connection.removedAt === null &&
          channel.whatsappInstance?.status === "active"
        );
      }
    }
    if (!lead.whatsappInstanceId) return true;
    const instance = await client.whatsappInstance.findFirst({
      where: { id: lead.whatsappInstanceId, workspaceId },
      select: { status: true },
    });
    return instance?.status === "active";
  }

  /**
   * Channel (number) of the lead's latest conversation when no entry receipt
   * names one: any conversion log of the lead carrying a channelId, else the
   * channel bridged to the lead's WhatsApp connection (Uazapi BYO / WAHA).
   */
  private async leadConversationChannelId(
    client: Prisma.TransactionClient,
    workspaceId: string,
    lead: LeadRow,
  ): Promise<string | null> {
    const latest = await client.conversionEventLog.findFirst({
      where: {
        workspaceId,
        leadId: lead.id,
        sourcePayload: { path: ["channelId"], not: Prisma.AnyNull },
      },
      orderBy: { eventOccurredAt: "desc" },
      select: { sourcePayload: true },
    });
    const payload = latest?.sourcePayload;
    if (
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      typeof payload.channelId === "string"
    )
      return payload.channelId;
    if (!lead.whatsappInstanceId) return null;
    const channel = await client.inboundWebhookChannel.findFirst({
      where: { workspaceId, whatsappInstanceId: lead.whatsappInstanceId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return channel?.id ?? null;
  }

  /** The same click (idempotencyKey) already recorded this conversion. */
  private async findReplay(
    client: Prisma.TransactionClient,
    workspaceId: string,
    plan: ManualPlan,
    input: ManualConversionInputDto,
  ): Promise<{ id: string; status: string; errorCode: string | null } | null> {
    const existing = await client.conversionEventLog.findFirst({
      where: { workspaceId, dedupeKey: plan.dedupeKey },
      select: {
        id: true,
        status: true,
        errorCode: true,
        leadId: true,
        sourcePayload: true,
      },
    });
    if (
      existing &&
      existing.leadId === plan.lead.id &&
      readManualSourcePayload(existing.sourcePayload)?.idempotencyKey ===
        input.idempotencyKey
    )
      return {
        id: existing.id,
        status: existing.status,
        errorCode: existing.errorCode,
      };
    return null;
  }

  /**
   * Decision 1a: the same +-24h event (Purchase, InitiateCheckout...) of the
   * lead within +-24h of occurredAt, from any source (rules, automations,
   * Payt/Braip, manual), sent or on its way, for the same destination (or
   * either side without one). Never for once-per-lead events (hard 409).
   */
  private async findRecentSameEvent(
    client: Prisma.TransactionClient,
    workspaceId: string,
    input: ManualConversionInputDto,
    plan: ManualPlan,
    identity: LeadConversionIdentity,
  ): Promise<Duplicate | null> {
    if (isLeadLifetimeEvent(input.eventName)) return null;
    const at = new Date(input.occurredAt).getTime();
    const destinationId = this.routeDestinationId(plan.route);
    const logs = await client.conversionEventLog.findMany({
      where: {
        workspaceId,
        leadId: { in: identity.leadIds },
        eventName: input.eventName,
        status: { in: RECENT_SENDING_STATUSES },
        eventOccurredAt: {
          gte: new Date(at - MANUAL_CONVERSION_RECENT_WINDOW_MS),
          lte: new Date(at + MANUAL_CONVERSION_RECENT_WINDOW_MS),
        },
      },
      select: {
        id: true,
        dedupeKey: true,
        eventOccurredAt: true,
        sourceTrigger: true,
        metaConversionDestinationId: true,
      },
      orderBy: { eventOccurredAt: "desc" },
      take: 20,
    });
    const match = logs.find(
      (log) =>
        log.dedupeKey !== plan.dedupeKey &&
        (!destinationId ||
          !log.metaConversionDestinationId ||
          log.metaConversionDestinationId === destinationId),
    );
    if (!match) return null;
    return {
      kind: "recent_same_event",
      message: `Já existe ${manualConversionEventLabel(input.eventName)} deste lead em ${formatDateTime(match.eventOccurredAt)} por ${manualConversionOriginLabel(match.sourceTrigger)}. Registrar mesmo assim?`,
      conversionEventLogId: match.id,
      occurredAt: match.eventOccurredAt.toISOString(),
      originLabel: manualConversionOriginLabel(match.sourceTrigger),
    };
  }

  /**
   * Order number of a sales-platform execution's preserved callback (nod:
   * Payt and Braip; Hotmart/Yampi join through manual-conversion-sales-platforms).
   */
  private readonly readProviderOrderRef: ProviderOrderRefReader = async ({
    workspaceId,
    executionId,
  }) => {
    if (!this.payloadEncryption) return null;
    const execution =
      await this.prisma.providerConversionRuleExecution.findFirst({
        where: { id: executionId, workspaceId },
        select: {
          sourceDelivery: {
            select: {
              id: true,
              workspaceId: true,
              connectionId: true,
              encryptedPayload: true,
              payloadIv: true,
              payloadTag: true,
              encryptionKeyVersion: true,
              payloadExpiresAt: true,
            },
          },
          providerRule: {
            select: {
              parserRelease: { select: { provider: true, version: true } },
            },
          },
        },
      });
    const delivery = execution?.sourceDelivery;
    const platform = manualPurchaseSalesPlatformOf(
      execution?.providerRule.parserRelease,
    );
    if (
      !delivery ||
      !platform ||
      delivery.payloadExpiresAt <= new Date() ||
      !delivery.encryptedPayload ||
      !delivery.payloadIv ||
      !delivery.payloadTag ||
      delivery.encryptionKeyVersion === null
    )
      return null;
    const plaintext = this.payloadEncryption.decrypt(
      {
        encryptedPayload: delivery.encryptedPayload,
        payloadIv: delivery.payloadIv,
        payloadTag: delivery.payloadTag,
        encryptionKeyVersion: delivery.encryptionKeyVersion,
      },
      {
        workspaceId: delivery.workspaceId,
        connectionId: delivery.connectionId,
        deliveryId: delivery.id,
      },
    );
    return platform.readOrderRef(
      JSON.parse(plaintext.toString("utf8")) as unknown,
    );
  };

  /** 409 reasons: lead already converted / order already registered. */
  private async findDuplicate(
    client: Prisma.TransactionClient,
    workspaceId: string,
    input: ManualConversionInputDto,
    plan: ManualPlan,
    identity: LeadConversionIdentity,
  ): Promise<Duplicate | null> {
    if (plan.orderKey) {
      const manual = await client.conversionEventLog.findFirst({
        where: {
          workspaceId,
          dedupeKey: plan.dedupeKey,
          status: { notIn: CANCELED_STATUSES },
        },
        select: { id: true, eventOccurredAt: true, sourcePayload: true },
      });
      if (
        manual &&
        readManualSourcePayload(manual.sourcePayload)?.idempotencyKey !==
          input.idempotencyKey
      )
        return {
          kind: "order_already_registered",
          message: `Pedido ${input.orderRef} já registrado em ${formatDateTime(manual.eventOccurredAt)} por registro manual.`,
          conversionEventLogId: manual.id,
          occurredAt: manual.eventOccurredAt.toISOString(),
          originLabel: "registro manual",
        };
      const provider = await findProviderPurchaseForOrder(client, {
        workspaceId,
        leadIds: identity.leadIds,
        orderKey: plan.orderKey,
      });
      // Payt/Braip purchases recorded before this release (no order key).
      const legacy =
        provider ??
        (input.orderRef
          ? await findLegacyProviderPurchaseForOrder(
              client,
              {
                workspaceId,
                leadIds: identity.leadIds,
                normalizedOrderRef: normalizeManualOrderRef(input.orderRef),
              },
              this.readProviderOrderRef,
            )
          : null);
      if (legacy)
        return {
          kind: "order_already_registered",
          message: `Pedido ${input.orderRef} já registrado em ${formatDateTime(legacy.eventOccurredAt)} por ${manualConversionOriginLabel(legacy.sourceTrigger)}.`,
          conversionEventLogId: legacy.id,
          occurredAt: legacy.eventOccurredAt.toISOString(),
          originLabel: manualConversionOriginLabel(legacy.sourceTrigger),
        };
    }
    if (!isLeadLifetimeEvent(input.eventName)) return null;
    const destinationId = this.routeDestinationId(plan.route);
    let priorId: string | null = null;
    if (destinationId) {
      const prior = await findPriorLeadLifetimeConversion(client, {
        workspaceId,
        identity,
        eventName: input.eventName,
        conversionDestinationId: destinationId,
        channelId: plan.route.channelId,
        pipeline: "manual",
        ownDedupeKey: plan.dedupeKey,
        includeAutoLead: leadSubmittedRuleOverrideEnabled(this.env),
      });
      priorId = prior?.conversionEventLogId ?? null;
    }
    // Without a destination (organic lead), or when the pixel saw nothing:
    // a previous manual registration of the same event still counts once.
    if (!priorId) {
      const manual = await client.conversionEventLog.findFirst({
        where: {
          workspaceId,
          leadId: { in: identity.leadIds },
          eventName: input.eventName,
          sourceTrigger: MANUAL_CONVERSION_TRIGGER,
          status: { notIn: CANCELED_STATUSES },
          dedupeKey: { not: plan.dedupeKey },
        },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      });
      priorId = manual?.id ?? null;
    }
    if (!priorId) return null;
    const prior = await client.conversionEventLog.findFirst({
      where: { id: priorId, workspaceId },
      select: { id: true, eventOccurredAt: true, sourceTrigger: true },
    });
    if (!prior) return null;
    return {
      kind: "lead_already_converted",
      message: `Lead já convertido em ${formatDateTime(prior.eventOccurredAt)} por ${manualConversionOriginLabel(prior.sourceTrigger)}.`,
      conversionEventLogId: prior.id,
      occurredAt: prior.eventOccurredAt.toISOString(),
      originLabel: manualConversionOriginLabel(prior.sourceTrigger),
    };
  }

  private recordInput(
    workspaceId: string,
    input: ManualConversionInputDto,
    plan: ManualPlan,
    identity: LeadConversionIdentity,
    actor: ManualConversionActor,
  ): Parameters<ConversionEventsService["recordExternalConversion"]>[0] {
    const { lead, route } = plan;
    const localOnly = plan.notSentReason !== null;
    const carriesValue = conversionEventCarriesValue(input.eventName);
    const sourcePayload: ManualConversionSourcePayload = {
      processingMode: MANUAL_CONVERSION_PROCESSING_MODE,
      createdByUserId: actor.userId,
      createdByName: actor.name?.trim() || null,
      note: input.note,
      orderRef: input.orderRef,
      orderKey: plan.orderKey,
      idempotencyKey: input.idempotencyKey,
      channelId: route.channelId,
      ...(input.source === "kanban" ? { origin: "kanban" as const } : {}),
    };
    const eventId = plan.orderKey
      ? manualPurchaseEventId(plan.orderKey)
      : isLeadLifetimeEvent(input.eventName)
        ? // Same id as a rule of this lead would send: Meta dedupes both.
          leadLifetimeMetaEventId(
            workspaceId,
            identity.lockIdentity,
            input.eventName,
          )
        : `manual_${conversionEventMetaEventIdPrefix(input.eventName)}_${createHash(
            "sha256",
          )
            .update(JSON.stringify(["manual-conversion-v1", workspaceId, input.idempotencyKey]))
            .digest("hex")}`;
    const ctwa = route.kind === "ctwa";
    return {
      workspaceId,
      externalConnectorId: null,
      sourceEventId: `manual:${input.idempotencyKey}`,
      sourceTrigger: MANUAL_CONVERSION_TRIGGER,
      enforceMetaEventWindow: true,
      eventName: input.eventName,
      eventId,
      dedupeKey: plan.dedupeKey,
      leadId: lead.id,
      phoneHash: lead.phoneHash,
      businessSource: lead.adId || route.kind !== "none" ? "paid" : "organic",
      // The CTWA path never carries the ad hierarchy (send-time denial).
      ...(ctwa && !localOnly ? { ctwaDestination: route.ctwaDestination } : {}),
      metaAccountId: route.kind === "ad" ? route.adAccountId : null,
      metaBusinessConnectionId:
        route.kind === "ad" ? route.businessConnectionId : null,
      metaConversionDestinationId:
        route.kind === "none" ? null : route.conversionDestinationId,
      campaignId: ctwa ? null : lead.campaignId,
      adSetId: ctwa ? null : lead.adSetId,
      adId: ctwa ? null : lead.adId,
      ctwaClid: lead.ctwaClid,
      valueCents: carriesValue ? input.valueCents : null,
      valueSource: carriesValue && input.valueCents ? "manual" : null,
      currency: carriesValue && input.valueCents ? input.currency : null,
      contentName: input.contentName,
      eventOccurredAt: new Date(input.occurredAt),
      sourcePayload: sourcePayload as unknown as Record<string, unknown>,
      ...(localOnly
        ? {
            deliveryStatus: "not_eligible" as const,
            notEligibleReason: this.notEligibleReason(plan.notSentReason!),
          }
        : {}),
      ...(route.kind !== "none" && !localOnly
        ? {
            leadLifetimeGuard: {
              channelId: route.channelId,
              pipeline: "manual" as const,
              inTransaction: true,
            },
          }
        : {}),
    };
  }

  private notEligibleReason(reason: ManualConversionNotSentReasonDto): {
    errorCode: string;
    errorMessage: string;
  } {
    const errorCode =
      reason === "send_disabled"
        ? MANUAL_CONVERSION_ERROR_CODES.localOnly
        : reason === "outside_meta_window"
          ? MANUAL_CONVERSION_ERROR_CODES.outsideMetaWindow
          : reason === "connection_inactive"
            ? MANUAL_CONVERSION_ERROR_CODES.connectionInactive
            : MANUAL_CONVERSION_ERROR_CODES.noDestination;
    return {
      errorCode,
      errorMessage: manualConversionNotSentReasonLabels[reason],
    };
  }

  private routeDestinationId(route: ManualConversionRoute): string | null {
    return route.kind === "none" ? null : route.conversionDestinationId;
  }

  /** Channel of the lead's latest entry receipt (number of origin). */
  private async leadEntryChannelId(
    client: Prisma.TransactionClient,
    workspaceId: string,
    leadId: string,
  ): Promise<string | null> {
    const entry = await client.conversionEventLog.findFirst({
      where: {
        workspaceId,
        leadId,
        eventName: "LeadSubmitted",
        sourceTrigger: { startsWith: "inbound_webhook:" },
      },
      orderBy: { eventOccurredAt: "desc" },
      select: { sourcePayload: true },
    });
    const payload = entry?.sourcePayload;
    return payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      typeof payload.channelId === "string"
      ? payload.channelId
      : null;
  }

  private resultOf(
    log: { id: string; status: string; errorCode?: string | null },
    replayed: boolean,
  ): ManualConversionResultDto {
    const queued = ["ready_to_send", "queued", "dispatching", "sent"].includes(
      log.status,
    );
    // Passed Meta's 7-day window between the form and the record, or while
    // queued: "Expirou antes do envio", never "enfileirada".
    const expired =
      log.status === "not_eligible" &&
      log.errorCode === MANUAL_CONVERSION_ERROR_CODES.expired;
    return {
      outcome: expired ? "expired" : queued ? "queued" : "local_only",
      conversionEventLogId: log.id,
      status: log.status,
      message: expired
        ? "Expirou antes do envio: a conversão passou de 7 dias e ficou só no painel."
        : queued
          ? "Conversão registrada e enfileirada para envio à Meta."
          : "Conversão registrada só no painel (não enviada à Meta).",
      replayed,
    };
  }
}
