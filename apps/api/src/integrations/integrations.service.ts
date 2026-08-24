import { createHash, randomBytes } from "node:crypto";
import {
  ConflictException,
  Inject,
  Injectable,
  Optional,
} from "@nestjs/common";
import type {
  MetaAdDestinationInputDto,
  MetaConnectionDto,
  MetaCapiTokenInputDto,
  MetaCapiTokenStatusDto,
  MetaConversionDestinationDto,
  MetaConversionDestinationInputDto,
  MetaAssetSelectionInputDto,
  MetaAssetsDto,
  MetaReportingAccountDto,
  MetaReportingAccountInputDto,
  MetaReportingAccountAdRoutingDto,
  IntegrationHealthSummaryDto,
  IntegrationPipelineOverviewDto,
  IntegrationStartActionDto,
  WhatsappDataSourceDto,
  MetaOAuthDisconnectInputDto,
  MetaOAuthDisconnectResultDto,
  MetaConnectionCapabilitiesDto,
  MetaManualAccountDestinationInputDto,
  MetaManualAssetDiscoveryDto,
  MetaManualBusinessConnectionInputDto,
  MetaManualBusinessConnectionRemovalInputDto,
  MetaManualBusinessConnectionStatusInputDto,
  MetaManualConnectionTestResultDto,
  MetaManualConfigurationDto,
  MetaManualCredentialInputDto,
  MetaManualCredentialRotationInputDto,
  MetaOAuthAdvancedRoutingInputDto,
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { WorkspaceAccessPolicyService } from "../workspaces/workspace-access-policy.service";
import type { IntegrationEnv } from "./integration.types";
import { INTEGRATION_ENV } from "./integration.types";
import { MetaAdapter } from "./meta/meta.adapter";
import { MetaAssetsService } from "./meta/meta-assets.service";
import { MetaConnectionsService } from "./meta/meta-connections.service";
import { MetaManualConnectionsService } from "./meta/meta-manual-connections.service";
import { WhatsappProviderRegistry } from "./whatsapp-providers/whatsapp-provider.registry";

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly metaAdapter: MetaAdapter,
    private readonly whatsappProviders: WhatsappProviderRegistry,
    @Inject(INTEGRATION_ENV) private readonly env: IntegrationEnv = process.env,
    @Inject(MetaConnectionsService)
    private readonly metaConnectionsService?: MetaConnectionsService,
    @Optional()
    @Inject(PrismaService)
    private readonly prisma?: PrismaService,
    @Optional()
    @Inject(MetaAssetsService)
    private readonly metaAssetsService?: MetaAssetsService,
    @Optional()
    @Inject(WorkspaceAccessPolicyService)
    private readonly accessPolicy: WorkspaceAccessPolicyService = new WorkspaceAccessPolicyService(),
    @Optional()
    @Inject(MetaManualConnectionsService)
    private readonly metaManualConnectionsService?: MetaManualConnectionsService,
  ) {}

  async getHealthSummary(): Promise<IntegrationHealthSummaryDto> {
    const [metaHealth, uazapiByoHealth, nodApiHealth] = await Promise.all([
      this.metaAdapter.getHealth(),
      this.getUazapiByoHealth(),
      this.getNodApiHealth(),
    ]);

    return {
      checkedAt: new Date().toISOString(),
      providers: nodApiHealth
        ? [metaHealth, uazapiByoHealth, nodApiHealth]
        : [metaHealth, uazapiByoHealth],
    };
  }

  private async getUazapiByoHealth() {
    const health = await this.whatsappProviders
      .require("uazapi_byo")
      .getHealth();

    return {
      provider: "uazapi_byo" as const,
      status: health.status,
      checkedAt: health.checkedAt,
      message: health.message,
    };
  }

  /**
   * Unlike uazapi_byo (always registered by WhatsappProvidersBootstrapService,
   * so `require()` is safe), nod_api is optional here on purpose — older
   * test doubles and any deployment that hasn't picked up F5.3b's bootstrap
   * change yet build a registry without it, so this reads via `get()` and
   * is simply omitted from the summary when absent.
   */
  private async getNodApiHealth() {
    const adapter = this.whatsappProviders.get("nod_api");

    if (!adapter) {
      return null;
    }

    const health = await adapter.getHealth();

    return {
      provider: "nod_api" as const,
      status: health.status,
      checkedAt: health.checkedAt,
      message: health.message,
    };
  }

  async getMetaConnection(workspaceId: string): Promise<MetaConnectionDto> {
    if (!this.metaConnectionsService) {
      return {
        workspaceId,
        status: "not_connected",
        tokenType: null,
        scopes: [],
        expiresAt: null,
        connectedAt: null,
        selectedBusinessId: null,
        selectedAdAccountId: null,
        selectedPixelId: null,
        capiTokenConfigured: false,
      };
    }

    return this.metaConnectionsService.getConnection(workspaceId);
  }

  async disconnectMetaOAuth(
    workspaceId: string,
    input: MetaOAuthDisconnectInputDto,
    actorUserId: string,
  ): Promise<MetaOAuthDisconnectResultDto> {
    if (!this.getMetaConnectionCapabilities().manualEnabled) {
      throw new ConflictException(
        "A conexao por token permanente nao esta habilitada neste ambiente",
      );
    }

    return this.requireMetaConnectionsService().disconnectOAuthConnection({
      workspaceId,
      actorUserId,
      request: input,
    });
  }

  async getMetaAssets(
    workspaceId: string,
    businessId?: string | null,
  ): Promise<MetaAssetsDto> {
    if (!this.metaConnectionsService) {
      return this.emptyMetaAssets(workspaceId);
    }

    const assets = businessId
      ? this.metaConnectionsService.listAssets(
          workspaceId,
          this.metaAdapter,
          businessId,
        )
      : this.metaConnectionsService.listAssets(workspaceId, this.metaAdapter);

    return this.withMetaOperationalData(workspaceId, assets);
  }

  async refreshMetaAssets(
    workspaceId: string,
    businessId?: string | null,
    actorUserId?: string | null,
  ): Promise<MetaAssetsDto> {
    if (!this.metaConnectionsService) {
      return this.emptyMetaAssets(workspaceId);
    }

    return this.withMetaOperationalData(
      workspaceId,
      this.metaConnectionsService.refreshAssets(
        workspaceId,
        this.metaAdapter,
        businessId,
        actorUserId,
      ),
    );
  }

  private async withMetaOperationalData(
    workspaceId: string,
    assets: Promise<MetaAssetsDto>,
  ): Promise<MetaAssetsDto> {
    const [baseAssets, conversionDestination, reportingAccounts] =
      await Promise.all([
        assets,
        this.getMetaConversionDestination(workspaceId),
        this.getMetaReportingAccounts(workspaceId),
      ]);

    return {
      ...baseAssets,
      pages: baseAssets.pages ?? [],
      conversionDestination,
      reportingAccounts,
    };
  }

  private emptyMetaAssets(workspaceId: string): MetaAssetsDto {
    return {
      workspaceId,
      status: "not_connected",
      businesses: [],
      adAccounts: [],
      pixels: [],
      pages: [],
      conversionDestination: this.emptyConversionDestination(workspaceId),
      reportingAccounts: [],
      selection: {
        businessId: null,
        adAccountId: null,
        pixelId: null,
      },
      lastSyncedAt: null,
      syncError: null,
    };
  }

  async saveMetaAssetSelection(
    workspaceId: string,
    input: MetaAssetSelectionInputDto,
    actorUserId?: string | null,
  ): Promise<MetaConnectionDto> {
    if (!this.metaConnectionsService) {
      return this.getMetaConnection(workspaceId);
    }

    return this.metaConnectionsService.saveAssetSelection(
      workspaceId,
      input,
      actorUserId,
    );
  }

  async saveMetaCapiToken(
    workspaceId: string,
    input: MetaCapiTokenInputDto,
    actorUserId?: string | null,
  ): Promise<MetaCapiTokenStatusDto> {
    if (!this.metaConnectionsService) {
      return {
        workspaceId,
        configured: false,
        updatedAt: new Date().toISOString(),
      };
    }

    return this.metaConnectionsService.saveCapiToken(
      workspaceId,
      input,
      actorUserId,
    );
  }

  async getMetaConversionDestination(
    workspaceId: string,
  ): Promise<MetaConversionDestinationDto> {
    if (!this.metaAssetsService) {
      return this.emptyConversionDestination(workspaceId);
    }

    return this.metaAssetsService.getConversionDestination(workspaceId);
  }

  async saveMetaConversionDestination(
    workspaceId: string,
    input: MetaConversionDestinationInputDto,
    actorUserId?: string | null,
  ): Promise<MetaConversionDestinationDto> {
    if (!this.metaAssetsService) {
      return this.emptyConversionDestination(workspaceId);
    }

    return this.metaAssetsService.saveConversionDestination(
      workspaceId,
      input,
      actorUserId,
    );
  }

  async getMetaReportingAccounts(
    workspaceId: string,
  ): Promise<MetaReportingAccountDto[]> {
    if (!this.metaAssetsService) {
      return [];
    }

    return this.metaAssetsService.listReportingAccounts(workspaceId);
  }

  async saveMetaReportingAccount(
    workspaceId: string,
    input: MetaReportingAccountInputDto,
    actorUserId?: string | null,
  ): Promise<MetaReportingAccountDto> {
    if (!this.metaAssetsService) {
      throw new Error("Meta assets service is not available");
    }

    return this.metaAssetsService.saveReportingAccount(
      workspaceId,
      input,
      actorUserId,
    );
  }

  async setMetaReportingAccountActive(
    workspaceId: string,
    id: string,
    active: boolean,
    actorUserId?: string | null,
  ): Promise<MetaReportingAccountDto[]> {
    if (!this.metaAssetsService) {
      return [];
    }

    return this.metaAssetsService.setReportingAccountActive(
      workspaceId,
      id,
      active,
      actorUserId,
    );
  }

  getUazapiStartAction(): IntegrationStartActionDto {
    const missingEnv = [
      ...this.missingEnv(["UAZAPI_BASE_URL"]),
      ...(!this.env.UAZAPI_TOKEN ? ["UAZAPI_TOKEN"] : []),
    ];

    return {
      provider: "uazapi",
      action: missingEnv.length > 0 ? "configure_env" : "wait_webhook",
      label:
        missingEnv.length > 0
          ? "Configurar NOD API"
          : "NOD API pronta para provisionar instancia",
      missingEnv,
    };
  }


  async getWhatsappDataSource(
    workspaceId: string,
  ): Promise<WhatsappDataSourceDto> {
    if (!this.prisma) {
      return this.nativeWhatsappDataSource();
    }

    const connector = await this.prisma.externalDataConnector.findFirst({
      where: {
        workspaceId,
        status: "active",
      },
      orderBy: { updatedAt: "desc" },
      select: {
        name: true,
        provider: true,
        lastSyncCompletedAt: true,
        lastSyncStatus: true,
      },
    });

    if (!connector) {
      return this.nativeWhatsappDataSource();
    }

    return {
      mode: "external",
      connectorName: connector.name,
      provider: connector.provider,
      lastSyncCompletedAt: connector.lastSyncCompletedAt?.toISOString() ?? null,
      lastSyncStatus: connector.lastSyncStatus,
    };
  }

  async getPipelineOverview(
    workspaceId: string,
    now = new Date(),
  ): Promise<IntegrationPipelineOverviewDto> {
    if (!this.prisma) {
      return this.emptyPipelineOverview(workspaceId);
    }

    const since = new Date(now);
    since.setDate(since.getDate() - 7);

    const [
      ctwaLeads,
      webhooksReceived,
      leadsTracked,
      conversionsReady,
      metaSent,
      whatsappSource,
    ] = await Promise.all([
      this.prisma.lead.count({
        where: {
          workspaceId,
          createdAt: { gte: since },
          OR: [
            { campaignId: { not: null } },
            { adSetId: { not: null } },
            { adId: { not: null } },
            { ctwaClid: { not: null } },
          ],
        },
      }),
      this.prisma.webhookLog.count({
        where: {
          workspaceId,
          source: "uazapi",
          receivedAt: { gte: since },
        },
      }),
      this.prisma.lead.count({
        where: {
          workspaceId,
          createdAt: { gte: since },
        },
      }),
      this.prisma.conversionEventLog.count({
        where: {
          workspaceId,
          status: "ready_to_send",
          createdAt: { gte: since },
        },
      }),
      this.prisma.conversionEventLog.count({
        where: {
          workspaceId,
          status: "sent",
          createdAt: { gte: since },
        },
      }),
      this.getWhatsappDataSource(workspaceId),
    ]);

    return {
      workspaceId,
      rangeLabel: "Ultimos 7 dias",
      whatsappSource,
      stages: [
        {
          key: "ctwa",
          label: "CTWA",
          value: ctwaLeads,
          detail: "Leads com origem de campanha Meta",
        },
        {
          key: "webhook",
          label: "Webhook",
          value: webhooksReceived,
          detail: "Webhooks NOD API recebidos",
        },
        {
          key: "lead",
          label: "Lead",
          value: leadsTracked,
          detail: "Leads rastreados pelo WhatsApp",
        },
        {
          key: "conversion_ready",
          label: "CAPI pronta",
          value: conversionsReady,
          detail: "Eventos aguardando envio para Meta",
        },
        {
          key: "meta_sent",
          label: "Meta ACK",
          value: metaSent,
          detail: "Eventos enviados para Meta",
        },
      ],
    };
  }

  private missingEnv(keys: string[]): string[] {
    return keys.filter((key) => !this.env[key]);
  }

  private emptyPipelineOverview(
    workspaceId: string,
  ): IntegrationPipelineOverviewDto {
    return {
      workspaceId,
      rangeLabel: "Ultimos 7 dias",
      whatsappSource: this.nativeWhatsappDataSource(),
      stages: [
        {
          key: "ctwa",
          label: "CTWA",
          value: 0,
          detail: "Leads com origem de campanha Meta",
        },
        {
          key: "webhook",
          label: "Webhook",
          value: 0,
          detail: "Webhooks NOD API recebidos",
        },
        {
          key: "lead",
          label: "Lead",
          value: 0,
          detail: "Leads rastreados pelo WhatsApp",
        },
        {
          key: "conversion_ready",
          label: "CAPI pronta",
          value: 0,
          detail: "Eventos aguardando envio para Meta",
        },
        {
          key: "meta_sent",
          label: "Meta ACK",
          value: 0,
          detail: "Eventos enviados para Meta",
        },
      ],
    };
  }

  private nativeWhatsappDataSource(): WhatsappDataSourceDto {
    return {
      mode: "native",
      connectorName: null,
      provider: null,
      lastSyncCompletedAt: null,
      lastSyncStatus: null,
    };
  }

  private emptyConversionDestination(
    workspaceId: string,
  ): MetaConversionDestinationDto {
    return {
      workspaceId,
      pixelId: null,
      pixelName: null,
      pageId: null,
      pageName: null,
      status: "needs_configuration",
      lastValidatedAt: null,
      validationError: null,
    };
  }

  getMetaConnectionCapabilities(): MetaConnectionCapabilitiesDto {
    return this.requireMetaManualConnectionsService().getCapabilities();
  }

  async getMetaManualConfiguration(
    workspaceId: string,
  ): Promise<MetaManualConfigurationDto> {
    return this.requireMetaManualConnectionsService().listConfiguration(
      workspaceId,
    );
  }

  async getMetaOAuthAdvancedConfiguration(
    workspaceId: string,
  ): Promise<MetaManualConfigurationDto> {
    return this.requireMetaManualConnectionsService().listOAuthConfiguration(
      workspaceId,
    );
  }

  async prepareMetaOAuthAdvancedCredential(
    workspaceId: string,
    actorUserId?: string | null,
  ): Promise<MetaManualAssetDiscoveryDto> {
    return this.requireMetaManualConnectionsService().prepareOAuthCredential(
      workspaceId,
      actorUserId,
    );
  }

  async discoverMetaOAuthAdvancedAssets(
    workspaceId: string,
    credentialId: string,
    businessId?: string | null,
  ): Promise<MetaManualAssetDiscoveryDto> {
    return this.requireMetaManualConnectionsService().discoverOAuthAssets(
      workspaceId,
      credentialId,
      businessId,
    );
  }

  async createMetaOAuthAdvancedBusinessConnection(
    workspaceId: string,
    input: MetaManualBusinessConnectionInputDto,
    actorUserId?: string | null,
  ): Promise<MetaManualConfigurationDto> {
    return this.requireMetaManualConnectionsService().createOAuthBusinessConnection(
      workspaceId,
      input,
      actorUserId,
    );
  }

  async setMetaOAuthAdvancedBusinessConnectionStatus(
    workspaceId: string,
    connectionId: string,
    input: MetaManualBusinessConnectionStatusInputDto,
    actorUserId?: string | null,
  ): Promise<MetaManualConfigurationDto> {
    return this.requireMetaManualConnectionsService().setOAuthBusinessConnectionStatus(
      workspaceId,
      connectionId,
      input,
      actorUserId,
    );
  }

  async testMetaOAuthAdvancedBusinessConnection(
    workspaceId: string,
    connectionId: string,
    actorUserId?: string | null,
  ): Promise<MetaManualConnectionTestResultDto> {
    return this.requireMetaManualConnectionsService().testOAuthBusinessConnection(
      workspaceId,
      connectionId,
      actorUserId,
    );
  }

  async removeMetaOAuthAdvancedBusinessConnection(
    workspaceId: string,
    connectionId: string,
    input: MetaManualBusinessConnectionRemovalInputDto,
    actorUserId?: string | null,
  ): Promise<MetaManualConfigurationDto> {
    return this.requireMetaManualConnectionsService().removeOAuthBusinessConnection(
      workspaceId,
      connectionId,
      input,
      actorUserId,
    );
  }

  async setMetaOAuthAdvancedReportingDestination(
    workspaceId: string,
    reportingAccountId: string,
    input: MetaManualAccountDestinationInputDto,
    actorUserId?: string | null,
  ): Promise<MetaManualConfigurationDto> {
    return this.requireMetaManualConnectionsService().setOAuthReportingAccountDestination(
      workspaceId,
      reportingAccountId,
      input,
      actorUserId,
    );
  }

  async getMetaOAuthAdvancedAdRouting(
    workspaceId: string,
    reportingAccountId: string,
  ): Promise<MetaReportingAccountAdRoutingDto> {
    return this.requireMetaManualConnectionsService().getOAuthReportingAccountAdRouting(
      workspaceId,
      reportingAccountId,
    );
  }

  async setMetaOAuthAdvancedAdDestination(
    workspaceId: string,
    reportingAccountId: string,
    adId: string,
    input: MetaAdDestinationInputDto,
    actorUserId?: string | null,
  ): Promise<MetaReportingAccountAdRoutingDto> {
    return this.requireMetaManualConnectionsService().setOAuthAdDestination(
      workspaceId,
      reportingAccountId,
      adId,
      input,
      actorUserId,
    );
  }

  async setMetaOAuthAdvancedRouting(
    workspaceId: string,
    input: MetaOAuthAdvancedRoutingInputDto,
    actorUserId?: string | null,
  ): Promise<MetaManualConfigurationDto> {
    return this.requireMetaManualConnectionsService().setOAuthAdvancedRouting(
      workspaceId,
      input,
      actorUserId,
    );
  }

  async createMetaManualCredential(
    workspaceId: string,
    input: MetaManualCredentialInputDto,
    actorUserId?: string | null,
  ): Promise<MetaManualAssetDiscoveryDto> {
    return this.requireMetaManualConnectionsService().createCredential(
      workspaceId,
      input,
      actorUserId,
    );
  }

  async discoverMetaManualAssets(
    workspaceId: string,
    credentialId: string,
    businessId?: string | null,
  ): Promise<MetaManualAssetDiscoveryDto> {
    return this.requireMetaManualConnectionsService().discoverAssets(
      workspaceId,
      credentialId,
      businessId,
    );
  }

  async createMetaManualBusinessConnection(
    workspaceId: string,
    input: MetaManualBusinessConnectionInputDto,
    actorUserId?: string | null,
  ): Promise<MetaManualConfigurationDto> {
    return this.requireMetaManualConnectionsService().createBusinessConnection(
      workspaceId,
      input,
      actorUserId,
    );
  }

  async rotateMetaManualCredential(
    workspaceId: string,
    credentialId: string,
    input: MetaManualCredentialRotationInputDto,
    actorUserId?: string | null,
  ): Promise<MetaManualConfigurationDto> {
    return this.requireMetaManualConnectionsService().rotateCredential(
      workspaceId,
      credentialId,
      input,
      actorUserId,
    );
  }

  async setMetaManualBusinessConnectionStatus(
    workspaceId: string,
    connectionId: string,
    input: MetaManualBusinessConnectionStatusInputDto,
    actorUserId?: string | null,
  ): Promise<MetaManualConfigurationDto> {
    return this.requireMetaManualConnectionsService().setBusinessConnectionStatus(
      workspaceId,
      connectionId,
      input,
      actorUserId,
    );
  }

  async testMetaManualBusinessConnection(
    workspaceId: string,
    connectionId: string,
    actorUserId?: string | null,
  ): Promise<MetaManualConnectionTestResultDto> {
    return this.requireMetaManualConnectionsService().testBusinessConnection(
      workspaceId,
      connectionId,
      actorUserId,
    );
  }

  async removeMetaManualBusinessConnection(
    workspaceId: string,
    connectionId: string,
    input: MetaManualBusinessConnectionRemovalInputDto,
    actorUserId?: string | null,
  ): Promise<MetaManualConfigurationDto> {
    return this.requireMetaManualConnectionsService().removeBusinessConnection(
      workspaceId,
      connectionId,
      input,
      actorUserId,
    );
  }

  async setMetaManualReportingDestination(
    workspaceId: string,
    reportingAccountId: string,
    input: MetaManualAccountDestinationInputDto,
    actorUserId?: string | null,
  ): Promise<MetaManualConfigurationDto> {
    return this.requireMetaManualConnectionsService().setReportingAccountDestination(
      workspaceId,
      reportingAccountId,
      input,
      actorUserId,
    );
  }

  async getMetaManualAdRouting(
    workspaceId: string,
    reportingAccountId: string,
  ): Promise<MetaReportingAccountAdRoutingDto> {
    return this.requireMetaManualConnectionsService().getReportingAccountAdRouting(
      workspaceId,
      reportingAccountId,
    );
  }

  async setMetaManualAdDestination(
    workspaceId: string,
    reportingAccountId: string,
    adId: string,
    input: MetaAdDestinationInputDto,
    actorUserId?: string | null,
  ): Promise<MetaReportingAccountAdRoutingDto> {
    return this.requireMetaManualConnectionsService().setAdDestination(
      workspaceId,
      reportingAccountId,
      adId,
      input,
      actorUserId,
    );
  }

  private requireMetaConnectionsService(): MetaConnectionsService {
    if (!this.metaConnectionsService) {
      throw new Error("MetaConnectionsService indisponivel");
    }

    return this.metaConnectionsService;
  }

  private requireMetaManualConnectionsService(): MetaManualConnectionsService {
    if (!this.metaManualConnectionsService) {
      throw new Error("MetaManualConnectionsService indisponivel");
    }

    return this.metaManualConnectionsService;
  }

  private requirePrisma(): PrismaService {
    if (!this.prisma) {
      throw new Error("PrismaService indisponivel para OAuth Meta");
    }

    return this.prisma;
  }
}
