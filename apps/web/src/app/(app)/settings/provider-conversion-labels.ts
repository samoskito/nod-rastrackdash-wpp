import type {
  ProviderConversionObservationDetailDto,
  PurchaseReviewDto,
} from "@wpptrack/shared";
import { CONVERSION_SENDING_OFF_FIX } from "../../../lib/server-switch-copy";

/**
 * Why a recognized event stayed in observation, and what a reprocess does
 * with it (ported from the SaaS, #171: every case read only "Reconhecido em
 * observação").
 */
export const observationDetailCopy: Record<
  ProviderConversionObservationDetailDto,
  { label: string; reprocess: string }
> = {
  rule_observation_at_receipt: {
    label: "A regra estava sem envio quando o evento chegou",
    reprocess: "Com a regra enviando, reprocessar envia à Meta.",
  },
  production_sending_disabled: {
    label: "Envio de conversões desligado no servidor",
    reprocess:
      `${CONVERSION_SENDING_OFF_FIX} Depois, reprocessar envia à Meta.`,
  },
  lead_number_legacy_engine: {
    label: "Número do lead ainda no motor antigo de conversões",
    reprocess:
      "Reprocessar não envia enquanto o número estiver no motor antigo.",
  },
  rule_not_activated: {
    label: "Regra sem envio ativo registrado",
    reprocess: "Ative o envio da regra; depois reprocessar envia à Meta.",
  },
  received_before_rule_activation: {
    label: "Recebido antes do envio ativo da regra",
    reprocess: "Reprocessar envia à Meta.",
  },
  lead_number_not_production: {
    label: "Número do lead com o envio desligado",
    reprocess:
      "Ative o envio do número (“Ativar envio neste número” na regra ou a conexão dele em Integrações); depois reprocessar envia à Meta.",
  },
  received_before_number_activation: {
    label: "Recebido antes do envio ativo do número do lead",
    reprocess: "Reprocessar envia à Meta.",
  },
};

export function observationDetailLabel(
  detail: ProviderConversionObservationDetailDto | null | undefined,
): { label: string; reprocess: string } | null {
  return detail ? (observationDetailCopy[detail] ?? null) : null;
}

export function purchaseReviewStatusLabel(
  status: PurchaseReviewDto["status"],
): string {
  const labels = {
    recognized: "Reconhecida",
    awaiting_data: "Aguardando dados",
    review_required: "Revisão necessária",
    approved: "Na fila",
    sent: "Enviada",
    duplicate: "Duplicada",
    rejected: "Rejeitada",
    failed: "Falhou",
    corrected_after_send: "Corrigida no painel",
  } satisfies Record<PurchaseReviewDto["status"], string>;

  return labels[status];
}

export function purchaseReviewTone(
  status: PurchaseReviewDto["status"],
): "" | "warn" | "bad" | "neutral" {
  if (status === "sent" || status === "recognized") return "";
  if (status === "failed" || status === "rejected") return "bad";
  if (["awaiting_data", "review_required", "approved"].includes(status)) {
    return "warn";
  }
  return "neutral";
}

export function purchaseReviewReasonLabel(reasonCode: string | null): string {
  if (!reasonCode) return "Pronta para revisão";

  const labels: Record<string, string> = {
    awaiting_complete_purchase_data: "Mensagem sem dados completos",
    catalog_combination_not_found: "Combinação fora do catálogo",
    catalog_message_ambiguous: "Mensagem com combinação ambígua",
    provider_conversion_paid_lead_missing: "Lead pago não localizado",
    provider_conversion_route_missing: "Rota Meta não localizada",
    provider_conversion_value_missing: "Valor da compra não localizado",
    provider_conversion_production_context_invalid:
      "Contexto de produção incompleto",
  };

  return labels[reasonCode] ?? executionReasonLabel(reasonCode);
}

