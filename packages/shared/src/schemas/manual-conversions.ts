import { z } from "zod";
import { currencyCodeSchema } from "../currency";
import {
  conversionEventCatalog,
  conversionEventValuePolicy,
} from "./conversion-event-catalog";
import {
  conversionEventNameSchema,
  type ConversionEventNameDto,
} from "./conversion-events";

/**
 * Conversao manual no lead (tarefa 21): um dono/admin registra, a partir do
 * detalhe do lead, uma conversao que aconteceu fora das automacoes (venda no
 * balcao, ligacao, CRM sem integracao). O destino Meta nunca e escolhido pelo
 * usuario: e resolvido como na automacao (anuncio do lead ou entrada CTWA).
 *
 * nod (porte do SaaS #158): vale para leads de Uazapi BYO, WAHA, Meta Cloud e
 * das demais conexoes por webhook (destino pelo anuncio do lead) e para a
 * entrada CTWA da Unnichat (destino pagina/pixel). Compra manual com pedido
 * deduplica contra a Payt, a Braip (6.5) e a Yampi (6.7, id do pedido); a
 * Hotmart entra na 6.6.
 */

/** sourceTrigger / processingMode gravados no ConversionEventLog. */
export const MANUAL_CONVERSION_TRIGGER = "manual_conversion";
/** A Meta aceita event_time de ate 7 dias: depois disso so fica no painel. */
export const MANUAL_CONVERSION_META_WINDOW_DAYS = 7;
/** Limite duro: conversoes mais antigas que isso nao podem ser registradas. */
export const MANUAL_CONVERSION_MAX_AGE_DAYS = 90;
export const MANUAL_CONVERSION_NOTE_MAX_LENGTH = 500;
export const MANUAL_CONVERSION_ORDER_REF_MAX_LENGTH = 120;
export const MANUAL_CONVERSION_CONTENT_NAME_MAX_LENGTH = 200;
/** Teto de valor (R$ 10 milhoes em centavos): evita digitacao absurda. */
export const MANUAL_CONVERSION_MAX_VALUE_CENTS = 1_000_000_000;
/** Pequena folga de relogio entre navegador e servidor. */
export const MANUAL_CONVERSION_FUTURE_SKEW_MS = 5 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

/** Eventos que podem ser registrados manualmente (todo o catalogo suportado). */
export const manualConversionEventNames = conversionEventNameSchema.options;

export function manualConversionEventLabel(
  eventName: ConversionEventNameDto,
): string {
  return conversionEventCatalog[eventName].label;
}

export type ManualConversionAgeState =
  | "invalid"
  | "future"
  | "too_old"
  | "outside_meta_window"
  | "ok";

/** Idade da conversao em relacao a agora (mesma regra no navegador e na API). */
export function manualConversionAgeState(
  occurredAt: Date | string,
  now: Date = new Date(),
): ManualConversionAgeState {
  const time = new Date(occurredAt).getTime();
  if (!Number.isFinite(time)) return "invalid";
  const age = now.getTime() - time;
  if (age < -MANUAL_CONVERSION_FUTURE_SKEW_MS) return "future";
  if (age > MANUAL_CONVERSION_MAX_AGE_DAYS * DAY_MS) return "too_old";
  if (age > MANUAL_CONVERSION_META_WINDOW_DAYS * DAY_MS)
    return "outside_meta_window";
  return "ok";
}

/**
 * Aviso de expiracao: a conversao esta a menos de 2h do limite de 7 dias da
 * Meta e pode expirar antes de sair da fila ("Expirou antes do envio").
 */
export const MANUAL_CONVERSION_EXPIRY_WARNING_MS =
  MANUAL_CONVERSION_META_WINDOW_DAYS * DAY_MS - 2 * 60 * 60_000;

export function manualConversionMayExpireBeforeSend(
  occurredAt: Date | string,
  now: Date = new Date(),
): boolean {
  const age = now.getTime() - new Date(occurredAt).getTime();
  return (
    Number.isFinite(age) &&
    age >= MANUAL_CONVERSION_EXPIRY_WARNING_MS &&
    age <= MANUAL_CONVERSION_META_WINDOW_DAYS * DAY_MS
  );
}

/** Janela (+-24h) do aviso de evento repetido para eventos nao vitalicios. */
export const MANUAL_CONVERSION_RECENT_WINDOW_MS = DAY_MS;

/**
 * Normalizacao do numero do pedido/venda: sem espacos nas pontas, sem
 * espacos/hifens internos, sem "#" inicial e sem diferenca de maiusculas.
 * "#ped-100", " PED 100 " e "Ped100" sao o mesmo pedido.
 */
export function normalizeManualOrderRef(orderRef: string): string {
  return orderRef
    .trim()
    .replace(/^#+/u, "")
    .replace(/[\s-]+/gu, "")
    .toUpperCase();
}

/** Origem do registro manual (auditoria / "Conversao manual (Kanban)"). */
export const manualConversionSources = ["lead_detail", "kanban"] as const;
export const manualConversionSourceSchema = z.enum(manualConversionSources);
export type ManualConversionSourceDto = z.infer<
  typeof manualConversionSourceSchema
>;

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));

