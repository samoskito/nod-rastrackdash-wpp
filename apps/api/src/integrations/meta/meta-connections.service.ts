import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type {
  MetaAdAccountAssetDto,
  MetaAssetSelectionInputDto,
  MetaAssetsDto,
  MetaBusinessAssetDto,
  MetaCapiTokenInputDto,
  MetaCapiTokenStatusDto,
  MetaConnectionDto,
  MetaConnectionStatusDto,
  MetaOAuthDisconnectInputDto,
  MetaOAuthDisconnectResultDto,
  MetaPageAssetDto,
  MetaPixelAssetDto,
} from "@wpptrack/shared";
import { META_OAUTH_DISCONNECT_CONFIRMATION } from "@wpptrack/shared";
import { PrismaService } from "../../common/prisma/prisma.service";
import { MetaAdapter } from "./meta.adapter";
import { MetaTokenEncryptionService } from "./meta-token-encryption.service";

export type SaveMetaConnectionInput = {
  workspaceId: string;
  accessToken: string;
  tokenType: string | null;
  expiresInSeconds: number | null;
  scopes: string[];
  actorUserId?: string | null;
};

type MetaIntegrationRecord = {
  workspaceId: string;
  status: string;
  encryptedAccessToken: string;
  tokenIv: string;
  tokenTag: string;
  tokenType: string | null;
  scopes: string[];
  expiresAt: Date | null;
  lastConnectedAt: Date | null;
  selectedBusinessId: string | null;
  selectedAdAccountId: string | null;
  selectedPixelId: string | null;
  capiAccessTokenEncrypted: string | null;
  capiTokenIv: string | null;
  capiTokenTag: string | null;
  primaryConversionDestinationId: string | null;
  advancedRoutingEnabled: boolean;
  updatedAt: Date;
};

type MetaAssetSnapshotRecord = {
  workspaceId: string;
  snapshotKey: string;
  businessId: string | null;
  status: string;
  businesses: Prisma.JsonValue;
  adAccounts: Prisma.JsonValue;
  pixels: Prisma.JsonValue;
  pages: Prisma.JsonValue;
  syncError: string | null;
  syncedAt: Date | null;
};

type MetaAssetSnapshotClient = {
  findUnique(args: {
    where: {
      workspaceId_snapshotKey: {
        workspaceId: string;
        snapshotKey: string;
      };
    };
  }): Promise<MetaAssetSnapshotRecord | null>;
  upsert(args: {
    where: {
      workspaceId_snapshotKey: {
        workspaceId: string;
        snapshotKey: string;
      };
    };
    create: {
      workspaceId: string;
      snapshotKey: string;
      businessId: string | null;
      status: string;
      businesses: Prisma.InputJsonValue;
      adAccounts: Prisma.InputJsonValue;
      pixels: Prisma.InputJsonValue;
      pages: Prisma.InputJsonValue;
      syncError: string | null;
      syncedAt: Date | null;
    };
    update: {
      businessId: string | null;
      status: string;
      businesses: Prisma.InputJsonValue;
      adAccounts: Prisma.InputJsonValue;
      pixels: Prisma.InputJsonValue;
      pages: Prisma.InputJsonValue;
      syncError: string | null;
      syncedAt: Date | null;
    };
  }): Promise<MetaAssetSnapshotRecord>;
};

const ROOT_SNAPSHOT_KEY = "root";