export function executionReasonLabel(reasonCode: string | null): string {
  if (!reasonCode) return "Processado";

  const labels: Record<string, string> = {
    catalog_matched: "Catálogo reconhecido",
    catalog_matched_observation:
      "Catálogo reconhecido com a regra sem envio: nada enviado à Meta",
    message_matched: "Mensagem reconhecida",
    message_matched_observation:
      "Mensagem reconhecida com a regra sem envio: nada enviado à Meta",
    automation_matched: "Automação reconhecida",
    automation_matched_observation:
      "Recebido com a regra sem envio: nada enviado à Meta",
    automation_manual_reprocess_approved: "Reprocessamento autorizado",
    automation_event_mismatch: "Evento diferente da regra",
    automation_channel_unresolved: "Canal não localizado",
    automation_paid_lead_missing: "Lead pago não localizado",
    automation_value_missing: "Valor médio não configurado",
    before_production_activation:
      "Recebido antes do envio ativo (regra ou número do lead): nada enviado à Meta",
    production_context_invalid: "Configuração incompleta",
    rule_production_not_activated: "Regra ainda sem envio ativo",
    rule_parser_not_certified: "Leitor da regra ainda não validado",
    connection_parser_not_certified: "Leitor da conexão ainda não validado",
    parser_release_mismatch: "Parser da regra difere da conexão",
    connection_removed: "Conexão removida",
    connection_not_production:
      "Envio da conexão desligado: ative em Integrações",
    channel_unresolved: "Canal não localizado",
    channel_not_active: "Envio do número desligado: ative em Integrações",
    purchase_within_24h: "Compra repetida em menos de 24h",
    purchase_repeated_within_12h:
      "Mesma compra (mesmo valor e moeda) repetida em menos de 12h",
    provider_conversion_paid_lead_missing: "Lead pago não localizado",
    provider_conversion_catalog_mismatch: "Mensagem divergiu do catálogo",
    provider_conversion_payload_unavailable: "Payload não está mais disponível",
    provider_conversion_source_event_mismatch: "Mensagem de origem inválida",
    provider_conversion_value_missing: "Valor médio não configurado",
    provider_conversion_production_context_invalid:
      "Contexto de produção incompleto",
    provider_conversion_production_disabled: "Envio de conversões desativado",
    provider_conversion_execution_not_found: "Execução não localizada",
    provider_conversion_identity_missing: "Identidade do lead incompleta",
    provider_conversion_execution_state_changed:
      "Estado da execução foi alterado",
    provider_conversion_production_unexpected:
      "Falha interna ao criar o evento Meta",
    queue_recovery_pending: "Aguardando recuperação da fila",
    qualified_lead_already_materialized: "Lead já qualificado anteriormente",
    lead_already_converted_other_number:
      "Lead já convertido por outro número: nada novo enviado à Meta",
    lead_already_converted_other_source:
      "Lead já convertido pela entrada do anúncio ou manualmente: nada novo enviado à Meta",
    lead_submitted_deferred_to_rule:
      "Lead recebido adiado: será enviado pela regra",
    purchase_registered_manually: "Compra já registrada manualmente",
    lead_event_registered_manually:
      "Já registrado manualmente nas últimas 24h",
    // Venda da Payt (Fase 4a).
    purchase_duplicate: "Venda repetida: recibo registrado, nada novo enviado",
    rule_in_observation: "Regra sem envio: nada é enviado à Meta",
    payt_purchase_identity_missing:
      "Venda sem vendedor ou pedido identificados",
    payt_currency_unsupported:
      "Venda em moeda fora de BRL, USD ou EUR: nada enviado à Meta",
    provider_purchase_identity_missing:
      "Venda sem vendedor ou pedido identificados",
    payt_channel_missing_or_ambiguous:
      "Número da venda não identificado ou ambíguo",
    provider_purchase_channel_missing_or_ambiguous:
      "Número da venda não identificado ou ambíguo",
    payt_lead_other_channel:
      "Lead de outro número: a regra desse número envia a venda",
    automation_matched_payt_observation:
      "Número do lead no motor antigo de conversões: nada enviado à Meta",
    payt_automation_v1_not_purchase: "Status da Payt não gera conversão",
    payt_automation_v1_event_not_in_rule: "Evento da Payt fora desta regra",
    // Venda da Braip (Fase 6.5).
    braip_purchase_identity_missing: "Venda da Braip sem transação identificada",
    braip_automation_v1_invalid_payload:
      "Postback da Braip incompleto (telefone, valor ou data)",
    braip_automation_v1_not_purchase: "Status da Braip não gera conversão",
    braip_automation_v1_event_not_in_rule: "Evento da Braip fora desta regra",
    // Venda da Yampi (Fase 6.7, porte do SaaS #186).
    yampi_purchase_identity_missing: "Venda da Yampi sem número do pedido",
    yampi_automation_v1_invalid_payload:
      "Aviso da Yampi incompleto (telefone, valor ou data)",
    yampi_automation_v1_not_purchase: "Não é um pedido pago da Yampi",
    yampi_automation_v1_event_not_in_rule: "Evento da Yampi fora desta regra",
    // Unnichat (Fase 4b).
    ctwa_missing: "Sem clique do anúncio (ctwa_clid): nada é enviado à Meta",
    ctwa_ad_unavailable:
      "Conversa sem anúncio de origem identificado e sem destino único de página e pixel",
    route_ad_missing:
      "Conversa sem anúncio de origem identificado e sem destino único de página e pixel",
    ctwa_destination_ambiguous:
      "Mais de um par de página e pixel possível: nada foi enviado",
    ctwa_destination_not_authorized:
      "Página e pixel deste número não estão autorizados",
    unnichat_v1_invalid_payload:
      "Corpo do webhook do Unnichat inválido ou incompleto",
    unnichat_automation_v1_invalid_payload:
      "Corpo da automação do Unnichat inválido ou incompleto",
    unnichat_original_bind_mismatch:
      "O contato não confere com a conversa original do anúncio",
    inbound_webhook_production_unnichat_bind_mismatch:
      "O contato não confere com a conversa original do anúncio",
    inbound_webhook_unnichat_channel_binding_missing:
      "A conexão do Unnichat está sem o número do cliente: recrie a conexão informando o número",
    roichat_v1_invalid_payload:
      "Corpo do webhook do ROI Chat inválido ou sem o telefone do lead",
    roichat_automation_v1_invalid_payload:
      "Compra do ROI Chat inválida (sem telefone, ou valor/moeda ilegível)",
    roichat_automation_v1_not_purchase:
      "Aviso do ROI Chat que não é compra",
    roichat_purchase_without_rule:
      "Compra do ROI Chat sem regra “Compra no ROI Chat” para este número",
    roichat_event_not_supported: "Aviso do ROI Chat ignorado (não é entrada nem compra)",
    inbound_webhook_roichat_channel_binding_missing:
      "A conexão do ROI Chat está sem o número do cliente: recrie a conexão informando o número",
  };

  if (reasonCode.startsWith("provider_conversion_route_")) {
    return "Rota Meta indisponível";
  }

  if (labels[reasonCode]) {
    return labels[reasonCode];
  }

  if (reasonCode.startsWith("inbound_webhook_production_unnichat_")) {
    return "Envio do Unnichat recusado: o contato não confere com a conversa do anúncio";
  }

  return catalogReasonLabel(reasonCode);
}

function catalogReasonLabel(reasonCode: string): string {
  const labels: Record<string, string> = {
    matched: "Conversão reconhecida",
    rule_inactive: "Regra pausada",
    catalog_inactive: "Catálogo pausado",
    missing_attribute: "Atributo ausente",
    ambiguous_attribute: "Atributo ambíguo",
    unknown_combination: "Combinação não cadastrada",
    ambiguous_variant: "Variante ambígua",
    missing_price: "Valor ausente",
    ambiguous_price: "Mais de um valor encontrado",
    price_mismatch: "Valor diferente do catálogo",
    trigger_missing: "Frase gatilho ausente",
    empty_template: "Template sem dados ignorado",
    awaiting_data: "Aguardando dados completos",
    incomplete_item: "Produto incompleto",
    invalid_quantity: "Quantidade inválida",
  };

  return labels[reasonCode] ?? "Requer revisão";
}