export const manualConversionInputSchema = z
  .object({
    eventName: conversionEventNameSchema,
    occurredAt: z.string().datetime({ offset: true }),
    valueCents: z
      .number()
      .int()
      .positive()
      .max(MANUAL_CONVERSION_MAX_VALUE_CENTS)
      .nullish()
      .transform((value) => value ?? null),
    currency: currencyCodeSchema.nullish().transform((value) => value ?? null),
    orderRef: optionalTrimmed(MANUAL_CONVERSION_ORDER_REF_MAX_LENGTH),
    contentName: optionalTrimmed(MANUAL_CONVERSION_CONTENT_NAME_MAX_LENGTH),
    note: optionalTrimmed(MANUAL_CONVERSION_NOTE_MAX_LENGTH),
    /** false: registrar so no painel (nunca enviar a Meta). */
    sendToMeta: z.boolean(),
    /** Gerado pelo formulario: o mesmo clique repetido nao duplica. */
    idempotencyKey: z.string().uuid(),
    /**
     * Confirmacao explicita de "Registrar mesmo assim" quando o lead ja tem o
     * mesmo evento nas +-24h (aviso recentDuplicate do preview).
     */
    confirmDuplicate: z.boolean().optional().default(false),
    /**
     * Onde o registro foi feito: detalhe do lead (padrao) ou o CRM Kanban
     * (card arrastado). "kanban" so aceita etapa posterior a atual do lead.
     * Mesmo caminho de envio; muda so a origem na auditoria.
     */
    source: manualConversionSourceSchema.optional(),
  })
  .superRefine((input, context) => {
    if (input.orderRef !== null && !normalizeManualOrderRef(input.orderRef))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["orderRef"],
        message: "Informe o número do pedido ou da venda.",
      });
    const policy = conversionEventValuePolicy(input.eventName);
    if (policy === "required") {
      if (input.valueCents === null)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["valueCents"],
          message: "Informe o valor da conversão.",
        });
      if (input.currency === null)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["currency"],
          message: "Informe a moeda.",
        });
      if (input.orderRef === null)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["orderRef"],
          message: "Informe o número do pedido ou da venda.",
        });
    } else if (policy === "none") {
      if (input.valueCents !== null || input.currency !== null)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["valueCents"],
          message: "Este evento não carrega valor.",
        });
    } else if (input.valueCents !== null && input.currency === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currency"],
        message: "Informe a moeda do valor.",
      });
    }
    const age = manualConversionAgeState(input.occurredAt);
    if (age === "future")
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["occurredAt"],
        message: "A data da conversão não pode estar no futuro.",
      });
    if (age === "too_old")
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["occurredAt"],
        message: `Só é possível registrar conversões dos últimos ${MANUAL_CONVERSION_MAX_AGE_DAYS} dias.`,
      });
  });

export type ManualConversionInputDto = z.infer<
  typeof manualConversionInputSchema
>;

/** Por que a conversao nao sera (ou nao foi) enviada a Meta. */
export const manualConversionNotSentReasons = [
  "send_disabled",
  "outside_meta_window",
  "no_destination",
  "missing_click",
  // nod: no lugar da "vaga" do SaaS, vale a conexão WhatsApp ativa do
  // número do lead (Uazapi BYO e WAHA). A licença bloqueada recusa o registro
  // inteiro (423), então não vira motivo aqui.
  "connection_inactive",
] as const;
export const manualConversionNotSentReasonSchema = z.enum(
  manualConversionNotSentReasons,
);
export type ManualConversionNotSentReasonDto = z.infer<
  typeof manualConversionNotSentReasonSchema
>;

export const manualConversionNotSentReasonLabels: Record<
  ManualConversionNotSentReasonDto,
  string
> = {
  send_disabled: "Registrado só no painel por escolha do usuário.",
  outside_meta_window:
    "Será registrado só no painel, não enviado à Meta: a Meta só aceita eventos dos últimos 7 dias.",
  no_destination:
    "Lead orgânico ou sem pixel resolvido: será registrado só no painel.",
  missing_click:
    "Lead sem identificador de clique do anúncio (ctwa_clid): será registrado só no painel.",
  connection_inactive:
    "A conexão WhatsApp do número deste lead está desativada: será registrado só no painel. Reative a conexão em Integrações para enviar à Meta.",
};

/** Texto do aviso de expiracao no limite da janela da Meta. */
export const MANUAL_CONVERSION_MAY_EXPIRE_LABEL =
  "Faltam menos de 2 horas para completar 7 dias: o evento pode expirar antes de ser enviado à Meta.";

