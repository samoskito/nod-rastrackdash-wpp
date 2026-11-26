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

/**
 * standard: POST /{WABA_ID}/subscribed_apps sem corpo (a Meta entrega na URL
 * de callback configurada no app). agency_central_app: o mesmo POST com
 * override_callback_uri (a URL desta conexão) e verify_token (o token de
 * verificação desta conexão), para uma agência usar um único app Meta para
 * todos os clientes.
 */
export const metaCloudWabaSubscriptionModeSchema = z.enum([
  "standard",
  "agency_central_app",
]);

/**
 * Token de verificação desta conexão (o mesmo mostrado ao criar a conexão ou
 * ao gerar nova URL). Usado só para a Meta confirmar a URL; nunca gravado.
 */
export const metaCloudWabaVerifyTokenSchema = z
  .string()
  .trim()
  .min(8, "Cole o token de verificação completo desta conexão.")
  .max(512, "Token de verificação longo demais.")
  .regex(/^[^\s]+$/, "O token de verificação não pode ter espaços.");

export const metaCloudWabaSubscriptionSubscribeInputSchema = z
  .object({
    wabaId: metaCloudWabaIdSchema,
    accessToken: metaCloudWabaAccessTokenSchema,
    confirm: z.literal(true, {
      errorMap: () => ({
        message: "Confirme explicitamente a inscrição do app na WABA.",
      }),
    }),
    mode: metaCloudWabaSubscriptionModeSchema.default("standard"),
    verifyToken: metaCloudWabaVerifyTokenSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "agency_central_app" && !value.verifyToken) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verifyToken"],
        message:
          "No modo App central da agência, cole o token de verificação desta conexão.",
      });
    }
    if (value.mode === "standard" && value.verifyToken) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verifyToken"],
        message:
          "O token de verificação só é usado no modo App central da agência.",
      });
    }
  });

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
  /** App central: a Meta aceitou e a reconsulta mostra a URL desta conexão. */
  "override_set",
  /** App central: a Meta aceitou, mas a reconsulta não mostra a URL desta conexão. */
  "override_unconfirmed",
]);

/**
 * Para onde um nível (WABA, número, app) aponta, comparado com a URL desta
 * conexão. this_connection: a URL desta conexão; other_connection_here: outra
 * conexão deste painel; other_url: outro endereço; none: sem desvio nesse
 * nível; unknown: não deu para ler (a Meta não respondeu ou não deu acesso).
 */
export const metaCloudWabaCallbackTargetSchema = z.enum([
  "this_connection",
  "other_connection_here",
  "other_url",
  "none",
  "unknown",
]);

export const metaCloudWabaCallbackStatusSchema = z.object({
  /** URL de callback desta conexão (sem token); null sem API_PUBLIC_URL. */
  expectedUrl: z.string().nullable(),
  /** Desvio da WABA (override_callback_uri do app desta conexão na WABA). */
  wabaOverride: metaCloudWabaCallbackTargetSchema,
  /** Só o domínio do outro endereço (nunca caminho nem parâmetros). */
  wabaOverrideHost: z.string().nullable(),
  /** URL de callback do app (nível do app), lida com o app token. */
  appCallback: metaCloudWabaCallbackTargetSchema,
  /** O campo messages está assinado no app? null quando não deu para ler. */
  appMessagesField: z.boolean().nullable(),
  /** Desvio de cada número (vence o desvio da WABA). */
  phoneOverrides: z.array(
    z.object({
      phoneNumberId: z.string().min(1),
      target: metaCloudWabaCallbackTargetSchema,
    }),
  ),
  /** Números da WABA além do limite de conferência (não foram lidos). */
  phoneOverridesNotChecked: z.number().int().nonnegative(),
  /**
   * Onde a Meta entrega as mensagens desta WABA para este app, pela ordem
   * da Meta (número > WABA > app). app_messages_off: o app não assina o
   * campo messages, então a Meta não entrega nada. unknown também quando
   * algum número não pôde ser conferido ou a reconsulta falhou.
   */
  effective: z.enum([
    "this_connection",
    "elsewhere",
    "unknown",
    "not_subscribed",
    "app_messages_off",
  ]),
});

export const metaCloudWabaSubscriptionStatusSchema = z.object({
  connectionId: z.string().min(1),
  wabaId: metaCloudWabaIdSchema,
  thisAppId: z.string().min(1),
  thisAppSubscribed: z.boolean(),
  apps: z.array(metaCloudWabaSubscribedAppSchema),
  phoneNumbers: z.array(metaCloudWabaPhoneNumberSchema),
  channelCheck: metaCloudWabaChannelCheckSchema,
  outcome: metaCloudWabaSubscriptionOutcomeSchema,
  mode: metaCloudWabaSubscriptionModeSchema,
  callback: metaCloudWabaCallbackStatusSchema,
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
  "verify_token_mismatch",
  "callback_url_unavailable",
  "override_verification_failed",
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
export type MetaCloudWabaSubscriptionMode = z.infer<
  typeof metaCloudWabaSubscriptionModeSchema
>;
export type MetaCloudWabaCallbackTarget = z.infer<
  typeof metaCloudWabaCallbackTargetSchema
>;
export type MetaCloudWabaCallbackStatusDto = z.infer<
  typeof metaCloudWabaCallbackStatusSchema
>;
export type MetaCloudWabaErrorCode = z.infer<typeof metaCloudWabaErrorCodeSchema>;
