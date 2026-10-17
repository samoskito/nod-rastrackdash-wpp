import { z } from "zod";

const metaNumericId = z
  .string()
  .trim()
  .regex(/^\d{5,25}$/, "ID numerico da Meta");

/** Meta already receives the lead itself: these would double count it. */
const crmEventName = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^[A-Za-z0-9_]+$/, "Use letras, numeros e _")
  .refine((value) => value !== "Lead" && value !== "LeadSubmitted", {
    message: "A Meta ja recebe o lead: use um nome de etapa (ex. LeadQualificado)",
  });

const accessToken = z.string().trim().min(20).max(2048);

export const metaLeadFormConnectionCreateInputSchema = z.object({
  label: z.string().trim().min(1).max(80),
  pageId: metaNumericId,
  formIds: z.array(metaNumericId).max(50).default([]),
  crmDatasetId: metaNumericId.nullable().optional(),
  qualifiedEventName: crmEventName.default("LeadQualificado"),
  /** System User token with leads_retrieval (and pages_manage_metadata). */
  graphToken: accessToken,
  /** Dataset CAPI token; without it the Graph token is used. */
  capiToken: accessToken.nullable().optional(),
});

export const metaLeadFormConnectionUpdateInputSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  formIds: z.array(metaNumericId).max(50).optional(),
  crmDatasetId: metaNumericId.nullable().optional(),
  qualifiedEventName: crmEventName.optional(),
  graphToken: accessToken.optional(),
  capiToken: accessToken.nullable().optional(),
  active: z.boolean().optional(),
});

export const metaLeadFormConnectionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  pageId: z.string().min(1),
  formIds: z.array(z.string().min(1)),
  crmDatasetId: z.string().min(1).nullable(),
  qualifiedEventName: z.string().min(1),
  graphTokenLast4: z.string(),
  capiTokenLast4: z.string().nullable(),
  active: z.boolean(),
  pageSubscribedAt: z.string().datetime().nullable(),
  webhookUrl: z.string().min(1),
  submissionCount: z.number().int().nonnegative(),
  lastSubmissionAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const metaLeadFormConnectionListSchema = z.array(
  metaLeadFormConnectionSchema,
);

export type MetaLeadFormConnectionCreateInputDto = z.infer<
  typeof metaLeadFormConnectionCreateInputSchema
>;
export type MetaLeadFormConnectionUpdateInputDto = z.infer<
  typeof metaLeadFormConnectionUpdateInputSchema
>;
export type MetaLeadFormConnectionDto = z.infer<
  typeof metaLeadFormConnectionSchema
>;