export const manualConversionDuplicateSchema = z.object({
  /**
   * lead_already_converted / order_already_registered: bloqueio (409).
   * recent_same_event: mesmo evento nas +-24h; exige confirmDuplicate.
   */
  kind: z.enum([
    "lead_already_converted",
    "order_already_registered",
    "recent_same_event",
  ]),
  message: z.string().min(1),
  conversionEventLogId: z.string().min(1).nullable(),
  occurredAt: z.string().datetime().nullable(),
  /** Origem em portugues (ex.: "automação Unnichat"), para o texto da tela. */
  originLabel: z.string().min(1).nullable().optional(),
});

/** Fase 6.9: etapa do CRM do formulario Meta mostrada na confirmacao. */
export const manualConversionCrmStagePreviewSchema = z.object({
  eventName: z.string().min(1),
  willSend: z.boolean(),
  reason: z.string().min(1).nullable(),
});

export const manualConversionPreviewSchema = z.object({
  eventName: conversionEventNameSchema,
  eventLabel: z.string().min(1),
  willSendToMeta: z.boolean(),
  notSentReason: manualConversionNotSentReasonSchema.nullable(),
  notSentReasonLabel: z.string().min(1).nullable(),
  destination: z.object({
    kind: z.enum(["ad", "ctwa", "none"]),
    pixelId: z.string().min(1).nullable(),
    destinationName: z.string().min(1).nullable(),
  }),
  attribution: z.object({
    campaignId: z.string().min(1).nullable(),
    campaignName: z.string().min(1).nullable(),
    adId: z.string().min(1).nullable(),
    adName: z.string().min(1).nullable(),
  }),
  /** Bloqueio: o registro sera recusado (409). */
  duplicate: manualConversionDuplicateSchema.nullable(),
  /** Mesmo evento nas +-24h: so com "Registrar mesmo assim". */
  recentDuplicate: manualConversionDuplicateSchema.nullable(),
  /** Perto do limite de 7 dias: pode expirar antes do envio. */
  mayExpireBeforeSend: z.boolean(),
  /**
   * Fase 6.9: etapa do CRM do formulario Meta (Lead Ads) do lead, enviada
   * junto com um QualifiedLead; null/ausente quando o lead nao tem formulario.
   */
  crmStage: manualConversionCrmStagePreviewSchema.nullable().optional(),
});
export type ManualConversionPreviewDto = z.infer<
  typeof manualConversionPreviewSchema
>;

/** code do 409 que pede confirmacao explicita (recent_same_event). */
export const MANUAL_CONVERSION_RECENT_DUPLICATE_CODE =
  "manual_conversion_recent_duplicate";

/** expired: chegou ao limite de 7 dias antes do envio (so no painel). */
export const manualConversionOutcomes = [
  "queued",
  "local_only",
  "expired",
] as const;
/**
 * Fase 6.9: etapa do CRM do formulario Meta (dataset proprio) registrada
 * junto com um QualifiedLead manual ou do Kanban.
 */
export const manualConversionCrmStageOutcomes = [
  "queued",
  "already_recorded",
  "not_eligible",
] as const;
export const manualConversionCrmStageResultSchema = z.object({
  outcome: z.enum(manualConversionCrmStageOutcomes),
  eventName: z.string().min(1),
  conversionEventLogId: z.string().min(1),
  message: z.string().min(1),
});
export type ManualConversionCrmStageResultDto = z.infer<
  typeof manualConversionCrmStageResultSchema
>;

export const manualConversionResultSchema = z.object({
  outcome: z.enum(manualConversionOutcomes),
  conversionEventLogId: z.string().min(1),
  status: z.string().min(1),
  message: z.string().min(1),
  /** true quando o mesmo pedido (idempotencyKey) ja tinha sido registrado. */
  replayed: z.boolean(),
  /** Fase 6.9: etapa do CRM do formulario Meta registrada junto. */
  crmStage: manualConversionCrmStageResultSchema.nullable().optional(),
});
export type ManualConversionResultDto = z.infer<
  typeof manualConversionResultSchema
>;

export const manualConversionCancelResultSchema = z.object({
  conversionEventLogId: z.string().min(1),
  status: z.literal("skipped"),
});
export type ManualConversionCancelResultDto = z.infer<
  typeof manualConversionCancelResultSchema
>;

/** errorCodes gravados nas conversoes manuais. */
export const MANUAL_CONVERSION_ERROR_CODES = {
  canceled: "ManualConversionCanceled",
  localOnly: "ManualConversionLocalOnly",
  outsideMetaWindow: "ManualConversionOutsideMetaWindow",
  noDestination: "ManualConversionNoDestination",
  connectionInactive: "ManualConversionConnectionInactive",
  /** Sender: passed Meta's 7-day window while queued. */
  expired: "MetaEventTimeExpired",
  /** Recovery: stayed "dispatching" (outcome unknown, never resent). */
  dispatchInterrupted: "ManualConversionDispatchInterrupted",
} as const;

/** Status de envio que ainda podem ser cancelados (nada chegou a Meta). */
export const MANUAL_CONVERSION_CANCELABLE_STATUSES = [
  "ready_to_send",
  "queued",
  "pending_meta_context",
  "pending_value",
  "not_eligible",
] as const;
