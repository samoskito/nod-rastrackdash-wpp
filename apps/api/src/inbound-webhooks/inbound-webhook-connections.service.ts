import { createHash, randomBytes } from "node:crypto";
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  InboundWebhookConnectionCreateInputDto,
  InboundWebhookConnectionCreateResultDto,
  InboundWebhookConnectionDto,
  InboundWebhookConnectionOverviewDto,
  InboundWebhookConnectionRotateSecretResultDto,
  InboundWebhookConnectionStatusUpdateInputDto,
  InboundWebhookCapabilitiesDto,
} from "@wpptrack/shared";
import { inboundWebhookProviders } from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { parseInboundWebhooksConfig } from "../config/deployment-config";
import {
  applyInboundWebhookConnectionStatus,
  concurrentMutationMessage,
  connectionAuditSummary,
  connectionNotFoundMessage,
  type ExternalChannelSeatHook,
  metaRouteRequiredForProvider,
  nextMutationTime,
  type PersistedInboundWebhookConnection,
  requireInboundWebhookConnection,
} from "./inbound-webhook-production-activation";
import { UazapiConversionBridgeService } from "./uazapi-conversion-bridge.service";
import {
  type BridgedWhatsappProvider,
  isBridgedWhatsappProvider,
} from "./bridged-whatsapp-providers";

/**
 * Porte do #105 do SaaS, com a ponte WAHA: a conexão-ponte de uma conexão
 * WhatsApp (Uazapi/WAHA) recebe pelo webhook da instância, não por esta URL.
 * Gerar URL aqui não ajuda e confunde: bloqueado.
 */
const bridgeSecretRotationBlockedMessage =
  "Conexões Uazapi e WAHA recebem pelo webhook da própria conexão WhatsApp. Não gere URL aqui: confira o webhook da conexão WhatsApp em Integrações.";
import { effectiveInboundParserStatus } from "./inbound-webhook-parser-eligibility";
import {
  bornChannelState,
  bornConnectionStatus,
  productionDirectEligible,
} from "./production-direct";
import { normalizePhoneIdentity } from "../common/phone/phone-identity";
import { reanchorSpanningAutomationRules } from "../conversion-rules/provider-rule-reanchor";

const parserVersion = "v1";

type UnnichatConnectionBind = {
  providerChannelId: string;
  connectedPhone: string;
  channelName: string;
};

/**
 * Fase 4b: the Unnichat entry webhook carries no provider channel id, so the
 * connection is created already bound to the client's WhatsApp number. The
 * normalized phone is the stable channel identity, the same one the parser
 * receives from the connection (never from the provider payload).
 */
function resolveUnnichatConnectionBind(
  input: InboundWebhookConnectionCreateInputDto,
): UnnichatConnectionBind | null {
  // Fase 6.8 (porte do #183): ROI Chat is bound the same way (one connection
  // = one client number = one URL); a URL only ever attributes to its number.
  if (input.provider !== "unnichat" && input.provider !== "roichat") return null;
  const connectedPhone = input.connectedPhone
    ? normalizePhoneIdentity(input.connectedPhone)
    : undefined;
  const channelName = input.displayName?.trim();
  if (!connectedPhone || !channelName || channelName.length > 120) return null;
  return { providerChannelId: connectedPhone, connectedPhone, channelName };
}

