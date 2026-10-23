import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  canonicalTrackingEventTypeSchema,
  conversionValueSourceSchema,
  type CanonicalTrackingEventTypeDto,
  type ConversionValueSourceDto
} from "@wpptrack/shared";
import { ConversionEventsQueueService } from "../common/queue/conversion-events-queue.service";
import { hashPhoneIdentity } from "../common/phone/phone-identity";
import { PrismaService } from "../common/prisma/prisma.service";
import { ConversionEventsService } from "../conversion-events/conversion-events.service";
import { LeadsService } from "../leads/leads.service";
import {
  buildExternalEventIdentity,
  ExternalEventIdentityError,
  shouldFilterExternalConversationWithoutCtwa
} from "./external-event-policy";
import type { ExternalEventRow } from "./external-mysql.adapter";

export type ExternalEventConnectorContext = {
  id: string;
  workspaceId: string;
  provider: string;
  timezone: string;
  shadowMode: boolean;
  capiSendEnabled: boolean;
  capiCutovers: Array<{
    eventType: CanonicalTrackingEventTypeDto;
    activatedAt: Date;
  }>;
  purchaseAverageValueCents: number | null;
  defaultCurrency: string | null;
  purchaseDefaultValueCents?: number | null;
  purchaseDefaultCurrency?: string | null;
  purchaseDefaultContentName?: string | null;
};

export type ExternalEventIngestionResult = {
  externalRowId: string;
  status: "imported" | "duplicate" | "filtered" | "rejected";
  leadId: string | null;
  conversionEventLogId: string | null;
  queued: boolean;
  errorCode: string | null;
};

export type ExternalEventIngestionOptions = {
  deliveryStatus?: "imported";
  updateLeadStatus?: boolean;
};

type LeadAttribution = {
  id: string;
  phoneHash: string;
  campaignId: string | null;
  adSetId: string | null;
  adId: string | null;
  ctwaClid: string | null;
};

