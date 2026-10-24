import { z } from "zod";

export const externalConnectorProviders = ["kinbox_mysql"] as const;
export const externalConnectorStatuses = [
  "draft",
  "active",
  "disabled",
  "error",
] as const;
export const externalConnectorSslModes = [
  "disabled",
  "required",
  "verify_identity",
] as const;
export const externalSyncStreams = ["leads", "events"] as const;
export const canonicalTrackingEventTypes = [
  "conversation_started",
  "qualified_lead",
  "purchase",
] as const;
export const conversionValueSources = [
  "actual",
  "configured_average",
  "manual",
] as const;

export const externalConnectorProviderSchema = z.enum(
  externalConnectorProviders,
);
export const externalConnectorStatusSchema = z.enum(externalConnectorStatuses);
export const externalConnectorSslModeSchema = z.enum(externalConnectorSslModes);
export const externalSyncStreamSchema = z.enum(externalSyncStreams);
export const canonicalTrackingEventTypeSchema = z.enum(
  canonicalTrackingEventTypes,
);
export const conversionValueSourceSchema = z.enum(conversionValueSources);

const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .superRefine((value, ctx) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Timezone inválido",
      });
    }
  });

const currencySchema = z
  .string()
  .trim()
  .length(3)
  .transform((value) => value.toUpperCase());

export const externalMysqlCredentialsInputSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65_535).default(3306),
  database: z.string().trim().min(1).max(128),
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(1_024),
  sslCa: z.string().min(1).max(65_535).optional(),
});

export const externalDataConnectorCreateInputSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().trim().min(2).max(120),
  provider: externalConnectorProviderSchema.default("kinbox_mysql"),
  timezone: timezoneSchema.default("America/Sao_Paulo"),
  sslMode: externalConnectorSslModeSchema.default("required"),
  credentials: externalMysqlCredentialsInputSchema,
  syncEnabled: z.boolean().default(false),
  shadowMode: z.boolean().default(true),
  capiSendEnabled: z.boolean().default(false),
  purchaseAverageValueCents: z.number().int().positive().nullable().optional(),
  defaultCurrency: currencySchema.default("BRL"),
});

export const externalDataConnectorUpdateInputSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    status: externalConnectorStatusSchema.optional(),
    timezone: timezoneSchema.optional(),
    sslMode: externalConnectorSslModeSchema.optional(),
    credentials: externalMysqlCredentialsInputSchema.partial().optional(),
    syncEnabled: z.boolean().optional(),
    shadowMode: z.boolean().optional(),
    capiSendEnabled: z.boolean().optional(),
    purchaseAverageValueCents: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional(),
    defaultCurrency: currencySchema.optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    message: "Informe ao menos uma alteração",
  });

export const externalSyncCursorSchema = z.object({
  stream: externalSyncStreamSchema,
  lastExternalId: z.string().nullable(),
  lastUpdatedAt: z.string().datetime().nullable(),
  lastSyncedAt: z.string().datetime().nullable(),
});

export const externalCapiCutoverStatusSchema = z.enum([
  "active",
  "rolled_back",
]);

export const externalCapiCutoverSchema = z.object({
  id: z.string().min(1),
  eventType: canonicalTrackingEventTypeSchema,
  status: externalCapiCutoverStatusSchema,
  activatedAt: z.string().datetime(),
  shadowArchivedRows: z.number().int().nonnegative(),
  rolledBackAt: z.string().datetime().nullable(),
});

export const externalDataConnectorSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  provider: externalConnectorProviderSchema,
  status: externalConnectorStatusSchema,
  timezone: z.string().min(1),
  sslMode: externalConnectorSslModeSchema,
  syncEnabled: z.boolean(),
  shadowMode: z.boolean(),
  capiSendEnabled: z.boolean(),
  capiCutovers: z.array(externalCapiCutoverSchema),
  purchaseAverageValueCents: z.number().int().positive().nullable(),
  defaultCurrency: z.string().length(3).nullable(),
  hasCredentials: z.literal(true),
  lastConnectionTestAt: z.string().datetime().nullable(),
  lastConnectionStatus: z.string().nullable(),
  lastSyncStartedAt: z.string().datetime().nullable(),
  lastSyncCompletedAt: z.string().datetime().nullable(),
  lastSyncStatus: z.string().nullable(),
  lastSyncErrorCode: z.string().nullable(),
  cursors: z.array(externalSyncCursorSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const externalConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  status: z.enum(["connected", "failed"]),
  latencyMs: z.number().int().nonnegative(),
  leadsViewAvailable: z.boolean(),
  eventsViewAvailable: z.boolean(),
  errorCode: z.string().nullable(),
  message: z.string().min(1),
});

export const externalSyncInputSchema = z.object({
  streams: z
    .array(externalSyncStreamSchema)
    .min(1)
    .default(["leads", "events"]),
});

export const externalSyncQueuedResultSchema = z.object({
  connectorId: z.string().min(1),
  streams: z.array(externalSyncStreamSchema).min(1),
  jobId: z.string().min(1),
  status: z.literal("queued"),
});

export const externalCapiCutoverActivateInputSchema = z.object({
  eventType: canonicalTrackingEventTypeSchema,
  confirmation: z.literal("ASSUMIR ENVIO"),
  expectedOperationalRows: z.number().int().nonnegative(),
});

