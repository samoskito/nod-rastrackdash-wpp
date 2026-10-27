import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type {
  MetaAdAccountAssetDto,
  MetaAdDestinationInputDto,
  MetaConnectionCapabilitiesDto,
  MetaManualAccountDestinationInputDto,
  MetaManualAssetDiscoveryDto,
  MetaManualBusinessConnectionDto,
  MetaManualBusinessConnectionInputDto,
  MetaManualBusinessConnectionRemovalInputDto,
  MetaManualBusinessConnectionStatusInputDto,
  MetaManualConnectionTestResultDto,
  MetaManualConfigurationDto,
  MetaManualCredentialDto,
  MetaManualCredentialInputDto,
  MetaManualCredentialRotationInputDto,
  MetaOAuthAdvancedRoutingInputDto,
  MetaPageAssetDto,
  MetaPixelAssetDto,
  MetaReportingAccountAdRoutingDto,
} from "@wpptrack/shared";
import { PrismaService } from "../../common/prisma/prisma.service";
import { InboundWebhookChannelRoutesService } from "../../inbound-webhooks/inbound-webhook-channel-routes.service";
import type { IntegrationEnv } from "../integration.types";
import { INTEGRATION_ENV } from "../integration.types";
import { MetaAdDestinationRoutingService } from "./meta-ad-destination-routing.service";
import { MetaAdapter } from "./meta.adapter";
import { clearMetaReportingSyncBlocks } from "./meta-reporting-sync-block";
import { MetaTokenEncryptionService } from "./meta-token-encryption.service";

