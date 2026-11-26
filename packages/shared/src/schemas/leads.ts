import { z } from "zod";

export const leadStatuses = [
  "new",
  "active",
  "qualified",
  "converted",
  "lost",
] as const;

export const leadBases = ["new", "returning", "repeat"] as const;

export const leadListQuerySchema = z.object({
  whatsappInstanceId: z.string().trim().min(1).max(191).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  status: z.enum(leadStatuses).optional(),
  eventName: z.string().trim().min(1).max(120).optional(),
  label: z.string().trim().min(1).max(120).optional(),
  campaignId: z.string().trim().min(1).max(120).optional(),
  adSetId: z.string().trim().min(1).max(120).optional(),
  adId: z.string().trim().min(1).max(120).optional(),
  attribution: z.enum(["paid", "organic"]).optional(),
  /**
   * Which people the period selects. "new" (default): first contact inside the
   * period (each person counts once ever, on the day of the first message).
   * "returning": first contact before the period and a new paid conversation
   * (LeadSubmitted) inside it. Without `since`, "returning" matches nobody.
   * "repeat": two or more paid conversations (LeadSubmitted) inside the period,
   * new or not. Without a period, "repeat" matches nobody.
   */
  base: z.enum(leadBases).optional(),
  since: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  until: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const leadExportFormats = ["csv", "xlsx"] as const;

/** Same filters as the list; the export always returns every matching row. */
export const leadExportQuerySchema = leadListQuerySchema
  .omit({ page: true, pageSize: true, limit: true })
  .extend({
    format: z.enum(leadExportFormats),
    /** "Ocultar dados" is a browser-side toggle, so the client sends it. */
    maskSensitive: z
      .enum(["1", "true", "0", "false"])
      .optional()
      .transform((value) => value === "1" || value === "true"),
  });

export const leadListItemSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1).nullable(),
  phoneDisplay: z.string().min(1).nullable(),
  phoneHash: z.string().min(1),
  status: z.enum(leadStatuses),
  source: z.string().min(1).nullable(),
  labels: z.array(z.string().min(1)).default([]),
  campaignId: z.string().min(1).nullable(),
  campaignName: z.string().min(1).nullable(),
  adSetId: z.string().min(1).nullable(),
  adId: z.string().min(1).nullable(),
  lastEventName: z.string().min(1).nullable(),
  /**
   * The stage (lastEventName) comes from a rule in observation: nothing was
   * sent to the Meta. The screens show "Em observação" next to the stage.
   */
  stageObservation: z.boolean().optional(),
  firstMessageAt: z.string().datetime().nullable(),
  lastMessageAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const leadListSchema = z.array(leadListItemSchema);

export const leadListPageSchema = z.object({
  items: leadListSchema,
  pagination: z.object({
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    totalItems: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  }),
  /**
   * Same filters without the attribution one, split by origin: lets the page
   * show organic leads as their own count next to the paid (anuncio) ones.
   */
  attributionCounts: z
    .object({
      paid: z.number().int().nonnegative(),
      organic: z.number().int().nonnegative(),
    })
    .optional(),
});

export const leadDetailConversionEventSchema = z.object({
  id: z.string().min(1),
  eventName: z.string().min(1),
  status: z.string().min(1),
  sourceTrigger: z.string().min(1),
  pixelId: z.string().min(1).nullable(),
  campaignId: z.string().min(1).nullable(),
  adSetId: z.string().min(1).nullable(),
  adId: z.string().min(1).nullable(),
  errorCode: z.string().min(1).nullable(),
  errorMessage: z.string().min(1).nullable(),
  occurredAt: z.string().datetime(),
  sentAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  /** Conversao registrada manualmente no lead (tarefa 21). */
  manual: z
    .object({
      createdByName: z.string().min(1).nullable(),
      note: z.string().min(1).nullable(),
      orderRef: z.string().min(1).nullable(),
      canCancel: z.boolean(),
      /** Onde foi registrada: detalhe do lead ou CRM Kanban. */
      origin: z.enum(["lead_detail", "kanban"]).optional(),
    })
    .nullable()
    .optional(),
  /**
   * Event recognized by a rule in observation (status
   * PROVIDER_OBSERVATION_EVENT_STATUS): listed like the others with the mark
   * "Em observação", never sent to the Meta. `executionId` deletes it
   * (DELETE /leads/:leadId/observed-events/:executionId).
   */
  observation: z
    .object({
      executionId: z.string().min(1),
    })
    .nullable()
    .optional(),
});

/** Status of a lead event recognized by a rule in observation (not a log). */
export const PROVIDER_OBSERVATION_EVENT_STATUS = "provider_observation";

export const leadDetailWebhookEventSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  eventType: z.string().min(1),
  status: z.string().min(1),
  errorCode: z.string().min(1).nullable(),
  errorMessage: z.string().min(1).nullable(),
  receivedAt: z.string().datetime(),
  processedAt: z.string().datetime().nullable(),
});

export const leadDetailSchema = z.object({
  lead: leadListItemSchema,
  attribution: z.object({
    campaignName: z.string().min(1).nullable(),
    adSetName: z.string().min(1).nullable(),
    adName: z.string().min(1).nullable(),
    creative: z.object({
      thumbnailUrl: z.string().url().nullable(),
      destinationUrl: z.string().url().nullable(),
      /** Set when a persisted thumbnail exists for the attributed ad. */
      thumbnailVersion: z.string().min(1).nullable().optional(),
    }),
  }),
  conversionEvents: z.array(leadDetailConversionEventSchema),
  webhookEvents: z.array(leadDetailWebhookEventSchema),
});

export type LeadStatusDto = z.infer<typeof leadListItemSchema>["status"];
export type LeadBaseDto = (typeof leadBases)[number];
export type LeadListQueryDto = z.infer<typeof leadListQuerySchema>;
export type LeadListItemDto = z.infer<typeof leadListItemSchema>;
export type LeadListPageDto = z.infer<typeof leadListPageSchema>;
export type LeadDetailConversionEventDto = z.infer<
  typeof leadDetailConversionEventSchema
>;
export type LeadDetailWebhookEventDto = z.infer<
  typeof leadDetailWebhookEventSchema
>;
export type LeadDetailDto = z.infer<typeof leadDetailSchema>;
export type LeadExportQueryDto = z.infer<typeof leadExportQuerySchema>;
export type LeadExportFormat = (typeof leadExportFormats)[number];

/**
 * "Excluir lead" (porte do SaaS #292): resultado. No aluno só sai lead sem
 * nenhum envio; conversões já enviadas à Meta não são desfeitas.
 */
export const leadDeleteResultSchema = z.object({
  leadId: z.string().min(1),
  deleted: z.literal(true),
  conversionsRemoved: z.number().int().nonnegative(),
});
export type LeadDeleteResultDto = z.infer<typeof leadDeleteResultSchema>;
/** Corpo obrigatório do DELETE /leads/:id (confirmação da tela). */
export const LEAD_DELETE_CONFIRMATION = "EXCLUIR_LEAD";