export const externalCapiCutoverRollbackInputSchema = z.object({
  eventType: canonicalTrackingEventTypeSchema,
  confirmation: z.literal("REVERTER CAPI"),
});

export const externalCapiCutoverResultSchema = z.object({
  connectorId: z.string().min(1),
  cutover: externalCapiCutoverSchema,
  syncJobId: z.string().nullable(),
});

export const externalReconciliationStateSchema = z.enum([
  "collecting",
  "blocked",
  "ready",
  "partial",
  "live",
]);

export const externalReconciliationBlockerSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

export const externalEventReconciliationSchema = z.object({
  eventType: canonicalTrackingEventTypeSchema,
  sourceRows: z.number().int().nonnegative(),
  acceptedRows: z.number().int().nonnegative(),
  operationalRows: z.number().int().nonnegative(),
  historicalRows: z.number().int().nonnegative(),
  expectedMatchedRows: z.number().int().nonnegative(),
  matchedRows: z.number().int().nonnegative(),
  duplicateDeliveries: z.number().int().nonnegative(),
  rejectedRows: z.number().int().nonnegative(),
  quarantinedRows: z.number().int().nonnegative(),
  blockingRejectedRows: z.number().int().nonnegative(),
  pendingRows: z.number().int().nonnegative(),
  readyToSendRows: z.number().int().nonnegative(),
  sentRows: z.number().int().nonnegative(),
  importedRows: z.number().int().nonnegative(),
  notEligibleRows: z.number().int().nonnegative(),
  shadowObservedRows: z.number().int().nonnegative(),
  blockedDeliveryRows: z.number().int().nonnegative(),
  capiActive: z.boolean(),
  readyForCutover: z.boolean(),
  cutoverAt: z.string().datetime().nullable(),
  firstOccurredAt: z.string().datetime().nullable(),
  lastOccurredAt: z.string().datetime().nullable(),
});

export const externalConnectorReconciliationSchema = z.object({
  connectorId: z.string().min(1),
  workspaceId: z.string().min(1),
  generatedAt: z.string().datetime(),
  state: externalReconciliationStateSchema,
  readyForCutover: z.boolean(),
  meta: z.object({
    connectionConfigured: z.boolean(),
    destinationConfigured: z.boolean(),
    pixelId: z.string().nullable(),
    pageId: z.string().nullable(),
  }),
  events: z.array(externalEventReconciliationSchema).length(3),
  blockers: z.array(externalReconciliationBlockerSchema),
});

export const externalConnectorHealthSchema = z.object({
  connector: externalDataConnectorSchema,
  totals: z.object({
    imported: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    quarantined: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
  }),
  reconciliation: externalConnectorReconciliationSchema.optional(),
});

export const externalConnectorHealthListSchema = z.array(
  externalConnectorHealthSchema,
);

export const externalDataConnectorListSchema = z.array(
  externalDataConnectorSchema,
);

export type ExternalConnectorProviderDto = z.infer<
  typeof externalConnectorProviderSchema
>;
export type ExternalConnectorStatusDto = z.infer<
  typeof externalConnectorStatusSchema
>;
export type ExternalConnectorSslModeDto = z.infer<
  typeof externalConnectorSslModeSchema
>;
export type ExternalSyncStreamDto = z.infer<typeof externalSyncStreamSchema>;
export type CanonicalTrackingEventTypeDto = z.infer<
  typeof canonicalTrackingEventTypeSchema
>;
export type ConversionValueSourceDto = z.infer<
  typeof conversionValueSourceSchema
>;
export type ExternalMysqlCredentialsInputDto = z.infer<
  typeof externalMysqlCredentialsInputSchema
>;
export type ExternalDataConnectorCreateInputDto = z.infer<
  typeof externalDataConnectorCreateInputSchema
>;
export type ExternalDataConnectorUpdateInputDto = z.infer<
  typeof externalDataConnectorUpdateInputSchema
>;
export type ExternalDataConnectorDto = z.infer<
  typeof externalDataConnectorSchema
>;
export type ExternalConnectionTestResultDto = z.infer<
  typeof externalConnectionTestResultSchema
>;
export type ExternalSyncInputDto = z.infer<typeof externalSyncInputSchema>;
export type ExternalSyncQueuedResultDto = z.infer<
  typeof externalSyncQueuedResultSchema
>;
export type ExternalCapiCutoverDto = z.infer<
  typeof externalCapiCutoverSchema
>;
export type ExternalCapiCutoverActivateInputDto = z.infer<
  typeof externalCapiCutoverActivateInputSchema
>;
export type ExternalCapiCutoverRollbackInputDto = z.infer<
  typeof externalCapiCutoverRollbackInputSchema
>;
export type ExternalCapiCutoverResultDto = z.infer<
  typeof externalCapiCutoverResultSchema
>;
export type ExternalReconciliationStateDto = z.infer<
  typeof externalReconciliationStateSchema
>;
export type ExternalReconciliationBlockerDto = z.infer<
  typeof externalReconciliationBlockerSchema
>;
export type ExternalEventReconciliationDto = z.infer<
  typeof externalEventReconciliationSchema
>;
export type ExternalConnectorReconciliationDto = z.infer<
  typeof externalConnectorReconciliationSchema
>;
export type ExternalConnectorHealthDto = z.infer<
  typeof externalConnectorHealthSchema
>;
