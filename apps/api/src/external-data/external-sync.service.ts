import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  canonicalTrackingEventTypeSchema,
  externalConnectorProviderSchema,
  externalConnectorSslModeSchema,
  externalSyncStreamSchema,
  type ExternalSyncStreamDto
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { LeadsService } from "../leads/leads.service";
import { ExternalCredentialEncryptionService } from "./external-credential-encryption.service";
import { ExternalConnectorEgressPolicyService } from "./external-connector-egress-policy.service";
import {
  ExternalEventIngestionService,
  type ExternalEventConnectorContext
} from "./external-event-ingestion.service";
import {
  dateInTimezone,
  shouldFilterExternalLeadWithoutCtwa,
  startOfDateInTimezone
} from "./external-event-policy";
import {
  ExternalMysqlAdapter,
  type ExternalEventRow,
  type ExternalLeadRow,
  type ExternalSyncCursorValue
} from "./external-mysql.adapter";

export type ExternalSyncCounts = {
  read: number;
  imported: number;
  duplicates: number;
  filtered: number;
  rejected: number;
  queued: number;
  removed: number;
};

export type ExternalConnectorSyncResult = {
  connectorId: string;
  workspaceId: string;
  streams: ExternalSyncStreamDto[];
  counts: ExternalSyncCounts;
  startedAt: string;
  completedAt: string;
  durationMs: number;
};

type ConnectorRecord = {
  id: string;
  workspaceId: string;
  provider: string;
  status: string;
  timezone: string;
  sslMode: string;
  credentialsEncrypted: string;
  credentialsIv: string;
  credentialsTag: string;
  shadowMode: boolean;
  capiSendEnabled: boolean;
  purchaseAverageValueCents: number | null;
  defaultCurrency: string | null;
};

type MetaAdHierarchy = {
  campaignId: string;
  adSetId: string;
};

