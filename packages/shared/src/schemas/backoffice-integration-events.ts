import { z } from "zod";
import {
  integrationEndpointEventStatusSchema,
  integrationEndpointKindSchema,
  integrationEndpointProviderSchema,
  integrationUnattributedReasonLabel,
} from "./integration-endpoints";
import { inboundWebhookParserReleaseSchema } from "./inbound-webhooks";

/**
 * Backoffice "Recebimentos das URLs únicas" (porte do SaaS #170, fase 6.5):
 * tudo o que chegou pelas URLs únicas (Payt, Braip) e pelas URLs por evento
 * (Unnichat, Umbler), de todos os workspaces da instalação, com o resultado
 * de cada recebimento. Só administradores da plataforma (o aluno dono da
 * instalação). Só leitura: nada aqui muda o envio.
 */

export const backofficeIntegrationEventStatusFilters = [
  "all",
  "routed",
  "unattributed",
  "pending",
  "ignored",
  "invalid",
  "rejected",
  "duplicate",
] as const;
export const backofficeIntegrationEventStatusFilterSchema = z.enum(
  backofficeIntegrationEventStatusFilters,
);

export const backofficeIntegrationEventPageSizeDefault = 50;
export const backofficeIntegrationEventPageSizeMax = 100;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));

const optionalDate = z
  .string()
  .trim()
  .max(40)
  .optional()
  .transform((value, context) => {
    if (!value) return undefined;
    // "2026-10-23" (dia inteiro, horário de Brasília) ou ISO completo.
    const date = /^\d{4}-\d{2}-\d{2}$/u.test(value)
      ? new Date(`${value}T00:00:00.000-03:00`)
      : new Date(value);
    if (Number.isNaN(date.getTime())) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Data inválida" });
      return z.NEVER;
    }
    return { date, dayOnly: /^\d{4}-\d{2}-\d{2}$/u.test(value) };
  });

export const backofficeIntegrationEventQuerySchema = z
  .object({
    /** ID do workspace ou parte do nome do cliente. */
    workspace: optionalText(120),
    /** Compatibilidade: ID exato do workspace. */
    workspaceId: optionalText(64),
    provider: integrationEndpointProviderSchema.optional(),
    status: backofficeIntegrationEventStatusFilterSchema.default("all"),
    eventName: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{1,40}$/u)
      .optional(),
    from: optionalDate,
    to: optionalDate,
    cursor: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,200}$/u)
      .optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(backofficeIntegrationEventPageSizeMax)
      .default(backofficeIntegrationEventPageSizeDefault),
  })
  .strip();

export const backofficeIntegrationEventSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  workspaceName: z.string().nullable(),
  provider: integrationEndpointProviderSchema,
  kind: integrationEndpointKindSchema,
  status: integrationEndpointEventStatusSchema,
  reasonCode: z.string().nullable(),
  /** Resultado em texto simples (com regra X / motivo). */
  resultLabel: z.string(),
  /** Status original da plataforma (ex.: "pagamento aprovado"). */
  providerStatus: z.string().nullable(),
  /** Evento mapeado (Purchase, InitiateCheckout, CartAbandoned...). */
  eventName: z.string().nullable(),
  valueCents: z.number().int().nullable(),
  currency: z.string().nullable(),
  /** Pedido da plataforma, lido do payload enquanto ele existe. */
  orderRef: z.string().nullable(),
  /** Só os últimos 4 dígitos. */
  phoneMasked: z.string().nullable(),
  productName: z.string().nullable(),
  productCode: z.string().nullable(),
  routedRuleId: z.string().nullable(),
  routedRuleName: z.string().nullable(),
  attemptCount: z.number().int().positive(),
  firstReceivedAt: z.string().datetime(),
  lastReceivedAt: z.string().datetime(),
  payloadAvailable: z.boolean(),
  payloadExpiresAt: z.string().datetime(),
});

export const backofficeIntegrationEventListSchema = z.object({
  items: z.array(backofficeIntegrationEventSchema),
  nextCursor: z.string().nullable(),
  /** Clientes encontrados pela busca (nome ou ID), no máximo 20. */
  matchedWorkspaces: z
    .array(z.object({ id: z.string(), name: z.string() }))
    .optional(),
});

export type BackofficeIntegrationEventStatusFilterDto = z.infer<
  typeof backofficeIntegrationEventStatusFilterSchema
>;
export type BackofficeIntegrationEventQueryDto = z.infer<
  typeof backofficeIntegrationEventQuerySchema
>;
export type BackofficeIntegrationEventDto = z.infer<
  typeof backofficeIntegrationEventSchema
>;
export type BackofficeIntegrationEventListDto = z.infer<
  typeof backofficeIntegrationEventListSchema
>;

/** Motivos de recusa (HTTP 4xx) e de leitura inválida/ignorada. */
export const integrationReceiptReasons = {
  token_missing: "URL chamada sem o token",
  token_invalid: "Token da URL não confere",
  endpoint_removed: "URL removida",
  parser_retired: "Leitor da plataforma retirado",
  content_type_unsupported: "Formato de envio não aceito (Content-Type)",
  body_empty: "Corpo vazio",
  body_invalid_json: "Corpo não é um JSON válido",
  body_invalid: "Corpo ilegível",
  payload_too_large: "Corpo maior que o limite (2 MB)",
  status_not_supported: "Status da plataforma não usado (ex.: cancelada)",
  integration_provider_unsupported: "Plataforma não suportada",
  unnichat_automation_v1_invalid_payload: "Formato da automação não reconhecido",
  umbler_automation_v1_invalid_payload: "Formato da automação não reconhecido",
  roichat_automation_v1_invalid_payload: "Formato da compra do ROI Chat não reconhecido",
} as const;

/** Texto de um motivo gravado no recibo (qualquer resultado). */
export function integrationReceiptReasonLabel(
  reasonCode: string | null | undefined,
): string {
  const code = reasonCode ?? "";
  const direct =
    integrationReceiptReasons[code as keyof typeof integrationReceiptReasons];
  if (direct) return direct;
  if (code.endsWith("_purchase_identity_missing"))
    return "Sem identificação do pedido (ex.: trans_key)";
  if (code.endsWith("_invalid_date")) return "Data inválida";
  if (code.endsWith("_invalid_value")) return "Valor inválido";
  if (code.endsWith("_phone_missing")) return "Sem telefone do comprador";
  if (code.endsWith("_currency_unsupported")) return "Moeda não suportada";
  if (code.endsWith("_status_not_supported"))
    return integrationReceiptReasons.status_not_supported;
  if (code.endsWith("_invalid_payload"))
    return "Formato não reconhecido pelo leitor (telefone, valor ou data ausente)";
  return integrationUnattributedReasonLabel(reasonCode);
}

/**
 * Backoffice "Leitores de webhook" (fase 6.5, porte só de leitura do SaaS
 * b4d71afc): as versões de leitor que esta instalação tem e se cada uma está
 * em uso. Diagnóstico de suporte: no nod os leitores validados entram por
 * migration (produção direta) e nada aqui muda o envio.
 */
export const backofficeParserReleaseListSchema = z.object({
  releases: z.array(inboundWebhookParserReleaseSchema),
});
export type BackofficeParserReleaseListDto = z.infer<
  typeof backofficeParserReleaseListSchema
>;
