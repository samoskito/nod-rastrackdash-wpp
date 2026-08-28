import { z } from "zod";
import { integrationStatuses } from "../statuses";

// "uazapi_byo" is the WhatsappProviderRegistry id for the BYO Uazapi
// adapter (F5.2) — the health summary now reports it instead of the
// legacy "uazapi" value so FE can distinguish WhatsApp provider health
// from other "uazapi"-labelled fields (webhook source, lead source, etc,
// which use unrelated schemas and are untouched by this enum).
// "nod_api" (F5.3b) is the WhatsappProviderRegistry id for the managed
// PalmUP broker adapter — added so the health summary can report its
// status alongside uazapi_byo. "waha" (F5.4) is the WhatsappProviderRegistry
// id for the BYO self-hosted WAHA adapter. "zapi" (F5.5) is the
// WhatsappProviderRegistry id for the BYO Z-API adapter.
export const integrationProviderSchema = z.enum([
  "meta",
  "uazapi",
  "uazapi_byo",
  "nod_api",
  "waha",
  "zapi",
]);

export const whatsappConnectionProviderSchema = z.enum([
  "uazapi_byo",
  "waha",
  "zapi",
  "nod_api",
]);

export const whatsappConnectionStatusSchema = z.enum([
  "pending_payment",
  "active",
  "disconnected",
  "suspended",
  "error",
]);

export const whatsappConnectionsSchema = z.array(
  z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      displayName: z.string().min(1).nullable(),
      provider: whatsappConnectionProviderSchema,
      status: whatsappConnectionStatusSchema,
      lastHealthStatus: z.string().min(1).nullable(),
      lastHealthCheckedAt: z.string().datetime().nullable(),
      connectedPhone: z.string().min(1).nullable().optional(),
      createdAt: z.string().datetime(),
    })
    .strict(),
);

const httpUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "A URL deve usar http ou https");

const whatsappConnectionMetadataSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    displayName: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

