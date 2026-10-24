import { z } from "zod";

/**
 * Inscrição do app Meta da instalação na WABA do aluno (Meta Cloud).
 *
 * O token do aluno viaja só no corpo da requisição e é descartado pela API
 * depois do uso: nunca é gravado, devolvido, logado ou auditado. Pode ser o
 * token temporário do painel do app (WhatsApp → Configuração da API), um
 * token do Graph API Explorer ou um token de system user, desde que seja do
 * mesmo app configurado na instalação (META_APP_ID).
 */
export const metaCloudWabaIdSchema = z
  .string()
  .trim()
  .regex(/^\d{5,25}$/, "Informe o WABA ID (somente números).");

export const metaCloudWabaAccessTokenSchema = z
  .string()
  .trim()
  .min(20, "Cole o token completo gerado no app Meta.")
  .max(4096, "Token longo demais.")
  .regex(/^[^\s]+$/, "O token não pode ter espaços ou quebras de linha.");

export const metaCloudWabaSubscriptionLookupInputSchema = z
  .object({
    wabaId: metaCloudWabaIdSchema,
    accessToken: metaCloudWabaAccessTokenSchema,
  })
  .strict();

export const metaCloudWabaSubscriptionSubscribeInputSchema = z
  .object({
    wabaId: metaCloudWabaIdSchema,
    accessToken: metaCloudWabaAccessTokenSchema,
    confirm: z.literal(true, {
      errorMap: () => ({
        message: "Confirme explicitamente a inscrição do app na WABA.",
      }),
    }),
  })
  .strict();

export const metaCloudWabaSubscribedAppSchema = z.object({
  appId: z.string().min(1),
  name: z.string().nullable(),
  isThisApp: z.boolean(),
});

export const metaCloudWabaPhoneNumberSchema = z.object({
  id: z.string().min(1),
  displayPhoneNumber: z.string().nullable(),
  verifiedName: z.string().nullable(),
});

export const metaCloudWabaChannelCheckSchema = z.object({
  /**
   * no_real_channel: a conexão ainda não recebeu webhook (só canais
   * provisórios); all_match: todo phone number ID real pertence à WABA;
   * mismatch: algum phone number ID real não pertence a esta WABA.
   */
  status: z.enum(["no_real_channel", "all_match", "mismatch"]),
  mismatchedChannels: z.number().int().nonnegative(),
});

export const metaCloudWabaSubscriptionOutcomeSchema = z.enum([
  "lookup",
  "subscribed",
  "already_subscribed",
  "subscribe_unconfirmed",
]);

export const metaCloudWabaSubscriptionStatusSchema = z.object({
  connectionId: z.string().min(1),
  wabaId: metaCloudWabaIdSchema,
  thisAppId: z.string().min(1),
  thisAppSubscribed: z.boolean(),
  apps: z.array(metaCloudWabaSubscribedAppSchema),
  phoneNumbers: z.array(metaCloudWabaPhoneNumberSchema),
  channelCheck: metaCloudWabaChannelCheckSchema,
  outcome: metaCloudWabaSubscriptionOutcomeSchema,
  checkedAt: z.string().datetime(),
});

/** `code` do corpo de erro da API, para a tela escolher o guia certo. */
export const metaCloudWabaErrorCodeSchema = z.enum([
  "meta_app_not_configured",
  "connection_not_meta_cloud",
  "token_invalid",
  "token_type_not_supported",
  "token_app_mismatch",
  "token_missing_scope",
  "token_waba_not_granted",
  "waba_id_is_phone_number",
  "waba_not_found",
  "permission_denied",
  "rate_limited",
  "graph_unavailable",
  "subscribe_failed",
]);

export type MetaCloudWabaSubscriptionLookupInputDto = z.infer<
  typeof metaCloudWabaSubscriptionLookupInputSchema
>;
export type MetaCloudWabaSubscriptionSubscribeInputDto = z.infer<
  typeof metaCloudWabaSubscriptionSubscribeInputSchema
>;
export type MetaCloudWabaSubscribedAppDto = z.infer<
  typeof metaCloudWabaSubscribedAppSchema
>;
export type MetaCloudWabaPhoneNumberDto = z.infer<
  typeof metaCloudWabaPhoneNumberSchema
>;
export type MetaCloudWabaSubscriptionStatusDto = z.infer<
  typeof metaCloudWabaSubscriptionStatusSchema
>;
export type MetaCloudWabaErrorCode = z.infer<typeof metaCloudWabaErrorCodeSchema>;
