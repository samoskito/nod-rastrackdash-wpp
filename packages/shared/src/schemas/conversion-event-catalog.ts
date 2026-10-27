import { z } from "zod";
import {
  conversionEventNameSchema,
  type ConversionEventNameDto,
} from "./conversion-events";

export const conversionEventCategories = [
  "journey",
  "conversion",
  "operational",
] as const;
export const conversionEventCategorySchema = z.enum(conversionEventCategories);

/**
 * required: nunca enviar sem valor (Purchase/InitiateCheckout, base do ROAS).
 * optional: pode viajar com ou sem valor.
 * none: o evento nunca carrega valor monetario.
 */
export const conversionEventValuePolicies = [
  "required",
  "optional",
  "none",
] as const;
export const conversionEventValuePolicySchema = z.enum(
  conversionEventValuePolicies,
);

export const conversionEventDedupeModes = [
  "lifetime",
  "rolling_window",
] as const;
export const conversionEventDedupeModeSchema = z.enum(
  conversionEventDedupeModes,
);

export type ConversionEventCategoryDto = z.infer<
  typeof conversionEventCategorySchema
>;
export type ConversionEventValuePolicyDto = z.infer<
  typeof conversionEventValuePolicySchema
>;
export type ConversionEventDedupeModeDto = z.infer<
  typeof conversionEventDedupeModeSchema
>;

export type ConversionEventMetadataDto = {
  eventName: ConversionEventNameDto;
  /**
   * Rotulo no singular usado no builder de gatilhos. Rotulos de funil ficam
   * em conversionEventDisplayLabels (funnel-configuration).
   */
  label: string;
  description: string;
  category: ConversionEventCategoryDto;
  order: number;
  valuePolicy: ConversionEventValuePolicyDto;
  hasItems: boolean;
  hasOrderId: boolean;
  dedupeMode: ConversionEventDedupeModeDto;
  /**
   * Prefixo do event_id enviado a Meta. Purchase/QualifiedLead/
   * InitiateCheckout carregam os prefixos legados: mudar quebra a
   * deduplicacao de eventos ja enviados.
   */
  metaEventIdPrefix: string;
};

export const conversionEventCatalog: Record<
  ConversionEventNameDto,
  ConversionEventMetadataDto