const uazapiCredentialsSchema = z
  .object({
    baseUrl: httpUrlSchema,
    token: z.string().trim().min(1).max(4096),
    instanceId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const wahaCredentialsSchema = z
  .object({
    baseUrl: httpUrlSchema,
    apiKey: z.string().trim().min(1).max(4096),
    session: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const zapiCredentialsSchema = z
  .object({
    baseUrl: httpUrlSchema,
    instanceId: z.string().trim().min(1).max(200),
    token: z.string().trim().min(1).max(4096),
  })
  .strict();

const nodApiCredentialsSchema = z
  .object({
    instanceId: z.string().trim().min(1).max(200),
    instanceToken: z.string().trim().min(1).max(4096),
  })
  .strict();

export const whatsappConnectionCreateInputSchema = z.discriminatedUnion(
  "provider",
  [
    whatsappConnectionMetadataSchema.extend({
      provider: z.literal("uazapi_byo"),
      credentials: uazapiCredentialsSchema,
    }),
    whatsappConnectionMetadataSchema.extend({
      provider: z.literal("waha"),
      credentials: wahaCredentialsSchema,
    }),
    whatsappConnectionMetadataSchema.extend({
      provider: z.literal("zapi"),
      credentials: zapiCredentialsSchema,
    }),
    whatsappConnectionMetadataSchema.extend({
      provider: z.literal("nod_api"),
      credentials: nodApiCredentialsSchema,
    }),
  ],
);

export const whatsappConnectionUpdateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    displayName: z.string().trim().min(1).max(120).nullable().optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "Informe ao menos um campo para atualizar",
  );

export const whatsappConnectionCredentialsUpdateSchema = z.discriminatedUnion(
  "provider",
  [
    z
      .object({
        provider: z.literal("uazapi_byo"),
        credentials: uazapiCredentialsSchema,
      })
      .strict(),
    z
      .object({
        provider: z.literal("waha"),
        credentials: wahaCredentialsSchema,
      })
      .strict(),
    z
      .object({
        provider: z.literal("zapi"),
        credentials: zapiCredentialsSchema,
      })
      .strict(),
    z
      .object({
        provider: z.literal("nod_api"),
        credentials: nodApiCredentialsSchema,
      })
      .strict(),
  ],
);

export const whatsappConnectionTestResultSchema = z
  .object({
    connectionId: z.string().min(1),
    provider: whatsappConnectionProviderSchema,
    status: z.string().min(1),
    checkedAt: z.string().datetime(),
    message: z.string().min(1).optional(),
  })
  .strict();

export const whatsappConnectionWebhookTokenRotateResultSchema = z
  .object({
    connection: whatsappConnectionsSchema.element,
    webhookEndpoint: httpUrlSchema,
    webhookToken: z.string().min(43).max(512),
  })
  .strict();

export const integrationHealthSchema = z.object({
  provider: integrationProviderSchema,
  status: z.enum(integrationStatuses),
  checkedAt: z.string().datetime(),
  message: z.string().optional(),
});

export const integrationHealthSummarySchema = z.object({
  checkedAt: z.string().datetime(),
  providers: z.array(integrationHealthSchema),
});

export const integrationStartActionSchema = z.object({
  provider: integrationProviderSchema,
  action: z.enum([
    "configure_env",
    "oauth_redirect",
    "open_checkout",
    "wait_webhook",
  ]),
  label: z.string().min(1),
  href: z.string().min(1).optional(),
  missingEnv: z.array(z.string()).default([]),
});

export const integrationPipelineStageSchema = z.object({
  key: z.enum(["ctwa", "webhook", "lead", "conversion_ready", "meta_sent"]),
  label: z.string().min(1),
  value: z.number().int().nonnegative(),
  detail: z.string().min(1),
});

export const whatsappDataSourceSchema = z.object({
  mode: z.enum(["native", "external"]),
  connectorName: z.string().min(1).nullable(),
  provider: z.string().min(1).nullable(),
  lastSyncCompletedAt: z.string().datetime().nullable(),
  lastSyncStatus: z.string().min(1).nullable(),
});

export const integrationPipelineOverviewSchema = z.object({
  workspaceId: z.string().min(1),
  rangeLabel: z.string().min(1),
  stages: z.array(integrationPipelineStageSchema),
  whatsappSource: whatsappDataSourceSchema.optional(),
});

export const metaOAuthCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

export const metaConnectionStatusSchema = z.enum([
  "not_connected",
  "connected",
  "needs_reconnect",
  "error",
]);

export const metaConnectionModeSchema = z.enum(["oauth", "manual"]);

export const metaConnectionCapabilitiesSchema = z.object({
  enabledModes: z.array(metaConnectionModeSchema),
  oauthEnabled: z.boolean(),
  manualEnabled: z.boolean(),
});

export const META_OAUTH_DISCONNECT_CONFIRMATION = "DESCONECTAR META";

export const metaOAuthDisconnectInputSchema = z.object({
  expectedWorkspaceId: z.string().trim().min(1),
  confirmation: z.literal(META_OAUTH_DISCONNECT_CONFIRMATION),
});

export const metaOAuthDisconnectResultSchema = z.object({
  workspaceId: z.string().min(1),
  status: z.literal("not_connected"),
  disconnectedAt: z.string().datetime(),
  preserved: z.object({
    assetSnapshots: z.number().int().nonnegative(),
    reportingAccounts: z.number().int().nonnegative(),
    conversionDestinations: z.number().int().nonnegative(),
  }),
});

export const metaConnectionSchema = z.object({
  workspaceId: z.string().min(1),
  status: metaConnectionStatusSchema,
  tokenType: z.string().min(1).nullable(),
  scopes: z.array(z.string()),
  expiresAt: z.string().datetime().nullable(),
  connectedAt: z.string().datetime().nullable(),
  selectedBusinessId: z.string().min(1).nullable(),
  selectedAdAccountId: z.string().min(1).nullable(),
  selectedPixelId: z.string().min(1).nullable(),
  capiTokenConfigured: z.boolean().default(false),
});

export const metaCapiTokenInputSchema = z
  .object({
    accessToken: z.string().trim().min(10).optional(),
    clear: z.boolean().optional().default(false),
  })
  .refine(
    (value) => value.clear || Boolean(value.accessToken),
    "Informe um token CAPI ou solicite limpar a configuracao",
  );

export const metaCapiTokenStatusSchema = z.object({
  workspaceId: z.string().min(1),
  configured: z.boolean(),
  updatedAt: z.string().datetime(),
});

export const metaBusinessAssetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  verificationStatus: z.string().min(1).nullable(),
});

export const metaAdAccountAssetSchema = z.object({
  id: z.string().min(1),
  businessId: z.string().min(1).nullable(),
  name: z.string().min(1),
  accountStatus: z.string().min(1).nullable(),
  currency: z.string().min(1).nullable(),
  timezoneName: z.string().min(1).nullable(),
});

export const metaPixelAssetSchema = z.object({
  id: z.string().min(1),
  businessId: z.string().min(1).nullable(),
  name: z.string().min(1),
  code: z.string().min(1).nullable(),
});

export const metaPageAssetSchema = z.object({
  id: z.string().min(1),
  businessId: z.string().min(1).nullable(),
  name: z.string().min(1),
});

export const metaConversionDestinationStatusSchema = z.enum([
  "needs_configuration",
  "configured",
  "error",
]);

export const metaConversionDestinationSchema = z.object({
  id: z.string().min(1).nullable().optional(),
  workspaceId: z.string().min(1),
  label: z.string().min(1).nullable().optional(),
  pixelId: z.string().min(1).nullable(),
  pixelName: z.string().min(1).nullable(),
  pageId: z.string().min(1).nullable(),
  pageName: z.string().min(1).nullable(),
  ownerBusinessManagerId: z.string().min(1).nullable().optional(),
  status: metaConversionDestinationStatusSchema,
  lastValidatedAt: z.string().datetime().nullable(),
  validationError: z.string().min(1).nullable(),
});

export const metaConversionDestinationInputSchema = z.object({
  pixelId: z.string().trim().min(1),
  pixelName: z.string().trim().min(1),
  pageId: z.string().trim().min(1),
  pageName: z.string().trim().min(1),
});

export const metaAssetSyncStatusSchema = z.enum([
  "pending",
  "syncing",
  "synced",
  "error",
]);

export const metaReportingAccountSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  businessId: z.string().min(1),
  businessName: z.string().min(1),
  adAccountId: z.string().min(1),
  adAccountName: z.string().min(1),
  currency: z.string().min(1).nullable(),
  timezoneName: z.string().min(1).nullable(),
  businessConnectionId: z.string().min(1).nullable().optional(),
  conversionDestinationId: z.string().min(1).nullable().optional(),
  conversionDestinationIds: z.array(z.string().min(1)).default([]),
  active: z.boolean(),
  syncStatus: metaAssetSyncStatusSchema,
  lastSyncedAt: z.string().datetime().nullable(),
  lastSyncSince: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  lastSyncUntil: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  syncError: z.string().min(1).nullable(),
});