@Injectable()
export class ExternalEventIngestionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LeadsService) private readonly leadsService: LeadsService,
    @Inject(ConversionEventsService)
    private readonly conversionEventsService: ConversionEventsService,
    @Inject(ConversionEventsQueueService)
    private readonly conversionQueue: ConversionEventsQueueService
  ) {}

  async ingest(
    connector: ExternalEventConnectorContext,
    row: ExternalEventRow,
    options: ExternalEventIngestionOptions = {}
  ): Promise<ExternalEventIngestionResult> {
    if (
      shouldFilterExternalConversationWithoutCtwa(
        connector.provider,
        row.eventType,
        row.ctwaClid
      )
    ) {
      return {
        externalRowId: row.externalRowId,
        status: "filtered",
        leadId: null,
        conversionEventLogId: null,
        queued: false,
        errorCode: null
      };
    }

    const sourceRowKey = [
      "external-row",
      connector.id,
      "events",
      row.externalRowId
    ].join(":");
    const previous = await this.prisma.externalIngestionRecord.findUnique({
      where: { dedupeKey: sourceRowKey },
      select: {
        id: true,
        status: true,
        leadId: true,
        conversionEventLogId: true,
        duplicateCount: true,
        errorCode: true
      }
    });

    if (previous) {
      if (
        previous.status === "rejected" &&
        previous.errorCode === "ExternalLeadNotMatched"
      ) {
        try {
          return await this.ingestNew(
            connector,
            row,
            sourceRowKey,
            options,
            previous.id
          );
        } catch (error) {
          const errorCode = this.errorCode(error);
          await this.recordRejected(connector, row, sourceRowKey, errorCode);

          return {
            externalRowId: row.externalRowId,
            status: "rejected",
            leadId: null,
            conversionEventLogId: null,
            queued: false,
            errorCode
          };
        }
      }

      const queued = await this.retryPendingDelivery(connector, previous, row);
      await this.prisma.externalIngestionRecord.update({
        where: { id: previous.id },
        data: {
          duplicateCount: Math.max(previous.duplicateCount, row.duplicateCount),
          lastReceivedAt: new Date(),
          ...(queued ? { status: "imported", errorCode: null, errorMessage: null } : {})
        }
      });

      return {
        externalRowId: row.externalRowId,
        status: "duplicate",
        leadId: previous.leadId,
        conversionEventLogId: previous.conversionEventLogId,
        queued,
        errorCode: null
      };
    }

    try {
      return await this.ingestNew(connector, row, sourceRowKey, options);
    } catch (error) {
      const errorCode = this.errorCode(error);
      await this.recordRejected(connector, row, sourceRowKey, errorCode);

      return {
        externalRowId: row.externalRowId,
        status: "rejected",
        leadId: null,
        conversionEventLogId: null,
        queued: false,
        errorCode
      };
    }
  }

  private async ingestNew(
    connector: ExternalEventConnectorContext,
    row: ExternalEventRow,
    sourceRowKey: string,
    options: ExternalEventIngestionOptions,
    existingRecordId?: string
  ): Promise<ExternalEventIngestionResult> {
    const eventType = canonicalTrackingEventTypeSchema.parse(row.eventType);
    const occurredAt = this.parseExternalDate(row.occurredAt);
    const lead =
      eventType === "conversation_started"
        ? await this.upsertConversationLead(connector, row, occurredAt)
        : await this.findExistingLead(connector, row);

    if (!lead) {
      throw new Error("ExternalLeadNotMatched");
    }

    const identity = buildExternalEventIdentity({
      connectorId: connector.id,
      connectorProvider: row.provider,
      eventType,
      leadIdentity: lead.phoneHash,
      occurredAt,
      timezone: connector.timezone,
      externalEventId: row.externalEventId,
      transactionId: row.transactionId,
      ctwaClid: row.ctwaClid ?? lead.ctwaClid
    });
    const value = this.resolveValue(connector, row, eventType);
    const ctwaClid = row.ctwaClid ?? lead.ctwaClid;
    const sourcePayload = this.sourceAuditPayload(row);
    const cutoverAt = this.cutoverAt(connector, eventType);
    const deliveryStatus =
      options.deliveryStatus ??
      (ctwaClid
        ? cutoverAt && occurredAt < cutoverAt
          ? "shadow_observed"
          : undefined
        : "not_eligible");
    const conversion = await this.conversionEventsService.recordExternalConversion({
      workspaceId: connector.workspaceId,
      externalConnectorId: connector.id,
      sourceEventId: row.externalEventId ?? row.externalRowId,
      sourceTrigger: `external_mysql:${row.provider}`,
      eventName: this.conversionEventName(eventType),
      eventId: identity.eventId,
      dedupeKey: identity.dedupeKey,
      leadId: lead.id,
      phoneHash: lead.phoneHash,
      businessSource: lead.adId || lead.ctwaClid ? "paid" : "organic",
      campaignId: row.campaignId ?? lead.campaignId,
      adSetId: row.adSetId ?? lead.adSetId,
      adId: row.adId ?? lead.adId,
      ctwaClid,
      valueCents: value.valueCents,
      valueSource: value.valueSource,
      currency: value.currency,
      contentName:
        eventType === "purchase"
          ? (connector.purchaseDefaultContentName ?? null)
          : null,
      eventOccurredAt: occurredAt,
      sourcePayload,
      ...(deliveryStatus
        ? { deliveryStatus }
        : {})
    });
    const ingestionStatus = conversion.status === "duplicate" ? "duplicate" : "imported";
    const recordData = {
      workspaceId: connector.workspaceId,
      connectorId: connector.id,
      stream: "events",
      externalRowId: row.externalRowId,
      dedupeKey: sourceRowKey,
      eventType,
      status: ingestionStatus,
      occurredAt,
      leadId: lead.id,
      conversionEventLogId: conversion.conversionEventLogId,
      duplicateCount: row.duplicateCount,
      errorCode: null,
      errorMessage: null,
      summaryPayload: {
        sourceEventName: row.sourceEventName,
        externalLeadId: row.externalLeadId,
        providerDedupeKey: row.dedupeKey,
        internalDedupeKey: identity.dedupeKey,
        identityPolicy: identity.policy,
        eventLocalDate: identity.localDate,
        valueSource: value.valueSource,
        sourcePayload
      } as Prisma.InputJsonValue
    };
    const record = existingRecordId
      ? await this.prisma.externalIngestionRecord.update({
          where: { id: existingRecordId },
          data: {
            eventType: recordData.eventType,
            status: recordData.status,
            occurredAt: recordData.occurredAt,
            leadId: recordData.leadId,
            conversionEventLogId: recordData.conversionEventLogId,
            duplicateCount: recordData.duplicateCount,
            errorCode: null,
            errorMessage: null,
            lastReceivedAt: new Date(),
            summaryPayload: recordData.summaryPayload
          }
        })
      : await this.prisma.externalIngestionRecord.create({
          data: recordData
        });

    if (options.updateLeadStatus !== false) {
      await this.updateLeadStatus(lead.id, eventType);
    }
    let queued = false;

    if (
      conversion.deliveryStatus === "ready_to_send" &&
      this.isLiveEvent(connector, eventType, occurredAt)
    ) {
      try {
        await this.conversionQueue.enqueueSend(
          conversion.conversionEventLogId,
          connector.workspaceId
        );
        queued = true;
      } catch (error) {
        await this.prisma.externalIngestionRecord.update({
          where: { id: record.id },
          data: {
            status: "pending_delivery",
            errorCode: "ExternalCapiQueueFailed",
            errorMessage: this.safeErrorMessage(error)
          }
        });

        return {
          externalRowId: row.externalRowId,
          status: ingestionStatus,
          leadId: lead.id,
          conversionEventLogId: conversion.conversionEventLogId,
          queued: false,
          errorCode: "ExternalCapiQueueFailed"
        };
      }
    }

    return {
      externalRowId: row.externalRowId,
      status: ingestionStatus,
      leadId: lead.id,
      conversionEventLogId: conversion.conversionEventLogId,
      queued,
      errorCode: null
    };
  }

  async reconcileLegacyOrphanPromotions(
    connector: ExternalEventConnectorContext
  ): Promise<{ reconciled: number; rejected: number }> {
    const orphanLeads = await this.prisma.lead.findMany({
      where: {
        workspaceId: connector.workspaceId,
        source: "external_mysql",
        firstMessageAt: null,
        lastMessageAt: null
      },
      select: { id: true },
      take: 500
    });
    let reconciled = 0;
    let rejected = 0;

    for (const orphan of orphanLeads) {
      const records = await this.prisma.externalIngestionRecord.findMany({
        where: {
          workspaceId: connector.workspaceId,
          connectorId: connector.id,
          stream: "events",
          leadId: orphan.id,
          eventType: { in: ["qualified_lead", "purchase"] }
        },
        select: {
          id: true,
          eventType: true,
          conversionEventLogId: true,
          summaryPayload: true
        }
      });

      if (records.length === 0) {
        continue;
      }

      for (const record of records) {
        const externalLeadId = this.externalLeadIdFromSummary(
          record.summaryPayload
        );
        const target = externalLeadId
          ? await this.findLeadByExternalId(connector, externalLeadId)
          : null;

        if (target) {
          await this.prisma.externalIngestionRecord.update({
            where: { id: record.id },
            data: {
              leadId: target.id,
              errorCode: null,
              errorMessage: null
            }
          });

          if (record.conversionEventLogId) {
            await this.prisma.conversionEventLog.update({
              where: { id: record.conversionEventLogId },
              data: {
                leadId: target.id,
                phoneHash: target.phoneHash,
                customerIdentityKey: target.phoneHash
              }
            });
          }

          await this.updateLeadStatus(
            target.id,
            canonicalTrackingEventTypeSchema.parse(record.eventType)
          );
          reconciled += 1;
          continue;
        }

        await this.prisma.externalIngestionRecord.update({
          where: { id: record.id },
          data: {
            status: "rejected",
            leadId: null,
            errorCode: "ExternalLeadNotMatched",
            errorMessage: this.safeErrorMessage("ExternalLeadNotMatched")
          }
        });

        if (record.conversionEventLogId) {
          await this.prisma.conversionEventLog.update({
            where: { id: record.conversionEventLogId },
            data: {
              status: "skipped",
              leadId: null,
              errorCode: "ExternalLeadNotMatched",
              errorMessage: this.safeErrorMessage("ExternalLeadNotMatched")
            }
          });
        }

        rejected += 1;
      }

      await this.prisma.conversionEventLog.updateMany({
        where: { workspaceId: connector.workspaceId, leadId: orphan.id },
        data: {
          status: "skipped",
          leadId: null,
          errorCode: "ExternalLeadNotMatched",
          errorMessage: this.safeErrorMessage("ExternalLeadNotMatched")
        }
      });
      await this.prisma.lead.delete({ where: { id: orphan.id } });
    }

    return { reconciled, rejected };
  }

  private async upsertConversationLead(
    connector: ExternalEventConnectorContext,
    row: ExternalEventRow,
    occurredAt: Date
  ): Promise<LeadAttribution | null> {
    const reference = await this.leadsService.upsertFromWhatsappWebhook({
      workspaceId: connector.workspaceId,
      phone: row.phone,
      source: "external_mysql",
      preserveExistingSource: true,
      campaignId: row.campaignId ?? undefined,
      adSetId: row.adSetId ?? undefined,
      adId: row.adId ?? undefined,
      ctwaClid: row.ctwaClid ?? undefined,
      ctwaSourceUrl: row.sourceUrl ?? undefined,
      occurredAt,
      recordMessageTimestamps: true
    });

    if (!reference) {
      throw new Error("ExternalLeadPhoneMissing");
    }

    return this.findLeadById(connector.workspaceId, reference.id);
  }

  private async findExistingLead(
    connector: ExternalEventConnectorContext,
    row: ExternalEventRow
  ): Promise<LeadAttribution | null> {
    const phoneHash = hashPhoneIdentity(row.phone);

    if (phoneHash) {
      const byPhone = (await this.prisma.lead.findUnique({
        where: {
          workspaceId_phoneHash: {
            workspaceId: connector.workspaceId,
            phoneHash
          }
        },
        select: this.leadAttributionSelect()
      })) as LeadAttribution | null;

      if (byPhone) {
        return byPhone;
      }
    }

    return row.externalLeadId
      ? this.findLeadByExternalId(connector, row.externalLeadId)
      : null;
  }

  private async findLeadByExternalId(
    connector: ExternalEventConnectorContext,
    externalLeadId: string
  ): Promise<LeadAttribution | null> {
    const importedLead = await this.prisma.externalIngestionRecord.findFirst({
      where: {
        workspaceId: connector.workspaceId,
        connectorId: connector.id,
        stream: "leads",
        status: "imported",
        leadId: { not: null },
        summaryPayload: {
          path: ["externalLeadId"],
          equals: externalLeadId
        }
      },
      orderBy: { lastReceivedAt: "desc" },
      select: { leadId: true }
    });

    return importedLead?.leadId
      ? this.findLeadById(connector.workspaceId, importedLead.leadId)
      : null;
  }

  private async findLeadById(
    workspaceId: string,
    leadId: string
  ): Promise<LeadAttribution | null> {
    return (await this.prisma.lead.findFirst({
      where: { id: leadId, workspaceId },
      select: this.leadAttributionSelect()
    })) as LeadAttribution | null;
  }

  private leadAttributionSelect() {
    return {
      id: true,
      phoneHash: true,
      campaignId: true,
      adSetId: true,
      adId: true,
      ctwaClid: true
    } as const;
  }

  private externalLeadIdFromSummary(value: unknown): string | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const externalLeadId = (value as Record<string, unknown>).externalLeadId;
    return typeof externalLeadId === "string" && externalLeadId.trim()
      ? externalLeadId.trim()
      : null;
  }

  private sourceAuditPayload(row: ExternalEventRow): Record<string, unknown> {
    return {
      schema: "external_event_row_v1",
      externalRowId: row.externalRowId,
      dedupeKey: row.dedupeKey,
      provider: row.provider,
      eventType: row.eventType,
      sourceEventName: row.sourceEventName,
      externalEventId: row.externalEventId,
      externalLeadId: row.externalLeadId,
      transactionId: row.transactionId,
      phone: this.maskPhoneForAudit(row.phone),
      phoneRedacted: true,
      occurredAt: row.occurredAt,
      eventLocalDate: row.eventLocalDate,
      adId: row.adId,
      adSetId: row.adSetId,
      campaignId: row.campaignId,
      ctwaClid: row.ctwaClid,
      sourceUrl: row.sourceUrl,
      valueCents: row.valueCents,
      currency: row.currency,
      valueSource: row.valueSource,
      duplicateCount: row.duplicateCount,
      updatedAt: row.updatedAt
    };
  }

  private maskPhoneForAudit(value: string): string | null {
    const digits = value.replace(/\D/g, "");

    return digits ? `***${digits.slice(-4)}` : null;
  }

  private resolveValue(
    connector: ExternalEventConnectorContext,
    row: ExternalEventRow,
    eventType: CanonicalTrackingEventTypeDto
  ): {
    valueCents: number | null;
    valueSource: ConversionValueSourceDto | null;
    currency: string | null;
  } {
    if (eventType !== "purchase") {
      return { valueCents: null, valueSource: null, currency: null };
    }

    if (row.valueCents !== null && row.valueCents > 0) {
      const parsedSource = conversionValueSourceSchema.safeParse(row.valueSource);
      return {
        valueCents: row.valueCents,
        valueSource: parsedSource.success ? parsedSource.data : "actual",
        currency: row.currency ?? connector.defaultCurrency
      };
    }

    const configuredValue =
      connector.purchaseDefaultValueCents ??
      connector.purchaseAverageValueCents;

    return {
      valueCents: configuredValue,
      valueSource:
        configuredValue === null
          ? null
          : "configured_average",
      currency:
        connector.purchaseDefaultCurrency ?? connector.defaultCurrency
    };
  }

  private conversionEventName(
    eventType: CanonicalTrackingEventTypeDto
  ): "LeadSubmitted" | "QualifiedLead" | "Purchase" {
    switch (eventType) {
      case "conversation_started":
        return "LeadSubmitted";
      case "qualified_lead":
        return "QualifiedLead";
      case "purchase":
        return "Purchase";
    }
  }

  private async updateLeadStatus(
    leadId: string,
    eventType: CanonicalTrackingEventTypeDto
  ): Promise<void> {
    if (eventType === "conversation_started") {
      return;
    }

    if (eventType === "purchase") {
      await this.prisma.lead.update({
        where: { id: leadId },
        data: { status: "converted" }
      });
      return;
    }

    await this.prisma.lead.updateMany({
      where: { id: leadId, status: { not: "converted" } },
      data: { status: "qualified" }
    });
  }

  private async retryPendingDelivery(
    connector: ExternalEventConnectorContext,
    record: {
      status: string;
      conversionEventLogId: string | null;
    },
    row: ExternalEventRow
  ): Promise<boolean> {
    if (!record.conversionEventLogId) {
      return false;
    }

    const eventType = canonicalTrackingEventTypeSchema.parse(row.eventType);
    const occurredAt = this.parseExternalDate(row.occurredAt);
    if (!this.isLiveEvent(connector, eventType, occurredAt)) {
      return false;
    }

    if (record.status !== "pending_delivery") {
      const conversion = await this.prisma.conversionEventLog.findUnique({
        where: { id: record.conversionEventLogId },
        select: { status: true, eventOccurredAt: true }
      });

      if (
        conversion?.status !== "ready_to_send" ||
        !this.isLiveEvent(connector, eventType, conversion.eventOccurredAt)
      ) {
        return false;
      }
    }

    await this.conversionQueue.enqueueSend(
      record.conversionEventLogId,
      connector.workspaceId
    );
    return true;
  }

  private cutoverAt(
    connector: ExternalEventConnectorContext,
    eventType: CanonicalTrackingEventTypeDto
  ): Date | null {
    return (
      connector.capiCutovers.find((cutover) => cutover.eventType === eventType)
        ?.activatedAt ?? null
    );
  }

  private isLiveEvent(
    connector: ExternalEventConnectorContext,
    eventType: CanonicalTrackingEventTypeDto,
    occurredAt: Date
  ): boolean {
    const cutoverAt = this.cutoverAt(connector, eventType);
    if (cutoverAt) {
      return occurredAt >= cutoverAt;
    }

    return connector.capiSendEnabled && !connector.shadowMode;
  }

  private async recordRejected(
    connector: ExternalEventConnectorContext,
    row: ExternalEventRow,
    sourceRowKey: string,
    errorCode: string
  ): Promise<void> {
    try {
      await this.prisma.externalIngestionRecord.upsert({
        where: { dedupeKey: sourceRowKey },
        create: {
          workspaceId: connector.workspaceId,
          connectorId: connector.id,
          stream: "events",
          externalRowId: row.externalRowId,
          dedupeKey: sourceRowKey,
          eventType: row.eventType,
          status: "rejected",
          occurredAt: this.tryParseExternalDate(row.occurredAt),
          duplicateCount: row.duplicateCount,
          errorCode,
          errorMessage: this.safeErrorMessage(errorCode),
          summaryPayload: {
            sourceEventName: row.sourceEventName,
            externalLeadId: row.externalLeadId,
            sourcePayload: this.sourceAuditPayload(row)
          } as Prisma.InputJsonValue
        },
        update: {
          status: "rejected",
          lastReceivedAt: new Date(),
          duplicateCount: row.duplicateCount,
          errorCode,
          errorMessage: this.safeErrorMessage(errorCode)
        }
      });
    } catch {
      return;
    }
  }

  private parseExternalDate(value: string): Date {
    const parsed = this.tryParseExternalDate(value);

    if (!parsed) {
      throw new Error("ExternalEventOccurredAtInvalid");
    }

    return parsed;
  }

  private tryParseExternalDate(value: string): Date | null {
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(
      value
    )
      ? `${value.replace(" ", "T")}Z`
      : value;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private errorCode(error: unknown): string {
    if (error instanceof ExternalEventIdentityError) {
      return error.code;
    }

    if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]+$/.test(error.message)) {
      return error.message.slice(0, 100);
    }

    return "ExternalEventIngestionFailed";
  }

  private safeErrorMessage(error: unknown): string {
    const code = typeof error === "string" ? error : this.errorCode(error);

    switch (code) {
      case "MissingProviderEventIdentity":
        return "O provider não forneceu uma identidade estável para o evento";
      case "ExternalEventOccurredAtInvalid":
        return "A data do evento externo é inválida";
      case "ExternalLeadPhoneMissing":
        return "O evento externo não possui telefone válido";
      case "ExternalLeadNotMatched":
        return "O evento externo não corresponde a um lead importado";
      case "ExternalCapiQueueFailed":
        return "O evento foi salvo, mas ainda não entrou na fila Meta";
      default:
        return "O evento externo não pode ser processado";
    }
  }
}
