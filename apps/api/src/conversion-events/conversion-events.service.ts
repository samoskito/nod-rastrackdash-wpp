import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import {
  kommoPublicationAuthorized,
  type KommoPublicationIntent,
} from "../kommo/kommo-publication-policy";
import {
  settleKommoSenderOutcome,
  KOMMO_DELIVERY_UNKNOWN,
  KOMMO_DELIVERY_UNKNOWN_MESSAGE,
} from "../kommo/kommo-sender-policy";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Prisma } from "@prisma/client";
import {
  lockKommoDispatch,
  KOMMO_DISPATCH_START_MS,
  KOMMO_DISPATCH_TRANSACTION_MS,
  KOMMO_NETWORK_MS,
} from "./kommo-dispatch-coordination";
import type {
  ConversionValueSourceDto,
  ConversionEventCustomDataDto,
  ConversionEventNameDto,
  ConversionEventTestInputDto,
  ConversionRuleDto,
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { MetaTokenEncryptionService } from "../integrations/meta/meta-token-encryption.service";
import {
  MetaConnectionResolverService,
  type ResolvedMetaCapiRoute,
} from "../integrations/meta/meta-connection-resolver.service";
import {
  MetaCapiAdapter,
  type MetaCapiSendEventErrorCode,
} from "./meta-capi.adapter";
import { LicenseClientService } from "../licensing-client/license-client.service";
import {
  isConversionEventRequiringValue,
  isSupportedConversionEventName,
} from "./conversion-event-registry";

export type RecordRuleMatchesInput = {
  workspaceId: string;
  rules: ConversionRuleDto[];
  leadId?: string;
  phoneHash?: string;
  campaignId?: string;
  adSetId?: string;
  adId?: string;
  ctwaClid?: string;
  valueCents?: number | null;
  currency?: string | null;
  contentName?: string | null;
  customData?: ConversionEventCustomDataDto;
  eventOccurredAt?: Date | string | null;
};

export type RecordRuleMatchesResult = {
  created: string[];
  duplicates: string[];
};

type ConversionEventLogRecord = {
  sourceTrigger?: string;
  id: string;
  workspaceId: string | null;
  externalConnectorId: string | null;
  leadId: string | null;
  pixelId: string | null;
  pageId: string | null;
  eventId: string | null;
  metaAccountId: string | null;
  metaBusinessConnectionId?: string | null;
  metaConversionDestinationId?: string | null;
  eventName: ConversionEventNameDto;
  status: string;
  phoneHash: string | null;
  eventOccurredAt: Date;
  customerIdentityKey: string | null;
  businessSource: string;
  purchaseKind: string | null;
  valueSource: string | null;
  campaignId: string | null;
  adSetId: string | null;
  adId: string | null;
  ctwaClid: string | null;
  attributionStatus: string | null;
  dedupeKey: string | null;
  sourcePayload: Prisma.JsonValue | null;
  customData: Prisma.JsonValue | null;
  valueCents: number | null;
  currency: string | null;
  contentName: string | null;
  errorCode: string | null;
};

type ConversionEventPrismaClient = Pick<
  Prisma.TransactionClient,
  "conversionEventLog"
>;

export type RecordExternalConversionInput = {
  workspaceId: string;
  externalConnectorId?: string | null;
  sourceEventId: string;
  sourceTrigger: string;
  // Any catalog event: provider rules can now be built for all of them, and
  // resolveInitialStatus already gates delivery per event.
  eventName: ConversionEventNameDto;
  eventId: string;
  dedupeKey: string;
  leadId?: string | null;
  phoneHash: string;
  businessSource: "paid" | "organic";
  metaAccountId?: string | null;
  metaBusinessConnectionId?: string | null;
  metaConversionDestinationId?: string | null;
  campaignId?: string | null;
  adSetId?: string | null;
  adId?: string | null;
  ctwaClid?: string | null;
  valueCents?: number | null;
  valueSource?: ConversionValueSourceDto | null;
  currency?: string | null;
  contentName?: string | null;
  eventOccurredAt: Date;
  sourcePayload?: Record<string, unknown> | null;
  deliveryStatus?: "imported" | "not_eligible" | "shadow_observed";
};

export type RecordExternalConversionResult = {
  conversionEventLogId: string;
  status: "created" | "duplicate";
  deliveryStatus: string;
};

type InitialStatus = {
  status:
    | "pending_meta_context"
    | "pending_value"
    | "ready_to_send"
    | "imported"
    | "not_eligible"
    | "shadow_observed"
    | "skipped";
  errorCode:
    | "MissingAdId"
    | "MissingCtwaClid"
    | "EventValueMissing"
    | "UnsupportedConversionEventName"
    | null;
  errorMessage: string | null;
};

type RecordAutomaticLeadSubmittedInput = {
  workspaceId: string;
  leadId?: string;
  phoneHash?: string;
  campaignId?: string;
  adSetId?: string;
  adId?: string;
  ctwaClid?: string;
  eventOccurredAt?: Date | string | null;
};

export type SendManualTestEventInput = ConversionEventTestInputDto;

type MetaIntegrationCapiTokenRecord = {
  encryptedAccessToken: string | null;
  tokenIv: string | null;
  tokenTag: string | null;
  capiAccessTokenEncrypted: string | null;
  capiTokenIv: string | null;
  capiTokenTag: string | null;
  selectedAdAccountId: string | null;
};

type MetaConversionDestinationRecord = {
  pixelId: string;
  pageId: string;
};

type FunnelEventDefaults = {
  eventName: string;
  defaultValueCents: number | null;
  defaultCurrency: string | null;
  defaultContentName: string | null;
};

type ResolvedConversionDestination = {
  source: "legacy_oauth" | "manual";
  accessToken: string | null;
  pixelId: string | null;
  pageId: string | null;
  reportingAccountId: string | null;
  adAccountId: string | null;
  businessConnectionId: string | null;
  conversionDestinationId: string | null;
  routeError: string | null;
  legacyShadowParity: LegacyRouteShadowParity | null;
};

type LegacyRouteShadowParity = {
  comparisonStatus: "matched" | "mismatch" | "unavailable";
  credentialFingerprintMatch: boolean | null;
  adAccountMatch: boolean | null;
  pixelMatch: boolean | null;
  pageMatch: boolean | null;
  parity: boolean;
};

export type SendReadyEventResult = {
  conversionEventLogId: string;
  workspaceId: string | null;
  status: "not_configured" | "sent" | "error" | "skipped";
  errorCode?: MetaCapiSendEventErrorCode;
  errorMessage?: string | null;
};

type SendReadyEventOptions = {
  workspaceId?: string;
  testEventCode?: string;
};

@Injectable()
export class ConversionEventsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MetaCapiAdapter) private readonly metaCapiAdapter: MetaCapiAdapter,
    private readonly metaTokenEncryption: MetaTokenEncryptionService,
    @Optional()
    private readonly connectionResolver: MetaConnectionResolverService | undefined,
    @Inject(LicenseClientService)
    private readonly licenseClient: LicenseClientService,
  ) {}

  /**
   * Kommo's background path has no HTTP guard. Use the canonical decision on
   * every side-effect boundary and deliberately fail closed if it cannot be
   * read. Inert is allowed only when the license service itself says so.
   */
  private async kommoLicenseAllows(): Promise<boolean> {
    try {
      const decision = await this.licenseClient.getLockState();
      return decision.inert || !decision.locked;
    } catch {
      return false;
    }
  }

  /** Only the Kommo consumer needs this background-write barrier. */
  private async assertKommoLicenseAllows(): Promise<void> {
    if (!(await this.kommoLicenseAllows()))
      throw new Error("kommo_license_locked");
  }

  async recordRuleMatches(
    input: RecordRuleMatchesInput,
  ): Promise<RecordRuleMatchesResult> {
    const created: string[] = [];
    const duplicates: string[] = [];
    const configuredDefaults =
      (await this.prisma.funnelStageConfiguration.findMany({
        where: {
          workspaceId: input.workspaceId,
          eventName: {
            in: Array.from(new Set(input.rules.map((rule) => rule.eventName))),
          },
        },
        select: {
          eventName: true,
          defaultValueCents: true,
          defaultCurrency: true,
          defaultContentName: true,
        },
      })) as FunnelEventDefaults[];
    const defaultsByEvent = new Map(
      configuredDefaults.map((defaults) => [defaults.eventName, defaults]),
    );

    for (const rule of input.rules) {
      const eventDefaults = defaultsByEvent.get(rule.eventName);
      const dedupeKey = this.buildDedupeKey(input, rule);
      const existing = (await this.prisma.conversionEventLog.findUnique({
        where: { dedupeKey },
      })) as ConversionEventLogRecord | null;

      if (existing) {
        duplicates.push(existing.id);
        continue;
      }

      const valueCents =
        input.valueCents ??
        rule.defaultValueCents ??
        eventDefaults?.defaultValueCents ??
        null;
      const initialStatus = this.resolveInitialStatus({
        eventName: rule.eventName,
        adId: input.adId,
        ctwaClid: input.ctwaClid,
        valueCents,
      });
      const customData =
        input.customData !== undefined
          ? (input.customData as Prisma.InputJsonValue)
          : rule.defaultItems
            ? ({ contents: rule.defaultItems } as Prisma.InputJsonValue)
            : Prisma.JsonNull;
      const eventOccurredAt = this.resolveEventOccurredAt(
        input.eventOccurredAt,
      );
      const customerIdentityKey = this.resolveCustomerIdentityKey(
        input.phoneHash,
      );
      const purchaseKind = await this.resolvePurchaseKind({
        workspaceId: input.workspaceId,
        eventName: rule.eventName,
        customerIdentityKey,
      });
      const log = await this.prisma.conversionEventLog.create({
        data: {
          workspaceId: input.workspaceId,
          leadId: input.leadId ?? null,
          phoneHash: input.phoneHash ?? null,
          eventOccurredAt,
          customerIdentityKey,
          businessSource: "paid",
          purchaseKind,
          sourceTrigger: rule.triggerType,
          eventName: rule.eventName,
          status: initialStatus.status,
          pixelId: rule.pixelId,
          eventId: dedupeKey,
          campaignId: input.campaignId ?? null,
          adSetId: input.adSetId ?? null,
          adId: input.adId ?? null,
          ctwaClid: input.ctwaClid ?? null,
          attributionStatus: input.adId ? "attributed" : "missing_ad_id",
          dedupeKey,
          valueCents,
          valueSource:
            input.valueCents != null
              ? "actual"
              : valueCents == null
                ? null
                : "configured_average",
          currency:
            input.currency ??
            rule.defaultCurrency ??
            eventDefaults?.defaultCurrency ??
            null,
          contentName:
            input.contentName ??
            rule.defaultContentName ??
            eventDefaults?.defaultContentName ??
            null,
          customData,
          errorCode: initialStatus.errorCode,
          errorMessage: initialStatus.errorMessage,
        },
      });

      created.push(log.id);
    }

    return { created, duplicates };
  }

  async recordAutomaticLeadSubmitted(
    input: RecordAutomaticLeadSubmittedInput,
  ): Promise<RecordRuleMatchesResult> {
    const subject = input.leadId ?? input.phoneHash ?? "unknown";
    const dedupeKey = [
      input.workspaceId,
      subject,
      "auto_lead",
      "LeadSubmitted",
      input.adId ?? "missing_ad",
    ].join(":");
    const existing = (await this.prisma.conversionEventLog.findUnique({
      where: { dedupeKey },
    })) as ConversionEventLogRecord | null;

    if (existing) {
      return { created: [], duplicates: [existing.id] };
    }

    const initialStatus = this.resolveInitialStatus({
      eventName: "LeadSubmitted",
      adId: input.adId,
      ctwaClid: input.ctwaClid,
      valueCents: null,
    });
    const eventOccurredAt = this.resolveEventOccurredAt(input.eventOccurredAt);
    const customerIdentityKey = this.resolveCustomerIdentityKey(
      input.phoneHash,
    );
    const log = await this.prisma.conversionEventLog.create({
      data: {
        workspaceId: input.workspaceId,
        leadId: input.leadId ?? null,
        phoneHash: input.phoneHash ?? null,
        eventOccurredAt,
        customerIdentityKey,
        businessSource: "paid",
        purchaseKind: null,
        sourceTrigger: "auto_lead",
        eventName: "LeadSubmitted",
        status: initialStatus.status,
        pixelId: null,
        eventId: dedupeKey,
        campaignId: input.campaignId ?? null,
        adSetId: input.adSetId ?? null,
        adId: input.adId ?? null,
        ctwaClid: input.ctwaClid ?? null,
        attributionStatus: input.adId ? "attributed" : "missing_ad_id",
        dedupeKey,
        valueCents: null,
        currency: null,
        contentName: null,
        customData: Prisma.JsonNull,
        errorCode: initialStatus.errorCode,
        errorMessage: initialStatus.errorMessage,
      },
    });

    return { created: [log.id], duplicates: [] };
  }

  async recordExternalConversion(
    input: RecordExternalConversionInput,
    client: ConversionEventPrismaClient = this.prisma,
  ): Promise<RecordExternalConversionResult> {
    const existing = (await client.conversionEventLog.findUnique({
      where: { dedupeKey: input.dedupeKey },
    })) as ConversionEventLogRecord | null;

    if (existing) {
      if (input.sourceTrigger === "kommo_stage")
        await this.assertKommoLicenseAllows();
      return this.reconcileExistingExternalConversion(existing, input, client);
    }

    const initialStatus = this.resolveExternalInitialStatus(input);
    const purchaseKind = await this.resolvePurchaseKind(
      {
        workspaceId: input.workspaceId,
        eventName: input.eventName,
        customerIdentityKey: input.phoneHash,
      },
      client,
    );

    // The Purchase-kind lookup is the final awaited read before the canonical
    // log write. Restrict this barrier to the Kommo consumer so other
    // providers retain their existing behavior.
    if (input.sourceTrigger === "kommo_stage")
      await this.assertKommoLicenseAllows();

    try {
      const log = await client.conversionEventLog.create({
        data: {
          workspaceId: input.workspaceId,
          externalConnectorId: input.externalConnectorId ?? null,
          sourceEventId: input.sourceEventId,
          leadId: input.leadId ?? null,
          phoneHash: input.phoneHash,
          eventOccurredAt: input.eventOccurredAt,
          customerIdentityKey: input.phoneHash,
          businessSource: input.businessSource,
          purchaseKind,
          valueSource: input.valueSource ?? null,
          sourceTrigger: input.sourceTrigger,
          eventName: input.eventName,
          status: initialStatus.status,
          pixelId: null,
          eventId: input.eventId,
          metaAccountId: input.metaAccountId ?? null,
          metaBusinessConnectionId: input.metaBusinessConnectionId ?? null,
          metaConversionDestinationId:
            input.metaConversionDestinationId ?? null,
          campaignId: input.campaignId ?? null,
          adSetId: input.adSetId ?? null,
          adId: input.adId ?? null,
          ctwaClid: input.ctwaClid ?? null,
          attributionStatus: input.adId
            ? "attributed"
            : "organic_or_unattributed",
          dedupeKey: input.dedupeKey,
          valueCents: input.valueCents ?? null,
          currency: input.currency ?? null,
          contentName: input.contentName ?? null,
          sourcePayload: input.sourcePayload
            ? (input.sourcePayload as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          customData: Prisma.JsonNull,
          errorCode: initialStatus.errorCode,
          errorMessage: initialStatus.errorMessage,
        },
      });

      return {
        conversionEventLogId: log.id,
        status: "created",
        deliveryStatus: log.status,
      };
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) {
        throw error;
      }

      const duplicate = (await client.conversionEventLog.findUnique({
        where: { dedupeKey: input.dedupeKey },
      })) as ConversionEventLogRecord | null;

      if (!duplicate) {
        throw error;
      }

      return {
        conversionEventLogId: duplicate.id,
        status: "duplicate",
        deliveryStatus: duplicate.status,
      };
    }
  }

  private async reconcileExistingExternalConversion(
    existing: ConversionEventLogRecord,
    input: RecordExternalConversionInput,
    client: ConversionEventPrismaClient,
  ): Promise<RecordExternalConversionResult> {
    const promotesHistoricalEvent =
      existing.status === "imported" && input.deliveryStatus !== "imported";
    const promotedStatus: InitialStatus | null = promotesHistoricalEvent
      ? this.resolveExternalInitialStatus(input)
      : null;
    const businessSource =
      existing.businessSource === "paid" || input.businessSource !== "paid"
        ? existing.businessSource
        : "paid";
    const adId = existing.adId ?? input.adId ?? null;
    const updated = (await client.conversionEventLog.update({
      where: { id: existing.id },
      data: {
        leadId: existing.leadId ?? input.leadId ?? null,
        phoneHash: existing.phoneHash ?? input.phoneHash,
        customerIdentityKey: existing.customerIdentityKey ?? input.phoneHash,
        businessSource,
        campaignId: existing.campaignId ?? input.campaignId ?? null,
        adSetId: existing.adSetId ?? input.adSetId ?? null,
        adId,
        metaAccountId: existing.metaAccountId ?? input.metaAccountId ?? null,
        metaBusinessConnectionId:
          existing.metaBusinessConnectionId ??
          input.metaBusinessConnectionId ??
          null,
        metaConversionDestinationId:
          existing.metaConversionDestinationId ??
          input.metaConversionDestinationId ??
          null,
        ctwaClid: existing.ctwaClid ?? input.ctwaClid ?? null,
        attributionStatus: adId ? "attributed" : existing.attributionStatus,
        valueCents: existing.valueCents ?? input.valueCents ?? null,
        valueSource: existing.valueSource ?? input.valueSource ?? null,
        currency: existing.currency ?? input.currency ?? null,
        ...(existing.sourcePayload == null && input.sourcePayload
          ? { sourcePayload: input.sourcePayload as Prisma.InputJsonValue }
          : {}),
        ...(promotesHistoricalEvent
          ? {
              sourceEventId: input.sourceEventId,
              sourceTrigger: input.sourceTrigger,
              eventId: input.eventId,
              eventOccurredAt: input.eventOccurredAt,
              status: promotedStatus?.status,
              errorCode: promotedStatus?.errorCode,
              errorMessage: promotedStatus?.errorMessage,
            }
          : {}),
      },
    })) as ConversionEventLogRecord;

    return {
      conversionEventLogId: existing.id,
      status: promotesHistoricalEvent ? "created" : "duplicate",
      deliveryStatus: updated.status,
    };
  }

  async listReadyLogIds(logIds: string[]): Promise<string[]> {
    if (logIds.length === 0) {
      return [];
    }

    const logs = (await this.prisma.conversionEventLog.findMany({
      where: {
        id: { in: logIds },
        status: "ready_to_send",
      },
      select: { id: true },
    })) as Array<{ id: string }>;

    return logs.map((log) => log.id);
  }

  async sendManualTestEvent(
    input: SendManualTestEventInput,
  ): Promise<SendReadyEventResult> {
    const subject = input.leadId ?? input.phoneHash ?? "unknown";
    const dedupeKey = [
      input.workspaceId,
      subject,
      "manual_test",
      input.eventName,
      input.adId ?? "missing_ad",
      Date.now(),
      randomUUID(),
    ].join(":");
    const initialStatus = this.resolveInitialStatus({
      eventName: input.eventName,
      adId: input.adId,
      ctwaClid: input.ctwaClid,
      valueCents: input.valueCents ?? null,
    });
    const eventOccurredAt = this.resolveEventOccurredAt();
    const customerIdentityKey = this.resolveCustomerIdentityKey(
      input.phoneHash,
    );
    const log = await this.prisma.conversionEventLog.create({
      data: {
        workspaceId: input.workspaceId,
        leadId: input.leadId ?? null,
        phoneHash: input.phoneHash,
        eventOccurredAt,
        customerIdentityKey,
        businessSource: "paid",
        purchaseKind: null,
        sourceTrigger: "manual_test",
        eventName: input.eventName,
        status: initialStatus.status,
        pixelId: null,
        eventId: dedupeKey,
        campaignId: null,
        adSetId: null,
        adId: input.adId ?? null,
        ctwaClid: input.ctwaClid ?? null,
        attributionStatus: "manual_test",
        dedupeKey,
        valueCents: input.valueCents ?? null,
        currency: input.currency ?? null,
        contentName: input.contentName ?? null,
        customData: Prisma.JsonNull,
        errorCode: initialStatus.errorCode,
        errorMessage: initialStatus.errorMessage,
      },
    });

    if (initialStatus.status !== "ready_to_send") {
      return {
        conversionEventLogId: log.id,
        workspaceId: input.workspaceId,
        status: "not_configured",
      };
    }

    return this.sendReadyEvent(log.id, {
      workspaceId: input.workspaceId,
      testEventCode: input.testEventCode,
    });
  }

  /** Only an undispatched, ready event can be published. Fetch supplies no retry proof. */
  async prepareKommoSenderRetry(
    logId: string,
    workspaceId: string,
  ): Promise<string> {
    if (!(await this.kommoLicenseAllows())) return "license_locked";
    return this.prisma.$transaction(async (tx) => {
      const snapshot = await tx.kommoConversionDedupe.findFirst({
        where: { workspaceId, conversionEventLogId: logId },
      });
      const target =
        snapshot?.publicationIntent as KommoPublicationIntent | null;
      if (!snapshot || !target) return "error";
      await tx.$queryRaw`SELECT "id" FROM "KommoConnection" WHERE "id" = ${target.connectionId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
      const intent = await tx.kommoConversionDedupe.findFirst({
        where: { id: snapshot.id, workspaceId },
      });
      const log = await tx.conversionEventLog.findFirst({
        where: { id: logId, workspaceId, sourceTrigger: "kommo_stage" },
      });
      if (!intent || !log || log.eventId !== target.eventId) return "error";
      const outcome = await settleKommoSenderOutcome(tx, intent, log);
      if (outcome === "sent" || outcome === "delivery_unknown") return outcome;
      if (!(await kommoPublicationAuthorized(tx, workspaceId, target)))
        return "revoked";
      if (intent.senderAttempts >= 5) return "error";
      return outcome;
    });
  }

  private async claimKommoSender(
    log: ConversionEventLogRecord,
    target: KommoPublicationIntent,
  ): Promise<string | null> {
    if (!log.workspaceId) return null;
    if (!(await this.kommoLicenseAllows())) return null;
    const workspaceId = log.workspaceId;
    const token = randomUUID();
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "KommoConnection" WHERE "id" = ${target.connectionId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
      if (!(await kommoPublicationAuthorized(tx, workspaceId, target)))
        return null;
      const current = await tx.conversionEventLog.findFirst({
        where: {
          id: log.id,
          workspaceId,
          sourceTrigger: "kommo_stage",
          status: "ready_to_send",
          eventId: target.eventId,
        },
      });
      if (!current) return null;
      const claim = await tx.kommoConversionDedupe.updateMany({
        where: {
          workspaceId,
          conversionEventLogId: log.id,
          senderLeaseToken: null,
          // No transport-supported proof of non-delivery exists. One dispatch only.
          senderAttempts: 0,
          publicationStatus: { not: "delivery_unknown" },
        },
        data: {
          senderLeaseToken: token,
          senderRetryable: false,
          senderAttempts: { increment: 1 },
        },
      });
      return claim.count ? token : null;
    });
  }

  async sendReadyEvent(
    logId: string,
    options: SendReadyEventOptions = {},
  ): Promise<SendReadyEventResult> {
    let log = (await this.prisma.conversionEventLog.findUnique({
      where: {
        id: logId,
        ...(options.workspaceId === undefined
          ? {}
          : { workspaceId: options.workspaceId }),
      },
    })) as ConversionEventLogRecord | null;

    if (!log && options.workspaceId !== undefined) {
      throw new NotFoundException("Evento de conversao nao encontrado");
    }

    if (log?.sourceTrigger === "kommo_stage" && !(await this.kommoLicenseAllows())) {
      return {
        conversionEventLogId: log.id,
        workspaceId: log.workspaceId,
        status: "skipped",
      };
    }

    if (
      log?.sourceTrigger === "kommo_stage" &&
      log.workspaceId &&
      log.status === "error"
    ) {
      await this.prepareKommoSenderRetry(logId, log.workspaceId);
      log = (await this.prisma.conversionEventLog.findUnique({
        where: { id: logId, workspaceId: log.workspaceId },
      })) as ConversionEventLogRecord | null;
    }

    const eventId = log?.eventId ?? log?.dedupeKey ?? null;
    if (!log || log.status !== "ready_to_send" || !eventId) {
      return {
        conversionEventLogId: logId,
        workspaceId: null,
        status: "skipped",
      };
    }

    if (!(await this.externalCapiDeliveryOwnedByWppTrack(log))) {
      await this.prisma.conversionEventLog.updateMany({
        where: { id: log.id, status: "ready_to_send" },
        data: {
          status: "shadow_observed",
          errorCode: null,
          errorMessage: null,
        },
      });

      return {
        conversionEventLogId: log.id,
        workspaceId: log.workspaceId,
        status: "skipped",
      };
    }

    let kommoIntent: KommoPublicationIntent | null = null;
    if (log.sourceTrigger === "kommo_stage") {
      if (!log.workspaceId) {
        return {
          conversionEventLogId: log.id,
          workspaceId: null,
          status: "skipped",
        };
      }
      const intent = await this.prisma.kommoConversionDedupe.findFirst({
        where: { workspaceId: log.workspaceId, conversionEventLogId: log.id },
      });
      kommoIntent = intent?.publicationIntent as KommoPublicationIntent;
      if (
        !(await kommoPublicationAuthorized(
          this.prisma,
          log.workspaceId,
          kommoIntent,
        ))
      ) {
        await this.prisma.conversionEventLog.updateMany({
          where: { id: log.id, status: "ready_to_send" },
          data: {
            errorCode: "kommo_publication_revoked",
            errorMessage: "Autorizacao de publicacao indisponivel",
          },
        });
        return {
          conversionEventLogId: log.id,
          workspaceId: log.workspaceId,
          status: "skipped",
        };
      }
    }

    const startedAt = new Date();
    const resolvedDestination = await this.resolveDeliveryRoute(log);
    if (
      kommoIntent &&
      (resolvedDestination.pixelId !== kommoIntent.pixelId ||
        resolvedDestination.pageId !== kommoIntent.pageId ||
        resolvedDestination.businessConnectionId !==
          kommoIntent.businessConnectionId ||
        resolvedDestination.conversionDestinationId !==
          kommoIntent.destinationId ||
        !log.workspaceId ||
        !(await kommoPublicationAuthorized(
          this.prisma,
          log.workspaceId,
          kommoIntent,
        )))
    )
      resolvedDestination.routeError = "Rota Kommo autorizada indisponivel";
    const senderToken = kommoIntent
      ? await this.claimKommoSender(log, kommoIntent)
      : null;
    if (kommoIntent && !senderToken)
      return {
        conversionEventLogId: log.id,
        workspaceId: log.workspaceId,
        status: "skipped",
      };
    const adapterInput = {
      accessToken: resolvedDestination.accessToken,
      pixelId: resolvedDestination.pixelId,
      pageId: resolvedDestination.pageId,
      eventName: log.eventName,
      dedupeKey: eventId,
      phoneHash: log.phoneHash,
      adId: log.adId,
      ctwaClid: log.ctwaClid,
      valueCents: log.valueCents,
      currency: log.currency,
      contentName: log.contentName,
      customData: log.customData as ConversionEventCustomDataDto | null,
      eventTime: log.eventOccurredAt,
      testEventCode: options.testEventCode ?? null,
    };
    // The durable claim is separate and never expires, including on failure
    // here. An ordinary post-claim read would still leave a TOCTOU window.
    const dispatchKommo = async () => {
      const deadline = performance.now() + KOMMO_DISPATCH_START_MS;
      const started = await this.prisma.$transaction(async (tx) => {
        await lockKommoDispatch(tx, log.workspaceId!);
        await tx.$queryRaw`SELECT "id" FROM "KommoConnection" WHERE "id" = ${kommoIntent!.connectionId} AND "workspaceId" = ${log.workspaceId!} FOR UPDATE`;
        const owned = await tx.kommoConversionDedupe.findFirst({
          where: {
            workspaceId: log.workspaceId!,
            conversionEventLogId: log.id,
            senderLeaseToken: senderToken,
            senderAttempts: 1,
            senderRetryable: false,
            publicationStatus: { not: "delivery_unknown" },
          },
        });
        const current = await tx.conversionEventLog.findFirst({
          where: {
            id: log.id,
            workspaceId: log.workspaceId!,
            sourceTrigger: "kommo_stage",
            status: "ready_to_send",
            eventId,
          },
        });
        if (
          !owned || !current ||
          !Object.entries(kommoIntent!).every(([key, value]) =>
            (owned.publicationIntent as Record<string, unknown> | null)?.[key] === value,
          ) ||
          !(await kommoPublicationAuthorized(tx, log.workspaceId!, kommoIntent!))
        ) throw new Error("kommo_dispatch_revoked");
        // This is the final authorization point before synchronous provider
        // dispatch. It catches a lock acquired after the durable sender claim.
        if (!(await this.kommoLicenseAllows()))
          throw new Error("kommo_license_locked");
        // sendEvent invokes fetch synchronously before its first await. Return
        // a holder rather than the promise: commit/release without awaiting
        // network I/O. The provider start is the dispatch linearization point.
        const delivery = this.metaCapiAdapter.sendEvent(adapterInput, {
          beforeDispatch: () => {
            if (performance.now() >= deadline)
              throw new Error("kommo_dispatch_deadline");
          },
          signal: AbortSignal.timeout(KOMMO_NETWORK_MS),
        });
        // Observe rejection even if commit fails after dispatch. The original
        // promise is still awaited on success; the durable claim stays fenced.
        void delivery.catch(() => undefined);
        return { delivery };
      }, { maxWait: KOMMO_DISPATCH_START_MS, timeout: KOMMO_DISPATCH_TRANSACTION_MS });
      return started.delivery;
    };
    let adapterResult;
    try {
      adapterResult = resolvedDestination.routeError
        ? {
            status: "not_configured" as const,
            requestPayload: null,
            responseSummary: {
              routeResolution: "blocked",
            },
            errorMessage: resolvedDestination.routeError,
            errorCode: "MissingMetaDestination" as const,
          }
        : kommoIntent
          ? await dispatchKommo()
          : await this.metaCapiAdapter.sendEvent(adapterInput);
    } catch (error) {
      if (
        senderToken &&
        log.workspaceId &&
        error instanceof Error &&
        error.message === "kommo_license_locked"
      ) {
        await this.releaseKommoSenderClaim(log, senderToken);
        return {
          conversionEventLogId: log.id,
          workspaceId: log.workspaceId,
          status: "skipped",
        };
      }
      throw error;
    }
    const unknownOutcome = Boolean(
      kommoIntent &&
      (adapterResult.errorCode === "MetaCapiNetworkError" ||
        adapterResult.errorCode === "MetaCapiDeliveryUnknown"),
    );
    const result = unknownOutcome
      ? {
          ...adapterResult,
          errorCode: "MetaCapiDeliveryUnknown" as const,
          errorMessage: KOMMO_DELIVERY_UNKNOWN_MESSAGE,
        }
      : adapterResult;
    const integrationLogId = await this.recordMetaCapiIntegrationLog(
      log,
      startedAt,
      result,
      resolvedDestination,
    );

    const deliveryData = {
      status: result.status,
      sentAt: result.status === "sent" ? new Date() : null,
      pixelId: resolvedDestination.pixelId,
      pageId: resolvedDestination.pageId,
      ...(resolvedDestination.source === "manual"
        ? {
            metaAccountId: resolvedDestination.adAccountId,
            metaBusinessConnectionId: resolvedDestination.businessConnectionId,
            metaConversionDestinationId:
              resolvedDestination.conversionDestinationId,
          }
        : {}),
      providerRequestPayload: result.requestPayload
        ? (result.requestPayload as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      providerResponseSummary: result.responseSummary
        ? (result.responseSummary as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    };
    if (senderToken && log.workspaceId) {
      await this.prisma.$transaction(async (tx) => {
        await lockKommoDispatch(tx, log.workspaceId!);
        const owned = await tx.kommoConversionDedupe.findFirst({
          where: {
            workspaceId: log.workspaceId!,
            conversionEventLogId: log.id,
            senderLeaseToken: senderToken,
          },
        });
        if (!owned) throw new Error("kommo_sender_lease_lost");
        const written = await tx.conversionEventLog.updateMany({
          where: {
            id: log.id,
            workspaceId: log.workspaceId,
            status: "ready_to_send",
            eventId,
          },
          data: deliveryData,
        });
        if (!written.count) throw new Error("kommo_sender_state_changed");
        await tx.kommoConversionDedupe.updateMany({
          where: { id: owned.id, senderLeaseToken: senderToken },
          data: {
            senderLeaseToken: unknownOutcome ? senderToken : null,
            senderRetryable: false,
            ...(unknownOutcome
              ? {
                  publicationStatus: "delivery_unknown",
                  publicationErrorCode: KOMMO_DELIVERY_UNKNOWN,
                }
              : {
                  publicationStatus:
                    result.status === "sent" ? "sent" : "publication_failed",
                  publicationErrorCode:
                    result.status === "sent" ? null : "sender_not_ready",
                }),
          },
        });
      });
    } else {
      await this.prisma.conversionEventLog.update({
        where: { id: log.id },
        data: deliveryData,
      });
    }
    await this.syncProviderConversionDelivery(log, result);
    if (log.workspaceId) {
      await this.prisma.purchaseReview.updateMany({
        where: {
          workspaceId: log.workspaceId,
          conversionEventLogId: log.id,
          status: {
            in: ["approved", "failed"],
          },
        },
        data: {
          status: result.status === "sent" ? "sent" : "failed",
          reasonCode:
            result.status === "sent"
              ? null
              : (result.errorCode ?? "meta_delivery_failed"),
          version: { increment: 1 },
        },
      });
    }
    await this.recordMetaCapiDiagnosticEvent(
      log,
      result,
      integrationLogId,
      resolvedDestination,
    );

    return {
      conversionEventLogId: log.id,
      workspaceId: log.workspaceId,
      status: result.status,
      ...(["MetaCapiNetworkError", "MetaCapiDeliveryUnknown"].includes(
        result.errorCode ?? "",
      )
        ? {
            errorCode: result.errorCode,
            errorMessage: result.errorMessage,
          }
        : {}),
    };
  }

  /** A pre-dispatch lock proves no provider request occurred, so release only this claim. */
  private async releaseKommoSenderClaim(
    log: ConversionEventLogRecord,
    senderToken: string,
  ): Promise<void> {
    if (!log.workspaceId) return;
    await this.prisma.kommoConversionDedupe.updateMany({
      where: {
        workspaceId: log.workspaceId,
        conversionEventLogId: log.id,
        senderLeaseToken: senderToken,
        senderAttempts: 1,
      },
      data: {
        senderLeaseToken: null,
        senderRetryable: false,
        senderAttempts: 0,
      },
    });
  }

  /**
   * A execucao da regra guarda o estado tecnico de entrega em
   * normalizedResult.technicalDelivery. Sem este espelhamento ela ficava
   * "queued" para sempre: a auditoria da regra mostrava o evento como criado e
   * a caminho da Meta mesmo depois de a Meta ter recusado o envio.
   */
  private async syncProviderConversionDelivery(
    log: ConversionEventLogRecord,
    result: {
      status: SendReadyEventResult["status"];
      errorCode: MetaCapiSendEventErrorCode;
    },
  ): Promise<void> {
    if (!log.workspaceId) {
      return;
    }

    const execution =
      await this.prisma.providerConversionRuleExecution.findFirst({
        where: {
          workspaceId: log.workspaceId,
          conversionEventLogId: log.id,
        },
        select: { id: true, normalizedResult: true },
      });
    if (!execution) {
      return;
    }

    const delivery = this.providerConversionTechnicalDelivery(result);
    const normalized =
      execution.normalizedResult &&
      typeof execution.normalizedResult === "object" &&
      !Array.isArray(execution.normalizedResult)
        ? (execution.normalizedResult as Record<string, unknown>)
        : {};

    await this.prisma.providerConversionRuleExecution.update({
      where: { id: execution.id },
      data: {
        normalizedResult: {
          ...normalized,
          technicalDelivery: {
            ...delivery,
            updatedAt: new Date().toISOString(),
          },
        } as Prisma.InputJsonValue,
      },
    });
  }

  private providerConversionTechnicalDelivery(result: {
    status: SendReadyEventResult["status"];
    errorCode: MetaCapiSendEventErrorCode;
  }): {
    state:
      | "sent"
      | "blocked_configuration"
      | "failed_retryable"
      | "failed_permanent";
    retryable: boolean;
    reasonCode: string | null;
  } {
    if (result.status === "sent") {
      return { state: "sent", retryable: false, reasonCode: null };
    }

    if (result.status === "not_configured") {
      return {
        state: "blocked_configuration",
        retryable: false,
        reasonCode: result.errorCode ?? "MetaCapiNotConfigured",
      };
    }

    if (result.errorCode === "MetaCapiNetworkError") {
      return {
        state: "failed_retryable",
        retryable: true,
        reasonCode: result.errorCode,
      };
    }

    return {
      state: "failed_permanent",
      retryable: false,
      reasonCode: result.errorCode ?? "MetaCapiSendError",
    };
  }

  private async externalCapiDeliveryOwnedByWppTrack(
    log: ConversionEventLogRecord,
  ): Promise<boolean> {
    if (!log.externalConnectorId) {
      return true;
    }

    const eventTypes: Record<string, string> = {
      LeadSubmitted: "conversation_started",
      QualifiedLead: "qualified_lead",
      Purchase: "purchase",
    };
    const eventType = eventTypes[log.eventName];
    if (!eventType) {
      return false;
    }

    const cutover = await this.prisma.externalCapiCutover.findFirst({
      where: {
        connectorId: log.externalConnectorId,
        eventType,
        status: "active",
        activatedAt: { lte: log.eventOccurredAt },
      },
      select: { id: true },
    });

    return Boolean(cutover);
  }

  private async resolveDeliveryRoute(
    log: ConversionEventLogRecord,
  ): Promise<ResolvedConversionDestination> {
    if (
      log.workspaceId &&
      this.connectionResolver &&
      (await this.connectionResolver.hasNormalizedConnections(log.workspaceId))
    ) {
      try {
        const route = await this.connectionResolver.resolveCapiRoute({
          workspaceId: log.workspaceId,
          metaAccountId: log.metaAccountId,
          campaignId: log.campaignId,
          adId: log.adId,
          ...(log.metaBusinessConnectionId
            ? { businessConnectionId: log.metaBusinessConnectionId }
            : {}),
          ...(log.metaConversionDestinationId
            ? {
                conversionDestinationId: log.metaConversionDestinationId,
              }
            : {}),
        });

        return this.normalizedDeliveryRoute(route);
      } catch (error) {
        return {
          source: "manual",
          accessToken: null,
          pixelId: null,
          pageId: null,
          reportingAccountId: null,
          adAccountId: null,
          businessConnectionId: null,
          conversionDestinationId: null,
          routeError:
            error instanceof Error
              ? error.message
              : "Nao foi possivel resolver a rota Meta deste evento",
          legacyShadowParity: null,
        };
      }
    }

    if (log.sourceTrigger === "kommo_stage") {
      return {
        source: "manual",
        accessToken: null,
        pixelId: null,
        pageId: null,
        reportingAccountId: null,
        adAccountId: null,
        businessConnectionId: null,
        conversionDestinationId: null,
        routeError: "Rota Kommo autorizada indisponivel",
        legacyShadowParity: null,
      };
    }

    // This is the existing OAuth execution path. It remains the source of truth
    // for Barbieri and every other legacy workspace.
    const legacyContext = await this.getWorkspaceCapiContext(log.workspaceId);
    const destination = await this.getWorkspaceConversionDestination(
      log.workspaceId,
    );
    const pixelId = destination?.pixelId ?? log.pixelId;
    const pageId = destination?.pageId ?? null;
    const legacyShadowParity = await this.compareLegacyCapiProjection({
      workspaceId: log.workspaceId,
      accessToken: legacyContext.accessToken,
      adAccountId: legacyContext.adAccountId,
      pixelId,
      pageId,
    });

    return {
      source: "legacy_oauth",
      accessToken: legacyContext.accessToken,
      pixelId,
      pageId,
      reportingAccountId: null,
      adAccountId: legacyContext.adAccountId,
      businessConnectionId: null,
      conversionDestinationId: null,
      routeError: null,
      legacyShadowParity,
    };
  }

  private normalizedDeliveryRoute(
    route: ResolvedMetaCapiRoute,
  ): ResolvedConversionDestination {
    return {
      source: route.source,
      accessToken: route.accessToken,
      pixelId: route.pixelId,
      pageId: route.pageId,
      reportingAccountId: route.reportingAccountId,
      adAccountId: route.adAccountId,
      businessConnectionId: route.businessConnectionId,
      conversionDestinationId: route.conversionDestinationId,
      routeError: null,
      legacyShadowParity: null,
    };
  }

  private async getWorkspaceCapiContext(
    workspaceId: string | null,
  ): Promise<{ accessToken: string | null; adAccountId: string | null }> {
    if (!workspaceId) {
      return { accessToken: null, adAccountId: null };
    }

    const connection = (await this.prisma.metaIntegration.findUnique({
      where: { workspaceId },
      select: {
        encryptedAccessToken: true,
        tokenIv: true,
        tokenTag: true,
        capiAccessTokenEncrypted: true,
        capiTokenIv: true,
        capiTokenTag: true,
        selectedAdAccountId: true,
      },
    })) as MetaIntegrationCapiTokenRecord | null;

    if (!connection) {
      return { accessToken: null, adAccountId: null };
    }

    const encryptedAccessToken =
      connection.capiAccessTokenEncrypted ?? connection.encryptedAccessToken;
    const tokenIv = connection.capiTokenIv ?? connection.tokenIv;
    const tokenTag = connection.capiTokenTag ?? connection.tokenTag;

    if (!encryptedAccessToken || !tokenIv || !tokenTag) {
      return {
        accessToken: null,
        adAccountId: connection.selectedAdAccountId,
      };
    }

    try {
      return {
        accessToken: this.metaTokenEncryption.decrypt({
          encryptedAccessToken,
          tokenIv,
          tokenTag,
        }),
        adAccountId: connection.selectedAdAccountId,
      };
    } catch {
      return {
        accessToken: null,
        adAccountId: connection.selectedAdAccountId,
      };
    }
  }

  private async compareLegacyCapiProjection(input: {
    workspaceId: string | null;
    accessToken: string | null;
    adAccountId: string | null;
    pixelId: string | null;
    pageId: string | null;
  }): Promise<LegacyRouteShadowParity | null> {
    if (!input.workspaceId || !this.connectionResolver) {
      return null;
    }

    try {
      const projection =
        await this.connectionResolver.getLegacyCompatibilityProjection(
          input.workspaceId,
          "capi",
        );
      const credentialFingerprintMatch = Boolean(
        input.accessToken &&
        this.metaTokenEncryption.fingerprint(input.accessToken) ===
          projection.credentialFingerprint,
      );
      const adAccountMatch = input.adAccountId === projection.adAccountId;
      const pixelMatch = input.pixelId === projection.destinationPixelId;
      const pageMatch = input.pageId === projection.destinationPageId;
      const parity =
        credentialFingerprintMatch && adAccountMatch && pixelMatch && pageMatch;

      return {
        comparisonStatus: parity ? "matched" : "mismatch",
        credentialFingerprintMatch,
        adAccountMatch,
        pixelMatch,
        pageMatch,
        parity,
      };
    } catch {
      return {
        comparisonStatus: "unavailable",
        credentialFingerprintMatch: null,
        adAccountMatch: null,
        pixelMatch: null,
        pageMatch: null,
        parity: false,
      };
    }
  }

  private async getWorkspaceConversionDestination(
    workspaceId: string | null,
  ): Promise<MetaConversionDestinationRecord | null> {
    if (!workspaceId) {
      return null;
    }

    return (await this.prisma.metaConversionDestination.findFirst({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
      select: {
        pixelId: true,
        pageId: true,
      },
    })) as MetaConversionDestinationRecord | null;
  }

  private async recordMetaCapiIntegrationLog(
    log: ConversionEventLogRecord,
    startedAt: Date,
    result: {
      status: SendReadyEventResult["status"];
      requestPayload: unknown;
      responseSummary: unknown;
      errorMessage: string | null;
      errorCode: MetaCapiSendEventErrorCode;
    },
    destination: ResolvedConversionDestination,
  ): Promise<string | null> {
    const finishedAt = new Date();
    const status =
      result.status === "sent"
        ? "success"
        : result.status === "not_configured"
          ? "blocked"
          : "error";

    try {
      const integrationLog = await this.prisma.integrationLog.create({
        data: {
          workspaceId: log.workspaceId,
          source: "meta",
          operation: "meta.capi.send_event",
          status,
          startedAt,
          finishedAt,
          durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
          providerRequestId: log.id,
          providerErrorCode: result.errorCode,
          providerErrorMessage: result.errorMessage,
          leadId: log.leadId,
          campaignId: log.campaignId,
          adSetId: log.adSetId,
          adId: log.adId,
          jobId: log.id,
          requestSummary: {
            conversionEventLogId: log.id,
            eventName: log.eventName,
            pixelId: destination.pixelId,
            pageId: destination.pageId,
            routeSource: destination.source,
            reportingAccountId: destination.reportingAccountId,
            adAccountId: destination.adAccountId,
            businessConnectionId: destination.businessConnectionId,
            conversionDestinationId: destination.conversionDestinationId,
            ...(destination.legacyShadowParity
              ? { legacyShadowParity: destination.legacyShadowParity }
              : {}),
            eventId: log.eventId,
            dedupeKey: log.dedupeKey,
            phoneHash: log.phoneHash,
            adId: log.adId,
            ctwaClid: log.ctwaClid,
            valueCents: log.valueCents,
            currency: log.currency,
            contentName: log.contentName,
            payload: result.requestPayload,
            errorCode: result.errorCode,
          } as Prisma.InputJsonValue,
          responseSummary:
            result.responseSummary === null
              ? Prisma.JsonNull
              : (result.responseSummary as Prisma.InputJsonValue),
        },
      });
      return integrationLog.id;
    } catch {
      return null;
    }
  }

  private async recordMetaCapiDiagnosticEvent(
    log: ConversionEventLogRecord,
    result: {
      status: SendReadyEventResult["status"];
      errorMessage: string | null;
      errorCode: MetaCapiSendEventErrorCode;
    },
    integrationLogId: string | null,
    destination: ResolvedConversionDestination,
  ): Promise<void> {
    if (result.status === "sent" || result.status === "skipped") {
      return;
    }

    const isBlocked = result.status === "not_configured";

    try {
      await this.prisma.diagnosticEvent.create({
        data: {
          workspaceId: log.workspaceId,
          source: "meta",
          eventType: "meta.capi.send_event",
          severity: isBlocked ? "warning" : "error",
          status: isBlocked ? "blocked" : "error",
          title: isBlocked
            ? "Envio Meta CAPI bloqueado por configuracao"
            : "Falha no envio Meta CAPI",
          message:
            result.errorMessage ??
            (isBlocked
              ? "Pixel ou token Meta CAPI nao configurado."
              : "O envio do evento para a Meta falhou."),
          leadId: log.leadId,
          phoneHash: log.phoneHash,
          campaignId: log.campaignId,
          adSetId: log.adSetId,
          adId: log.adId,
          jobId: log.id,
          errorCode:
            result.errorCode ??
            (isBlocked ? "MetaCapiNotConfigured" : "MetaCapiSendError"),
          integrationLogId,
          conversionEventLogId: log.id,
          summaryPayload: {
            conversionEventLogId: log.id,
            eventName: log.eventName,
            pixelId: destination.pixelId,
            pageId: destination.pageId,
            routeSource: destination.source,
            reportingAccountId: destination.reportingAccountId,
            adAccountId: destination.adAccountId,
            businessConnectionId: destination.businessConnectionId,
            conversionDestinationId: destination.conversionDestinationId,
            ...(destination.legacyShadowParity
              ? { legacyShadowParity: destination.legacyShadowParity }
              : {}),
            eventId: log.eventId,
            status: result.status,
            errorCode: result.errorCode,
            errorMessage: result.errorMessage,
          } as Prisma.InputJsonValue,
        },
      });
    } catch {
      return;
    }
  }

  private buildDedupeKey(
    input: RecordRuleMatchesInput,
    rule: ConversionRuleDto,
  ): string {
    const subject = input.leadId ?? input.phoneHash ?? "unknown";
    return [
      input.workspaceId,
      subject,
      rule.id,
      rule.eventName,
      input.adId ?? "missing_ad",
    ].join(":");
  }

  private resolveEventOccurredAt(value?: Date | string | null): Date {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value;
    }

    if (typeof value === "string") {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }

    return new Date();
  }

  private resolveCustomerIdentityKey(phoneHash?: string | null): string | null {
    const normalized = phoneHash?.trim();
    return normalized ? normalized : null;
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002",
    );
  }

  private async resolvePurchaseKind(
    input: {
      workspaceId: string;
      eventName: ConversionEventNameDto;
      customerIdentityKey: string | null;
    },
    client: ConversionEventPrismaClient = this.prisma,
  ): Promise<"first_purchase" | "repurchase" | null> {
    if (input.eventName !== "Purchase" || !input.customerIdentityKey) {
      return null;
    }

    const previousPurchases = await client.conversionEventLog.count({
      where: {
        workspaceId: input.workspaceId,
        eventName: "Purchase",
        customerIdentityKey: input.customerIdentityKey,
        sourceTrigger: {
          not: "manual_test",
        },
      },
    });

    return previousPurchases === 0 ? "first_purchase" : "repurchase";
  }

  private resolveInitialStatus(input: {
    eventName: ConversionEventNameDto;
    adId?: string | null;
    ctwaClid?: string | null;
    valueCents?: number | null;
  }): InitialStatus {
    if (!isSupportedConversionEventName(input.eventName)) {
      return {
        status: "skipped",
        errorCode: "UnsupportedConversionEventName",
        errorMessage: "Unsupported conversion event name",
      };
    }

    if (!input.adId) {
      return {
        status: "pending_meta_context",
        errorCode: "MissingAdId",
        errorMessage: "Meta CAPI ad id not available",
      };
    }

    if (!input.ctwaClid) {
      return {
        status: "pending_meta_context",
        errorCode: "MissingCtwaClid",
        errorMessage: "Meta CAPI ctwa_clid not available",
      };
    }

    if (
      isConversionEventRequiringValue(input.eventName) &&
      input.valueCents == null
    ) {
      return {
        status: "pending_value",
        errorCode: "EventValueMissing",
        errorMessage: "Conversion event value is required",
      };
    }

    return {
      status: "ready_to_send",
      errorCode: null,
      errorMessage: null,
    };
  }

  private resolveExternalInitialStatus(
    input: RecordExternalConversionInput,
  ): InitialStatus {
    if (
      input.deliveryStatus === "imported" ||
      input.deliveryStatus === "shadow_observed"
    ) {
      return {
        status: input.deliveryStatus,
        errorCode: null,
        errorMessage: null,
      };
    }

    const resolved = this.resolveInitialStatus({
      eventName: input.eventName,
      adId: input.adId,
      ctwaClid: input.ctwaClid,
      valueCents: input.valueCents,
    });

    if (input.deliveryStatus !== "not_eligible") {
      return resolved;
    }

    return {
      status: "not_eligible",
      errorCode:
        resolved.errorCode === "MissingAdId" ||
        resolved.errorCode === "MissingCtwaClid"
          ? resolved.errorCode
          : null,
      errorMessage:
        resolved.errorCode === "MissingAdId" ||
        resolved.errorCode === "MissingCtwaClid"
          ? resolved.errorMessage
          : null,
    };
  }
}