export const metaReportingAccountInputSchema = z.object({
  businessId: z.string().trim().min(1),
  businessName: z.string().trim().min(1),
  adAccountId: z.string().trim().min(1),
  adAccountName: z.string().trim().min(1),
  currency: z.string().trim().min(1).nullable().optional(),
  timezoneName: z.string().trim().min(1).nullable().optional(),
});

export const metaReportingAccountStatusInputSchema = z.object({
  active: z.boolean(),
});

export const metaAssetSelectionSchema = z.object({
  businessId: z.string().min(1).nullable(),
  adAccountId: z.string().min(1).nullable(),
  pixelId: z.string().min(1).nullable(),
});

export const metaAssetsSchema = z.object({
  workspaceId: z.string().min(1),
  status: metaConnectionStatusSchema,
  businesses: z.array(metaBusinessAssetSchema),
  adAccounts: z.array(metaAdAccountAssetSchema),
  pixels: z.array(metaPixelAssetSchema),
  pages: z.array(metaPageAssetSchema).optional(),
  conversionDestination: metaConversionDestinationSchema.nullable().optional(),
  reportingAccounts: z.array(metaReportingAccountSchema).optional(),
  selection: metaAssetSelectionSchema,
  lastSyncedAt: z.string().datetime().nullable(),
  syncError: z.string().min(1).nullable(),
});

export const metaAssetSelectionInputSchema = metaAssetSelectionSchema.refine(
  (value) => Boolean(value.businessId || value.adAccountId || value.pixelId),
  "Informe ao menos um ativo Meta",
);

export const metaOAuthCallbackResultSchema = z.object({
  provider: z.literal("meta"),
  status: z.enum(["configure_env", "connected", "exchange_failed"]),
  tokenType: z.string().min(1).nullable().default(null),
  expiresInSeconds: z.number().int().positive().nullable().default(null),
  scopes: z.array(z.string()).default([]),
  missingEnv: z.array(z.string()).default([]),
  connection: metaConnectionSchema.optional(),
  message: z.string().min(1).optional(),
});

export const metaCredentialSourceSchema = z.enum(["oauth", "manual"]);

export const metaCredentialStatusSchema = z.enum([
  "pending",
  "active",
  "validation_required",
  "expired",
  "revoked",
  "error",
  "paused",
]);