@Injectable()
export class ExternalSyncService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LeadsService) private readonly leadsService: LeadsService,
    @Inject(ExternalCredentialEncryptionService)
    private readonly credentialEncryption: ExternalCredentialEncryptionService,
    @Inject(ExternalMysqlAdapter)
    private readonly mysqlAdapter: ExternalMysqlAdapter,
    @Inject(ExternalConnectorEgressPolicyService)
    private readonly egressPolicy: ExternalConnectorEgressPolicyService,
    @Inject(ExternalEventIngestionService)
    private readonly eventIngestion: ExternalEventIngestionService
  ) {}

  async syncConnector(
    connectorId: string,
    requestedStreams: ExternalSyncStreamDto[],
    options: { projectionRefresh?: boolean; workspaceId?: string } = {}
  ): Promise<ExternalConnectorSyncResult> {
    const connector = (await this.prisma.externalDataConnector.findUnique({
      where: {
        id: connectorId,
        ...(options.workspaceId === undefined
          ? {}
          : { workspaceId: options.workspaceId })
      }
    })) as ConnectorRecord | null;

    if (!connector) {
      throw new NotFoundException("Conector externo nao encontrado");
    }

    if (connector.status !== "active") {
      throw new Error("ExternalConnectorNotActive");
    }

    const streams = this.normalizeStreams(requestedStreams);
    const projectionRefresh = options.projectionRefresh === true;
    const credentials = this.credentialEncryption.decrypt(connector);
    const resolvedCredentials =
      await this.egressPolicy.resolveAllowed(credentials);
    const sslMode = externalConnectorSslModeSchema.parse(connector.sslMode);
    const context = await this.connectorContext(connector);
    const startedAt = new Date();
    const counts = this.emptyCounts();

    await this.prisma.externalDataConnector.update({
      where: { id: connector.id },
      data: {
        lastSyncStartedAt: startedAt,
        lastSyncStatus: "running",
        lastSyncErrorCode: null
      }
    });

    const integrationLog = await this.prisma.integrationLog.create({
      data: {
        workspaceId: connector.workspaceId,
        source: "external_mysql",
        operation: projectionRefresh ? "lead_projection_refresh" : "incremental_sync",
        status: "running",
        startedAt,
        requestSummary: {
          connectorId: connector.id,
          provider: connector.provider,
          streams,
          projectionRefresh
        } as Prisma.InputJsonValue
      },
      select: { id: true }
    });

    try {
      for (const stream of streams) {
        const streamCounts =
          stream === "leads"
            ? await this.syncLeads(
                connector,
                context,
                resolvedCredentials,
                sslMode,
                projectionRefresh
              )
            : await this.syncEvents(context, resolvedCredentials, sslMode);
        this.addCounts(counts, streamCounts);
      }

      const completedAt = new Date();
      const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());

      await this.prisma.$transaction([
        this.prisma.externalDataConnector.update({
          where: { id: connector.id },
          data: {
            lastSyncCompletedAt: completedAt,
            lastSyncStatus: "completed",
            lastSyncErrorCode: null
          }
        }),
        this.prisma.integrationLog.update({
          where: { id: integrationLog.id },
          data: {
            status: "completed",
            finishedAt: completedAt,
            durationMs,
            responseSummary: counts as Prisma.InputJsonValue
          }
        })
      ]);

      return {
        connectorId: connector.id,
        workspaceId: connector.workspaceId,
        streams,
        counts,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs
      };
    } catch (error) {
      const completedAt = new Date();
      const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
      const errorCode = this.errorCode(error);

      await this.prisma.$transaction([
        this.prisma.externalDataConnector.update({
          where: { id: connector.id },
          data: {
            lastSyncCompletedAt: completedAt,
            lastSyncStatus: "failed",
            lastSyncErrorCode: errorCode
          }
        }),
        this.prisma.integrationLog.update({
          where: { id: integrationLog.id },
          data: {
            status: "failed",
            finishedAt: completedAt,
            durationMs,
            providerErrorCode: errorCode,
            providerErrorMessage: this.safeErrorMessage(error),
            responseSummary: counts as Prisma.InputJsonValue
          }
        })
      ]);

      throw error;
    }
  }

  private async syncLeads(
    connector: ConnectorRecord,
    eventContext: ExternalEventConnectorContext,
    credentials: ReturnType<ExternalCredentialEncryptionService["decrypt"]>,
    sslMode: ReturnType<typeof externalConnectorSslModeSchema.parse>,
    projectionRefresh = false
  ): Promise<ExternalSyncCounts> {
    const counts = this.emptyCounts();
    const batchSize = this.rowBatchSize();
    const snapshotStartedAt = new Date();
    let cursor = projectionRefresh
      ? { lastExternalId: null, lastUpdatedAt: null }
      : await this.getCursor(connector.id, "leads");

    while (true) {
      const rows = await this.mysqlAdapter.readLeadsPage(
        credentials,
        sslMode,
        cursor,
        batchSize
      );
      counts.read += rows.length;
      const eligibleRows = rows.filter((row) => {
        if (
          shouldFilterExternalLeadWithoutCtwa(
            connector.provider,
            row.ctwaClid
          )
        ) {
          counts.filtered += 1;
          return false;
        }

        return true;
      });
      const hierarchyByAdId = await this.loadMetaAdHierarchy(
        connector.workspaceId,
        eligibleRows
      );

      for (const row of eligibleRows) {
        const hierarchy = row.adId
          ? hierarchyByAdId.get(row.adId)
          : undefined;
        const status = await this.ingestLead(
          connector,
          eventContext,
          row,
          projectionRefresh,
          hierarchy
        );
        counts[status] += 1;
      }

      if (rows.length > 0) {
        cursor = projectionRefresh
          ? this.cursorFromRow(rows.at(-1)!)
          : await this.advanceCursor(connector.id, "leads", rows.at(-1)!);
      } else if (!projectionRefresh) {
        await this.touchCursor(connector.id, "leads", cursor);
      }

      if (rows.length < batchSize) {
        if (projectionRefresh) {
          counts.removed += await this.reconcileLeadSnapshot(
            connector,
            snapshotStartedAt
          );
        }
        return counts;
      }
    }
  }

  private async syncEvents(
    connector: ExternalEventConnectorContext,
    credentials: ReturnType<ExternalCredentialEncryptionService["decrypt"]>,
    sslMode: ReturnType<typeof externalConnectorSslModeSchema.parse>
  ): Promise<ExternalSyncCounts> {
    const counts = this.emptyCounts();
    const batchSize = this.rowBatchSize();
    let cursor = await this.getCursor(connector.id, "events");

    await this.eventIngestion.reconcileLegacyOrphanPromotions(connector);

    while (true) {
      const rows = await this.mysqlAdapter.readEventsPage(
        credentials,
        sslMode,
        cursor,
        batchSize
      );
      counts.read += rows.length;
      const hierarchyByAdId = await this.loadMetaAdHierarchy(
        connector.workspaceId,
        rows
      );

      for (const row of rows) {
        const hierarchy = row.adId
          ? hierarchyByAdId.get(row.adId)
          : undefined;
        const enrichedRow = hierarchy
          ? {
              ...row,
              campaignId: row.campaignId ?? hierarchy.campaignId,
              adSetId: row.adSetId ?? hierarchy.adSetId
            }
          : row;
        const result = await this.eventIngestion.ingest(connector, enrichedRow);
        if (result.status === "duplicate") {
          counts.duplicates += 1;
        } else {
          counts[result.status] += 1;
        }
        counts.queued += result.queued ? 1 : 0;
      }

      if (rows.length > 0) {
        cursor = await this.advanceCursor(connector.id, "events", rows.at(-1)!);
      } else {
        await this.touchCursor(connector.id, "events", cursor);
      }

      if (rows.length < batchSize) {
        return counts;
      }
    }
  }

  private async ingestLead(
    connector: ConnectorRecord,
    eventContext: ExternalEventConnectorContext,
    row: ExternalLeadRow,
    projectionRefresh = false,
    hierarchy?: MetaAdHierarchy
  ): Promise<"imported" | "duplicates" | "rejected"> {
    const sourceRowKey = `external-row:${connector.id}:leads:${row.externalRowId}`;

    try {
      const firstMessageAt = this.parseCalendarDateOrTimestamp(
        row.firstMessageAt,
        connector.timezone
      );
      const lastMessageAt = row.lastMessageAt
        ? this.parseExternalDate(row.lastMessageAt)
        : firstMessageAt;
      const lead = await this.leadsService.upsertFromWhatsappWebhook({
        workspaceId: connector.workspaceId,
        phone: row.phone,
        name: row.name ?? undefined,
        source: "external_mysql",
        preserveExistingSource: true,
        campaignId: hierarchy?.campaignId,
        adSetId: hierarchy?.adSetId,
        adId: row.adId ?? undefined,
        ctwaClid: row.ctwaClid ?? undefined,
        ctwaSourceUrl: row.sourceUrl ?? undefined,
        ctwaThumbnailUrl: row.thumbnailUrl ?? undefined,
        occurredAt: lastMessageAt,
        firstMessageAt,
        lastMessageAt,
        recordMessageTimestamps: true
      });

      if (!lead) {
        throw new Error("ExternalLeadPhoneMissing");
      }

      await this.prisma.lead.update({
        where: { id: lead.id },
        data: { status: this.leadStatus(row) }
      });

      await this.projectHistoricalMilestones(connector, eventContext, row);

      const existing = projectionRefresh
        ? null
        : await this.prisma.externalIngestionRecord.findUnique({
            where: { dedupeKey: sourceRowKey },
            select: { id: true, duplicateCount: true }
          });

      await this.prisma.externalIngestionRecord.upsert({
        where: { dedupeKey: sourceRowKey },
        create: {
          workspaceId: connector.workspaceId,
          connectorId: connector.id,
          stream: "leads",
          externalRowId: row.externalRowId,
          dedupeKey: sourceRowKey,
          status: "imported",
          occurredAt: firstMessageAt,
          leadId: lead.id,
          lastReceivedAt: new Date(),
          summaryPayload: {
            externalLeadId: row.externalLeadId,
            sourceStatus: row.status
          } as Prisma.InputJsonValue
        },
        update: {
          status: "imported",
          occurredAt: firstMessageAt,
          leadId: lead.id,
          lastReceivedAt: new Date(),
          ...(projectionRefresh
            ? {}
            : { duplicateCount: { increment: 1 } }),
          errorCode: null,
          errorMessage: null,
          summaryPayload: {
            externalLeadId: row.externalLeadId,
            sourceStatus: row.status
          } as Prisma.InputJsonValue
        }
      });

      return existing ? "duplicates" : "imported";
    } catch (error) {
      await this.prisma.externalIngestionRecord.upsert({
        where: { dedupeKey: sourceRowKey },
        create: {
          workspaceId: connector.workspaceId,
          connectorId: connector.id,
          stream: "leads",
          externalRowId: row.externalRowId,
          dedupeKey: sourceRowKey,
          status: "rejected",
          lastReceivedAt: new Date(),
          errorCode: this.errorCode(error),
          errorMessage: this.safeErrorMessage(error),
          summaryPayload: {
            externalLeadId: row.externalLeadId
          } as Prisma.InputJsonValue
        },
        update: {
          status: "rejected",
          lastReceivedAt: new Date(),
          errorCode: this.errorCode(error),
          errorMessage: this.safeErrorMessage(error)
        }
      });

      return "rejected";
    }
  }

  private async reconcileLeadSnapshot(
    connector: ConnectorRecord,
    snapshotStartedAt: Date
  ): Promise<number> {
    const staleRecords = await this.prisma.externalIngestionRecord.findMany({
      where: {
        connectorId: connector.id,
        stream: "leads",
        status: { not: "removed" },
        lastReceivedAt: { lt: snapshotStartedAt }
      },
      select: { id: true, leadId: true }
    });

    if (staleRecords.length === 0) {
      return 0;
    }

    const staleRecordIds = staleRecords.map((record) => record.id);
    const candidateLeadIds = [
      ...new Set(
        staleRecords
          .map((record) => record.leadId)
          .filter((leadId): leadId is string => Boolean(leadId))
      )
    ];
    let removed = 0;

    for (const leadId of candidateLeadIds) {
      const currentReferences = await this.prisma.externalIngestionRecord.count({
        where: {
          id: { notIn: staleRecordIds },
          stream: "leads",
          leadId,
          status: { not: "removed" }
        }
      });

      if (currentReferences > 0) {
        continue;
      }

      const lead = await this.prisma.lead.findFirst({
        where: {
          id: leadId,
          workspaceId: connector.workspaceId,
          source: "external_mysql"
        },
        select: { id: true }
      });

      if (!lead) {
        continue;
      }

      await this.prisma.conversionEventLog.updateMany({
        where: { workspaceId: connector.workspaceId, leadId },
        data: {
          status: "skipped",
          leadId: null,
          errorCode: "ExternalLeadRemovedAtSource",
          errorMessage: "O lead nao existe mais na origem externa"
        }
      });
      await this.prisma.externalIngestionRecord.updateMany({
        where: {
          workspaceId: connector.workspaceId,
          stream: "events",
          leadId
        },
        data: {
          status: "removed",
          leadId: null,
          errorCode: "ExternalLeadRemovedAtSource",
          errorMessage: "O lead nao existe mais na origem externa",
          lastReceivedAt: new Date()
        }
      });
      await this.prisma.lead.delete({ where: { id: lead.id } });
      removed += 1;
    }

    await this.prisma.externalIngestionRecord.updateMany({
      where: { id: { in: staleRecordIds } },
      data: {
        status: "removed",
        leadId: null,
        errorCode: "ExternalLeadRemovedAtSource",
        errorMessage: "O lead nao existe mais na origem externa",
        lastReceivedAt: new Date()
      }
    });

    return removed;
  }

  private async loadMetaAdHierarchy(
    workspaceId: string,
    rows: Array<{ adId: string | null }>
  ): Promise<Map<string, MetaAdHierarchy>> {
    const adIds = [
      ...new Set(
        rows
          .map((row) => row.adId?.trim())
          .filter((adId): adId is string => Boolean(adId))
      )
    ];

    if (adIds.length === 0) {
      return new Map();
    }

    const ads = await this.prisma.metaAd.findMany({
      where: {
        workspaceId,
        adId: { in: adIds }
      },
      select: {
        adId: true,
        campaignId: true,
        adSetId: true
      }
    });

    return new Map(
      ads.map((ad) => [
        ad.adId,
        { campaignId: ad.campaignId, adSetId: ad.adSetId }
      ])
    );
  }

  private async getCursor(
    connectorId: string,
    stream: ExternalSyncStreamDto
  ): Promise<ExternalSyncCursorValue> {
    const cursor = await this.prisma.externalSyncCursor.findUnique({
      where: { connectorId_stream: { connectorId, stream } },
      select: { lastExternalId: true, lastUpdatedAt: true }
    });

    return cursor ?? { lastExternalId: null, lastUpdatedAt: null };
  }

  private cursorFromRow(row: {
    externalRowId: string;
    updatedAt: string;
  }): ExternalSyncCursorValue {
    return {
      lastExternalId: row.externalRowId,
      lastUpdatedAt: this.parseExternalDate(row.updatedAt)
    };
  }

  private async advanceCursor(
    connectorId: string,
    stream: ExternalSyncStreamDto,
    row: { externalRowId: string; updatedAt: string }
  ): Promise<ExternalSyncCursorValue> {
    const lastUpdatedAt = this.parseExternalDate(row.updatedAt);
    const now = new Date();

    await this.prisma.externalSyncCursor.upsert({
      where: { connectorId_stream: { connectorId, stream } },
      create: {
        connectorId,
        stream,
        lastExternalId: row.externalRowId,
        lastUpdatedAt,
        lastSyncedAt: now
      },
      update: {
        lastExternalId: row.externalRowId,
        lastUpdatedAt,
        lastSyncedAt: now
      }
    });

    return { lastExternalId: row.externalRowId, lastUpdatedAt };
  }

  private async touchCursor(
    connectorId: string,
    stream: ExternalSyncStreamDto,
    cursor: ExternalSyncCursorValue
  ): Promise<void> {
    await this.prisma.externalSyncCursor.upsert({
      where: { connectorId_stream: { connectorId, stream } },
      create: {
        connectorId,
        stream,
        lastExternalId: cursor.lastExternalId,
        lastUpdatedAt: cursor.lastUpdatedAt,
        lastSyncedAt: new Date()
      },
      update: { lastSyncedAt: new Date() }
    });
  }

  private async connectorContext(
    connector: ConnectorRecord
  ): Promise<ExternalEventConnectorContext> {
    const [purchaseDefaults, activeCutovers] = await Promise.all([
      this.prisma.funnelStageConfiguration?.findUnique({
        where: {
          workspaceId_eventName: {
            workspaceId: connector.workspaceId,
            eventName: "Purchase"
          }
        },
        select: {
          defaultValueCents: true,
          defaultCurrency: true,
          defaultContentName: true
        }
      }),
      this.prisma.externalCapiCutover.findMany({
        where: { connectorId: connector.id, status: "active" },
        select: { eventType: true, activatedAt: true }
      })
    ]);

    return {
      id: connector.id,
      workspaceId: connector.workspaceId,
      provider: externalConnectorProviderSchema.parse(connector.provider),
      timezone: connector.timezone,
      shadowMode: connector.shadowMode,
      capiSendEnabled: connector.capiSendEnabled,
      capiCutovers: activeCutovers.map((cutover) => ({
        eventType: canonicalTrackingEventTypeSchema.parse(cutover.eventType),
        activatedAt: cutover.activatedAt
      })),
      purchaseAverageValueCents: connector.purchaseAverageValueCents,
      defaultCurrency: connector.defaultCurrency,
      purchaseDefaultValueCents: purchaseDefaults?.defaultValueCents ?? null,
      purchaseDefaultCurrency: purchaseDefaults?.defaultCurrency ?? null,
      purchaseDefaultContentName: purchaseDefaults?.defaultContentName ?? null
    };
  }

  private async projectHistoricalMilestones(
    connector: ConnectorRecord,
    eventContext: ExternalEventConnectorContext,
    row: ExternalLeadRow
  ): Promise<void> {
    const milestones = [
      { eventType: "qualified_lead", occurredAt: row.qualifiedAt },
      { eventType: "purchase", occurredAt: row.purchasedAt }
    ] as const;

    for (const milestone of milestones) {
      if (!milestone.occurredAt) {
        continue;
      }

      const occurredAt = this.parseCalendarDateOrTimestamp(
        milestone.occurredAt,
        connector.timezone
      );
      const externalRowId = [
        "historical-lead",
        row.externalRowId,
        milestone.eventType
      ].join(":");
      const historicalEvent: ExternalEventRow = {
        externalRowId,
        dedupeKey: externalRowId,
        provider: connector.provider,
        eventType: milestone.eventType,
        sourceEventName: "historical_lead_projection",
        externalEventId: null,
        externalLeadId: row.externalLeadId,
        transactionId: null,
        phone: row.phone,
        occurredAt: occurredAt.toISOString(),
        eventLocalDate: dateInTimezone(occurredAt, connector.timezone),
        adId: row.adId,
        adSetId: null,
        campaignId: null,
        ctwaClid: row.ctwaClid,
        sourceUrl: row.sourceUrl,
        valueCents: null,
        currency: null,
        valueSource: null,
        duplicateCount: 0,
        updatedAt: row.updatedAt
      };

      const result = await this.eventIngestion.ingest(
        eventContext,
        historicalEvent,
        { deliveryStatus: "imported", updateLeadStatus: false }
      );

      if (result.status === "rejected") {
        throw new Error(result.errorCode ?? "HistoricalMilestoneRejected");
      }
    }
  }

  private parseCalendarDateOrTimestamp(value: string, timezone: string): Date {
    const dateOnly = /^(\d{4}-\d{2}-\d{2})(?:[ T]00:00:00(?:\.0+)?)?$/.exec(
      value
    );

    return dateOnly
      ? startOfDateInTimezone(dateOnly[1], timezone)
      : this.parseExternalDate(value);
  }

  private normalizeStreams(streams: ExternalSyncStreamDto[]): ExternalSyncStreamDto[] {
    const requested = new Set(streams.map((stream) => externalSyncStreamSchema.parse(stream)));

    return (["leads", "events"] as const).filter((stream) => requested.has(stream));
  }

  private leadStatus(row: ExternalLeadRow): "active" | "qualified" | "converted" {
    const status = row.status?.trim().toLowerCase();

    if (row.purchasedAt || ["comprou", "purchase", "converted"].includes(status ?? "")) {
      return "converted";
    }

    if (
      row.qualifiedAt ||
      ["qualificado", "qualified", "qualified_lead"].includes(status ?? "")
    ) {
      return "qualified";
    }

    return "active";
  }

  private parseExternalDate(value: string): Date {
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value;
    const parsed = new Date(normalized);

    if (Number.isNaN(parsed.getTime())) {
      throw new Error("ExternalRowTimestampInvalid");
    }

    return parsed;
  }

  private rowBatchSize(): number {
    const parsed = Number.parseInt(
      process.env.WPPTRACK_EXTERNAL_SYNC_ROW_BATCH_SIZE ?? "",
      10
    );
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 1_000) : 200;
  }

  private emptyCounts(): ExternalSyncCounts {
    return {
      read: 0,
      imported: 0,
      duplicates: 0,
      filtered: 0,
      rejected: 0,
      queued: 0,
      removed: 0
    };
  }

  private addCounts(target: ExternalSyncCounts, source: ExternalSyncCounts): void {
    target.read += source.read;
    target.imported += source.imported;
    target.duplicates += source.duplicates;
    target.filtered += source.filtered;
    target.rejected += source.rejected;
    target.queued += source.queued;
    target.removed += source.removed;
  }

  private errorCode(error: unknown): string {
    if (error && typeof error === "object" && "code" in error) {
      const code = String((error as { code?: unknown }).code ?? "").trim();
      if (code) {
        return code.slice(0, 100);
      }
    }

    if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]+$/.test(error.message)) {
      return error.message.slice(0, 100);
    }

    return "ExternalDataSyncFailed";
  }

  private safeErrorMessage(error: unknown): string {
    switch (this.errorCode(error)) {
      case "ExternalConnectorNotActive":
        return "O conector externo nao esta ativo";
      case "ExternalRowTimestampInvalid":
        return "A origem retornou uma data invalida";
      case "ER_ACCESS_DENIED_ERROR":
        return "O MySQL recusou as credenciais do conector";
      case "ETIMEDOUT":
      case "PROTOCOL_SEQUENCE_TIMEOUT":
        return "A consulta ao MySQL excedeu o tempo limite";
      default:
        return "A sincronizacao externa nao foi concluida";
    }
  }
}
