import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { MetaTokenEncryptionService } from "./meta-token-encryption.service";

type EncryptedCredential = {
  encryptedAccessToken: string;
  tokenIv: string;
  tokenTag: string;
};

type LegacyIntegration = EncryptedCredential & {
  capiAccessTokenEncrypted: string | null;
  capiTokenIv: string | null;
  capiTokenTag: string | null;
  selectedBusinessId: string | null;
  selectedAdAccountId: string | null;
  selectedPixelId: string | null;
  primaryConversionDestinationId: string | null;
  advancedRoutingEnabled: boolean;
};

export type ResolvedMetaReportingRoute = {
  source: "legacy_oauth" | "manual";
  workspaceId: string;
  accessToken: string;
  reportingAccountId: string;
  adAccountId: string;
  businessConnectionId: string | null;
  credentialId: string | null;
};

export type MetaReportingSyncTarget = {
  workspaceId: string;
  businessConnectionId: string | null;
  reportingAccountId: string | null;
};

export type ResolvedMetaCapiRoute = {
  source: "legacy_oauth" | "manual";
  workspaceId: string;
  accessToken: string | null;
  reportingAccountId: string | null;
  adAccountId: string | null;
  businessConnectionId: string | null;
  credentialId: string | null;
  conversionDestinationId: string | null;
  pixelId: string | null;
  pageId: string | null;
};

export type LegacyMetaCompatibilityProjection = {
  source: "legacy_oauth";
  workspaceId: string;
  businessId: string | null;
  adAccountId: string | null;
  pixelId: string | null;
  destinationPixelId: string | null;
  destinationPageId: string | null;
  credentialFingerprint: string;
};