@Injectable()
export class InboundWebhookConnectionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RUNTIME_ENV) private readonly env: RuntimeEnv,
    @Optional()
    @Inject(UazapiConversionBridgeService)
    private readonly uazapiBridge?: UazapiConversionBridgeService,
  ) {}

  async getCapabilities(): Promise<InboundWebhookCapabilitiesDto> {
    const config = parseInboundWebhooksConfig(this.env);
    const releases = await this.prisma.inboundWebhookParserRelease.findMany({
      where: {
        provider: {
          in: [...inboundWebhookProviders],
        },
        version: parserVersion,
      },
      select: {
        provider: true,
        status: true,
      },
    });
    const releaseByProvider = new Map(
      releases.map((release) => [release.provider, release]),
    );

    return {
      enabled: config.enabled,
      productionEnabled: config.enabled && config.productionEnabled,
      // UAZAPI/NOD is bridged automatically from the WhatsApp instance and
      // never goes through the generic manual creation flow. Payt is a sales
      // platform with no WhatsApp number: its rules live in Conversoes; so is
      // Braip (6.5), reached only by the workspace integration URL (hub).
      // WAHA is a WhatsApp connection (Integrações → WhatsApp) whose own
      // receiver uses the waha parser release; it has no generic connection.
      providers: inboundWebhookProviders
        .filter(
          (provider) =>
            provider !== "uazapi" &&
            provider !== "payt" &&
            provider !== "braip" &&
            provider !== "waha",
        )
        .map((provider) => {
          const release = releaseByProvider.get(provider);

          return {
            provider,
            parserVersion,
            parserReleaseStatus: release ? effectiveInboundParserStatus({ provider, version: parserVersion, status: release.status }) : null,
            creationEnabled:
              config.enabled === true &&
              release !== undefined &&
              release.status !== "retired",
          };
        }),
    };
  }

  async listConnections(
    workspaceId: string,
  ): Promise<InboundWebhookConnectionDto[]> {
    await this.syncUazapiBridges(workspaceId);

    const connections = await this.prisma.inboundWebhookConnection.findMany({
      where: {
        workspaceId,
        removedAt: null,
      },
      include: {
        parserRelease: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return connections.map((connection) => this.toDto(connection));
  }

  async getOverview(
    workspaceId: string,
    connectionId: string,
  ): Promise<InboundWebhookConnectionOverviewDto> {
    const connection = await this.requireConnection(
      this.prisma,
      workspaceId,
      connectionId,
    );

    // Porte do #103 do SaaS, com a ponte WAHA: a ponte Uazapi/WAHA não usa o
    // pipeline genérico de observação. O CTWA vira lead direto pelo webhook
    // da instância, então ler InboundWebhookEvent mostraria a conexão vazia.
    if (isBridgedWhatsappProvider(connection.provider)) {
      return this.getBridgeOverview(
        workspaceId,
        connection,
        connection.provider,
      );
    }

    const [eventCounts, deliveries] = await Promise.all([
      this.prisma.inboundWebhookEvent.groupBy({
        by: ["classification"],
        where: {
          workspaceId,
          connectionId,
        },
        _count: {
          _all: true,
        },
      }),
      this.prisma.inboundWebhookDelivery.findMany({
        where: {
          workspaceId,
          connectionId,
        },
        select: {
          attemptCount: true,
          classification: true,
        },
      }),
    ]);
    const countsByClassification = new Map(
      eventCounts.map((row) => [row.classification, row._count._all]),
    );
    // Fase 4b: the Unnichat sale automation has its own parser release (and,
    // since 6.8, the ROI Chat purchase received on the number URL).
    const automationParserRelease =
      connection.provider === "unnichat" || connection.provider === "roichat"
        ? await this.prisma.inboundWebhookParserRelease.findFirst({
            where: { provider: connection.provider, version: "automation-v1" },
            select: { id: true, version: true, status: true },
          })
        : undefined;

    return {
      ...(automationParserRelease !== undefined
        ? { automationParserRelease }
        : {}),
      connection: this.toDto(connection),
      counters: {
        eligibleRouted:
          countsByClassification.get("eligible_route_resolved") ?? 0,
        eligibleUnresolved:
          countsByClassification.get("eligible_route_unresolved") ?? 0,
        ignoredNoCtwa: countsByClassification.get("ignored_no_ctwa") ?? 0,
        duplicate: deliveries.reduce(
          (total, delivery) => total + Math.max(0, delivery.attemptCount - 1),
          0,
        ),
        invalid: deliveries.filter(
          (delivery) => delivery.classification === "invalid_payload",
        ).length,
      },
    };
  }

  private async getBridgeOverview(
    workspaceId: string,
    connection: PersistedInboundWebhookConnection,
    provider: BridgedWhatsappProvider,
  ): Promise<InboundWebhookConnectionOverviewDto> {
    const empty = {
      eligibleRouted: 0,
      eligibleUnresolved: 0,
      ignoredNoCtwa: 0,
      duplicate: 0,
      invalid: 0,
    };
    const channel = await this.prisma.inboundWebhookChannel.findFirst({
      where: {
        workspaceId,
        connectionId: connection.id,
        whatsappInstanceId: { not: null },
      },
      select: { whatsappInstanceId: true },
    });
    const whatsappInstanceId = channel?.whatsappInstanceId;
    if (!whatsappInstanceId) {
      return { connection: this.toDto(connection), counters: empty };
    }

    const [eligibleRouted, latestLog] = await Promise.all([
      this.prisma.lead.count({
        where: {
          workspaceId,
          whatsappInstanceId,
          source: provider,
          ctwaClid: { not: null },
        },
      }),
      this.prisma.webhookLog.findFirst({
        where: { workspaceId, whatsappInstanceId, source: provider },
        orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
        select: { receivedAt: true },
      }),
    ]);

    return {
      connection: this.toDto(connection, latestLog?.receivedAt ?? null),
      counters: {
        // A bridge lead is only created for an inbound message with ctwaClid.
        eligibleRouted,
        // The bridge has no persisted unresolved route state: never invented.
        eligibleUnresolved: 0,
        // WebhookLog keeps a redacted payload, not a queryable CTWA outcome.
        ignoredNoCtwa: 0,
        // Duplicate and invalid attempts return before a distinct log exists.
        duplicate: 0,
        invalid: 0,
      },
    };
  }

  async getConnection(
    workspaceId: string,
    connectionId: string,
  ): Promise<InboundWebhookConnectionDto> {
    return this.toDto(
      await this.requireConnection(this.prisma, workspaceId, connectionId),
    );
  }

  async createConnection(
    workspaceId: string,
    input: InboundWebhookConnectionCreateInputDto,
    actorUserId: string,
  ): Promise<InboundWebhookConnectionCreateResultDto> {
    if (input.provider === "uazapi") {
      // UAZAPI/NOD connections are provisioned automatically from the
      // workspace's WhatsApp instance (see UazapiConversionBridgeService);
      // they never go through the generic secret-based creation flow.
      throw new ConflictException(
        "Conexões UAZAPI são criadas automaticamente a partir da instância WhatsApp",
      );
    }
    if (input.provider === "payt" || input.provider === "braip") {
      // A sales platform (Payt, Braip) has no WhatsApp number: its rule is
      // created in Conversões and bound to the connection of its numbers.
      throw new ConflictException(
        `A ${input.provider === "braip" ? "Braip" : "Payt"} não usa conexão própria: crie a regra de venda em Conversões`,
      );
    }
    if (input.provider === "waha") {
      // WAHA is connected in Integrações → WhatsApp (server URL, API key and
      // session of the student's own WAHA); its webhook goes to the WhatsApp
      // connection receiver, never to a generic inbound connection.
      throw new ConflictException(
        "A WAHA é conectada em Integrações → WhatsApp, não por uma conexão de webhook genérica",
      );
    }
    const unnichatBind = resolveUnnichatConnectionBind(input);
    if (
      (input.provider === "unnichat" || input.provider === "roichat") &&
      !unnichatBind
    ) {
      // The shared schema already requires it; keep the service boundary
      // fail-closed for direct callers too: the connection must own the
      // client's number before any payload can be parsed.
      throw new ConflictException(
        input.provider === "roichat"
          ? "Conexões ROI Chat exigem o número de WhatsApp do cliente"
          : "Conexões Unnichat exigem o número de WhatsApp do cliente",
      );
    }

    const config = this.requireEnabledConfig();
    const secret = this.generateSecret();
    const secretHash = this.hashSecret(secret);

    const connection = await this.prisma.$transaction(async (transaction) => {
      const release = await transaction.inboundWebhookParserRelease.findFirst({
        where: {
          provider: input.provider,
          version: parserVersion,
          status: {
            not: "retired",
          },
        },
      });

      if (!release) {
        throw new ConflictException(
          "Versão do leitor do provedor indisponível",
        );
      }

      // Fase 6.1c (produção direta): integração validada nasce em produção;
      // só um leitor ainda não validado começa em observação. Meta Cloud sem
      // META_APP_SECRET também: em produção a API passa a exigir a assinatura
      // da Meta e recusaria as entregas; a tela pede o segredo e "Ativar
      // envio" confere de novo.
      const bornAt = new Date();
      const status =
        input.provider === "meta_cloud" && !this.env.META_APP_SECRET?.trim()
          ? "observation"
          : bornConnectionStatus(release);
      const created = await transaction.inboundWebhookConnection.create({
        data: {
          workspaceId,
          provider: input.provider,
          displayName: input.displayName,
          parserReleaseId: release.id,
          secretHash,
          status,
          productionActivatedAt: status === "production" ? bornAt : null,
          createdByUserId: actorUserId,
        },
        include: {
          parserRelease: true,
        },
      });

      if (unnichatBind) {
        const channelState = bornChannelState(created, release, bornAt);
        await transaction.inboundWebhookChannel.create({
          data: {
            // Unnichat numbers explicitly follow the workspace Meta
            // configuration (as in the SaaS); a ROI Chat number keeps the
            // column default, like the other non-Unnichat providers, whose
            // routing ignores this mode (route learned from the entry's ad).
            ...(input.provider === "unnichat"
              ? { metaRoutingMode: "inherit_workspace" as const }
              : {}),
            workspaceId,
            connectionId: created.id,
            organizationId: workspaceId,
            providerChannelId: unnichatBind.providerChannelId,
            connectedPhone: unnichatBind.connectedPhone,
            channelName: unnichatBind.channelName,
            status: channelState.status,
            productionActivatedAt: channelState.productionActivatedAt,
            conversionEngineMode: "canonical",
            firstSeenAt: created.createdAt,
            lastSeenAt: created.createdAt,
          },
        });
      }

      await this.createAudit(transaction, {
        workspaceId,
        actorUserId,
        action: "inbound_webhook.connection_created",
        targetId: created.id,
        resultStatus: created.status,
        beforeSummary: undefined,
        afterSummary: this.auditSummary(created),
      });

      return created;
    });

    return {
      connection: this.toDto(connection),
      secret,
      webhookUrl: this.buildWebhookUrl(
        config.apiPublicUrl,
        connection.id,
        secret,
        connection.provider,
      ),
    };
  }

  async rotateSecret(
    workspaceId: string,
    connectionId: string,
    actorUserId: string,
  ): Promise<InboundWebhookConnectionRotateSecretResultDto> {
    const existing = await this.requireConnection(
      this.prisma,
      workspaceId,
      connectionId,
    );
    if (isBridgedWhatsappProvider(existing.provider)) {
      throw new ConflictException(bridgeSecretRotationBlockedMessage);
    }

    const config = this.requireEnabledConfig();
    const secret = this.generateSecret();
    const secretHash = this.hashSecret(secret);

    const connection = await this.prisma.$transaction(async (transaction) => {
      const current = await this.requireConnection(
        transaction,
        workspaceId,
        connectionId,
      );
      if (isBridgedWhatsappProvider(current.provider)) {
        throw new ConflictException(bridgeSecretRotationBlockedMessage);
      }
      const updatedAt = this.nextMutationTime(current.updatedAt);
      const claimed = await transaction.inboundWebhookConnection.updateMany({
        where: this.activeMutationWhere(current),
        data: {
          secretHash,
          updatedAt,
        },
      });

      this.assertMutationClaimed(claimed.count);
      const updated = await this.requireConnection(
        transaction,
        workspaceId,
        connectionId,
      );

      await this.createAudit(transaction, {
        workspaceId,
        actorUserId,
        action: "inbound_webhook.secret_rotated",
        targetId: updated.id,
        resultStatus: updated.status,
        beforeSummary: this.auditSummary(current),
        afterSummary: {
          ...this.auditSummary(updated),
          secretRotated: true,
        },
      });

      return updated;
    });

    return {
      connectionId: connection.id,
      provider: connection.provider,
      secret,
      webhookUrl: this.buildWebhookUrl(
        config.apiPublicUrl,
        connection.id,
        secret,
        connection.provider,
      ),
      rotatedAt: connection.updatedAt.toISOString(),
    };
  }

  async updateStatus(
    workspaceId: string,
    connectionId: string,
    input: InboundWebhookConnectionStatusUpdateInputDto,
    actorUserId: string,
  ): Promise<InboundWebhookConnectionDto> {
    if (input.status === "observation") {
      this.requireEnabledConfig();
    }

    if (input.status === "production") {
      this.requireProductionEnabledConfig();
    }

    const updated = await this.prisma.$transaction(async (transaction) => {
      const current = await this.requireConnection(
        transaction,
        workspaceId,
        connectionId,
      );

      return applyInboundWebhookConnectionStatus(transaction, {
        workspaceId,
        connectionId,
        status: input.status,
        actorUserId,
        requireValidMetaRoute: metaRouteRequiredForProvider(current.provider),
        seats: this.seatHook(),
        env: this.env,
        // Fase 6.1c: "Retomar conexão" de uma integração validada volta a
        // enviar sem exigir rota em cada número (conferida no envio).
        productionDirectResume:
          current.status === "paused" &&
          input.status === "production" &&
          productionDirectEligible(current.parserRelease),
      });
    });

    return this.toDto(updated);
  }

  async removeConnection(
    workspaceId: string,
    connectionId: string,
    actorUserId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const current = await this.requireConnection(
        transaction,
        workspaceId,
        connectionId,
      );
      const removedAt = this.nextMutationTime(current.updatedAt);
      const claimed = await transaction.inboundWebhookConnection.updateMany({
        where: this.activeMutationWhere(current),
        data: {
          status: "paused",
          secretHash: null,
          productionActivatedAt: null,
          removedAt,
          updatedAt: removedAt,
        },
      });

      this.assertMutationClaimed(claimed.count);

      // Fase 6.1a (porte do #159): Umbler/Unnichat rules for ALL numbers
      // anchored here move to another live connection of the provider, so
      // the other numbers keep sending (audited; same transaction).
      await reanchorSpanningAutomationRules(transaction, {
        workspaceId,
        removedConnectionId: connectionId,
        provider: current.provider,
        actorUserId,
      });

      // rastrackdash sanitize (rewrite_rules.external-channel-seat-gate-noop):
      // billing/ is stripped in this edition, so external-channel seats are
      // never allocated and there is nothing to release here.

      const removed: PersistedInboundWebhookConnection = {
        ...current,
        status: "paused",
        secretHash: null,
        productionActivatedAt: null,
        removedAt,
        updatedAt: removedAt,
      };

      await this.createAudit(transaction, {
        workspaceId,
        actorUserId,
        action: "inbound_webhook.connection_removed",
        targetId: removed.id,
        resultStatus: "removed",
        beforeSummary: this.auditSummary(current),
        afterSummary: {
          ...this.auditSummary(removed),
          removed: true,
        },
      });
    });
  }

  /**
   * U2c: lazily provisions the InboundWebhookConnection/Channel bridge for
   * every active UAZAPI/NOD instance (and every active WAHA connection, whose
   * team messages run the phrase rules too) so it shows up in the same Gatilhos
   * builder without requiring a webhook to have arrived yet. Best-effort:
   * a failure here just means the instance stays invisible until its next
   * successful webhook (see UazapiProviderConversionService), not a 500.
   */
  private async syncUazapiBridges(workspaceId: string): Promise<void> {
    if (!this.uazapiBridge) return;

    const instances = await this.prisma.whatsappInstance.findMany({
      where: {
        workspaceId,
        provider: { in: ["uazapi", "waha"] },
        status: "active",
      },
      select: {
        id: true,
        workspaceId: true,
        name: true,
        providerInstanceId: true,
        provider: true,
      },
    });

    for (const instance of instances) {
      try {
        const { provider, ...bridgeInstance } = instance;
        await this.uazapiBridge.ensureBridge(
          bridgeInstance,
          provider === "waha" ? "waha" : "uazapi",
        );
      } catch {
        // best-effort; see doc comment above
      }
    }
  }

  private activeMutationWhere(
    connection: PersistedInboundWebhookConnection,
  ): Prisma.InboundWebhookConnectionWhereInput {
    return {
      id: connection.id,
      workspaceId: connection.workspaceId,
      removedAt: null,
      updatedAt: connection.updatedAt,
    };
  }

  private assertMutationClaimed(count: number): void {
    if (count !== 1) {
      throw new ConflictException(concurrentMutationMessage);
    }
  }

  private nextMutationTime(previous: Date): Date {
    return nextMutationTime(previous);
  }

  private async requireConnection(
    client: Pick<PrismaService, "inboundWebhookConnection">,
    workspaceId: string,
    connectionId: string,
  ): Promise<PersistedInboundWebhookConnection> {
    return requireInboundWebhookConnection(client, workspaceId, connectionId);
  }

  /**
   * Seat enforcement is resolved lazily: externalChannelEnforcementEnabled()
   * throws when enforcement is on without a seat service, so it must only run
   * at the points the activation flow actually bills a seat.
   */
  private seatHook(): ExternalChannelSeatHook {
    return {
      enforcementEnabled: () => this.externalChannelEnforcementEnabled(),
      activateSeat: () => {
        throw new Error(
          "External channel seat activation is unavailable once billing/ is removed.",
        );
      },
    };
  }

  private requireEnabledConfig() {
    const config = parseInboundWebhooksConfig(this.env);

    if (!config.enabled) {
      throw new ServiceUnavailableException(
        "Conexões de webhook de entrada ainda não estão habilitadas",
      );
    }

    return config;
  }

  private generateSecret(): string {
    return randomBytes(32).toString("base64url");
  }

  private hashSecret(secret: string): string {
    return createHash("sha256").update(secret, "utf8").digest("hex");
  }

  private buildWebhookUrl(
    apiPublicUrl: string,
    connectionId: string,
    secret: string,
    provider?: string,
  ): string {
    const url = new URL(
      `/webhooks/inbound/${encodeURIComponent(connectionId)}`,
      apiPublicUrl,
    );

    // Meta Cloud sends the verification token separately as hub.verify_token
    // during its GET handshake. Keeping it out of the callback URL avoids
    // exposing it in Meta's configured endpoint while other providers retain
    // their existing query-token callback contract.
    if (provider === "meta_cloud") {
      return url.toString();
    }

    url.searchParams.set("token", secret);

    return url.toString();
  }

  private toDto(
    connection: PersistedInboundWebhookConnection,
    lastDeliveryAt: Date | null = connection.lastDeliveryAt,
  ): InboundWebhookConnectionDto {
    return {
      id: connection.id,
      workspaceId: connection.workspaceId,
      provider: connection.provider,
      displayName: connection.displayName,
      parserVersion: connection.parserRelease.version,
      parserReleaseStatus: effectiveInboundParserStatus(connection.parserRelease),
      status: connection.status,
      productionActivatedAt:
        connection.productionActivatedAt?.toISOString() ?? null,
      lastDeliveryAt: lastDeliveryAt?.toISOString() ?? null,
      lastSuccessfulParseAt:
        connection.lastSuccessfulParseAt?.toISOString() ?? null,
      createdAt: connection.createdAt.toISOString(),
      updatedAt: connection.updatedAt.toISOString(),
    };
  }

  private auditSummary(
    connection: PersistedInboundWebhookConnection,
  ): Prisma.InputJsonObject {
    return connectionAuditSummary(connection);
  }

  private requireProductionEnabledConfig() {
    const config = this.requireEnabledConfig();

    if (!config.productionEnabled) {
      throw new ServiceUnavailableException(
        "Envio automatico de webhooks ainda nao esta habilitado",
      );
    }

    return config;
  }

  private externalChannelEnforcementEnabled(): boolean {
    // rastrackdash sanitize (rewrite_rules.external-channel-seat-gate-noop):
    // billing/ is stripped in this edition, so external-channel seat
    // enforcement can never be enabled — hardcode the noop outcome instead
    // of inferring it from now-absent optional billing deps.
    return false;
  }

  private async createAudit(
    transaction: Prisma.TransactionClient,
    input: {
      workspaceId: string;
      actorUserId: string;
      action: string;
      targetId: string;
      resultStatus: string;
      beforeSummary: Prisma.InputJsonObject | undefined;
      afterSummary: Prisma.InputJsonObject;
    },
  ): Promise<void> {
    await transaction.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        actorType: "user",
        action: input.action,
        targetType: "InboundWebhookConnection",
        targetId: input.targetId,
        reason: null,
        sourceIp: null,
        resultStatus: input.resultStatus,
        beforeSummary: input.beforeSummary,
        afterSummary: input.afterSummary,
      },
    });
  }
}