@Injectable()
export class MetaConnectionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly encryption: MetaTokenEncryptionService,
  ) {}

  async getConnection(workspaceId: string): Promise<MetaConnectionDto> {
    const connection = (await this.prisma.metaIntegration.findUnique({
      where: { workspaceId },
    })) as MetaIntegrationRecord | null;

    if (!connection) {
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

    return this.toDto(connection);
  }

  async saveOAuthConnection(
    input: SaveMetaConnectionInput,
  ): Promise<MetaConnectionDto> {
    const manualCredential = await this.prisma.metaCredential.findFirst({
      where: { workspaceId: input.workspaceId, source: "manual" },
      select: { id: true },
    });

    if (manualCredential) {
      throw new ConflictException(
        "Este workspace já iniciou uma conexão por token permanente. Remova a configuração manual antes de conectar via OAuth",
      );
    }

    const encrypted = this.encryption.encrypt(input.accessToken);
    const expiresAt = input.expiresInSeconds
      ? new Date(Date.now() + input.expiresInSeconds * 1000)
      : null;
    const connectedAt = new Date();
    const data = {
      status: "connected",
      encryptedAccessToken: encrypted.encryptedAccessToken,
      tokenIv: encrypted.tokenIv,
      tokenTag: encrypted.tokenTag,
      tokenType: input.tokenType,
      scopes: input.scopes,
      expiresAt,
      lastConnectedAt: connectedAt,
    };
    const saved = await this.prisma.$transaction(async (transaction) => {
      const normalizedOAuthCredential =
        await transaction.metaCredential.findFirst({
          where: { workspaceId: input.workspaceId, source: "oauth" },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        });
      const savedConnection = await transaction.metaIntegration.upsert({
        where: { workspaceId: input.workspaceId },
        create: {
          workspaceId: input.workspaceId,
          ...data,
        },
        update: {
          ...data,
          ...(normalizedOAuthCredential
            ? { advancedRoutingEnabled: false }
            : {}),
        },
      });

      if (normalizedOAuthCredential) {
        await transaction.metaCredential.update({
          where: { id: normalizedOAuthCredential.id },
          data: {
            encryptedAccessToken: encrypted.encryptedAccessToken,
            tokenIv: encrypted.tokenIv,
            tokenTag: encrypted.tokenTag,
            encryptionKeyVersion: this.encryption.currentKeyVersion,
            fingerprint: this.encryption.fingerprint(input.accessToken),
            tokenLast4: this.encryption.tokenLast4(input.accessToken),
            tokenType: input.tokenType ?? "oauth",
            scopes: input.scopes,
            expiresAt,
            status: "active",
            lastValidatedAt: connectedAt,
            validationError: null,
            rotatedAt: connectedAt,
          },
        });
        await transaction.metaBusinessConnection.updateMany({
          where: {
            workspaceId: input.workspaceId,
            credentialId: normalizedOAuthCredential.id,
          },
          data: {
            status: "validation_required",
            validationError:
              "Valide esta BM novamente após atualizar o login social",
          },
        });
      }

      return {
        connection: savedConnection,
        advancedRoutingRequiresReview: Boolean(normalizedOAuthCredential),
      };
    });
    const connection = saved.connection as MetaIntegrationRecord;
    await this.recordMetaAudit({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId ?? null,
      action: "meta.oauth.connected",
      resultStatus: "connected",
      afterSummary: {
        status: "connected",
        tokenType: input.tokenType,
        scopes: input.scopes,
        expiresAt: expiresAt?.toISOString() ?? null,
        advancedRoutingRequiresReview: saved.advancedRoutingRequiresReview,
      } as Prisma.InputJsonValue,
    });

    return this.toDto(connection);
  }

  async disconnectOAuthConnection(input: {
    workspaceId: string;
    actorUserId: string;
    request: MetaOAuthDisconnectInputDto;
  }): Promise<MetaOAuthDisconnectResultDto> {
    if (input.request.expectedWorkspaceId !== input.workspaceId) {
      throw new ConflictException(
        "O workspace da sessão mudou. Recarregue a página antes de desconectar a Meta",
      );
    }

    if (input.request.confirmation !== META_OAUTH_DISCONNECT_CONFIRMATION) {
      throw new BadRequestException("Confirmação de desconexão inválida");
    }

    const disconnectedAt = new Date();

    return this.prisma.$transaction(async (transaction) => {
      const connection = await transaction.metaIntegration.findUnique({
        where: { workspaceId: input.workspaceId },
        select: {
          status: true,
          tokenType: true,
          scopes: true,
          expiresAt: true,
          selectedBusinessId: true,
          selectedAdAccountId: true,
          selectedPixelId: true,
          capiAccessTokenEncrypted: true,
        },
      });

      if (!connection) {
        throw new ConflictException(
          "A conexão OAuth deste workspace já foi desconectada",
        );
      }

      const [assetSnapshots, reportingAccounts, conversionDestinations] =
        await Promise.all([
          transaction.metaAssetSnapshot.count({
            where: { workspaceId: input.workspaceId },
          }),
          transaction.metaReportingAccount.count({
            where: { workspaceId: input.workspaceId },
          }),
          transaction.metaConversionDestination.count({
            where: { workspaceId: input.workspaceId },
          }),
        ]);
      const oauthCredentials = await transaction.metaCredential.findMany({
        where: { workspaceId: input.workspaceId, source: "oauth" },
        select: { id: true },
      });
      const oauthCredentialIds = oauthCredentials.map(
        (credential) => credential.id,
      );

      if (oauthCredentialIds.length > 0) {
        const oauthConnections =
          await transaction.metaBusinessConnection.findMany({
            where: {
              workspaceId: input.workspaceId,
              credentialId: { in: oauthCredentialIds },
            },
            select: { id: true },
          });
        const oauthConnectionIds = oauthConnections.map(
          (metaConnection) => metaConnection.id,
        );

        if (oauthConnectionIds.length > 0) {
          await transaction.metaReportingAccount.updateMany({
            where: {
              workspaceId: input.workspaceId,
              businessConnectionId: { in: oauthConnectionIds },
            },
            data: {
              active: false,
              businessConnectionId: null,
              conversionDestinationId: null,
              syncStatus: "pending",
              syncError: null,
            },
          });
          await transaction.metaBusinessConnection.deleteMany({
            where: {
              workspaceId: input.workspaceId,
              id: { in: oauthConnectionIds },
            },
          });
        }

        await transaction.metaCredential.deleteMany({
          where: {
            workspaceId: input.workspaceId,
            source: "oauth",
            id: { in: oauthCredentialIds },
          },
        });
      }
      const deleted = await transaction.metaIntegration.deleteMany({
        where: { workspaceId: input.workspaceId },
      });

      if (deleted.count !== 1) {
        throw new ConflictException(
          "A conexão Meta mudou durante a desconexão. Recarregue a página",
        );
      }

      await transaction.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          actorType: "user",
          action: "meta.oauth.disconnected_for_manual",
          targetType: "MetaIntegration",
          targetId: input.workspaceId,
          reason: "switch_to_manual",
          sourceIp: null,
          resultStatus: "disconnected",
          beforeSummary: {
            status: connection.status,
            tokenType: connection.tokenType,
            scopes: connection.scopes,
            expiresAt: connection.expiresAt?.toISOString() ?? null,
            selectedBusinessId: connection.selectedBusinessId,
            selectedAdAccountId: connection.selectedAdAccountId,
            selectedPixelId: connection.selectedPixelId,
            capiTokenConfigured: Boolean(connection.capiAccessTokenEncrypted),
          },
          afterSummary: {
            status: "not_connected",
            nextConnectionMode: "manual",
            preserved: {
              assetSnapshots,
              reportingAccounts,
              conversionDestinations,
            },
          },
        },
      });

      return {
        workspaceId: input.workspaceId,
        status: "not_connected",
        disconnectedAt: disconnectedAt.toISOString(),
        preserved: {
          assetSnapshots,
          reportingAccounts,
          conversionDestinations,
        },
      };
    });
  }

  async listAssets(
    workspaceId: string,
    _metaAdapter: Pick<
      MetaAdapter,
      | "listBusinesses"
      | "listOwnedAdAccounts"
      | "listBusinessPixels"
      | "listBusinessPages"
    >,
    requestedBusinessId?: string | null,
  ): Promise<MetaAssetsDto> {
    const startedAt = Date.now();
    const connection = (await this.prisma.metaIntegration.findUnique({
      where: { workspaceId },
    })) as MetaIntegrationRecord | null;

    if (!connection) {
      return this.emptyAssets(workspaceId, "not_connected", null);
    }

    try {
      const rootSnapshot = await this.findAssetSnapshot(
        workspaceId,
        ROOT_SNAPSHOT_KEY,
      );
      const selectedBusinessId =
        requestedBusinessId?.trim() || connection.selectedBusinessId;
      const businessSnapshot = selectedBusinessId
        ? await this.findAssetSnapshot(workspaceId, selectedBusinessId)
        : null;
      const assets = this.assetsFromSnapshots(
        workspaceId,
        connection,
        rootSnapshot,
        businessSnapshot,
      );

      this.logSlowAssetList(
        assets,
        Date.now() - startedAt,
        requestedBusinessId,
      );

      return assets;
    } catch (error) {
      const result = this.emptyAssets(
        workspaceId,
        "error",
        error instanceof Error
          ? error.message
          : "Erro ao sincronizar ativos Meta",
      );

      this.logSlowAssetList(
        result,
        Date.now() - startedAt,
        requestedBusinessId,
      );

      return result;
    }
  }

  async refreshAssets(
    workspaceId: string,
    metaAdapter: Pick<
      MetaAdapter,
      | "listBusinesses"
      | "listOwnedAdAccounts"
      | "listBusinessPixels"
      | "listBusinessPages"
    >,
    requestedBusinessId?: string | null,
    actorUserId?: string | null,
  ): Promise<MetaAssetsDto> {
    const connection = (await this.prisma.metaIntegration.findUnique({
      where: { workspaceId },
    })) as MetaIntegrationRecord | null;

    if (!connection) {
      return this.emptyAssets(workspaceId, "not_connected", null);
    }

    try {
      const syncedAt = new Date();
      const accessToken = this.encryption.decrypt({
        encryptedAccessToken: connection.encryptedAccessToken,
        tokenIv: connection.tokenIv,
        tokenTag: connection.tokenTag,
      });
      const businesses = await metaAdapter.listBusinesses({ accessToken });
      const preferredBusinessId =
        requestedBusinessId?.trim() || connection.selectedBusinessId;
      const selectedBusinessId = businesses.some(
        (business) => business.id === preferredBusinessId,
      )
        ? preferredBusinessId
        : (businesses[0]?.id ?? null);
      const selectedBusinessExists = Boolean(selectedBusinessId);
      let adAccounts: MetaAdAccountAssetDto[] = [];
      let pixels: MetaPixelAssetDto[] = [];
      let pages: MetaPageAssetDto[] = [];
      let businessSyncError: string | null = null;

      if (selectedBusinessId && selectedBusinessExists) {
        const [adAccountResult, pixelResult, pageResult] =
          await Promise.allSettled([
            metaAdapter
              .listOwnedAdAccounts({
                accessToken,
                businessId: selectedBusinessId,
              })
              .then((items) =>
                items.map((adAccount) => ({
                  ...adAccount,
                  businessId: adAccount.businessId ?? selectedBusinessId,
                })),
              ),
            metaAdapter
              .listBusinessPixels({
                accessToken,
                businessId: selectedBusinessId,
              })
              .then((items) =>
                items.map((pixel) => ({
                  ...pixel,
                  businessId: pixel.businessId ?? selectedBusinessId,
                  code: null,
                })),
              ),
            metaAdapter
              .listBusinessPages({
                accessToken,
                businessId: selectedBusinessId,
              })
              .then((items) =>
                items.map((page) => ({
                  ...page,
                  businessId: page.businessId ?? selectedBusinessId,
                })),
              ),
          ]);
        const failedAssets: string[] = [];

        if (adAccountResult.status === "fulfilled") {
          adAccounts = adAccountResult.value;
        } else {
          failedAssets.push("contas de anúncio");
        }

        if (pixelResult.status === "fulfilled") {
          pixels = pixelResult.value;
        } else {
          failedAssets.push("Pixels");
        }

        if (pageResult.status === "fulfilled") {
          pages = pageResult.value;
        } else {
          failedAssets.push("páginas");
        }

        businessSyncError = failedAssets.length
          ? `A Meta não permitiu carregar ${failedAssets.join(", ")} para o BM selecionado.`
          : null;
      }
      const status = this.toStatus(connection.status);
      const rootSnapshot = await this.upsertAssetSnapshot({
        workspaceId,
        snapshotKey: ROOT_SNAPSHOT_KEY,
        businessId: null,
        status,
        businesses,
        adAccounts: [],
        pixels: [],
        pages: [],
        syncError: null,
        syncedAt,
      });
      const businessSnapshot =
        selectedBusinessId && selectedBusinessExists
          ? await this.upsertAssetSnapshot({
              workspaceId,
              snapshotKey: selectedBusinessId,
              businessId: selectedBusinessId,
              status,
              businesses: [],
              adAccounts,
              pixels,
              pages,
              syncError: businessSyncError,
              syncedAt,
            })
          : null;
      const shouldPersistRequestedBusiness = Boolean(
        requestedBusinessId?.trim() &&
        selectedBusinessId &&
        selectedBusinessId !== connection.selectedBusinessId,
      );
      const activeConnection = shouldPersistRequestedBusiness
        ? ((await this.prisma.metaIntegration.update({
            where: { workspaceId },
            data: {
              selectedBusinessId,
              selectedAdAccountId: null,
              selectedPixelId: null,
            },
          })) as MetaIntegrationRecord)
        : connection;
      const result = this.assetsFromSnapshots(
        workspaceId,
        activeConnection,
        rootSnapshot,
        businessSnapshot,
      );

      await this.recordMetaAudit({
        workspaceId,
        actorUserId: actorUserId ?? null,
        action: "meta.assets.snapshot_refreshed",
        resultStatus: "success",
        afterSummary: {
          businessId: selectedBusinessId ?? null,
          businesses: result.businesses.length,
          adAccounts: result.adAccounts.length,
          pixels: result.pixels.length,
          pages: (result.pages ?? []).length,
        } as Prisma.InputJsonValue,
      });

      return result;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Erro ao sincronizar ativos Meta";

      await this.upsertAssetSnapshot({
        workspaceId,
        snapshotKey: ROOT_SNAPSHOT_KEY,
        businessId: null,
        status: "error",
        businesses: [],
        adAccounts: [],
        pixels: [],
        pages: [],
        syncError: message,
        syncedAt: new Date(),
      });

      return this.emptyAssets(workspaceId, "error", message);
    }
  }

  async saveAssetSelection(
    workspaceId: string,
    input: MetaAssetSelectionInputDto,
    actorUserId?: string | null,
  ): Promise<MetaConnectionDto> {
    const connection = (await this.prisma.metaIntegration.update({
      where: { workspaceId },
      data: {
        selectedBusinessId: input.businessId,
        selectedAdAccountId: input.adAccountId,
        selectedPixelId: input.pixelId,
      },
    })) as MetaIntegrationRecord;
    await this.recordMetaAudit({
      workspaceId,
      actorUserId: actorUserId ?? null,
      action: "meta.assets.selection_updated",
      resultStatus: "success",
      afterSummary: {
        businessId: input.businessId,
        adAccountId: input.adAccountId,
        pixelId: input.pixelId,
      } as Prisma.InputJsonValue,
    });

    return this.toDto(connection);
  }

  async saveCapiToken(
    workspaceId: string,
    input: MetaCapiTokenInputDto,
    actorUserId?: string | null,
  ): Promise<MetaCapiTokenStatusDto> {
    const encrypted = input.clear
      ? null
      : this.encryption.encrypt(input.accessToken ?? "");
    const connection = (await this.prisma.metaIntegration.update({
      where: { workspaceId },
      data: input.clear
        ? {
            capiAccessTokenEncrypted: null,
            capiTokenIv: null,
            capiTokenTag: null,
          }
        : {
            capiAccessTokenEncrypted: encrypted?.encryptedAccessToken,
            capiTokenIv: encrypted?.tokenIv,
            capiTokenTag: encrypted?.tokenTag,
          },
    })) as MetaIntegrationRecord;
    const configured = Boolean(connection.capiAccessTokenEncrypted);

    await this.recordMetaAudit({
      workspaceId,
      actorUserId: actorUserId ?? null,
      action: "meta.capi_token.updated",
      resultStatus: configured ? "configured" : "cleared",
      afterSummary: {
        configured,
        tokenLast4:
          !input.clear && input.accessToken
            ? input.accessToken.slice(-4)
            : null,
      } as Prisma.InputJsonValue,
    });

    return {
      workspaceId: connection.workspaceId,
      configured,
      updatedAt: connection.updatedAt.toISOString(),
    };
  }

  private async recordMetaAudit(input: {
    workspaceId: string;
    actorUserId: string | null;
    action: string;
    resultStatus: string;
    afterSummary: Prisma.InputJsonValue;
  }): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          actorType: input.actorUserId ? "user" : "system",
          action: input.action,
          targetType: "MetaIntegration",
          targetId: input.workspaceId,
          reason: null,
          sourceIp: null,
          resultStatus: input.resultStatus,
          beforeSummary: undefined,
          afterSummary: input.afterSummary,
        },
      });
    } catch {
      return;
    }
  }

  private emptyAssets(
    workspaceId: string,
    status: MetaConnectionStatusDto,
    syncError: string | null,
  ): MetaAssetsDto {
    return {
      workspaceId,
      status,
      businesses: [],
      adAccounts: [],
      pixels: [],
      pages: [],
      selection: {
        businessId: null,
        adAccountId: null,
        pixelId: null,
      },
      lastSyncedAt: null,
      syncError,
    };
  }

  private toDto(record: MetaIntegrationRecord): MetaConnectionDto {
    return {
      workspaceId: record.workspaceId,
      status: this.toStatus(record.status),
      tokenType: record.tokenType,
      scopes: record.scopes,
      expiresAt: record.expiresAt?.toISOString() ?? null,
      connectedAt: record.lastConnectedAt?.toISOString() ?? null,
      selectedBusinessId: record.selectedBusinessId,
      selectedAdAccountId: record.selectedAdAccountId,
      selectedPixelId: record.selectedPixelId,
      capiTokenConfigured: Boolean(record.capiAccessTokenEncrypted),
    };
  }

  private toStatus(status: string): MetaConnectionStatusDto {
    if (
      status === "connected" ||
      status === "needs_reconnect" ||
      status === "error"
    ) {
      return status;
    }

    return "not_connected";
  }

  private get metaAssetSnapshots(): MetaAssetSnapshotClient {
    return (
      this.prisma as unknown as {
        metaAssetSnapshot: MetaAssetSnapshotClient;
      }
    ).metaAssetSnapshot;
  }

  private async findAssetSnapshot(
    workspaceId: string,
    snapshotKey: string,
  ): Promise<MetaAssetSnapshotRecord | null> {
    return this.metaAssetSnapshots.findUnique({
      where: {
        workspaceId_snapshotKey: {
          workspaceId,
          snapshotKey,
        },
      },
    });
  }

  private async upsertAssetSnapshot(input: {
    workspaceId: string;
    snapshotKey: string;
    businessId: string | null;
    status: MetaConnectionStatusDto;
    businesses: MetaBusinessAssetDto[];
    adAccounts: MetaAdAccountAssetDto[];
    pixels: MetaPixelAssetDto[];
    pages: MetaPageAssetDto[];
    syncError: string | null;
    syncedAt: Date | null;
  }): Promise<MetaAssetSnapshotRecord> {
    const data = {
      businessId: input.businessId,
      status: input.status,
      businesses: input.businesses as Prisma.InputJsonValue,
      adAccounts: input.adAccounts as Prisma.InputJsonValue,
      pixels: input.pixels as Prisma.InputJsonValue,
      pages: input.pages as Prisma.InputJsonValue,
      syncError: input.syncError,
      syncedAt: input.syncedAt,
    };

    return this.metaAssetSnapshots.upsert({
      where: {
        workspaceId_snapshotKey: {
          workspaceId: input.workspaceId,
          snapshotKey: input.snapshotKey,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        snapshotKey: input.snapshotKey,
        ...data,
      },
      update: data,
    });
  }

  private assetsFromSnapshots(
    workspaceId: string,
    connection: MetaIntegrationRecord,
    rootSnapshot: MetaAssetSnapshotRecord | null,
    businessSnapshot: MetaAssetSnapshotRecord | null,
  ): MetaAssetsDto {
    const mostSpecificSnapshot = businessSnapshot ?? rootSnapshot;

    return {
      workspaceId,
      status: this.toStatus(connection.status),
      businesses: this.snapshotArray<MetaBusinessAssetDto>(
        rootSnapshot?.businesses,
      ),
      adAccounts: this.snapshotArray<MetaAdAccountAssetDto>(
        businessSnapshot?.adAccounts,
      ),
      pixels: this.snapshotArray<MetaPixelAssetDto>(businessSnapshot?.pixels),
      pages: this.snapshotArray<MetaPageAssetDto>(businessSnapshot?.pages),
      selection: {
        businessId: connection.selectedBusinessId,
        adAccountId: connection.selectedAdAccountId,
        pixelId: connection.selectedPixelId,
      },
      lastSyncedAt: mostSpecificSnapshot?.syncedAt?.toISOString() ?? null,
      syncError: businessSnapshot?.syncError ?? rootSnapshot?.syncError ?? null,
    };
  }

  private snapshotArray<T>(value: Prisma.JsonValue | undefined): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
  }

  private logSlowAssetList(
    result: MetaAssetsDto,
    durationMs: number,
    requestedBusinessId?: string | null,
  ): void {
    const thresholdMs = Number(process.env.META_ASSETS_SLOW_LOG_MS ?? 1500);

    if (!Number.isFinite(thresholdMs) || durationMs < thresholdMs) {
      return;
    }

    console.warn("[wpptrack:meta-assets] slow list", {
      status: result.status,
      durationMs,
      requestedBusiness: Boolean(requestedBusinessId?.trim()),
      businesses: result.businesses.length,
      adAccounts: result.adAccounts.length,
      pixels: result.pixels.length,
      pages: (result.pages ?? []).length,
    });
  }
}