export const metaManualCredentialSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  source: metaCredentialSourceSchema,
  label: z.string().min(1),
  fingerprint: z.string().min(8),
  tokenLast4: z.string().min(1).max(8),
  tokenType: z.string().min(1).nullable(),
  scopes: z.array(z.string()),
  expiresAt: z.string().datetime().nullable(),
  status: metaCredentialStatusSchema,
  lastValidatedAt: z.string().datetime().nullable(),
  validationError: z.string().min(1).nullable(),
  rotatedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const metaBusinessConnectionStatusSchema = z.enum([
  "pending",
  "active",
  "validation_required",
  "token_expired",
  "missing_permission",
  "destination_invalid",
  "error",
  "paused",
]);

export const metaManualBusinessConnectionSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  credentialId: z.string().min(1),
  businessManagerId: z.string().min(1),
  businessManagerName: z.string().min(1),
  status: metaBusinessConnectionStatusSchema,
  defaultConversionDestinationId: z.string().min(1).nullable(),
  reportingAccountCount: z.number().int().nonnegative().default(0),
  activeReportingAccountCount: z.number().int().nonnegative().default(0),
  lastValidatedAt: z.string().datetime().nullable(),
  validationError: z.string().min(1).nullable(),
  lastSyncedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const metaManualCredentialInputSchema = z.object({
  label: z.string().trim().min(2).max(80),
  accessToken: z.string().trim().min(20).max(4096),
});

export const metaManualCredentialRotationInputSchema = z.object({
  accessToken: z.string().trim().min(20).max(4096),
});

export const metaManualAssetDiscoverySchema = z.object({
  credential: metaManualCredentialSchema,
  businesses: z.array(metaBusinessAssetSchema),
  selectedBusinessId: z.string().min(1).nullable(),
  adAccounts: z.array(metaAdAccountAssetSchema),
  pixels: z.array(metaPixelAssetSchema),
  pages: z.array(metaPageAssetSchema),
});

export const metaManualDestinationInputSchema = z
  .object({
    existingDestinationId: z.string().trim().min(1).optional(),
    label: z.string().trim().min(2).max(80).optional(),
    ownerBusinessManagerId: z.string().trim().min(1).nullable().optional(),
    pixelId: z.string().trim().min(1).optional(),
    pageId: z.string().trim().min(1).optional(),
  })
  .superRefine((value, context) => {
    const hasExisting = Boolean(value.existingDestinationId);
    const hasNew = Boolean(value.pixelId && value.pageId);

    if (hasExisting === hasNew) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Escolha um destino existente ou informe Pixel e Pagina",
      });
    }
  });

export const metaManualBusinessConnectionInputSchema = z.object({
  credentialId: z.string().trim().min(1),
  businessManagerId: z.string().trim().min(1),
  businessManagerName: z.string().trim().min(1).max(160),
  adAccountIds: z.array(z.string().trim().min(1)).min(1).max(200),
  accountSelectionMode: z.enum(["merge", "replace"]).optional(),
  destination: metaManualDestinationInputSchema,
});

export const metaManualBusinessConnectionStatusInputSchema = z.object({
  status: z.enum(["active", "paused"]),
});

export const metaManualBusinessConnectionRemovalInputSchema = z.object({
  businessManagerId: z.string().trim().min(1),
});

export const metaManualConnectionTestResultSchema = z.object({
  connectionId: z.string().min(1),
  credentialId: z.string().min(1),
  destinationId: z.string().min(1),
  reportingAccountCount: z.number().int().nonnegative(),
  status: z.literal("active"),
  validatedAt: z.string().datetime(),
  message: z.string().min(1),
});

export const metaManualAccountDestinationInputSchema = z
  .object({
    conversionDestinationId: z.string().trim().min(1).nullable(),
    conversionDestinationIds: z
      .array(z.string().trim().min(1))
      .max(50)
      .default([]),
  })
  .superRefine((value, context) => {
    if (
      value.conversionDestinationId &&
      !value.conversionDestinationIds.includes(value.conversionDestinationId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "O destino padrao precisa estar entre os destinos autorizados",
        path: ["conversionDestinationId"],
      });
    }
  });

export const metaAdDestinationAssignmentSourceSchema = z.enum([
  "automatic",
  "manual",
]);

export const metaAdDestinationRouteStatusSchema = z.enum([
  "assigned",
  "unresolved",
  "ambiguous",
]);

