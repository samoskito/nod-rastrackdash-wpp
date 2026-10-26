import type { ConversionEventNameDto } from "@wpptrack/shared";

/**
 * "Lead recebido pela regra" (porte do SaaS #155): com
 * LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED ligada na API (padrão desta edição),
 * uma regra por provedor com evento Lead recebido, ativa e enviando,
 * substitui o envio do Lead recebido na entrada da conversa nos números que
 * cobre. Avisos e selo só aparecem com a variável ligada.
 */

export const leadSubmittedOverrideCopy = {
  title: "Muda quando o Lead recebido vai para a Meta",
  deferredChip: "Adiado para a regra",
  awaitingHint:
    "A entrada destes leads foi registrada, mas o Lead recebido só vai para a Meta quando esta regra for acionada. Nada é enviado sozinho.",
  notice:
    "Com esta regra, o Lead recebido (LeadSubmitted na Meta) deixa de ser enviado na entrada da conversa nos números cobertos e passa a ser enviado quando a regra for acionada.",
  notSending: "Vale enquanto a regra estiver enviando.",
  badge: "Substitui envio na entrada",
  badgeTitle:
    "O Lead recebido destes números é enviado à Meta quando esta regra for acionada, não na entrada da conversa.",
} as const;

/** A regra (ativa, enviando, Lead recebido) substitui o envio na entrada. */
export function replacesEntryLeadSubmitted(rule: {
  kind?: "provider" | "crm";
  eventName: ConversionEventNameDto | string;
  active: boolean;
  mode: "observation" | "production" | null | string;
}): boolean {
  return (
    rule.kind !== "crm" &&
    rule.eventName === "LeadSubmitted" &&
    rule.active &&
    rule.mode === "production"
  );
}

/** Aviso do formulário de regra (criar/editar) quando o evento é Lead recebido. */
export function LeadSubmittedOverrideNotice({
  enabled,
  eventName,
  mode,
}: {
  enabled: boolean;
  eventName: ConversionEventNameDto | string;
  /** Regras novas já nascem enviando (produção direta). */
  mode: "observation" | "production" | null | string;
}) {
  if (!enabled || eventName !== "LeadSubmitted") return null;

  // Callout de aviso do design system: é uma mudança de comportamento.
  return (
    <div
      className="feedback-banner warn"
      role="note"
      data-lead-submitted-override="notice"
    >
      <strong>{leadSubmittedOverrideCopy.title}</strong>
      <span>
        {leadSubmittedOverrideCopy.notice}
        {mode !== "production" ? <> {leadSubmittedOverrideCopy.notSending}</> : null}
      </span>
    </div>
  );
}

/**
 * Execuções: recibo de entrada adiado para a regra (not_eligible +
 * lead_submitted_deferred_to_rule). Não está na fila de envio.
 */
export function isDeferredToRuleReason(reasonCode: string | null | undefined) {
  return reasonCode === "lead_submitted_deferred_to_rule";
}

/** "N leads aguardando a regra" (Execuções da regra). */
export function leadsAwaitingRuleLabel(input: {
  count: number;
  olderThanDays: number;
  capped: boolean;
}): string | null {
  if (input.count <= 0) return null;
  const count = `${input.capped ? "Mais de " : ""}${input.count}`;
  return `${count} ${input.count === 1 ? "lead aguardando" : "leads aguardando"} a regra há mais de ${input.olderThanDays} dias`;
}

/** Selo da lista de regras. */
export function LeadSubmittedOverrideBadge() {
  return (
    <span
      className="tag"
      data-lead-submitted-override="badge"
      title={leadSubmittedOverrideCopy.badgeTitle}
    >
      {leadSubmittedOverrideCopy.badge}
    </span>
  );
}
