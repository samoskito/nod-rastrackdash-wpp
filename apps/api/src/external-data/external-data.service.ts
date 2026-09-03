import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  canonicalTrackingEventTypes,
  externalCapiCutoverResultSchema,
  externalConnectorProviderSchema,
  externalConnectorReconciliationSchema,
  externalConnectorSslModeSchema,
  externalConnectorStatusSchema,
  externalConnectorHealthSchema,
  externalDataConnectorSchema,
  externalMysqlCredentialsInputSchema,
  type CanonicalTrackingEventTypeDto,
  type ExternalCapiCutoverActivateInputDto,
  type ExternalCapiCutoverResultDto,
  type ExternalCapiCutoverRollbackInputDto,
  type ExternalConnectionTestResultDto,
  type ExternalConnectorHealthDto,
  type ExternalConnectorReconciliationDto,
  type ExternalDataConnectorCreateInputDto,
  type ExternalDataConnectorDto,
  type ExternalDataConnectorUpdateInputDto,
  type ExternalSyncInputDto,
  type ExternalSyncQueuedResultDto,
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { ExternalCredentialEncryptionService } from "./external-credential-encryption.service";
import { ExternalConnectorEgressPolicyService } from "./external-connector-egress-policy.service";
import { ExternalMysqlAdapter } from "./external-mysql.adapter";
import { ExternalSyncQueueService } from "./external-sync-queue.service";

type ConnectorWithCursors = {
  id: string;
  workspaceId: string;
  name: string;
  provider: string;
  status: string;
  timezone: string;
  sslMode: string;
  credentialsEncrypted: string;
  credentialsIv: string;
  credentialsTag: string;
  syncEnabled: boolean;
  shadowMode: boolean;
  capiSendEnabled: boolean;
  purchaseAverageValueCents: number | null;
  defaultCurrency: string | null;
  lastConnectionTestAt: Date | null;
  lastConnectionStatus: string | null;
  lastSyncStartedAt: Date | null;
  lastSyncCompletedAt: Date | null;
  lastSyncStatus: string | null;
  lastSyncErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  cursors: Array<{
    stream: string;
    lastExternalId: string | null;
    lastUpdatedAt: Date | null;
    lastSyncedAt: Date | null;
  }>;
  capiCutovers: Array<{
    id: string;
    eventType: string;
    status: string;
    activatedAt: Date;
    shadowArchivedRows: number;
    rolledBackAt: Date | null;
  }>;
};