export const metaAdDestinationRouteSchema = z.object({
  adId: z.string().min(1),
  adName: z.string().min(1),
  status: z.string().min(1).nullable(),
  effectiveStatus: z.string().min(1).nullable(),
  routeStatus: metaAdDestinationRouteStatusSchema,
  conversionDestinationId: z.string().min(1).nullable(),
  assignmentSource: metaAdDestinationAssignmentSourceSchema.nullable(),
  detectedPixelId: z.string().min(1).nullable(),
  detectedPageId: z.string().min(1).nullable(),
  candidateDestinationIds: z.array(z.string().min(1)),
  updatedAt: z.string().datetime().nullable(),
});

export const metaReportingAccountAdRoutingSchema = z.object({
  reportingAccountId: z.string().min(1),
  adAccountId: z.string().min(1),
  adAccountName: z.string().min(1),
  conversionDestinationId: z.string().min(1).nullable(),
  conversionDestinationIds: z.array(z.string().min(1)),
  ads: z.array(metaAdDestinationRouteSchema),
});

export const metaAdDestinationInputSchema = z.object({
  conversionDestinationId: z.string().trim().min(1).nullable(),
});

export const metaOAuthAdvancedRoutingInputSchema = z.object({
  enabled: z.boolean(),
});

export const metaManualConfigurationSchema = z.object({
  workspaceId: z.string().min(1),
  connectionMode: z.enum(["manual", "oauth"]),
  advancedRoutingEnabled: z.boolean(),
  unmappedActiveAccountCount: z.number().int().nonnegative(),
  credentials: z.array(metaManualCredentialSchema),
  businessConnections: z.array(metaManualBusinessConnectionSchema),
  destinations: z.array(metaConversionDestinationSchema),
  reportingAccounts: z.array(metaReportingAccountSchema),
});

export type IntegrationProvider = z.infer<typeof integrationProviderSchema>;
export type WhatsappConnectionDto = z.infer<
  typeof whatsappConnectionsSchema
>[number];
export type WhatsappConnectionsDto = z.infer<typeof whatsappConnectionsSchema>;
export type WhatsappConnectionCreateInputDto = z.infer<
  typeof whatsappConnectionCreateInputSchema
>;
export type WhatsappConnectionUpdateInputDto = z.infer<
  typeof whatsappConnectionUpdateInputSchema
>;
export type WhatsappConnectionCredentialsUpdateDto = z.infer<
  typeof whatsappConnectionCredentialsUpdateSchema
>;
export type WhatsappConnectionTestResultDto = z.infer<
  typeof whatsappConnectionTestResultSchema
>;
export type WhatsappConnectionWebhookTokenRotateResultDto = z.infer<
  typeof whatsappConnectionWebhookTokenRotateResultSchema
>;
export type IntegrationHealthDto = z.infer<typeof integrationHealthSchema>;
export type IntegrationHealthSummaryDto = z.infer<
  typeof integrationHealthSummarySchema
>;
export type IntegrationStartActionDto = z.infer<
  typeof integrationStartActionSchema
>;
export type IntegrationPipelineStageDto = z.infer<
  typeof integrationPipelineStageSchema
>;
export type IntegrationPipelineOverviewDto = z.infer<
  typeof integrationPipelineOverviewSchema
>;
export type WhatsappDataSourceDto = z.infer<typeof whatsappDataSourceSchema>;
export type MetaOAuthCallbackQueryDto = z.infer<
  typeof metaOAuthCallbackQuerySchema
>;
export type MetaOAuthCallbackResultDto = z.infer<
  typeof metaOAuthCallbackResultSchema
>;
export type MetaOAuthDisconnectInputDto = z.infer<
  typeof metaOAuthDisconnectInputSchema
>;
export type MetaOAuthDisconnectResultDto = z.infer<
  typeof metaOAuthDisconnectResultSchema
>;
export type MetaConnectionStatusDto = z.infer<
  typeof metaConnectionStatusSchema
>;
export type MetaConnectionDto = z.infer<typeof metaConnectionSchema>;
export type MetaConnectionModeDto = z.infer<typeof metaConnectionModeSchema>;
export type MetaConnectionCapabilitiesDto = z.infer<
  typeof metaConnectionCapabilitiesSchema
