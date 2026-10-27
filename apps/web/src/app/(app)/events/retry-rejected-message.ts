/**
 * Resumo do "Reenviar recusados" em lote (1.3.1). Fora do arquivo de server
 * actions para poder ser testado.
 */
export type RetryRejectedResult = {
  claimed: number;
  enqueued: number;
  skipped: number;
  /** Part of skipped: older than Meta's 7-day window (absent on older APIs). */
  expired?: number;
  /**
   * Part of skipped: the current Meta route of the number or of the ad is not
   * ready, so it stays out by configuration (absent on older APIs).
   */
  notReady?: number;
  /**
   * Part of skipped: the current destination already has this once-per-lead
   * event from another log of the same lead (absent on older APIs).
   */
  alreadyConverted?: number;
  failed: number;
};

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

export function retryRejectedMessage(result: RetryRejectedResult): string {
  const parts: string[] = [];

  if (result.enqueued > 0) {
    parts.push(
      `${result.enqueued} ${plural(result.enqueued, "evento recusado enfileirado", "eventos recusados enfileirados")} com a configuração atual.`
    );
  }

  const expired = Math.min(result.expired ?? 0, result.skipped);
  const notReady = Math.min(result.notReady ?? 0, result.skipped - expired);
  const alreadyConverted = Math.min(
    result.alreadyConverted ?? 0,
    result.skipped - expired - notReady
  );
  const otherSkipped = result.skipped - expired - notReady - alreadyConverted;

  if (otherSkipped > 0) {
    parts.push(
      `${otherSkipped} ${plural(otherSkipped, "já tinha sido reenviado e ficou", "já tinham sido reenviados e ficaram")} de fora.`
    );
  }

  if (notReady > 0) {
    parts.push(
      `${notReady} ${plural(notReady, "evento ficou", "eventos ficaram")} de fora por configuração: a rota Meta do número ou do anúncio ainda não está pronta. Corrija em Integrações e reenvie.`
    );
  }

  if (alreadyConverted > 0) {
    parts.push(
      `${alreadyConverted} ${plural(alreadyConverted, "evento ficou", "eventos ficaram")} de fora porque o lead já foi convertido para o pixel atual por outro evento (uma conversão por lead e pixel).`
    );
  }

  if (expired > 0) {
    parts.push(
      `${expired} ${plural(expired, "evento ficou", "eventos ficaram")} de fora por ter mais de 7 dias: a Meta não aceita mais.`
    );
  }

  if (result.failed > 0) {
    parts.push(
      `${result.failed} ${plural(result.failed, "não pode ser enfileirado", "não puderam ser enfileirados")} agora; tente de novo em instantes.`
    );
  }

  return parts.length
    ? parts.join(" ")
    : "Nenhum evento recusado para reenviar neste período.";
}
