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

/**
 * Botão de ligar uma regra que está com o envio desligado. Decisão do Samuel
 * (D1, 27/10/2026): a regra "Lead recebido" que estava em observação não é
 * ligada pela atualização; o aluno liga quando quiser, sabendo que, ligada,
 * ela passa a ser a única a enviar o Lead recebido dos números que cobre.
 */
export function activateRuleCopy(input: {
  name: string;
  eventName: ConversionEventNameDto | string;
  leadSubmittedOverrideEnabled: boolean;
}): {
  label: string;
  ariaLabel: string;
  title: string;
  body: string;
  confirmLabel: string;
} {
  if (input.eventName === "LeadSubmitted" && input.leadSubmittedOverrideEnabled) {
    return {
      label: "Ligar esta regra",
      ariaLabel: `Ligar a regra ${input.name}`,
      title: "Ligar esta regra",
      body: "Depois de ligada, o Lead recebido dos números desta regra deixa de ir para a Meta na entrada da conversa e passa a ir só quando a regra for acionada. Você pode pausar a regra quando quiser; pausada, o Lead recebido volta a sair na entrada.",
      confirmLabel: "Ligar esta regra",
    };
  }
  return {
    label: "Ativar envio",
    ariaLabel: `Ativar envio automático de ${input.name}`,
    title: "Ativar envio automático",
    body: "Cada conversão reconhecida por esta regra passa a ser enviada para a Meta, pelo destino de cada número.",
    confirmLabel: "Ativar envio",
  };
}

/** Aviso da tela Conversões quando o envio está desligado na API. */
export const conversionSendingOffCopy = {
  title: "Envio desligado no servidor",
  body: "Nenhuma regra está mandando conversões para a Meta agora, nem as que aparecem como enviando (Kommo e Pipedrive também). O envio foi desligado na configuração da API. Para voltar a enviar, peça à sua IA ou a quem cuida do servidor para ligar o envio de conversões (guia: docs/setup/environment.md) e refazer o deploy da API.",
} as const;