>;
export type MetaCapiTokenInputDto = z.infer<typeof metaCapiTokenInputSchema>;
export type MetaCapiTokenStatusDto = z.infer<typeof metaCapiTokenStatusSchema>;
export type MetaBusinessAssetDto = z.infer<typeof metaBusinessAssetSchema>;
export type MetaAdAccountAssetDto = z.infer<typeof metaAdAccountAssetSchema>;
export type MetaPixelAssetDto = z.infer<typeof metaPixelAssetSchema>;
export type MetaPageAssetDto = z.infer<typeof metaPageAssetSchema>;
export type MetaConversionDestinationStatusDto = z.infer<
  typeof metaConversionDestinationStatusSchema
>;
export type MetaConversionDestinationDto = z.infer<
  typeof metaConversionDestinationSchema
>;
export type MetaConversionDestinationInputDto = z.infer<
  typeof metaConversionDestinationInputSchema
>;
export type MetaAssetSyncStatusDto = z.infer<typeof metaAssetSyncStatusSchema>;
export type MetaReportingAccountDto = z.infer<
  typeof metaReportingAccountSchema
>;
export type MetaReportingAccountInputDto = z.infer<
  typeof metaReportingAccountInputSchema
>;
export type MetaReportingAccountStatusInputDto = z.infer<
  typeof metaReportingAccountStatusInputSchema
>;
export type MetaAssetSelectionDto = z.infer<typeof metaAssetSelectionSchema>;
export type MetaAssetsDto = z.infer<typeof metaAssetsSchema>;
export type MetaAssetSelectionInputDto = z.infer<
  typeof metaAssetSelectionInputSchema
>;
export type MetaCredentialSourceDto = z.infer<
  typeof metaCredentialSourceSchema
>;
export type MetaCredentialStatusDto = z.infer<
  typeof metaCredentialStatusSchema
>;
export type MetaManualCredentialDto = z.infer<
  typeof metaManualCredentialSchema
>;
export type MetaBusinessConnectionStatusDto = z.infer<
  typeof metaBusinessConnectionStatusSchema
>;
export type MetaManualBusinessConnectionDto = z.infer<
  typeof metaManualBusinessConnectionSchema
>;
export type MetaManualCredentialInputDto = z.infer<
  typeof metaManualCredentialInputSchema
>;
export type MetaManualCredentialRotationInputDto = z.infer<
  typeof metaManualCredentialRotationInputSchema
>;
export type MetaManualAssetDiscoveryDto = z.infer<
  typeof metaManualAssetDiscoverySchema
>;
export type MetaManualDestinationInputDto = z.infer<
  typeof metaManualDestinationInputSchema
>;
export type MetaManualBusinessConnectionInputDto = z.infer<
  typeof metaManualBusinessConnectionInputSchema
>;
export type MetaManualBusinessConnectionStatusInputDto = z.infer<
  typeof metaManualBusinessConnectionStatusInputSchema
>;
export type MetaManualBusinessConnectionRemovalInputDto = z.infer<
  typeof metaManualBusinessConnectionRemovalInputSchema
>;
export type MetaManualConnectionTestResultDto = z.infer<
  typeof metaManualConnectionTestResultSchema
>;
export type MetaManualAccountDestinationInputDto = z.infer<
  typeof metaManualAccountDestinationInputSchema
>;
export type MetaAdDestinationAssignmentSourceDto = z.infer<
  typeof metaAdDestinationAssignmentSourceSchema
>;
export type MetaAdDestinationRouteStatusDto = z.infer<
  typeof metaAdDestinationRouteStatusSchema
>;
export type MetaAdDestinationRouteDto = z.infer<
  typeof metaAdDestinationRouteSchema
>;
export type MetaReportingAccountAdRoutingDto = z.infer<
  typeof metaReportingAccountAdRoutingSchema
>;
export type MetaAdDestinationInputDto = z.infer<
  typeof metaAdDestinationInputSchema
>;
export type MetaOAuthAdvancedRoutingInputDto = z.infer<
  typeof metaOAuthAdvancedRoutingInputSchema
>;
export type MetaManualConfigurationDto = z.infer<
  typeof metaManualConfigurationSchema
>;

// WhatsApp instance conversation labels (UAZAPI). Not billing-related — kept
// here (rather than schemas/billing.ts) since it's used by the WhatsApp
// integration adapter/label picker regardless of billing edition.
export const whatsappLabelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  colorHex: z.string().min(1).nullable(),
  labelId: z.string().min(1).nullable(),
});

export const whatsappLabelListSchema = z.array(whatsappLabelSchema);

export type WhatsappLabelDto = z.infer<typeof whatsappLabelSchema>;
export type WhatsappLabelListDto = z.infer<typeof whatsappLabelListSchema>;