> = {
  LeadSubmitted: {
    eventName: "LeadSubmitted",
    label: "Lead recebido",
    description:
      "Primeiro contato do lead no WhatsApp. Nao carrega valor e e enviado no maximo uma vez por lead.",
    category: "journey",
    order: 10,
    valuePolicy: "none",
    hasItems: false,
    hasOrderId: false,
    dedupeMode: "lifetime",
    metaEventIdPrefix: "lead_submitted",
  },
  ViewContent: {
    eventName: "ViewContent",
    label: "Conteudo visualizado",
    description:
      "Lead viu uma oferta, pagina de produto ou material enviado pelo time. O valor e opcional.",
    category: "journey",
    order: 20,
    valuePolicy: "optional",
    hasItems: true,
    hasOrderId: false,
    dedupeMode: "rolling_window",
    metaEventIdPrefix: "view_content",
  },
  AddToCart: {
    eventName: "AddToCart",
    label: "Adicionou ao carrinho",
    description:
      "Lead escolheu um produto e sinalizou intencao de levar. O valor e opcional.",
    category: "journey",
    order: 30,
    valuePolicy: "optional",
    hasItems: true,
    hasOrderId: false,
    dedupeMode: "rolling_window",
    metaEventIdPrefix: "add_to_cart",
  },
  CartAbandoned: {
    eventName: "CartAbandoned",
    label: "Carrinho abandonado",
    description:
      "Lead parou de responder depois de montar o pedido. O valor e opcional.",
    category: "operational",
    order: 35,
    valuePolicy: "optional",
    hasItems: true,
    hasOrderId: false,
    dedupeMode: "rolling_window",
    metaEventIdPrefix: "cart_abandoned",
  },
  InitiateCheckout: {
    eventName: "InitiateCheckout",
    label: "Checkout iniciado",
    description:
      "Link de pagamento enviado ou checkout aberto. Exige valor: fixo ou extraido da mensagem.",
    category: "journey",
    order: 45,
    valuePolicy: "required",
    hasItems: true,
    hasOrderId: true,
    dedupeMode: "rolling_window",
    metaEventIdPrefix: "checkout",
  },
  QualifiedLead: {
    eventName: "QualifiedLead",
    label: "Lead qualificado",
    description:
      "Lead demonstrou alta intencao de compra. Nao carrega valor e e enviado no maximo uma vez por lead.",
    category: "journey",
    order: 40,
    valuePolicy: "none",
    hasItems: false,
    hasOrderId: false,
    dedupeMode: "lifetime",
    metaEventIdPrefix: "qualified",
  },
  Purchase: {
    eventName: "Purchase",
    label: "Compra realizada",
    description:
      "Pagamento confirmado. Evento principal de ROAS: exige valor fixo ou extraido da mensagem.",
    category: "conversion",
    order: 50,
    valuePolicy: "required",
    hasItems: true,
    hasOrderId: true,
    dedupeMode: "rolling_window",
    metaEventIdPrefix: "purchase",
  },
  OrderCreated: {
    eventName: "OrderCreated",
    label: "Pedido criado",
    description:
      "Pedido registrado antes da expedicao. Usado por operacoes de produto fisico. O valor e opcional.",
    category: "operational",
    order: 60,
    valuePolicy: "optional",
    hasItems: true,
    hasOrderId: true,
    dedupeMode: "rolling_window",
    metaEventIdPrefix: "order_created",
  },
  OrderShipped: {
    eventName: "OrderShipped",
    label: "Pedido enviado",
    description: "Pedido despachado para o cliente. Nao carrega valor.",
    category: "operational",
    order: 70,
    valuePolicy: "none",
    hasItems: false,
    hasOrderId: true,
    dedupeMode: "rolling_window",
    metaEventIdPrefix: "order_shipped",
  },
  OrderDelivered: {
    eventName: "OrderDelivered",
    label: "Pedido entregue",
    description: "Pedido entregue ao cliente final. Nao carrega valor.",
    category: "operational",
    order: 80,
    valuePolicy: "none",
    hasItems: false,
    hasOrderId: true,
    dedupeMode: "rolling_window",
    metaEventIdPrefix: "order_delivered",
  },
  OrderCanceled: {
    eventName: "OrderCanceled",
    label: "Pedido cancelado",
    description:
      "Pedido cancelado pelo cliente ou pela operacao. Nao carrega valor.",
    category: "operational",
    order: 85,
    valuePolicy: "none",
    hasItems: false,
    hasOrderId: true,
    dedupeMode: "rolling_window",
    metaEventIdPrefix: "order_canceled",
  },
  OrderReturned: {
    eventName: "OrderReturned",
    label: "Pedido devolvido",
    description: "Produto devolvido pelo cliente. Nao carrega valor.",
    category: "operational",
    order: 90,
    valuePolicy: "none",
    hasItems: false,
    hasOrderId: true,
    dedupeMode: "rolling_window",
    metaEventIdPrefix: "order_returned",
  },
  RatingProvided: {
    eventName: "RatingProvided",
    label: "Avaliacao enviada",
    description:
      "Cliente enviou uma nota sobre o produto ou o atendimento. Nao carrega valor.",
    category: "operational",
    order: 95,
    valuePolicy: "none",
    hasItems: false,
    hasOrderId: true,
    dedupeMode: "rolling_window",
    metaEventIdPrefix: "rating_provided",
  },
  ReviewProvided: {
    eventName: "ReviewProvided",
    label: "Comentario enviado",
    description:
      "Cliente escreveu um depoimento sobre o produto ou o atendimento. Nao carrega valor.",
    category: "operational",
    order: 100,
    valuePolicy: "none",
    hasItems: false,
    hasOrderId: true,
    dedupeMode: "rolling_window",
    metaEventIdPrefix: "review_provided",
  },
};

export const conversionEventCatalogOrdered: ConversionEventMetadataDto[] =
  Object.values(conversionEventCatalog).sort((a, b) => a.order - b.order);

/**
 * Ordem canonica do funil. Eventos fora do catalogo (dado antigo/sujo vindo do
 * banco) caem no fim em vez de derrubar a ordenacao.
 */
export function conversionEventCatalogOrder(eventName: string): number {
  return conversionEventNameSchema.safeParse(eventName).success
    ? conversionEventCatalog[eventName as ConversionEventNameDto].order
    : Number.MAX_SAFE_INTEGER;
}

export function conversionEventMetadata(
  eventName: ConversionEventNameDto,
): ConversionEventMetadataDto {
  return conversionEventCatalog[eventName];
}

export function conversionEventBuilderLabel(eventName: string): string {
  return conversionEventNameSchema.safeParse(eventName).success
    ? conversionEventCatalog[eventName as ConversionEventNameDto].label
    : eventName;
}

export function conversionEventValuePolicy(
  eventName: ConversionEventNameDto,
): ConversionEventValuePolicyDto {
  return conversionEventCatalog[eventName].valuePolicy;
}

/** O evento pode viajar com valor monetario (fixo ou extraido). */
export function conversionEventCarriesValue(
  eventName: ConversionEventNameDto,
): boolean {
  return conversionEventValuePolicy(eventName) !== "none";
}

/** O evento nunca deve ser enviado sem valor. */
export function conversionEventRequiresValue(
  eventName: ConversionEventNameDto,
): boolean {
  return conversionEventValuePolicy(eventName) === "required";
}

export function conversionEventDedupeMode(
  eventName: ConversionEventNameDto,
): ConversionEventDedupeModeDto {
  return conversionEventCatalog[eventName].dedupeMode;
}

export function conversionEventMetaEventIdPrefix(
  eventName: ConversionEventNameDto,
): string {
  return conversionEventCatalog[eventName].metaEventIdPrefix;
}