@Injectable()
export class ExternalDataService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ExternalCredentialEncryptionService)
    private readonly credentialEncryption: ExternalCredentialEncryptionService,
    @Inject(ExternalMysqlAdapter)
    private readonly mysqlAdapter: ExternalMysqlAdapter,
    @Inject(ExternalConnectorEgressPolicyService)
    private readonly egressPolicy: ExternalConnectorEgressPolicyService,
    @Inject(ExternalSyncQueueService)
    private readonly syncQueue: ExternalSyncQueueService,
  ) {}

  async listWorkspaceConnectors(
    workspaceId: string,
    _actorUserId: string,
  ): Promise<ExternalDataConnectorDto[]> {
    return this.listConnectors(workspaceId) as Promise<
      ExternalDataConnectorDto[]
    >;
  }

  async createWorkspaceConnector(
    workspaceId: string,
    input: ExternalDataConnectorCreateInputDto,
    actorUserId: string,
  ): Promise<ExternalDataConnectorDto> {
    if (input.workspaceId !== workspaceId) {
      throw new BadRequestException("Workspace do conector invalido");
    }
    if (input.syncEnabled || !input.shadowMode || input.capiSendEnabled) {
      throw new BadRequestException(
        "Este conector opera somente em modo leitura",
      );
    }
    await this.egressPolicy.assertAllowed(input.credentials);
    return this.createConnector(input, actorUserId);
  }

  async testWorkspaceConnection(
    workspaceId: string,
    connectorId: string,
    actorUserId: string,
  ): Promise<ExternalConnectionTestResultDto> {
    const connector = await this.getWorkspaceConnector(
      workspaceId,
      connectorId,
    );
    const credentials = this.credentialEncryption.decrypt(connector);
    const resolvedCredentials =
      await this.egressPolicy.resolveAllowed(credentials);
    return this.testConnectionForConnector(
      connector,
      resolvedCredentials,
      actorUserId,
    );
  }

  async getWorkspaceConnectorStatus(
    workspaceId: string,
    connectorId: string,
    _actorUserId: string,
  ): Promise<ExternalDataConnectorDto> {
    return this.toDto(
      await this.getWorkspaceConnector(workspaceId, connectorId),
    );
  }

  async listConnectors(
    workspaceId?: string,
    includeHealth = false,
  ): Promise<ExternalDataConnectorDto[] | ExternalConnectorHealthDto[]> {
    const connectors = (await this.prisma.externalDataConnector.findMany({
      where: workspaceId ? { workspaceId } : undefined,
      include: {
        cursors: { orderBy: { stream: "asc" } },
        capiCutovers: {
          where: { status: "active" },
          orderBy: { activatedAt: "asc" },
        },
      },
      orderBy: [{ workspaceId: "asc" }, { createdAt: "desc" }],
    })) as ConnectorWithCursors[];

    if (!includeHealth) {
      return connectors.map((connector) => this.toDto(connector));
    }

    const totalsByConnector = await this.ingestionTotals(
      connectors.map((connector) => connector.id),
    );
    const reconciliationByConnector =
      await this.buildReconciliations(connectors);

    return connectors.map((connector) =>
      externalConnectorHealthSchema.parse({
        connector: this.toDto(connector),
        totals:
          totalsByConnector.get(connector.id) ?? this.emptyIngestionTotals(),
        reconciliation: reconciliationByConnector.get(connector.id),
      }),
    );
  }

  async createConnector(
    input: ExternalDataConnectorCreateInputDto,
    actorUserId: string,
  ): Promise<ExternalDataConnectorDto> {
    if (input.capiSendEnabled || !input.shadowMode) {
      throw new BadRequestException(
        "O conector deve ser criado em modo sombra antes do corte CAPI",
      );
    }

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: input.workspaceId },
      select: { id: true },
    });

    if (!workspace) {
      throw new NotFoundException("Workspace nao encontrado");
    }

    const encrypted = this.credentialEncryption.encrypt(input.credentials);
    const connector = (await this.prisma.externalDataConnector.create({
      data: {
        workspaceId: input.workspaceId,
        name: input.name,
        provider: input.provider,
        timezone: input.timezone,
        sslMode: input.sslMode,
        ...encrypted,
        syncEnabled: input.syncEnabled,
        shadowMode: input.shadowMode,
        capiSendEnabled: input.capiSendEnabled,
        purchaseAverageValueCents: input.purchaseAverageValueCents ?? null,
        defaultCurrency: input.defaultCurrency,
      },
      include: { cursors: true, capiCutovers: true },
    })) as ConnectorWithCursors;
    const dto = this.toDto(connector);

    await this.createAudit({
      workspaceId: connector.workspaceId,
      actorUserId,
      action: "external_connector.created",
      targetId: connector.id,
      afterSummary: this.auditSummary(dto),
    });

    return dto;
  }

  async updateConnector(
    connectorId: string,
    input: ExternalDataConnectorUpdateInputDto,
    actorUserId: string,
  ): Promise<ExternalDataConnectorDto> {
    const current = await this.getConnector(connectorId);
    const before = this.toDto(current);
    const enablesReading =
      input.status === "active" || input.syncEnabled === true;

    if (input.capiSendEnabled === true || input.shadowMode === false) {
      throw new BadRequestException(
        "Use o gate de corte CAPI para transferir o envio ao WppTrack",
      );
    }

    if (
      current.capiCutovers.length > 0 &&
      (input.status === "disabled" || input.syncEnabled === false)
    ) {
      throw new BadRequestException(
        "Reverta os cortes CAPI ativos antes de desligar o conector",
      );
    }

    if (enablesReading && current.lastConnectionStatus !== "connected") {
      throw new BadRequestException(
        "Teste a conexao e as views antes de ativar a sincronizacao",
      );
    }

    const data: Prisma.ExternalDataConnectorUpdateInput = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.sslMode !== undefined ? { sslMode: input.sslMode } : {}),
      ...(input.syncEnabled !== undefined
        ? { syncEnabled: input.syncEnabled }
        : {}),
      ...(input.shadowMode !== undefined
        ? { shadowMode: input.shadowMode }
        : {}),
      ...(input.capiSendEnabled !== undefined
        ? { capiSendEnabled: input.capiSendEnabled }
        : {}),
      ...(input.purchaseAverageValueCents !== undefined
        ? { purchaseAverageValueCents: input.purchaseAverageValueCents }
        : {}),
      ...(input.defaultCurrency !== undefined
        ? { defaultCurrency: input.defaultCurrency }
        : {}),
    };

    if (input.credentials) {
      const existing = this.credentialEncryption.decrypt(current);
      const credentials = externalMysqlCredentialsInputSchema.parse({
        ...existing,
        ...input.credentials,
      });
      Object.assign(data, this.credentialEncryption.encrypt(credentials));
    }

    if (input.status === "disabled") {
      data.syncEnabled = false;
      data.capiSendEnabled = false;
    }

    const updated = (await this.prisma.externalDataConnector.update({
      where: { id: connectorId },
      data,
      include: {
        cursors: { orderBy: { stream: "asc" } },
        capiCutovers: {
          where: { status: "active" },
          orderBy: { activatedAt: "asc" },
        },
      },
    })) as ConnectorWithCursors;
    const dto = this.toDto(updated);

    await this.createAudit({
      workspaceId: updated.workspaceId,
      actorUserId,
      action: "external_connector.updated",
      targetId: updated.id,
      beforeSummary: this.auditSummary(before),
      afterSummary: this.auditSummary(dto),
    });

    return dto;
  }

  async testConnection(
    connectorId: string,
    actorUserId: string,
  ): Promise<ExternalConnectionTestResultDto> {
    const connector = await this.getConnector(connectorId);
    const credentials = this.credentialEncryption.decrypt(connector);
    const resolvedCredentials =
      await this.egressPolicy.resolveAllowed(credentials);
    return this.testConnectionForConnector(
      connector,
      resolvedCredentials,
      actorUserId,
    );
  }

  private async testConnectionForConnector(
    connector: ConnectorWithCursors,
    credentials: ReturnType<ExternalCredentialEncryptionService["decrypt"]>,
    actorUserId: string,
  ): Promise<ExternalConnectionTestResultDto> {
    const sslMode = externalConnectorSslModeSchema.parse(connector.sslMode);
    const result = await this.mysqlAdapter.testConnection(credentials, sslMode);

    await this.prisma.externalDataConnector.update({
      where: { id: connector.id },
      data: {
        lastConnectionTestAt: new Date(),
        lastConnectionStatus: result.status,
        ...(result.ok ? { lastSyncErrorCode: null } : {}),
      },
    });
    await this.createAudit({
      workspaceId: connector.workspaceId,
      actorUserId,
      action: "external_connector.connection_tested",
      targetId: connector.id,
      resultStatus: result.ok ? "success" : "failed",
      afterSummary: {
        status: result.status,
        latencyMs: result.latencyMs,
        leadsViewAvailable: result.leadsViewAvailable,
        eventsViewAvailable: result.eventsViewAvailable,
        errorCode: result.errorCode,
      },
    });

    return result;
  }

  async enqueueSync(
    connectorId: string,
    input: ExternalSyncInputDto,
    actorUserId: string,
  ): Promise<ExternalSyncQueuedResultDto> {
    const connector = await this.getConnector(connectorId);

    if (connector.status !== "active") {
      throw new BadRequestException("Ative o conector antes de sincronizar");
    }

    const result = await this.syncQueue.enqueueSync({
      connectorId,
      workspaceId: connector.workspaceId,
      streams: input.streams,
      requestedByUserId: actorUserId,
    });
    await this.createAudit({
      workspaceId: connector.workspaceId,
      actorUserId,
      action: "external_connector.sync_requested",
      targetId: connector.id,
      afterSummary: { streams: result.streams, jobId: result.jobId },
    });

    return result;
  }

  async enqueueLeadsReimport(
    connectorId: string,
    actorUserId: string,
  ): Promise<ExternalSyncQueuedResultDto> {
    const connector = await this.getConnector(connectorId);

    if (connector.status !== "active") {
      throw new BadRequestException("Ative o conector antes de reimportar");
    }

    if (connector.lastSyncStatus === "running") {
      throw new BadRequestException("Aguarde a sincronizacao atual terminar");
    }

    const result = await this.syncQueue.enqueueSync({
      connectorId,
      workspaceId: connector.workspaceId,
      streams: ["leads"],
      projectionRefresh: true,
      requestedByUserId: actorUserId,
    });
    await this.createAudit({
      workspaceId: connector.workspaceId,
      actorUserId,
      action: "external_connector.leads_reimport_requested",
      targetId: connector.id,
      afterSummary: { streams: result.streams, jobId: result.jobId },
    });

    return result;
  }

  async getHealth(connectorId: string): Promise<ExternalConnectorHealthDto> {
    const connector = await this.getConnector(connectorId);
    const [totalsByConnector, reconciliations] = await Promise.all([
      this.ingestionTotals([connectorId]),
      this.buildReconciliations([connector]),
    ]);

    return externalConnectorHealthSchema.parse({
      connector: this.toDto(connector),
      totals: totalsByConnector.get(connectorId) ?? this.emptyIngestionTotals(),
      reconciliation: reconciliations.get(connectorId),
    });
  }

  async activateCapiCutover(
    connectorId: string,
    input: ExternalCapiCutoverActivateInputDto,
    actorUserId: string,
  ): Promise<ExternalCapiCutoverResultDto> {
    const health = await this.getHealth(connectorId);
    const event = health.reconciliation?.events.find(
      (candidate) => candidate.eventType === input.eventType,
    );

    if (!event) {
      throw new BadRequestException(
        "Evento externo nao encontrado no gate CAPI",
      );
    }
    if (event.capiActive) {
      throw new BadRequestException(
        "O WppTrack ja assumiu este tipo de evento",
      );
    }
    if (!event.readyForCutover) {
      throw new BadRequestException(
        "Resolva os bloqueios deste evento antes de assumir o envio",
      );
    }
    if (event.operationalRows !== input.expectedOperationalRows) {
      throw new BadRequestException(
        "Os totais mudaram. Atualize o gate e confirme o corte novamente",
      );
    }

    const connector = health.connector;
    const activatedAt = new Date();
    const eventName = this.conversionEventName(input.eventType);
    const cutover = await this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.externalCapiCutover.findFirst({
        where: {
          connectorId,
          eventType: input.eventType,
          status: "active",
        },
      });

      if (existing) {
        throw new BadRequestException(
          "O WppTrack ja assumiu este tipo de evento",
        );
      }

      const archived = await transaction.conversionEventLog.updateMany({
        where: {
          externalConnectorId: connectorId,
          eventName,
          status: "ready_to_send",
          eventOccurredAt: { lt: activatedAt },
        },
        data: {
          status: "shadow_observed",
          errorCode: null,
          errorMessage: null,
        },
      });
      const created = await transaction.externalCapiCutover.create({
        data: {
          workspaceId: connector.workspaceId,
          connectorId,
          eventType: input.eventType,
          status: "active",
          activatedAt,
          activatedByUserId: actorUserId,
          shadowArchivedRows: archived.count,
        },
      });
      const activeCount = await transaction.externalCapiCutover.count({
        where: { connectorId, status: "active" },
      });

      await transaction.externalDataConnector.update({
        where: { id: connectorId },
        data: {
          capiSendEnabled: activeCount > 0,
          shadowMode: activeCount < canonicalTrackingEventTypes.length,
        },
      });

      return created;
    });

    let syncJobId: string | null = null;
    try {
      const sync = await this.syncQueue.enqueueSync({
        connectorId,
        workspaceId: connector.workspaceId,
        streams: ["events"],
        requestedByUserId: actorUserId,
      });
      syncJobId = sync.jobId;
    } catch {
      // A sincronizacao automatica continua ativa; o corte nao deve ser revertido por falha da fila.
    }

    await this.createAudit({
      workspaceId: connector.workspaceId,
      actorUserId,
      action: "external_connector.capi_cutover_activated",
      targetId: connectorId,
      beforeSummary: {
        eventType: input.eventType,
        operationalRows: input.expectedOperationalRows,
        legacyDelivery: "n8n",
      },
      afterSummary: {
        eventType: input.eventType,
        activatedAt: cutover.activatedAt.toISOString(),
        shadowArchivedRows: cutover.shadowArchivedRows,
        deliveryOwner: "wpptrack",
        syncJobId,
      },
    });

    return externalCapiCutoverResultSchema.parse({
      connectorId,
      cutover: this.cutoverDto(cutover),
      syncJobId,
    });
  }

  async rollbackCapiCutover(
    connectorId: string,
    input: ExternalCapiCutoverRollbackInputDto,
    actorUserId: string,
  ): Promise<ExternalCapiCutoverResultDto> {
    const connector = await this.getConnector(connectorId);
    const rolledBackAt = new Date();
    const rollback = await this.prisma.$transaction(async (transaction) => {
      const active = await transaction.externalCapiCutover.findFirst({
        where: {
          connectorId,
          eventType: input.eventType,
          status: "active",
        },
        orderBy: { activatedAt: "desc" },
      });

      if (!active) {
        throw new BadRequestException(
          "Este tipo de evento nao esta ativo no WppTrack",
        );
      }

      const eventName = this.conversionEventName(input.eventType);
      const archived = await transaction.conversionEventLog.updateMany({
        where: {
          externalConnectorId: connectorId,
          eventName,
          status: "ready_to_send",
        },
        data: {
          status: "shadow_observed",
          errorCode: null,
          errorMessage: null,
        },
      });
      const updated = await transaction.externalCapiCutover.update({
        where: { id: active.id },
        data: {
          status: "rolled_back",
          rolledBackAt,
          rolledBackByUserId: actorUserId,
        },
      });
      const activeCount = await transaction.externalCapiCutover.count({
        where: { connectorId, status: "active" },
      });

      await transaction.externalDataConnector.update({
        where: { id: connectorId },
        data: {
          capiSendEnabled: activeCount > 0,
          shadowMode: activeCount < canonicalTrackingEventTypes.length,
        },
      });

      return { cutover: updated, archivedRows: archived.count };
    });

    await this.createAudit({
      workspaceId: connector.workspaceId,
      actorUserId,
      action: "external_connector.capi_cutover_rolled_back",
      targetId: connectorId,
      beforeSummary: {
        eventType: input.eventType,
        deliveryOwner: "wpptrack",
      },
      afterSummary: {
        eventType: input.eventType,
        rolledBackAt:
          rollback.cutover.rolledBackAt?.toISOString() ??
          rolledBackAt.toISOString(),
        deliveryOwner: "n8n",
        cancelledReadyRows: rollback.archivedRows,
      },
    });

    return externalCapiCutoverResultSchema.parse({
      connectorId,
      cutover: this.cutoverDto(rollback.cutover),
      syncJobId: null,
    });
  }

  private async buildReconciliations(
    connectors: ConnectorWithCursors[],
  ): Promise<Map<string, ExternalConnectorReconciliationDto>> {
    const reconciliations = new Map<
      string,
      ExternalConnectorReconciliationDto
    >();
    if (!connectors.length) {
      return reconciliations;
    }

    const connectorIds = connectors.map((connector) => connector.id);
    const workspaceIds = [
      ...new Set(connectors.map((connector) => connector.workspaceId)),
    ];
    const eventNames = ["LeadSubmitted", "QualifiedLead", "Purchase"];
    const activeConversionLinks =
      await this.prisma.externalIngestionRecord.findMany({
        where: {
          connectorId: { in: connectorIds },
          stream: "events",
          eventType: { in: [...canonicalTrackingEventTypes] },
          status: { in: ["imported", "duplicate"] },
          conversionEventLogId: { not: null },
        },
        select: {
          connectorId: true,
          eventType: true,
          conversionEventLogId: true,
        },
      });
    const activeConversionIdsByConnector = new Map<string, Set<string>>();
    const expectedConversionIdsByConnector = new Map<
      string,
      Map<CanonicalTrackingEventTypeDto, Set<string>>
    >();
    for (const link of activeConversionLinks) {
      if (!link.conversionEventLogId || !link.eventType) {
        continue;
      }
      const ids =
        activeConversionIdsByConnector.get(link.connectorId) ??
        new Set<string>();
      ids.add(link.conversionEventLogId);
      activeConversionIdsByConnector.set(link.connectorId, ids);

      const eventType = link.eventType as CanonicalTrackingEventTypeDto;
      const idsByEvent =
        expectedConversionIdsByConnector.get(link.connectorId) ??
        new Map<CanonicalTrackingEventTypeDto, Set<string>>();
      const eventIds = idsByEvent.get(eventType) ?? new Set<string>();
      eventIds.add(link.conversionEventLogId);
      idsByEvent.set(eventType, eventIds);
      expectedConversionIdsByConnector.set(link.connectorId, idsByEvent);
    }
    const activeDeliveryFilters = [
      ...activeConversionIdsByConnector.entries(),
    ].map(([externalConnectorId, ids]) => ({
      externalConnectorId,
      id: { in: [...ids] },
    }));
    const [
      ingestionGroups,
      historicalGroups,
      deliveryGroups,
      metaConnections,
      metaDestinations,
    ] = await Promise.all([
      this.prisma.externalIngestionRecord.groupBy({
        by: ["connectorId", "eventType", "status", "errorCode"],
        where: {
          connectorId: { in: connectorIds },
          stream: "events",
          eventType: { in: [...canonicalTrackingEventTypes] },
          status: { not: "removed" },
        },
        _count: { _all: true },
        _sum: { duplicateCount: true },
        _min: { occurredAt: true },
        _max: { occurredAt: true },
      }),
      this.prisma.externalIngestionRecord.groupBy({
        by: ["connectorId", "eventType"],
        where: {
          connectorId: { in: connectorIds },
          stream: "events",
          eventType: { in: [...canonicalTrackingEventTypes] },
          externalRowId: { startsWith: "historical-lead:" },
          status: { in: ["imported", "duplicate"] },
        },
        _count: { _all: true },
      }),
      activeDeliveryFilters.length
        ? this.prisma.conversionEventLog.groupBy({
            by: [
              "externalConnectorId",
              "eventName",
              "status",
              "businessSource",
            ],
            where: {
              OR: activeDeliveryFilters,
              eventName: { in: eventNames },
            },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      this.prisma.metaIntegration.findMany({
        where: { workspaceId: { in: workspaceIds } },
        select: { workspaceId: true, status: true, encryptedAccessToken: true },
      }),
      this.prisma.metaConversionDestination.findMany({
        where: { workspaceId: { in: workspaceIds } },
        select: {
          workspaceId: true,
          status: true,
          pixelId: true,
          pageId: true,
        },
      }),
    ]);
    const eventsByConnector = new Map<
      string,
      Map<
        CanonicalTrackingEventTypeDto,
        ExternalConnectorReconciliationDto["events"][number]
      >
    >();
    for (const connector of connectors) {
      const activeCutovers = new Map(
        connector.capiCutovers
          .filter((cutover) => cutover.status === "active")
          .map((cutover) => [cutover.eventType, cutover.activatedAt] as const),
      );
      const events = new Map<
        CanonicalTrackingEventTypeDto,
        ExternalConnectorReconciliationDto["events"][number]
      >();
      for (const eventType of canonicalTrackingEventTypes) {
        events.set(eventType, {
          eventType,
          sourceRows: 0,
          acceptedRows: 0,
          operationalRows: 0,
          historicalRows: 0,
          expectedMatchedRows: 0,
          matchedRows: 0,
          duplicateDeliveries: 0,
          rejectedRows: 0,
          quarantinedRows: 0,
          blockingRejectedRows: 0,
          pendingRows: 0,
          readyToSendRows: 0,
          sentRows: 0,
          importedRows: 0,
          notEligibleRows: 0,
          shadowObservedRows: 0,
          blockedDeliveryRows: 0,
          capiActive: activeCutovers.has(eventType),
          readyForCutover: false,
          cutoverAt: activeCutovers.get(eventType)?.toISOString() ?? null,
          firstOccurredAt: null,
          lastOccurredAt: null,
        });
      }
      eventsByConnector.set(connector.id, events);
    }
    for (const [connectorId, idsByEvent] of expectedConversionIdsByConnector) {
      const events = eventsByConnector.get(connectorId);
      if (!events) {
        continue;
      }
      for (const [eventType, ids] of idsByEvent) {
        const event = events.get(eventType);
        if (event) {
          event.expectedMatchedRows = ids.size;
        }
      }
    }

    for (const group of ingestionGroups) {
      const event = group.eventType
        ? eventsByConnector
            .get(group.connectorId)
            ?.get(group.eventType as CanonicalTrackingEventTypeDto)
        : undefined;
      if (!event) {
        continue;
      }

      event.sourceRows += group._count._all;
      event.duplicateDeliveries += Math.max(0, group._sum.duplicateCount ?? 0);
      event.firstOccurredAt = this.earlierDate(
        event.firstOccurredAt,
        group._min.occurredAt,
      );
      event.lastOccurredAt = this.laterDate(
        event.lastOccurredAt,
        group._max.occurredAt,
      );

      if (["imported", "duplicate"].includes(group.status)) {
        event.acceptedRows += group._count._all;
      } else if (group.status === "rejected") {
        event.rejectedRows += group._count._all;
        if (group.errorCode === "ExternalLeadNotMatched") {
          event.quarantinedRows += group._count._all;
        } else {
          event.blockingRejectedRows += group._count._all;
        }
      } else if (["pending", "pending_delivery"].includes(group.status)) {
        event.pendingRows += group._count._all;
      }
    }

    for (const group of historicalGroups) {
      const event = group.eventType
        ? eventsByConnector
            .get(group.connectorId)
            ?.get(group.eventType as CanonicalTrackingEventTypeDto)
        : undefined;
      if (event) {
        event.historicalRows += group._count._all;
      }
    }

    const eventTypeByName = new Map<string, CanonicalTrackingEventTypeDto>([
      ["LeadSubmitted", "conversation_started"],
      ["QualifiedLead", "qualified_lead"],
      ["Purchase", "purchase"],
    ]);
    const acceptedPaidStatuses = new Set([
      "ready_to_send",
      "sent",
      "imported",
      "not_eligible",
      "shadow_observed",
    ]);

    for (const group of deliveryGroups) {
      const eventType = eventTypeByName.get(group.eventName);
      const event =
        eventType && group.externalConnectorId
          ? eventsByConnector.get(group.externalConnectorId)?.get(eventType)
          : undefined;
      if (!event) {
        continue;
      }

      event.matchedRows += group._count._all;
      if (group.status === "ready_to_send") {
        event.readyToSendRows += group._count._all;
      } else if (group.status === "sent") {
        event.sentRows += group._count._all;
      } else if (group.status === "imported") {
        event.importedRows += group._count._all;
      } else if (group.status === "not_eligible") {
        event.notEligibleRows += group._count._all;
      } else if (group.status === "shadow_observed") {
        event.shadowObservedRows += group._count._all;
      }

      if (
        group.businessSource === "paid" &&
        !acceptedPaidStatuses.has(group.status)
      ) {
        event.blockedDeliveryRows += group._count._all;
      }
    }

    const metaConnectionByWorkspace = new Map<
      string,
      (typeof metaConnections)[number]
    >();
    for (const connection of metaConnections) {
      metaConnectionByWorkspace.set(connection.workspaceId, connection);
    }
    const metaDestinationByWorkspace = new Map<
      string,
      (typeof metaDestinations)[number]
    >();
    for (const destination of metaDestinations) {
      metaDestinationByWorkspace.set(destination.workspaceId, destination);
    }

    const generatedAt = new Date().toISOString();
    for (const connector of connectors) {
      const eventMap = eventsByConnector.get(connector.id);
      if (!eventMap) {
        continue;
      }

      const reconciledEvents = [...eventMap.values()].map((event) => ({
        ...event,
        operationalRows: Math.max(
          0,
          event.acceptedRows - event.historicalRows - event.notEligibleRows,
        ),
      }));
      const blockers: ExternalConnectorReconciliationDto["blockers"] = [];
      const addBlocker = (code: string, message: string) => {
        blockers.push({ code, message });
      };

      if (connector.status !== "active") {
        addBlocker(
          "CONNECTOR_INACTIVE",
          "Ative o conector externo antes do corte CAPI.",
        );
      }
      if (!connector.syncEnabled) {
        addBlocker(
          "SYNC_DISABLED",
          "Ative a sincronizacao automatica do conector.",
        );
      }
      if (connector.lastConnectionStatus !== "connected") {
        addBlocker(
          "CONNECTION_NOT_VALIDATED",
          "Valide novamente a conexao MySQL.",
        );
      }
      if (connector.lastSyncStatus !== "completed") {
        addBlocker(
          "SYNC_NOT_COMPLETED",
          "Conclua uma sincronizacao sem falhas.",
        );
      }
      if (
        !connector.cursors.some(
          (cursor) => cursor.stream === "events" && cursor.lastSyncedAt,
        )
      ) {
        addBlocker(
          "EVENT_CURSOR_MISSING",
          "Sincronize o fluxo de eventos ao menos uma vez.",
        );
      }
      const activeCutoverCount = connector.capiCutovers.filter(
        (cutover) => cutover.status === "active",
      ).length;
      const expectedCapiEnabled = activeCutoverCount > 0;
      const expectedShadowMode =
        activeCutoverCount < canonicalTrackingEventTypes.length;
      if (
        connector.capiSendEnabled !== expectedCapiEnabled ||
        connector.shadowMode !== expectedShadowMode
      ) {
        addBlocker(
          "CAPI_MODE_INCONSISTENT",
          "O modo CAPI nao corresponde aos tipos de evento assumidos pelo WppTrack.",
        );
      }

      const metaConnection = metaConnectionByWorkspace.get(
        connector.workspaceId,
      );
      const metaDestination = metaDestinationByWorkspace.get(
        connector.workspaceId,
      );
      const connectionConfigured =
        metaConnection?.status === "connected" &&
        Boolean(metaConnection.encryptedAccessToken);
      const destinationConfigured =
        metaDestination?.status === "configured" &&
        Boolean(metaDestination.pixelId) &&
        Boolean(metaDestination.pageId);

      if (!connectionConfigured) {
        addBlocker(
          "META_CONNECTION_MISSING",
          "Conecte a conta Meta deste workspace.",
        );
      }
      if (!destinationConfigured) {
        addBlocker(
          "META_DESTINATION_MISSING",
          "Configure Pixel e Pagina do destino CAPI.",
        );
      }

      const baseReadyForCutover =
        connector.status === "active" &&
        connector.syncEnabled &&
        connector.lastConnectionStatus === "connected" &&
        connector.lastSyncStatus === "completed" &&
        connector.cursors.some(
          (cursor) => cursor.stream === "events" && cursor.lastSyncedAt,
        ) &&
        connectionConfigured &&
        destinationConfigured &&
        connector.capiSendEnabled === expectedCapiEnabled &&
        connector.shadowMode === expectedShadowMode;

      for (const event of reconciledEvents) {
        const eventLabel = this.reconciliationEventLabel(event.eventType);
        if (event.operationalRows === 0) {
          addBlocker(
            `EVENT_NOT_OBSERVED_${event.eventType.toUpperCase()}`,
            `Aguarde o primeiro evento real de ${eventLabel}.`,
          );
        }
        if (event.blockingRejectedRows > 0) {
          addBlocker(
            `REJECTED_${event.eventType.toUpperCase()}`,
            `${event.blockingRejectedRows} evento(s) de ${eventLabel} falharam na ingestao.`,
          );
        }
        if (event.pendingRows > 0) {
          addBlocker(
            `PENDING_${event.eventType.toUpperCase()}`,
            `${event.pendingRows} evento(s) de ${eventLabel} estao pendentes.`,
          );
        }

        const expectedMatches = event.expectedMatchedRows;
        if (event.matchedRows < expectedMatches) {
          addBlocker(
            `UNMATCHED_${event.eventType.toUpperCase()}`,
            `${expectedMatches - event.matchedRows} evento(s) de ${eventLabel} nao possuem conversao vinculada.`,
          );
        }
        if (event.blockedDeliveryRows > 0) {
          addBlocker(
            `DELIVERY_BLOCKED_${event.eventType.toUpperCase()}`,
            `${event.blockedDeliveryRows} evento(s) pagos de ${eventLabel} nao estao prontos para CAPI.`,
          );
        }

        event.readyForCutover =
          !event.capiActive &&
          baseReadyForCutover &&
          event.operationalRows > 0 &&
          event.blockingRejectedRows === 0 &&
          event.pendingRows === 0 &&
          event.matchedRows >= event.expectedMatchedRows &&
          event.blockedDeliveryRows === 0;
      }

      const readyForCutover =
        activeCutoverCount < canonicalTrackingEventTypes.length &&
        reconciledEvents.every(
          (event) => event.capiActive || event.readyForCutover,
        );
      const onlyWaitingForSamples =
        blockers.length > 0 &&
        blockers.every((blocker) =>
          blocker.code.startsWith("EVENT_NOT_OBSERVED_"),
        );
      const state =
        activeCutoverCount === canonicalTrackingEventTypes.length
          ? "live"
          : activeCutoverCount > 0
            ? "partial"
            : readyForCutover
              ? "ready"
              : onlyWaitingForSamples
                ? "collecting"
                : "blocked";

      const reconciliation = externalConnectorReconciliationSchema.parse({
        connectorId: connector.id,
        workspaceId: connector.workspaceId,
        generatedAt,
        state,
        readyForCutover,
        meta: {
          connectionConfigured,
          destinationConfigured,
          pixelId: metaDestination?.pixelId ?? null,
          pageId: metaDestination?.pageId ?? null,
        },
        events: reconciledEvents,
        blockers,
      });
      reconciliations.set(connector.id, reconciliation);
    }

    return reconciliations;
  }

  private reconciliationEventLabel(
    eventType: CanonicalTrackingEventTypeDto,
  ): string {
    const labels: Record<CanonicalTrackingEventTypeDto, string> = {
      conversation_started: "conversa",
      qualified_lead: "lead qualificado",
      purchase: "compra",
    };

    return labels[eventType];
  }

  private earlierDate(
    current: string | null,
    candidate: Date | null,
  ): string | null {
    if (!candidate) {
      return current;
    }
    if (!current || candidate.getTime() < new Date(current).getTime()) {
      return candidate.toISOString();
    }
    return current;
  }

  private laterDate(
    current: string | null,
    candidate: Date | null,
  ): string | null {
    if (!candidate) {
      return current;
    }
    if (!current || candidate.getTime() > new Date(current).getTime()) {
      return candidate.toISOString();
    }
    return current;
  }

  private async ingestionTotals(
    connectorIds: string[],
  ): Promise<Map<string, ExternalConnectorHealthDto["totals"]>> {
    const totalsByConnector = new Map<
      string,
      ExternalConnectorHealthDto["totals"]
    >();

    if (!connectorIds.length) {
      return totalsByConnector;
    }

    const groups = await this.prisma.externalIngestionRecord.groupBy({
      by: ["connectorId", "status", "errorCode"],
      where: { connectorId: { in: connectorIds } },
      _count: { _all: true },
      _sum: { duplicateCount: true },
    });

    for (const group of groups) {
      const totals =
        totalsByConnector.get(group.connectorId) ?? this.emptyIngestionTotals();
      if (group.status !== "removed") {
        totals.duplicates += Math.max(0, group._sum.duplicateCount ?? 0);
      }

      if (group.status === "imported") {
        totals.imported += group._count._all;
      } else if (group.status === "duplicate") {
        totals.duplicates += group._count._all;
      } else if (group.status === "rejected") {
        totals.rejected += group._count._all;
        if (group.errorCode === "ExternalLeadNotMatched") {
          totals.quarantined += group._count._all;
        } else {
          totals.failed += group._count._all;
        }
      } else if (["pending", "pending_delivery"].includes(group.status)) {
        totals.pending += group._count._all;
      }

      totalsByConnector.set(group.connectorId, totals);
    }

    return totalsByConnector;
  }

  private emptyIngestionTotals(): ExternalConnectorHealthDto["totals"] {
    return {
      imported: 0,
      duplicates: 0,
      rejected: 0,
      quarantined: 0,
      failed: 0,
      pending: 0,
    };
  }

  private async getConnector(
    connectorId: string,
  ): Promise<ConnectorWithCursors> {
    const connector = (await this.prisma.externalDataConnector.findUnique({
      where: { id: connectorId },
      include: {
        cursors: { orderBy: { stream: "asc" } },
        capiCutovers: {
          where: { status: "active" },
          orderBy: { activatedAt: "asc" },
        },
      },
    })) as ConnectorWithCursors | null;

    if (!connector) {
      throw new NotFoundException("Conector externo nao encontrado");
    }

    return connector;
  }

  private async getWorkspaceConnector(
    workspaceId: string,
    connectorId: string,
  ): Promise<ConnectorWithCursors> {
    const connector = (await this.prisma.externalDataConnector.findFirst({
      where: { id: connectorId, workspaceId },
      include: {
        cursors: { orderBy: { stream: "asc" } },
        capiCutovers: {
          where: { status: "active" },
          orderBy: { activatedAt: "asc" },
        },
      },
    })) as ConnectorWithCursors | null;

    if (!connector)
      throw new NotFoundException("Conector externo nao encontrado");
    return connector;
  }

  private toDto(connector: ConnectorWithCursors): ExternalDataConnectorDto {
    return externalDataConnectorSchema.parse({
      id: connector.id,
      workspaceId: connector.workspaceId,
      name: connector.name,
      provider: externalConnectorProviderSchema.parse(connector.provider),
      status: externalConnectorStatusSchema.parse(connector.status),
      timezone: connector.timezone,
      sslMode: externalConnectorSslModeSchema.parse(connector.sslMode),
      syncEnabled: connector.syncEnabled,
      shadowMode: connector.shadowMode,
      capiSendEnabled: connector.capiSendEnabled,
      capiCutovers: connector.capiCutovers.map((cutover) =>
        this.cutoverDto(cutover),
      ),
      purchaseAverageValueCents: connector.purchaseAverageValueCents,
      defaultCurrency: connector.defaultCurrency,
      hasCredentials: true,
      lastConnectionTestAt:
        connector.lastConnectionTestAt?.toISOString() ?? null,
      lastConnectionStatus: connector.lastConnectionStatus,
      lastSyncStartedAt: connector.lastSyncStartedAt?.toISOString() ?? null,
      lastSyncCompletedAt: connector.lastSyncCompletedAt?.toISOString() ?? null,
      lastSyncStatus: connector.lastSyncStatus,
      lastSyncErrorCode: connector.lastSyncErrorCode,
      cursors: connector.cursors.map((cursor) => ({
        stream: cursor.stream,
        lastExternalId: cursor.lastExternalId,
        lastUpdatedAt: cursor.lastUpdatedAt?.toISOString() ?? null,
        lastSyncedAt: cursor.lastSyncedAt?.toISOString() ?? null,
      })),
      createdAt: connector.createdAt.toISOString(),
      updatedAt: connector.updatedAt.toISOString(),
    });
  }

  private auditSummary(
    connector: ExternalDataConnectorDto,
  ): Prisma.InputJsonValue {
    return {
      name: connector.name,
      provider: connector.provider,
      status: connector.status,
      timezone: connector.timezone,
      sslMode: connector.sslMode,
      syncEnabled: connector.syncEnabled,
      shadowMode: connector.shadowMode,
      capiSendEnabled: connector.capiSendEnabled,
      capiCutovers: connector.capiCutovers.map((cutover) => ({
        eventType: cutover.eventType,
        activatedAt: cutover.activatedAt,
      })),
      purchaseAverageValueCents: connector.purchaseAverageValueCents,
      defaultCurrency: connector.defaultCurrency,
      hasCredentials: true,
    } as Prisma.InputJsonValue;
  }

  private async createAudit(input: {
    workspaceId: string;
    actorUserId: string;
    action: string;
    targetId: string;
    resultStatus?: string;
    beforeSummary?: Prisma.InputJsonValue;
    afterSummary?: Prisma.InputJsonValue;
  }): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        actorType: "platform_admin",
        action: input.action,
        targetType: "ExternalDataConnector",
        targetId: input.targetId,
        resultStatus: input.resultStatus ?? "success",
        beforeSummary: input.beforeSummary ?? Prisma.JsonNull,
        afterSummary: input.afterSummary ?? Prisma.JsonNull,
      },
    });
  }

  private conversionEventName(
    eventType: CanonicalTrackingEventTypeDto,
  ): string {
    const names: Record<CanonicalTrackingEventTypeDto, string> = {
      conversation_started: "LeadSubmitted",
      qualified_lead: "QualifiedLead",
      purchase: "Purchase",
    };

    return names[eventType];
  }

  private cutoverDto(cutover: {
    id: string;
    eventType: string;
    status: string;
    activatedAt: Date;
    shadowArchivedRows: number;
    rolledBackAt: Date | null;
  }) {
    return {
      id: cutover.id,
      eventType: cutover.eventType,
      status: cutover.status,
      activatedAt: cutover.activatedAt.toISOString(),
      shadowArchivedRows: cutover.shadowArchivedRows,
      rolledBackAt: cutover.rolledBackAt?.toISOString() ?? null,
    };
  }
}