type CredentialRecord = {
  id: string;
  workspaceId: string;
  source: "oauth" | "manual";
  label: string;
  encryptedAccessToken: string;
  tokenIv: string;
  tokenTag: string;
  encryptionKeyVersion: number;
  fingerprint: string;
  tokenLast4: string;
  tokenType: string | null;
  scopes: string[];
  expiresAt: Date | null;
  status:
    | "pending"
    | "active"
    | "validation_required"
    | "expired"
    | "revoked"
    | "error"
    | "paused";
  lastValidatedAt: Date | null;
  validationError: string | null;
  rotatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type NormalizedConnectionSource = "oauth" | "manual";

type BusinessConnectionRecord = {
  id: string;
  workspaceId: string;
  credentialId: string;
  businessManagerId: string;
  businessManagerName: string;
  status:
    | "pending"
    | "active"
    | "validation_required"
    | "token_expired"
    | "missing_permission"
    | "destination_invalid"
    | "error"
    | "paused";
  defaultConversionDestinationId: string | null;
  lastValidatedAt: Date | null;
  validationError: string | null;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { reportingAccounts: number };
  reportingAccounts?: Array<{ active: boolean }>;
};

type DestinationRecord = {
  id: string;
  workspaceId: string;
  label: string | null;
  pixelId: string;
  pixelName: string;
  pageId: string;
  pageName: string;
  ownerBusinessManagerId: string | null;
  status: "needs_configuration" | "configured" | "error";
  lastValidatedAt: Date | null;
  validationError: string | null;
};

type ReportingAccountRecord = {
  id: string;
  workspaceId: string;
  businessId: string;
  businessName: string;
  adAccountId: string;
  adAccountName: string;
  currency: string | null;
  timezoneName: string | null;
  businessConnectionId: string | null;
  conversionDestinationId: string | null;
  allowedDestinations?: Array<{
    conversionDestinationId: string;
    active: boolean;
  }>;
  active: boolean;
  syncStatus: "pending" | "syncing" | "synced" | "error";
  lastSyncedAt: Date | null;
  lastSyncSince: string | null;
  lastSyncUntil: string | null;
  syncError: string | null;
};

@Injectable()
export class MetaManualConnectionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly adapter: MetaAdapter,
    private readonly adDestinationRouting: MetaAdDestinationRoutingService,
    private readonly encryption: MetaTokenEncryptionService,
    @Inject(INTEGRATION_ENV) private readonly env: IntegrationEnv = process.env,
    @Optional()
    private readonly inboundRoutes?: InboundWebhookChannelRoutesService,
  ) {}

  getCapabilities(): MetaConnectionCapabilitiesDto {
    const enabledModes = (this.env.META_CONNECTION_MODES ?? "oauth")
      .split(",")
      .map((mode) => mode.trim().toLowerCase())
      .filter(
        (mode): mode is "oauth" | "manual" =>
          mode === "oauth" || mode === "manual",
      );

    return {
      enabledModes: [...new Set(enabledModes)],
      oauthEnabled: enabledModes.includes("oauth"),
      manualEnabled: enabledModes.includes("manual"),
    };
  }

  async listConfiguration(
    workspaceId: string,
  ): Promise<MetaManualConfigurationDto> {
    this.requireManualEnabled();
    return this.listConfigurationForSource(workspaceId, "manual");
  }

  async listOAuthConfiguration(
    workspaceId: string,
  ): Promise<MetaManualConfigurationDto> {
    this.requireOAuthEnabled();
    await this.assertOAuthPathPresent(workspaceId);
    return this.listConfigurationForSource(workspaceId, "oauth");
  }

  async prepareOAuthCredential(
    workspaceId: string,
    actorUserId?: string | null,
  ): Promise<MetaManualAssetDiscoveryDto> {
    this.requireOAuthEnabled();
    const integration = await this.prisma.metaIntegration.findUnique({
      where: { workspaceId },
    });

    if (!integration || integration.status !== "connected") {
      throw new ConflictException(
        "Conecte a conta Meta pelo login social antes de configurar destinos por BM",
      );
    }

    const accessToken = this.decryptStoredToken(integration);

    try {
      const [profile, businesses] = await Promise.all([
        this.adapter.getTokenProfile({ accessToken }),
        this.adapter.listBusinesses({ accessToken }),
      ]);
      this.assertRequiredScopes(profile.scopes);
      const now = new Date();
      const fingerprint = this.encryption.fingerprint(accessToken);
      const existing = (await this.prisma.metaCredential.findFirst({
        where: { workspaceId, source: "oauth" },
        orderBy: { createdAt: "asc" },
      })) as CredentialRecord | null;
      const encrypted = this.encryption.encrypt(accessToken);
      const data = {
        label: "Login social Meta",
        encryptedAccessToken: encrypted.encryptedAccessToken,
        tokenIv: encrypted.tokenIv,
        tokenTag: encrypted.tokenTag,
        encryptionKeyVersion: this.encryption.currentKeyVersion,
        fingerprint,
        tokenLast4: this.encryption.tokenLast4(accessToken),
        tokenType: integration.tokenType ?? "oauth",
        scopes: profile.scopes,
        expiresAt: integration.expiresAt,
        status: "active" as const,
        lastValidatedAt: now,
        validationError: null,
      };
      const credential = existing
        ? ((await this.prisma.metaCredential.update({
            where: { id: existing.id },
            data: {
              ...data,
              rotatedAt:
                existing.fingerprint === fingerprint ? existing.rotatedAt : now,
            },
          })) as CredentialRecord)
        : ((await this.prisma.metaCredential.create({
            data: {
              workspaceId,
              source: "oauth",
              ...data,
              createdByUserId: actorUserId ?? null,
            },
          })) as CredentialRecord);

      await clearMetaReportingSyncBlocks(this.prisma, { workspaceId });
      await this.recordAudit({
        workspaceId,
        actorUserId: actorUserId ?? null,
        action: "meta.oauth.advanced_credential_prepared",
        targetType: "MetaCredential",
        targetId: credential.id,
        resultStatus: "success",
        afterSummary: {
          fingerprint: credential.fingerprint.slice(0, 12),
          identityId: profile.id,
          accessibleBusinesses: businesses.length,
          scopes: profile.scopes,
        },
      });

      return {
        credential: this.toCredentialDto(credential),
        businesses,
        selectedBusinessId: null,
        adAccounts: [],
        pixels: [],
        pages: [],
      };
    } catch (error) {
      throw this.publicBadRequest(
        error,
        "Não foi possível preparar o login social para o roteamento por BM",
      );
    }
  }

  private async listConfigurationForSource(
    workspaceId: string,
    source: NormalizedConnectionSource,
  ): Promise<MetaManualConfigurationDto> {
    const [credentials, allBusinessConnections, destinations, allAccounts] =
      await Promise.all([
        this.prisma.metaCredential.findMany({
          where: { workspaceId, source },
          orderBy: { createdAt: "asc" },
        }),
        this.prisma.metaBusinessConnection.findMany({
          where: { workspaceId },
          include: {
            _count: { select: { reportingAccounts: true } },
            reportingAccounts: { select: { active: true } },
          },
          orderBy: { createdAt: "asc" },
        }),
        this.prisma.metaConversionDestination.findMany({
          where: { workspaceId },
          orderBy: { createdAt: "asc" },
        }),
        this.prisma.metaReportingAccount.findMany({
          where: { workspaceId },
          include: {
            allowedDestinations: {
              where: { active: true },
              select: {
                conversionDestinationId: true,
                active: true,
              },
              orderBy: { createdAt: "asc" },
            },
          },
          orderBy: [{ businessName: "asc" }, { adAccountName: "asc" }],
        }),
      ]);
    const credentialIds = new Set(credentials.map((record) => record.id));
    const businessConnections = allBusinessConnections.filter((record) =>
      credentialIds.has(record.credentialId),
    );
    const businessConnectionIds = new Set(
      businessConnections.map((record) => record.id),
    );
    const reportingAccounts = allAccounts.filter(
      (record) =>
        record.businessConnectionId &&
        businessConnectionIds.has(record.businessConnectionId),
    );
    const integration =
      source === "oauth"
        ? await this.prisma.metaIntegration.findUnique({
            where: { workspaceId },
            select: { advancedRoutingEnabled: true },
          })
        : null;
    const unmappedActiveAccountCount =
      source === "oauth"
        ? allAccounts.filter(
            (record) =>
              record.active &&
              (!record.businessConnectionId ||
                !businessConnectionIds.has(record.businessConnectionId)),
          ).length
        : 0;

    return {
      workspaceId,
      connectionMode: source,
      advancedRoutingEnabled:
        source === "manual"
          ? true
          : Boolean(integration?.advancedRoutingEnabled),
      unmappedActiveAccountCount,
      credentials: (credentials as CredentialRecord[]).map((record) =>
        this.toCredentialDto(record),
      ),
      businessConnections: (
        businessConnections as BusinessConnectionRecord[]
      ).map((record) => this.toBusinessConnectionDto(record)),
      destinations: (destinations as DestinationRecord[]).map((record) =>
        this.toDestinationDto(record),
      ),
      reportingAccounts: (reportingAccounts as ReportingAccountRecord[]).map(
        (record) => this.toReportingAccountDto(record),
      ),
    };
  }

  async createCredential(
    workspaceId: string,
    input: MetaManualCredentialInputDto,
    actorUserId?: string | null,
  ): Promise<MetaManualAssetDiscoveryDto> {
    this.requireManualEnabled();
    await this.assertLegacyPathAbsent(workspaceId);
    const accessToken = input.accessToken.trim();

    try {
      const [profile, businesses] = await Promise.all([
        this.adapter.getTokenProfile({ accessToken }),
        this.adapter.listBusinesses({ accessToken }).catch(() => []),
      ]);
      this.assertRequiredScopes(profile.scopes);

      const now = new Date();
      const encrypted = this.encryption.encrypt(accessToken);
      const fingerprint = this.encryption.fingerprint(accessToken);
      const existing = (await this.prisma.metaCredential.findUnique({
        where: {
          workspaceId_fingerprint: { workspaceId, fingerprint },
        },
      })) as CredentialRecord | null;
      const status = existing?.status === "active" ? "active" : "pending";
      const credential = (await this.prisma.metaCredential.upsert({
        where: {
          workspaceId_fingerprint: { workspaceId, fingerprint },
        },
        create: {
          workspaceId,
          source: "manual",
          label: input.label,
          encryptedAccessToken: encrypted.encryptedAccessToken,
          tokenIv: encrypted.tokenIv,
          tokenTag: encrypted.tokenTag,
          encryptionKeyVersion: this.encryption.currentKeyVersion,
          fingerprint,
          tokenLast4: this.encryption.tokenLast4(accessToken),
          tokenType: "system_user",
          scopes: profile.scopes,
          expiresAt: null,
          status,
          lastValidatedAt: now,
          validationError: null,
          createdByUserId: actorUserId ?? null,
        },
        update: {
          label: input.label,
          encryptedAccessToken: encrypted.encryptedAccessToken,
          tokenIv: encrypted.tokenIv,
          tokenTag: encrypted.tokenTag,
          encryptionKeyVersion: this.encryption.currentKeyVersion,
          tokenLast4: this.encryption.tokenLast4(accessToken),
          tokenType: "system_user",
          scopes: profile.scopes,
          status,
          lastValidatedAt: now,
          validationError: null,
        },
      })) as CredentialRecord;

      await this.recordAudit({
        workspaceId,
        actorUserId: actorUserId ?? null,
        action: "meta.manual.credential_validated",
        targetType: "MetaCredential",
        targetId: credential.id,
        resultStatus: "success",
        afterSummary: {
          label: credential.label,
          fingerprint: credential.fingerprint.slice(0, 12),
          tokenLast4: credential.tokenLast4,
          identityId: profile.id,
          accessibleBusinesses: businesses.length,
          scopes: profile.scopes,
        },
      });

      return {
        credential: this.toCredentialDto(credential),
        businesses,
        selectedBusinessId: null,
        adAccounts: [],
        pixels: [],
        pages: [],
      };
    } catch (error) {
      throw this.publicBadRequest(
        error,
        "Não foi possível validar o token permanente na Meta",
      );
    }
  }

  async discoverAssets(
    workspaceId: string,
    credentialId: string,
    businessId?: string | null,
    source: NormalizedConnectionSource = "manual",
  ): Promise<MetaManualAssetDiscoveryDto> {
    this.requireSourceEnabled(source);
    const credential = await this.getCredential(
      workspaceId,
      credentialId,
      source,
    );
    const accessToken = this.decryptCredential(credential);

    try {
      const businesses = await this.adapter
        .listBusinesses({ accessToken })
        .catch(() => []);
      const selectedBusinessId =
        businessId?.trim() || businesses[0]?.id || null;

      if (!selectedBusinessId) {
        return {
          credential: this.toCredentialDto(credential),
          businesses,
          selectedBusinessId: null,
          adAccounts: [],
          pixels: [],
          pages: [],
        };
      }

      const selectedBusiness = await this.adapter.getBusiness({
        accessToken,
        businessId: selectedBusinessId,
      });
      const normalizedBusinesses = businesses.some(
        (business) => business.id === selectedBusiness.id,
      )
        ? businesses
        : [...businesses, selectedBusiness];
      const [accountsResult, pixelsResult, pagesResult] =
        await Promise.allSettled([
          this.adapter.listOwnedAdAccounts({
            accessToken,
            businessId: selectedBusinessId,
          }),
          this.adapter.listBusinessPixels({
            accessToken,
            businessId: selectedBusinessId,
          }),
          this.adapter.listBusinessPages({
            accessToken,
            businessId: selectedBusinessId,
          }),
        ]);

      return {
        credential: this.toCredentialDto(credential),
        businesses: normalizedBusinesses,
        selectedBusinessId,
        adAccounts:
          accountsResult.status === "fulfilled" ? accountsResult.value : [],
        pixels: pixelsResult.status === "fulfilled" ? pixelsResult.value : [],
        pages: pagesResult.status === "fulfilled" ? pagesResult.value : [],
      };
    } catch (error) {
      throw this.publicBadRequest(
        error,
        "Não foi possível consultar os ativos acessíveis por este token",
      );
    }
  }

  async discoverOAuthAssets(
    workspaceId: string,
    credentialId: string,
    businessId?: string | null,
  ): Promise<MetaManualAssetDiscoveryDto> {
    await this.assertOAuthPathPresent(workspaceId);
    return this.discoverAssets(workspaceId, credentialId, businessId, "oauth");
  }

  async createBusinessConnection(
    workspaceId: string,
    input: MetaManualBusinessConnectionInputDto,
    actorUserId?: string | null,
    source: NormalizedConnectionSource = "manual",
  ): Promise<MetaManualConfigurationDto> {
    this.requireSourceEnabled(source);

    if (source === "manual") {
      await this.assertLegacyPathAbsent(workspaceId);
    } else {
      await this.assertOAuthPathPresent(workspaceId);
    }

    const credential = await this.getCredential(
      workspaceId,
      input.credentialId,
      source,
    );
    const accessToken = this.decryptCredential(credential);

    try {
      const business = await this.adapter.getBusiness({
        accessToken,
        businessId: input.businessManagerId,
      });
      const accounts = await Promise.all(
        [...new Set(input.adAccountIds)].map((adAccountId) =>
          this.adapter.getAdAccount({
            accessToken,
            adAccountId,
            businessId: business.id,
          }),
        ),
      );
      const destination = await this.validateDestinationInput({
        workspaceId,
        accessToken,
        businessId: input.destination.ownerBusinessManagerId ?? business.id,
        input: input.destination,
      });
      const occupiedAccounts = await this.prisma.metaReportingAccount.findMany({
        where: {
          workspaceId,
          adAccountId: { in: accounts.map((account) => account.id) },
          businessConnectionId: { not: null },
        },
        select: { adAccountId: true, businessConnectionId: true },
      });
      const existingConnection =
        await this.prisma.metaBusinessConnection.findUnique({
          where: {
            workspaceId_businessManagerId: {
              workspaceId,
              businessManagerId: business.id,
            },
          },
          select: {
            id: true,
            credentialId: true,
            defaultConversionDestinationId: true,
          },
        });
      const conflictingAccount = occupiedAccounts.find(
        (account) => account.businessConnectionId !== existingConnection?.id,
      );

      if (conflictingAccount) {
        throw new ConflictException(
          `A conta ${conflictingAccount.adAccountId} já pertence a outra conexão Meta deste workspace`,
        );
      }

      const accountSelectionMode = input.accountSelectionMode ?? "merge";
      const now = new Date();
      const saved = await this.prisma.$transaction(async (transaction) => {
        const savedDestination = destination.existing
          ? destination.record
          : await transaction.metaConversionDestination.upsert({
              where: {
                workspaceId_pixelId_pageId: {
                  workspaceId,
                  pixelId: destination.pixel.id,
                  pageId: destination.page.id,
                },
              },
              create: {
                workspaceId,
                label:
                  input.destination.label ??
                  `${destination.pixel.name} / ${destination.page.name}`,
                pixelId: destination.pixel.id,
                pixelName: destination.pixel.name,
                pageId: destination.page.id,
                pageName: destination.page.name,
                ownerBusinessManagerId:
                  input.destination.ownerBusinessManagerId ?? business.id,
                status: "configured",
                lastValidatedAt: now,
                validationError: null,
                createdByUserId: actorUserId ?? null,
              },
              update: {
                label:
                  input.destination.label ??
                  `${destination.pixel.name} / ${destination.page.name}`,
                pixelName: destination.pixel.name,
                pageName: destination.page.name,
                ownerBusinessManagerId:
                  input.destination.ownerBusinessManagerId ?? business.id,
                status: "configured",
                lastValidatedAt: now,
                validationError: null,
              },
            });
        const defaultConversionDestinationId =
          accountSelectionMode === "merge" &&
          existingConnection?.defaultConversionDestinationId
            ? existingConnection.defaultConversionDestinationId
            : savedDestination.id;
        const selectedAccountDestinationId =
          defaultConversionDestinationId === savedDestination.id
            ? null
            : savedDestination.id;
        const connection = await transaction.metaBusinessConnection.upsert({
          where: {
            workspaceId_businessManagerId: {
              workspaceId,
              businessManagerId: business.id,
            },
          },
          create: {
            workspaceId,
            credentialId: credential.id,
            businessManagerId: business.id,
            businessManagerName: business.name,
            status: "active",
            defaultConversionDestinationId,
            lastValidatedAt: now,
            validationError: null,
            createdByUserId: actorUserId ?? null,
          },
          update: {
            credentialId: credential.id,
            businessManagerName: business.name,
            status: "active",
            defaultConversionDestinationId,
            lastValidatedAt: now,
            validationError: null,
          },
        });

        for (const account of accounts) {
          const savedAccount = await transaction.metaReportingAccount.upsert({
            where: {
              workspaceId_adAccountId: {
                workspaceId,
                adAccountId: account.id,
              },
            },
            create: {
              workspaceId,
              businessId: business.id,
              businessName: business.name,
              adAccountId: account.id,
              adAccountName: account.name,
              currency: account.currency,
              timezoneName: account.timezoneName,
              businessConnectionId: connection.id,
              conversionDestinationId: selectedAccountDestinationId,
              active: true,
              syncStatus: "pending",
              syncError: null,
            },
            update: {
              businessId: business.id,
              businessName: business.name,
              adAccountName: account.name,
              currency: account.currency,
              timezoneName: account.timezoneName,
              businessConnectionId: connection.id,
              active: true,
              syncStatus: "pending",
              syncError: null,
            },
          });

          await transaction.metaReportingAccountDestination.upsert({
            where: {
              workspaceId_reportingAccountId_conversionDestinationId: {
                workspaceId,
                reportingAccountId: savedAccount.id,
                conversionDestinationId: savedDestination.id,
              },
            },
            create: {
              workspaceId,
              reportingAccountId: savedAccount.id,
              conversionDestinationId: savedDestination.id,
              active: true,
              createdByUserId: actorUserId ?? null,
            },
            update: {
              active: true,
            },
          });
        }

        if (accountSelectionMode === "replace") {
          await transaction.metaReportingAccount.updateMany({
            where: {
              workspaceId,
              businessConnectionId: connection.id,
              active: true,
              adAccountId: {
                notIn: accounts.map((account) => account.id),
              },
            },
            data: {
              active: false,
              businessConnectionId: null,
              conversionDestinationId: null,
              syncStatus: "pending",
              syncError: null,
            },
          });

          await transaction.metaReportingAccountDestination.updateMany({
            where: {
              workspaceId,
              account: {
                businessConnectionId: connection.id,
                active: false,
              },
            },
            data: { active: false },
          });
        }

        await transaction.metaCredential.update({
          where: { id: credential.id },
          data: {
            status: "active",
            lastValidatedAt: now,
            validationError: null,
          },
        });

        return {
          connectionId: connection.id,
          destinationId: savedDestination.id,
        };
      });

      await clearMetaReportingSyncBlocks(this.prisma, {
        workspaceId,
        businessConnectionId: saved.connectionId,
      });
      await this.recordAudit({
        workspaceId,
        actorUserId: actorUserId ?? null,
        action: `meta.${source}.business_connection_activated`,
        targetType: "MetaBusinessConnection",
        targetId: saved.connectionId,
        resultStatus: "success",
        afterSummary: {
          credentialId: credential.id,
          businessManagerId: business.id,
          destinationId: saved.destinationId,
          adAccountIds: accounts.map((account) => account.id),
          accountSelectionMode,
        },
      });

      return this.listConfigurationForSource(workspaceId, source);
    } catch (error) {
      throw this.publicBadRequest(
        error,
        "Não foi possível ativar esta estrutura Meta",
      );
    }
  }

  async createOAuthBusinessConnection(
    workspaceId: string,
    input: MetaManualBusinessConnectionInputDto,
    actorUserId?: string | null,
  ): Promise<MetaManualConfigurationDto> {
    return this.createBusinessConnection(
      workspaceId,
      input,
      actorUserId,
      "oauth",
    );
  }

  async rotateCredential(
    workspaceId: string,
    credentialId: string,
    input: MetaManualCredentialRotationInputDto,
    actorUserId?: string | null,
  ): Promise<MetaManualConfigurationDto> {
    this.requireManualEnabled();
    const credential = await this.getManualCredential(
      workspaceId,
      credentialId,
    );
    const accessToken = input.accessToken.trim();

    try {
      const profile = await this.adapter.getTokenProfile({ accessToken });
      this.assertRequiredScopes(profile.scopes);
      const connections = await this.prisma.metaBusinessConnection.findMany({
        where: { workspaceId, credentialId },
        include: {
          defaultConversionDestination: true,
          reportingAccounts: true,
        },
      });

      for (const connection of connections) {
        await this.adapter.getBusiness({
          accessToken,
          businessId: connection.businessManagerId,
        });

        for (const account of connection.reportingAccounts) {
          await this.adapter.getAdAccount({
            accessToken,
            adAccountId: account.adAccountId,
            businessId: connection.businessManagerId,
          });
        }

        if (connection.defaultConversionDestination) {
          await this.validateDestinationAccess(
            accessToken,
            connection.defaultConversionDestination,
          );
        }
      }

      const encrypted = this.encryption.encrypt(accessToken);
      const fingerprint = this.encryption.fingerprint(accessToken);
      const now = new Date();

      await this.prisma.$transaction([
        this.prisma.metaCredential.update({
          where: { id: credential.id },
          data: {
            encryptedAccessToken: encrypted.encryptedAccessToken,
            tokenIv: encrypted.tokenIv,
            tokenTag: encrypted.tokenTag,
            encryptionKeyVersion: this.encryption.currentKeyVersion,
            fingerprint,
            tokenLast4: this.encryption.tokenLast4(accessToken),
            scopes: profile.scopes,
            status: "active",
            lastValidatedAt: now,
            validationError: null,
            rotatedAt: now,
          },
        }),
        this.prisma.metaBusinessConnection.updateMany({
          where: { workspaceId, credentialId },
          data: {
            status: "active",
            lastValidatedAt: now,
            validationError: null,
          },
        }),
      ]);

      await clearMetaReportingSyncBlocks(this.prisma, {
        workspaceId,
        businessConnection: { is: { credentialId: credential.id } },
      });
      await this.recordAudit({
        workspaceId,
        actorUserId: actorUserId ?? null,
        action: "meta.manual.credential_rotated",
        targetType: "MetaCredential",
        targetId: credential.id,
        resultStatus: "success",
        afterSummary: {
          fingerprint: fingerprint.slice(0, 12),
          tokenLast4: this.encryption.tokenLast4(accessToken),
          affectedConnections: connections.length,
        },
      });

      return this.listConfiguration(workspaceId);
    } catch (error) {
      throw this.publicBadRequest(
        error,
        "O novo token não acessa toda a estrutura desta conexão",
      );
    }
  }

  async setBusinessConnectionStatus(
    workspaceId: string,
    connectionId: string,
    input: MetaManualBusinessConnectionStatusInputDto,
    actorUserId?: string | null,
    source: NormalizedConnectionSource = "manual",
  ): Promise<MetaManualConfigurationDto> {
    this.requireSourceEnabled(source);
    const connection = await this.prisma.metaBusinessConnection.findFirst({
      where: { id: connectionId, workspaceId },
      include: { credential: true },
    });

    if (!connection || connection.credential.source !== source) {
      throw new NotFoundException("Conexão Meta não encontrada");
    }

    if (
      input.status === "active" &&
      connection.credential.status !== "active"
    ) {
      throw new ConflictException(
        "Valide ou troque o token antes de reativar esta conexão",
      );
    }

    await this.prisma.metaBusinessConnection.updateMany({
      where: { id: connectionId, workspaceId },
      data: { status: input.status },
    });
    await this.recordAudit({
      workspaceId,
      actorUserId: actorUserId ?? null,
      action: `meta.${source}.business_connection_status_updated`,
      targetType: "MetaBusinessConnection",
      targetId: connectionId,
      resultStatus: "success",
      afterSummary: { status: input.status },
    });

    return this.listConfigurationForSource(workspaceId, source);
  }

  async setOAuthBusinessConnectionStatus(
    workspaceId: string,
    connectionId: string,
    input: MetaManualBusinessConnectionStatusInputDto,
    actorUserId?: string | null,
  ): Promise<MetaManualConfigurationDto> {
    return this.setBusinessConnectionStatus(
      workspaceId,
      connectionId,
      input,
      actorUserId,
      "oauth",
    );
  }

  async removeBusinessConnection(
    workspaceId: string,
    connectionId: string,
    input: MetaManualBusinessConnectionRemovalInputDto,
    actorUserId?: string | null,
    source: NormalizedConnectionSource = "manual",
  ): Promise<MetaManualConfigurationDto> {
    this.requireSourceEnabled(source);
    const connection = await this.prisma.metaBusinessConnection.findFirst({
      where: { id: connectionId, workspaceId },
      select: {
        id: true,
        credentialId: true,
        businessManagerId: true,
        businessManagerName: true,
        defaultConversionDestinationId: true,
        credential: { select: { source: true } },
      },
    });

    if (!connection || connection.credential.source !== source) {
      throw new NotFoundException("Conexão Meta não encontrada");
    }

    if (input.businessManagerId !== connection.businessManagerId) {
      throw new BadRequestException("Confirme o ID exato da BM para remover");
    }

    const result = await this.prisma.$transaction(async (transaction) => {
      const disabledAccounts =
        await transaction.metaReportingAccount.updateMany({
          where: {
            workspaceId,
            businessConnectionId: connection.id,
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
        where: { id: connection.id, workspaceId },
      });

      const remainingCredentialConnections =
        await transaction.metaBusinessConnection.count({
          where: { workspaceId, credentialId: connection.credentialId },
        });
      let credentialRemoved = false;

      if (source === "manual" && remainingCredentialConnections === 0) {
        const deletedCredential = await transaction.metaCredential.deleteMany({
          where: {
            id: connection.credentialId,
            workspaceId,
            source: "manual",
          },
        });
        credentialRemoved = deletedCredential.count === 1;
      }

      if (source === "oauth" && remainingCredentialConnections === 0) {
        await transaction.metaIntegration.updateMany({
          where: { workspaceId },
          data: { advancedRoutingEnabled: false },
        });
      }

      return {
        disabledAccountCount: disabledAccounts.count,
        credentialRemoved,
      };
    });

    await this.recordAudit({
      workspaceId,
      actorUserId: actorUserId ?? null,
      action: `meta.${source}.business_connection_removed`,
      targetType: "MetaBusinessConnection",
      targetId: connection.id,
      resultStatus: "success",
      beforeSummary: {
        businessManagerId: connection.businessManagerId,
        businessManagerName: connection.businessManagerName,
        credentialId: connection.credentialId,
        defaultConversionDestinationId:
          connection.defaultConversionDestinationId,
      },
      afterSummary: result,
    });

    return this.listConfigurationForSource(workspaceId, source);
  }

  async removeOAuthBusinessConnection(
    workspaceId: string,
    connectionId: string,
    input: MetaManualBusinessConnectionRemovalInputDto,
    actorUserId?: string | null,
  ): Promise<MetaManualConfigurationDto> {
    return this.removeBusinessConnection(
      workspaceId,
      connectionId,
      input,
      actorUserId,
      "oauth",
    );
  }

  async testBusinessConnection(
    workspaceId: string,
    connectionId: string,
    actorUserId?: string | null,
    source: NormalizedConnectionSource = "manual",
  ): Promise<MetaManualConnectionTestResultDto> {
    this.requireSourceEnabled(source);
    const connection = await this.prisma.metaBusinessConnection.findFirst({
      where: { id: connectionId, workspaceId },
      include: {
        credential: true,
        defaultConversionDestination: true,
        reportingAccounts: {
          where: { active: true },
          orderBy: { adAccountId: "asc" },
        },
      },
    });

    if (
      !connection?.defaultConversionDestination ||
      connection.credential.source !== source
    ) {
      throw new NotFoundException("Conexão Meta não encontrada");
    }

    const accessToken = this.decryptCredential(
      connection.credential as CredentialRecord,
    );

    try {
      await this.adapter.getBusiness({
        accessToken,
        businessId: connection.businessManagerId,
      });

      for (const account of connection.reportingAccounts) {
        await this.adapter.getAdAccount({
          accessToken,
          adAccountId: account.adAccountId,
          businessId: connection.businessManagerId,
        });
      }

      await this.validateDestinationAccess(
        accessToken,
        connection.defaultConversionDestination,
      );
      const now = new Date();

      await this.prisma.$transaction([
        this.prisma.metaBusinessConnection.updateMany({
          where: { id: connection.id, workspaceId },
          data: {
            status: "active",
            lastValidatedAt: now,
            validationError: null,
          },
        }),
        this.prisma.metaCredential.updateMany({
          where: {
            id: connection.credentialId,
            workspaceId,
            source,
          },
          data: {
            status: "active",
            lastValidatedAt: now,
            validationError: null,
          },
        }),
      ]);
      // The token answered: lift the reporting-only breaker for its accounts.
      await clearMetaReportingSyncBlocks(this.prisma, {
        workspaceId,
        businessConnection: { is: { credentialId: connection.credentialId } },
      });
      await this.recordAudit({
        workspaceId,
        actorUserId: actorUserId ?? null,
        action: `meta.${source}.business_connection_tested`,
        targetType: "MetaBusinessConnection",
        targetId: connection.id,
        resultStatus: "success",
        afterSummary: {
          credentialId: connection.credentialId,
          destinationId: connection.defaultConversionDestination.id,
          reportingAccountCount: connection.reportingAccounts.length,
        },
      });

      return {
        connectionId: connection.id,
        credentialId: connection.credentialId,
        destinationId: connection.defaultConversionDestination.id,
        reportingAccountCount: connection.reportingAccounts.length,
        status: "active",
        validatedAt: now.toISOString(),
        message: "Token, BM, contas e destino validados com sucesso",
      };
    } catch (error) {
      const now = new Date();

      await this.prisma.metaBusinessConnection.updateMany({
        where: { id: connection.id, workspaceId },
        data: {
          status: "validation_required",
          lastValidatedAt: now,
          validationError: "A Meta recusou a validação desta conexão",
        },
      });
      await this.recordAudit({
        workspaceId,
        actorUserId: actorUserId ?? null,
        action: `meta.${source}.business_connection_tested`,
        targetType: "MetaBusinessConnection",
        targetId: connection.id,
        resultStatus: "failed",
        afterSummary: {
          reportingAccountCount: connection.reportingAccounts.length,
          reason: "meta_validation_failed",
        },
      });

      throw this.publicBadRequest(
        error,
        "A Meta recusou a validação desta conexão",
      );
    }
  }

  async testOAuthBusinessConnection(
    workspaceId: string,
    connectionId: string,
    actorUserId?: string | null,
  ): Promise<MetaManualConnectionTestResultDto> {
    return this.testBusinessConnection(
      workspaceId,
      connectionId,
      actorUserId,
      "oauth",
    );
  }

  async setReportingAccountDestination(
    workspaceId: string,
    reportingAccountId: string,
    input: MetaManualAccountDestinationInputDto,
    actorUserId?: string | null,
    source: NormalizedConnectionSource = "manual",
  ): Promise<MetaManualConfigurationDto> {
    this.requireSourceEnabled(source);
    const account = await this.prisma.metaReportingAccount.findFirst({
      where: { id: reportingAccountId, workspaceId },
      include: {
        businessConnection: { include: { credential: true } },
      },
    });

    if (
      !account?.businessConnection ||
      account.businessConnection.credential.source !== source
    ) {
      throw new NotFoundException("Conta Meta normalizada não encontrada");
    }

    const requestedDestinationIds = [
      ...new Set(input.conversionDestinationIds),
    ];
    const destinations = await this.prisma.metaConversionDestination.findMany({
      where: {
        workspaceId,
        id: { in: requestedDestinationIds },
      },
    });

    if (destinations.length !== requestedDestinationIds.length) {
      throw new NotFoundException(
        "Um ou mais destinos Meta não foram encontrados",
      );
    }

    const destinationByPage = new Map<string, (typeof destinations)[number]>();

    for (const destination of destinations) {
      const existing = destinationByPage.get(destination.pageId);

      if (existing && existing.id !== destination.id) {
        throw new BadRequestException(
          "Cada Página Meta pode apontar para apenas um Pixel nesta conta",
        );
      }

      destinationByPage.set(destination.pageId, destination);
    }

    const accessToken = this.decryptCredential(
      account.businessConnection.credential as CredentialRecord,
    );

    try {
      for (const destination of destinations) {
        await this.validateDestinationAccess(accessToken, destination);
      }
    } catch (error) {
      throw this.publicBadRequest(
        error,
        "O token desta BM não acessa todos os destinos selecionados",
      );
    }

    await this.prisma.$transaction(async (transaction) => {
      await transaction.metaReportingAccount.updateMany({
        where: { id: reportingAccountId, workspaceId },
        data: { conversionDestinationId: input.conversionDestinationId },
      });
      await transaction.metaReportingAccountDestination.updateMany({
        where: { workspaceId, reportingAccountId, active: true },
        data: { active: false },
      });

      for (const conversionDestinationId of requestedDestinationIds) {
        await transaction.metaReportingAccountDestination.upsert({
          where: {
            workspaceId_reportingAccountId_conversionDestinationId: {
              workspaceId,
              reportingAccountId,
              conversionDestinationId,
            },
          },
          create: {
            workspaceId,
            reportingAccountId,
            conversionDestinationId,
            active: true,
            createdByUserId: actorUserId ?? null,
          },
          update: { active: true },
        });
      }

      await transaction.metaAdDestinationAssignment.deleteMany({
        where: {
          workspaceId,
          reportingAccountId,
          ...(requestedDestinationIds.length > 0
            ? { conversionDestinationId: { notIn: requestedDestinationIds } }
            : {}),
        },
      });
    });
    await this.recordAudit({
      workspaceId,
      actorUserId: actorUserId ?? null,
      action: `meta.${source}.reporting_destination_updated`,
      targetType: "MetaReportingAccount",
      targetId: reportingAccountId,
      resultStatus: "success",
      afterSummary: {
        conversionDestinationId: input.conversionDestinationId,
        conversionDestinationIds: requestedDestinationIds,
      },
    });

    await this.adDestinationRouting.reconcileReportingAccount({
      workspaceId,
      reportingAccountId,
    });

    await this.inboundRoutes?.reevaluateWorkspaceOpenEvents(workspaceId);

    return this.listConfigurationForSource(workspaceId, source);
  }

  async setOAuthReportingAccountDestination(
    workspaceId: string,
    reportingAccountId: string,
    input: MetaManualAccountDestinationInputDto,
    actorUserId?: string | null,
  ): Promise<MetaManualConfigurationDto> {
    return this.setReportingAccountDestination(
      workspaceId,
      reportingAccountId,
      input,
      actorUserId,
      "oauth",
    );
  }

  async getReportingAccountAdRouting(
    workspaceId: string,
    reportingAccountId: string,
    source: NormalizedConnectionSource = "manual",
  ): Promise<MetaReportingAccountAdRoutingDto> {
    this.requireSourceEnabled(source);
    const account = await this.prisma.metaReportingAccount.findFirst({
      where: { id: reportingAccountId, workspaceId },
      include: {
        businessConnection: { include: { credential: true } },
        allowedDestinations: {
          where: { active: true },
          include: { destination: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (
      !account?.businessConnection ||
      account.businessConnection.credential.source !== source
    ) {
      throw new NotFoundException("Conta Meta normalizada não encontrada");
    }

    let destinations = account.allowedDestinations.map(
      (record) => record.destination,
    );
    const legacyDestinationId =
      account.conversionDestinationId ??
      account.businessConnection.defaultConversionDestinationId;

    if (destinations.length === 0 && legacyDestinationId) {
      destinations = await this.prisma.metaConversionDestination.findMany({
        where: { id: legacyDestinationId, workspaceId },
      });
    }

    const allowedDestinationIds = destinations.map(
      (destination) => destination.id,
    );
    const ads = await this.prisma.metaAd.findMany({
      where: {
        workspaceId,
        adAccountId: account.adAccountId,
      },
      select: {
        adId: true,
        name: true,
        status: true,
        effectiveStatus: true,
        detectedPixelIds: true,
        detectedPageIds: true,
        updatedAt: true,
        destinationAssignment: {
          select: {
            conversionDestinationId: true,
            source: true,
            detectedPixelId: true,
            detectedPageId: true,
            updatedAt: true,
          },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
      take: 1000,
    });

    return {
      reportingAccountId: account.id,
      adAccountId: account.adAccountId,
      adAccountName: account.adAccountName,
      conversionDestinationId: account.conversionDestinationId,
      conversionDestinationIds: allowedDestinationIds,
      ads: ads.map((ad) => {
        const candidates = this.adDestinationRouting.destinationCandidates(
          destinations,
          ad.detectedPixelIds,
          ad.detectedPageIds,
        );
        const assignment =
          ad.destinationAssignment &&
          allowedDestinationIds.includes(
            ad.destinationAssignment.conversionDestinationId,
          )
            ? ad.destinationAssignment
            : null;

        return {
          adId: ad.adId,
          adName: ad.name,
          status: ad.status,
          effectiveStatus: ad.effectiveStatus,
          routeStatus: assignment
            ? ("assigned" as const)
            : candidates.length > 1
              ? ("ambiguous" as const)
              : ("unresolved" as const),
          conversionDestinationId: assignment?.conversionDestinationId ?? null,
          assignmentSource: assignment?.source ?? null,
          detectedPixelId:
            assignment?.detectedPixelId ?? ad.detectedPixelIds[0] ?? null,
          detectedPageId:
            assignment?.detectedPageId ?? ad.detectedPageIds[0] ?? null,
          candidateDestinationIds: candidates.map(
            (destination) => destination.id,
          ),
          updatedAt:
            assignment?.updatedAt.toISOString() ?? ad.updatedAt.toISOString(),
        };
      }),
    };
  }

  async getOAuthReportingAccountAdRouting(
    workspaceId: string,
    reportingAccountId: string,
  ): Promise<MetaReportingAccountAdRoutingDto> {
    return this.getReportingAccountAdRouting(
      workspaceId,
      reportingAccountId,
      "oauth",
    );
  }

  async setAdDestination(
    workspaceId: string,
    reportingAccountId: string,
    adId: string,
    input: MetaAdDestinationInputDto,
    actorUserId?: string | null,
    source: NormalizedConnectionSource = "manual",
  ): Promise<MetaReportingAccountAdRoutingDto> {
    this.requireSourceEnabled(source);
    const account = await this.prisma.metaReportingAccount.findFirst({
      where: { id: reportingAccountId, workspaceId },
      include: {
        businessConnection: { include: { credential: true } },
        allowedDestinations: {
          where: { active: true },
          include: { destination: true },
        },
      },
    });

    if (
      !account?.businessConnection ||
      account.businessConnection.credential.source !== source
    ) {
      throw new NotFoundException("Conta Meta normalizada não encontrada");
    }

    const ad = await this.prisma.metaAd.findFirst({
      where: {
        workspaceId,
        adId,
        adAccountId: account.adAccountId,
      },
      select: {
        adId: true,
        detectedPixelIds: true,
        detectedPageIds: true,
      },
    });

    if (!ad) {
      throw new NotFoundException("Anúncio Meta não encontrado nesta conta");
    }

    let destinations = account.allowedDestinations.map(
      (record) => record.destination,
    );
    const legacyDestinationId =
      account.conversionDestinationId ??
      account.businessConnection.defaultConversionDestinationId;

    if (destinations.length === 0 && legacyDestinationId) {
      destinations = await this.prisma.metaConversionDestination.findMany({
        where: { id: legacyDestinationId, workspaceId },
      });
    }

    if (
      input.conversionDestinationId &&
      !destinations.some(
        (destination) => destination.id === input.conversionDestinationId,
      )
    ) {
      throw new BadRequestException(
        "O destino escolhido não está autorizado para esta conta",
      );
    }

    const automaticCandidate = this.adDestinationRouting.destinationCandidates(
      destinations,
      ad.detectedPixelIds,
      ad.detectedPageIds,
    );
    const selectedDestinationId =
      input.conversionDestinationId ??
      (automaticCandidate.length === 1 ? automaticCandidate[0].id : null);
    const assignmentSource = input.conversionDestinationId
      ? ("manual" as const)
      : ("automatic" as const);

    await this.prisma.$transaction(async (transaction) => {
      if (!selectedDestinationId) {
        await transaction.metaAdDestinationAssignment.deleteMany({
          where: { workspaceId, adId: ad.adId },
        });
        return;
      }

      await transaction.metaAdDestinationAssignment.upsert({
        where: {
          workspaceId_adId: { workspaceId, adId: ad.adId },
        },
        create: {
          workspaceId,
          adId: ad.adId,
          reportingAccountId: account.id,
          conversionDestinationId: selectedDestinationId,
          source: assignmentSource,
          detectedPixelId: ad.detectedPixelIds[0] ?? null,
          detectedPageId: ad.detectedPageIds[0] ?? null,
          createdByUserId:
            assignmentSource === "manual" ? (actorUserId ?? null) : null,
        },
        update: {
          reportingAccountId: account.id,
          conversionDestinationId: selectedDestinationId,
          source: assignmentSource,
          detectedPixelId: ad.detectedPixelIds[0] ?? null,
          detectedPageId: ad.detectedPageIds[0] ?? null,
          createdByUserId:
            assignmentSource === "manual" ? (actorUserId ?? null) : null,
        },
      });
    });

    await this.recordAudit({
      workspaceId,
      actorUserId: actorUserId ?? null,
      action: `meta.${source}.ad_destination_updated`,
      targetType: "MetaAd",
      targetId: ad.adId,
      resultStatus: "success",
      afterSummary: {
        reportingAccountId: account.id,
        conversionDestinationId: selectedDestinationId,
        source: selectedDestinationId ? assignmentSource : null,
      },
    });

    await this.inboundRoutes?.reevaluateWorkspaceOpenEvents(workspaceId);

    return this.getReportingAccountAdRouting(
      workspaceId,
      reportingAccountId,
      source,
    );
  }

  async setOAuthAdDestination(
    workspaceId: string,
    reportingAccountId: string,
    adId: string,
    input: MetaAdDestinationInputDto,
    actorUserId?: string | null,
  ): Promise<MetaReportingAccountAdRoutingDto> {
    return this.setAdDestination(
      workspaceId,
      reportingAccountId,
      adId,
      input,
      actorUserId,
      "oauth",
    );
  }

  async setOAuthAdvancedRouting(
    workspaceId: string,
    input: MetaOAuthAdvancedRoutingInputDto,
    actorUserId?: string | null,
  ): Promise<MetaManualConfigurationDto> {
    this.requireOAuthEnabled();
    await this.assertOAuthPathPresent(workspaceId);
    const configuration = await this.listConfigurationForSource(
      workspaceId,
      "oauth",
    );

    if (input.enabled) {
      const activeConnections = configuration.businessConnections.filter(
        (connection) => connection.status === "active",
      );
      const connectionsById = new Map(
        configuration.businessConnections.map((connection) => [
          connection.id,
          connection,
        ]),
      );
      const destinationsById = new Map(
        configuration.destinations.flatMap((destination) =>
          destination.id ? [[destination.id, destination] as const] : [],
        ),
      );
      const invalidConnection = activeConnections.find((connection) => {
        const destination = connection.defaultConversionDestinationId
          ? destinationsById.get(connection.defaultConversionDestinationId)
          : null;

        return (
          connection.activeReportingAccountCount === 0 ||
          !destination ||
          destination.status !== "configured"
        );
      });
      const invalidAccount = configuration.reportingAccounts
        .filter((account) => account.active)
        .find((account) => {
          const connection = account.businessConnectionId
            ? connectionsById.get(account.businessConnectionId)
            : null;
          const destinationId =
            account.conversionDestinationId ??
            connection?.defaultConversionDestinationId;
          const destination = destinationId
            ? destinationsById.get(destinationId)
            : null;

          return (
            !connection ||
            connection.status !== "active" ||
            !destination ||
            destination.status !== "configured"
          );
        });

      if (configuration.unmappedActiveAccountCount > 0) {
        throw new ConflictException(
          `${configuration.unmappedActiveAccountCount} conta(s) ativa(s) ainda não possuem uma BM e um destino. Vincule ou desative essas contas antes de ativar`,
        );
      }

      if (invalidAccount) {
        throw new ConflictException(
          "Todas as contas ativas precisam pertencer a uma BM ativa e ter um destino validado",
        );
      }

      if (activeConnections.length === 0) {
        throw new ConflictException(
          "Configure ao menos uma BM com contas e destino antes de ativar o roteamento avançado",
        );
      }

      if (invalidConnection) {
        throw new ConflictException(
          "Todas as BMs ativas precisam ter contas e um destino validado",
        );
      }
    }

    await this.prisma.metaIntegration.updateMany({
      where: { workspaceId, status: "connected" },
      data: { advancedRoutingEnabled: input.enabled },
    });
    await this.recordAudit({
      workspaceId,
      actorUserId: actorUserId ?? null,
      action: "meta.oauth.advanced_routing_updated",
      targetType: "MetaIntegration",
      targetId: workspaceId,
      resultStatus: "success",
      afterSummary: {
        advancedRoutingEnabled: input.enabled,
        businessConnectionCount: configuration.businessConnections.length,
        mappedAccountCount: configuration.reportingAccounts.filter(
          (account) => account.active,
        ).length,
      },
    });

    return this.listConfigurationForSource(workspaceId, "oauth");
  }

  private async validateDestinationInput(input: {
    workspaceId: string;
    accessToken: string;
    businessId: string;
    input: MetaManualBusinessConnectionInputDto["destination"];
  }): Promise<
    | { existing: true; record: DestinationRecord }
    | {
        existing: false;
        pixel: MetaPixelAssetDto;
        page: MetaPageAssetDto;
      }
  > {
    if (input.input.existingDestinationId) {
      const record = (await this.prisma.metaConversionDestination.findFirst({
        where: {
          id: input.input.existingDestinationId,
          workspaceId: input.workspaceId,
        },
      })) as DestinationRecord | null;

      if (!record) {
        throw new NotFoundException("Destino Meta não encontrado");
      }

      await this.validateDestinationAccess(input.accessToken, record);
      return { existing: true, record };
    }

    const [pixel, page] = await Promise.all([
      this.adapter.getPixel({
        accessToken: input.accessToken,
        pixelId: input.input.pixelId ?? "",
        businessId: input.businessId,
      }),
      this.adapter.getPage({
        accessToken: input.accessToken,
        pageId: input.input.pageId ?? "",
        businessId: input.businessId,
      }),
    ]);

    return { existing: false, pixel, page };
  }

  private async validateDestinationAccess(
    accessToken: string,
    destination: {
      pixelId: string;
      pageId: string;
      ownerBusinessManagerId?: string | null;
    },
  ): Promise<void> {
    await Promise.all([
      this.adapter.getPixel({
        accessToken,
        pixelId: destination.pixelId,
        businessId: destination.ownerBusinessManagerId ?? null,
      }),
      this.adapter.getPage({
        accessToken,
        pageId: destination.pageId,
        businessId: destination.ownerBusinessManagerId ?? null,
      }),
    ]);
  }

  private async getManualCredential(
    workspaceId: string,
    credentialId: string,
  ): Promise<CredentialRecord> {
    return this.getCredential(workspaceId, credentialId, "manual");
  }

  private async getCredential(
    workspaceId: string,
    credentialId: string,
    source: NormalizedConnectionSource,
  ): Promise<CredentialRecord> {
    const credential = (await this.prisma.metaCredential.findFirst({
      where: { id: credentialId, workspaceId, source },
    })) as CredentialRecord | null;

    if (!credential) {
      throw new NotFoundException("Credencial Meta não encontrada");
    }

    if (
      credential.status === "revoked" ||
      credential.status === "paused" ||
      credential.status === "expired"
    ) {
      throw new ConflictException(
        "Esta credencial precisa ser validada antes de ser utilizada",
      );
    }

    return credential;
  }

  private decryptCredential(credential: CredentialRecord): string {
    try {
      return this.encryption.decrypt({
        encryptedAccessToken: credential.encryptedAccessToken,
        tokenIv: credential.tokenIv,
        tokenTag: credential.tokenTag,
      });
    } catch {
      throw new ConflictException(
        "Não foi possível abrir a credencial Meta armazenada",
      );
    }
  }

  private async assertLegacyPathAbsent(workspaceId: string): Promise<void> {
    const legacy = await this.prisma.metaIntegration.findUnique({
      where: { workspaceId },
      select: { id: true },
    });

    if (legacy) {
      throw new ConflictException(
        "Este workspace já usa a conexão OAuth legada. A configuração manual exige uma migração separada e aprovada",
      );
    }
  }

  private async assertOAuthPathPresent(workspaceId: string): Promise<void> {
    const integration = await this.prisma.metaIntegration.findUnique({
      where: { workspaceId },
      select: { status: true },
    });

    if (integration?.status !== "connected") {
      throw new ConflictException(
        "Conecte a conta Meta pelo login social antes de configurar destinos por BM",
      );
    }
  }

  private decryptStoredToken(input: {
    encryptedAccessToken: string;
    tokenIv: string;
    tokenTag: string;
  }): string {
    try {
      return this.encryption.decrypt({
        encryptedAccessToken: input.encryptedAccessToken,
        tokenIv: input.tokenIv,
        tokenTag: input.tokenTag,
      });
    } catch {
      throw new ConflictException(
        "Não foi possível abrir a credencial do login social",
      );
    }
  }

  private assertRequiredScopes(scopes: string[]): void {
    if (scopes.length === 0) {
      return;
    }

    const granted = new Set(scopes.map((scope) => scope.toLowerCase()));
    const canReadAds = granted.has("ads_read") || granted.has("ads_management");

    if (!granted.has("business_management") || !canReadAds) {
      throw new BadRequestException(
        "O token precisa de business_management e ads_read ou ads_management",
      );
    }
  }

  private requireManualEnabled(): void {
    if (!this.getCapabilities().manualEnabled) {
      throw new NotFoundException("Conexão manual Meta não habilitada");
    }
  }

  private requireOAuthEnabled(): void {
    if (!this.getCapabilities().oauthEnabled) {
      throw new NotFoundException("Login social Meta não habilitado");
    }
  }

  private requireSourceEnabled(source: NormalizedConnectionSource): void {
    if (source === "manual") {
      this.requireManualEnabled();
      return;
    }

    this.requireOAuthEnabled();
  }

  private toCredentialDto(record: CredentialRecord): MetaManualCredentialDto {
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      source: record.source,
      label: record.label,
      fingerprint: record.fingerprint.slice(0, 12),
      tokenLast4: record.tokenLast4,
      tokenType: record.tokenType,
      scopes: record.scopes,
      expiresAt: record.expiresAt?.toISOString() ?? null,
      status: record.status,
      lastValidatedAt: record.lastValidatedAt?.toISOString() ?? null,
      validationError: record.validationError,
      rotatedAt: record.rotatedAt?.toISOString() ?? null,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  private toBusinessConnectionDto(
    record: BusinessConnectionRecord,
  ): MetaManualBusinessConnectionDto {
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      credentialId: record.credentialId,
      businessManagerId: record.businessManagerId,
      businessManagerName: record.businessManagerName,
      status: record.status,
      defaultConversionDestinationId:
        record.defaultConversionDestinationId ?? null,
      reportingAccountCount:
        record._count?.reportingAccounts ??
        record.reportingAccounts?.length ??
        0,
      activeReportingAccountCount:
        record.reportingAccounts?.filter((account) => account.active).length ??
        0,
      lastValidatedAt: record.lastValidatedAt?.toISOString() ?? null,
      validationError: record.validationError,
      lastSyncedAt: record.lastSyncedAt?.toISOString() ?? null,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  private toDestinationDto(record: DestinationRecord) {
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      label: record.label,
      pixelId: record.pixelId,
      pixelName: record.pixelName,
      pageId: record.pageId,
      pageName: record.pageName,
      ownerBusinessManagerId: record.ownerBusinessManagerId,
      status: record.status,
      lastValidatedAt: record.lastValidatedAt?.toISOString() ?? null,
      validationError: record.validationError,
    };
  }

  private toReportingAccountDto(record: ReportingAccountRecord) {
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      businessId: record.businessId,
      businessName: record.businessName,
      adAccountId: record.adAccountId,
      adAccountName: record.adAccountName,
      currency: record.currency,
      timezoneName: record.timezoneName,
      businessConnectionId: record.businessConnectionId,
      conversionDestinationId: record.conversionDestinationId,
      conversionDestinationIds:
        record.allowedDestinations
          ?.filter((destination) => destination.active)
          .map((destination) => destination.conversionDestinationId) ?? [],
      active: record.active,
      syncStatus: record.syncStatus,
      lastSyncedAt: record.lastSyncedAt?.toISOString() ?? null,
      lastSyncSince: record.lastSyncSince,
      lastSyncUntil: record.lastSyncUntil,
      syncError: record.syncError,
    };
  }

  private async recordAudit(input: {
    workspaceId: string;
    actorUserId: string | null;
    action: string;
    targetType: string;
    targetId: string;
    resultStatus: string;
    beforeSummary?: Record<string, unknown>;
    afterSummary: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          actorType: input.actorUserId ? "user" : "system",
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId,
          reason: null,
          sourceIp: null,
          resultStatus: input.resultStatus,
          beforeSummary: input.beforeSummary
            ? (input.beforeSummary as Prisma.InputJsonValue)
            : undefined,
          afterSummary: input.afterSummary as Prisma.InputJsonValue,
        },
      });
    } catch {
      return;
    }
  }

  private publicBadRequest(error: unknown, fallback: string): Error {
    if (
      error instanceof BadRequestException ||
      error instanceof ConflictException ||
      error instanceof NotFoundException
    ) {
      return error;
    }

    const raw = error instanceof Error ? error.message : fallback;
    const redacted = raw
      .replace(/access_token=[^&\s]+/gi, "access_token=[redacted]")
      .replace(/EAA[A-Za-z0-9_-]{12,}/g, "[redacted-token]")
      .slice(0, 400);

    return new BadRequestException(redacted || fallback);
  }
}
