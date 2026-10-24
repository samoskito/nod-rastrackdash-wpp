import { z } from "zod";

const alertPhoneSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\D/g, ""))
  .refine((value) => value.length === 0 || (value.length >= 10 && value.length <= 13), {
    message: "Telefone deve ter entre 10 e 13 dígitos",
  });

const phoneDigitsSchema = alertPhoneSchema.refine((value) => value.length > 0, {
  message: "Telefone é obrigatório",
});

export const workspaceOpsAlertSettingsInputSchema = z
  .object({
    enabled: z.boolean(),
    alertPhones: z.array(phoneDigitsSchema).max(10).optional().default([]),
    alertPhone: alertPhoneSchema.optional().default(""),
    disconnectAlerts: z.boolean().optional().default(true),
    webhookSilenceAlerts: z.boolean().optional().default(true),
    silenceThresholdHours: z.number().int().min(1).max(24 * 30).optional().default(24),
    debounceHours: z.number().int().min(1).max(24 * 30).optional().default(6),
  })
  .superRefine((value, context) => {
    const alertPhones = value.alertPhones.length > 0 ? value.alertPhones : value.alertPhone ? [value.alertPhone] : [];
    if (new Set(alertPhones).size !== alertPhones.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["alertPhones"], message: "Telefones devem ser únicos" });
    }
    if (value.enabled && alertPhones.length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["alertPhones"], message: "Informe ao menos um telefone quando alertas estão ativos" });
    }
  })
  .transform((value) => ({
    ...value,
    alertPhones: value.alertPhones.length > 0 ? value.alertPhones : value.alertPhone ? [value.alertPhone] : [],
  }));

export const workspaceOpsAlertSettingsSchema = z.object({
  id: z.string().nullable(),
  workspaceId: z.string(),
  enabled: z.boolean(),
  alertPhonesE164: z.array(z.string()),
  alertPhoneE164: z.string().nullable(),
  disconnectAlerts: z.boolean(),
  webhookSilenceAlerts: z.boolean(),
  silenceThresholdHours: z.number().int(),
  debounceHours: z.number().int(),
  createdAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime().nullable(),
});

export type WorkspaceOpsAlertSettingsInput = z.infer<
  typeof workspaceOpsAlertSettingsInputSchema
>;

export type WorkspaceOpsAlertSettings = z.infer<
  typeof workspaceOpsAlertSettingsSchema
>;
