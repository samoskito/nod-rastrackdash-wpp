import type { WhatsappWebhookReceiptStatusDto } from "@wpptrack/shared";
import { displayTimeZone } from "../../../lib/date-time";

const sourceLabels: Record<string, string> = {
  uazapi: "Uazapi",
  meta: "Meta",
  umbler: "Umbler",
  gupshup: "Gupshup",
  asaas: "Asaas",
};

/**
 * Student-visible evidence that a WhatsApp webhook actually reached the
 * platform. Deliberately renders only timestamp/status/source/lead-created —
 * never a raw payload, hash or id (see WhatsappWebhookReceiptStatusDto).
 */
export function WhatsappWebhookReceiptStatus({
  status,
  state,
}: {
  status: WhatsappWebhookReceiptStatusDto | null;
  state: "real" | "empty" | "error";
}) {
  if (state === "error") {
    return (
      <div
        className="metric-grid compact"
        data-testid="whatsapp-webhook-receipt-status"
      >
        <div className="metric-card">
          <span className="micro-label">Recebimento de webhook</span>
          <strong>Nao foi possivel carregar o status do webhook</strong>
        </div>
      </div>
    );
  }

  if (!status || !status.hasReceipts) {
    return (
      <div
        className="metric-grid compact"
        data-testid="whatsapp-webhook-receipt-status"
      >
        <div className="metric-card">
          <span className="micro-label">Recebimento de webhook</span>
          <strong>Nenhum webhook recebido ainda</strong>
        </div>
      </div>
    );
  }

  return (
    <div
      className="metric-grid compact"
      data-testid="whatsapp-webhook-receipt-status"
    >
      <div className="metric-card">
        <span className="micro-label">Ultimo webhook recebido</span>
        <strong>{formatReceivedAt(status.lastReceivedAt)}</strong>
        <span className="muted">
          Origem: {sourceLabel(status.lastSource)}
        </span>
      </div>
      <div className="metric-card">
        <span className="micro-label">Resultado</span>
        <strong>{receiptOutcomeLabel(status)}</strong>
      </div>
      <div className="metric-card">
        <span className="micro-label">Ultimas consultas</span>
        <strong>
          {status.recentCount} webhook{status.recentCount === 1 ? "" : "s"}{" "}
          recente{status.recentCount === 1 ? "" : "s"}
        </strong>
      </div>
    </div>
  );
}

function receiptOutcomeLabel(status: WhatsappWebhookReceiptStatusDto) {
  if (status.lastStatus === "error" || status.lastStatus === "failed") {
    return "Recebido — erro ao processar";
  }

  return status.lastLeadCreated
    ? "Recebido — lead CTWA criado"
    : "Recebido — organico, sem lead CTWA";
}

function sourceLabel(source: string | null) {
  if (!source) {
    return "desconhecida";
  }

  return sourceLabels[source] ?? source;
}

function formatReceivedAt(value: string | null) {
  if (!value) {
    return "Aguardando primeiro webhook";
  }

  return new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: displayTimeZone,
  });
}