@Injectable()
export class MetaConnectionResolverService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly encryption: MetaTokenEncryptionService,
  ) {}

  async listReportingSyncTargets(
    workspaceId: string,
  ): Promise<MetaReportingSyncTarget[]> {
    if (await this.isNormalizedRoutingEnabled(workspaceId)) {
      const accounts = await this.prisma.metaReportingAccount.findMany({
        where: {
          workspaceId,
          active: true,
          businessConnectionId: { not: null },
          businessConnection: {
            is: {
              status: "active",
              credential: { is: { status: "active" } },
            },
          },
        },
        select: {
          id: true,
          businessConnectionId: true,
        },
        orderBy: { id: "asc" },
      });

      return accounts.flatMap((account) =>
        account.businessConnectionId
          ? [
              {
                workspaceId,
                businessConnectionId: account.businessConnectionId,
                reportingAccountId: account.id,
              },
            ]
          : [],
      );
    }

    const legacy = await this.prisma.metaIntegration.findUnique({
      where: { workspaceId },
      select: { status: true },
    });
    const activeAccounts = await this.prisma.metaReportingAccount.count({
      where: { workspaceId, active: true },
    });

    return legacy?.status === "connected" && activeAccounts > 0
      ? [
          {
            workspaceId,
            businessConnectionId: null,
            reportingAccountId: null,
          },
        ]
      : [];
  }

  async hasNormalizedConnections(workspaceId: string): Promise<boolean> {
    const activeConnections = await this.prisma.metaBusinessConnection.count({
      where: {
        workspaceId,
        status: "active",
        credential: { is: { status: "active" } },
      },
    });

    return (
      activeConnections > 0 || this.isNormalizedRoutingEnabled(workspaceId)
    );
  }

  async resolveReportingRoute(input: {
    workspaceId: string;
    reportingAccountId?: string | null;
    adAccountId?: string | null;
    businessConnectionId?: string | null;
  }): Promise<ResolvedMetaReportingRoute> {
    const account = await this.prisma.metaReportingAccount.findFirst({
      where: {
        workspaceId: input.workspaceId,
        active: true,
        ...(input.reportingAccountId ? { id: input.reportingAccountId } : {}),
        ...(input.adAccountId ? { adAccountId: input.adAccountId } : {}),
      },
      select: {
        id: true,
        adAccountId: true,
        businessConnectionId: true,
      },
    });

    if (!account) {
      throw new NotFoundException("Conta Meta ativa nao encontrada");
    }

    if (
      input.businessConnectionId &&
      account.businessConnectionId !== input.businessConnectionId
    ) {
      throw new NotFoundException("Conta Meta ativa nao encontrada");
    }

    if (
      account.businessConnectionId &&
      (await this.isNormalizedRoutingEnabled(input.workspaceId))
    ) {
      if (
        !input.reportingAccountId ||
        !input.businessConnectionId ||
        account.businessConnectionId !== input.businessConnectionId
      ) {
        throw new ConflictException(
          "A sincronizacao configurada exige a conta e a conexao Meta exatas",
        );
      }

      const connection = await this.prisma.metaBusinessConnection.findFirst({
        where: {
          id: account.businessConnectionId,
          workspaceId: input.workspaceId,
        },
        include: { credential: true },
      });

      if (!connection) {
        throw new NotFoundException("Conexao Meta nao encontrada");
      }

      this.assertNormalizedConnectionActive(connection);

      return {
        source:
          connection.credential.source === "oauth" ? "legacy_oauth" : "manual",
        workspaceId: input.workspaceId,
        accessToken: this.decrypt(connection.credential),
        reportingAccountId: account.id,
        adAccountId: account.adAccountId,
        businessConnectionId: connection.id,
        credentialId: connection.credentialId,
      };
    }

    const legacy = await this.getLegacyIntegration(input.workspaceId);

    return {
      source: "legacy_oauth",
      workspaceId: input.workspaceId,
      accessToken: this.decrypt(legacy),
      reportingAccountId: account.id,
      adAccountId: account.adAccountId,
      businessConnectionId: null,
      credentialId: null,
    };
  }

  async resolveCapiRoute(input: {
    workspaceId: string;
    adId?: string | null;
    campaignId?: string | null;
    metaAccountId?: string | null;
    businessConnectionId?: string | null;
    conversionDestinationId?: string | null;
  }): Promise<ResolvedMetaCapiRoute> {
    const adAccountId =
      input.metaAccountId?.trim() ||
      (await this.resolveAttributedAdAccountId(input.workspaceId, input));
    // Live BM credentials take precedence over the legacy OAuth routing flag
    // for CAPI, including workspaces that recreated their connection manually.
    const activeConnections = await this.prisma.metaBusinessConnection.count({
      where: {
        workspaceId: input.workspaceId,
        status: "active",
        credential: { is: { status: "active" } },
      },
    });
    const normalizedRoutingEnabled =
      activeConnections > 0 ||
      (await this.isNormalizedRoutingEnabled(input.workspaceId));

    if (!normalizedRoutingEnabled) {
      return this.resolveLegacyCapiRoute(input.workspaceId);
    }

    const account = adAccountId
      ? await this.prisma.metaReportingAccount.findFirst({
          where: {
            workspaceId: input.workspaceId,
            adAccountId,
            active: true,
            businessConnectionId: { not: null },
          },
        })
      : await this.onlyNormalizedReportingAccount(input.workspaceId);

    if (account?.businessConnectionId) {
      if (
        input.businessConnectionId &&
        account.businessConnectionId !== input.businessConnectionId
      ) {
        throw new NotFoundException("Rota Meta nao encontrada");
      }

      const connection = await this.prisma.metaBusinessConnection.findFirst({
        where: {
          id: account.businessConnectionId,
          workspaceId: input.workspaceId,
        },
        include: { credential: true },
      });

      if (!connection) {
        throw new NotFoundException("Rota Meta nao encontrada");
      }

      this.assertNormalizedConnectionActive(connection);
      const adDestinationAssignment = input.adId?.trim()
        ? await this.prisma.metaAd.findFirst({
            where: {
              workspaceId: input.workspaceId,
              adId: input.adId.trim(),
              adAccountId: account.adAccountId,
            },
            select: {
              destinationAssignment: {
                select: {
                  reportingAccountId: true,
                  conversionDestinationId: true,
                },
              },
            },
          })
        : null;
      const currentAdDestinationId =
        adDestinationAssignment?.destinationAssignment?.reportingAccountId ===
        account.id
          ? adDestinationAssignment.destinationAssignment
              .conversionDestinationId
          : null;
      const destinationId =
        currentAdDestinationId ??
        input.conversionDestinationId ??
        account.conversionDestinationId ??
        connection.defaultConversionDestinationId;

      if (!destinationId) {
        throw new ConflictException(
          "Nenhum destino de conversao foi associado a esta conta Meta",
        );
      }

      const destination = await this.prisma.metaConversionDestination.findFirst(
        {
          where: {
            id: destinationId,
            workspaceId: input.workspaceId,
            status: "configured",
          },
        },
      );

      if (!destination) {
        throw new ConflictException(
          "O destino de conversao desta conta precisa ser validado",
        );
      }

      return {
        source:
          connection.credential.source === "oauth" ? "legacy_oauth" : "manual",
        workspaceId: input.workspaceId,
        accessToken: this.decrypt(connection.credential),
        reportingAccountId: account.id,
        adAccountId: account.adAccountId,
        businessConnectionId: connection.id,
        credentialId: connection.credentialId,
        conversionDestinationId: destination.id,
        pixelId: destination.pixelId,
        pageId: destination.pageId,
      };
    }

    throw new ConflictException(
      adAccountId
        ? "A conta atribuida ao evento nao possui uma rota Meta ativa"
        : "Nao foi possivel determinar com seguranca qual conexao Meta deve enviar este evento",
    );
  }

  async getLegacyCompatibilityProjection(
    workspaceId: string,
    purpose: "reporting" | "capi" = "capi",
  ): Promise<LegacyMetaCompatibilityProjection> {
    const legacy = await this.getLegacyIntegration(workspaceId);
    const destination = await this.getLegacyDestination(
      workspaceId,
      legacy.primaryConversionDestinationId,
    );
    const encryptedAccessToken =
      purpose === "capi"
        ? (legacy.capiAccessTokenEncrypted ?? legacy.encryptedAccessToken)
        : legacy.encryptedAccessToken;
    const tokenIv =
      purpose === "capi"
        ? (legacy.capiTokenIv ?? legacy.tokenIv)
        : legacy.tokenIv;
    const tokenTag =
      purpose === "capi"
        ? (legacy.capiTokenTag ?? legacy.tokenTag)
        : legacy.tokenTag;
    const credentialFingerprint = this.encryption.fingerprint(
      this.decrypt({ encryptedAccessToken, tokenIv, tokenTag }),
    );

    return {
      source: "legacy_oauth",
      workspaceId,
      businessId: legacy.selectedBusinessId,
      adAccountId: legacy.selectedAdAccountId,
      pixelId: legacy.selectedPixelId,
      destinationPixelId: destination?.pixelId ?? null,
      destinationPageId: destination?.pageId ?? null,
      credentialFingerprint,
    };
  }

  private async resolveLegacyCapiRoute(
    workspaceId: string,
  ): Promise<ResolvedMetaCapiRoute> {
    const legacy = await this.getLegacyIntegration(workspaceId);
    const encryptedAccessToken =
      legacy.capiAccessTokenEncrypted ?? legacy.encryptedAccessToken;
    const tokenIv = legacy.capiTokenIv ?? legacy.tokenIv;
    const tokenTag = legacy.capiTokenTag ?? legacy.tokenTag;
    const destination = await this.getLegacyDestination(
      workspaceId,
      legacy.primaryConversionDestinationId,
    );

    return {
      source: "legacy_oauth",
      workspaceId,
      accessToken: this.decrypt({ encryptedAccessToken, tokenIv, tokenTag }),
      reportingAccountId: null,
      adAccountId: legacy.selectedAdAccountId,
      businessConnectionId: null,
      credentialId: null,
      conversionDestinationId: destination?.id ?? null,
      pixelId: destination?.pixelId ?? legacy.selectedPixelId,
      pageId: destination?.pageId ?? null,
    };
  }

  private async resolveAttributedAdAccountId(
    workspaceId: string,
    input: { adId?: string | null; campaignId?: string | null },
  ): Promise<string | null> {
    if (input.adId) {
      const ad = await this.prisma.metaAd.findFirst({
        where: { workspaceId, adId: input.adId },
        select: { adAccountId: true },
      });

      if (ad?.adAccountId) {
        return ad.adAccountId;
      }
    }

    if (input.campaignId) {
      const campaign = await this.prisma.metaCampaign.findFirst({
        where: { workspaceId, campaignId: input.campaignId },
        select: { adAccountId: true },
      });

      if (campaign?.adAccountId) {
        return campaign.adAccountId;
      }
    }

    return null;
  }

  private async onlyNormalizedReportingAccount(workspaceId: string) {
    const accounts = await this.prisma.metaReportingAccount.findMany({
      where: {
        workspaceId,
        active: true,
        businessConnectionId: { not: null },
      },
      take: 2,
    });

    return accounts.length === 1 ? accounts[0] : null;
  }

  private async getLegacyIntegration(
    workspaceId: string,
  ): Promise<LegacyIntegration> {
    const legacy = (await this.prisma.metaIntegration.findUnique({
      where: { workspaceId },
    })) as LegacyIntegration | null;

    if (!legacy) {
      throw new NotFoundException("Meta nao conectada");
    }

    return legacy;
  }

  private async getLegacyDestination(
    workspaceId: string,
    primaryConversionDestinationId: string | null,
  ) {
    if (!primaryConversionDestinationId) {
      return null;
    }

    return this.prisma.metaConversionDestination.findFirst({
      where: {
        workspaceId,
        id: primaryConversionDestinationId,
      },
    });
  }

  private async isNormalizedRoutingEnabled(
    workspaceId: string,
  ): Promise<boolean> {
    const [normalizedConnections, legacy] = await Promise.all([
      this.prisma.metaBusinessConnection.count({
        where: { workspaceId },
      }),
      this.prisma.metaIntegration.findUnique({
        where: { workspaceId },
        select: { advancedRoutingEnabled: true },
      }),
    ]);

    if (normalizedConnections === 0) {
      return false;
    }

    return legacy ? legacy.advancedRoutingEnabled : true;
  }

  private assertNormalizedConnectionActive(connection: {
    status: string;
    credential: { status: string };
  }): void {
    if (connection.status !== "active") {
      throw new ConflictException(
        "A conexao Meta desta conta esta pausada ou requer validacao",
      );
    }

    if (connection.credential.status !== "active") {
      throw new ConflictException(
        "O token desta conexao Meta esta pausado ou requer validacao",
      );
    }
  }

  private decrypt(input: EncryptedCredential): string {
    try {
      return this.encryption.decrypt(input);
    } catch {
      throw new BadRequestException(
        "Nao foi possivel abrir a credencial Meta armazenada",
      );
    }
  }
}
