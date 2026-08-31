"use client";

import type { BackofficeWhatsappWebhookDetailDto } from "@wpptrack/shared";
import { Braces, Eye, X } from "lucide-react";
import { useRef, useState } from "react";
import { apiFetch } from "../lib/api";
import { formatDateTime } from "../lib/date-time";

/**
 * Row-level "Inspecionar" action for the backoffice webhook history table.
 * Fetches the redacted payload lazily on open — the list request never
 * carries payload bytes, only the summary columns already rendered inline.
 */
export function WebhookHistoryDetail({
  connectionId,
  webhookLogId,
}: {
  connectionId: string;
  webhookLogId: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<BackofficeWhatsappWebhookDetailDto | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  async function openDetails() {
    dialogRef.current?.showModal();

    if (detail || loading) {
      return;
    }

    setLoading(true);
    setFailed(false);

    try {
      setDetail(
        await apiFetch<BackofficeWhatsappWebhookDetailDto>(
          `/backoffice/whatsapp-webhooks/connections/${encodeURIComponent(
            connectionId,
          )}/history/${encodeURIComponent(webhookLogId)}`,
        ),
      );
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  function closeDetails() {
    dialogRef.current?.close();
  }

  const serialized = detail?.payload
    ? JSON.stringify(detail.payload, null, 2)
    : null;

  return (
    <>
      <button
        className="button ghost audit-inspect-button"
        onClick={openDetails}
        title="Inspecionar webhook"
        type="button"
      >
        <Eye aria-hidden="true" size={16} />
        Inspecionar
      </button>

      <dialog
        className="event-audit-dialog"
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            closeDetails();
          }
        }}
        ref={dialogRef}
      >
        <div className="event-audit-dialog-shell">
          <header className="event-audit-dialog-header">
            <div>
              <span className="micro-label">Webhook</span>
              <h3>{detail?.webhook.eventType ?? webhookLogId}</h3>
              <span className="event-audit-id">{webhookLogId}</span>
            </div>
            <button
              aria-label="Fechar"
              className="meta-dialog-close"
              onClick={closeDetails}
              title="Fechar"
              type="button"
            >
              <X aria-hidden="true" size={18} />
            </button>
          </header>

          {loading ? (
            <div className="event-audit-loading">Carregando webhook...</div>
          ) : failed ? (
            <div className="event-audit-loading error">
              Não foi possível carregar os detalhes deste webhook.
            </div>
          ) : detail ? (
            <div className="event-audit-dialog-body">
              <dl className="event-audit-facts">
                <div>
                  <dt>Recebido em</dt>
                  <dd>{formatDateTime(detail.webhook.receivedAt)}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{detail.webhook.status}</dd>
                </div>
                <div>
                  <dt>Origem</dt>
                  <dd>{detail.webhook.source}</dd>
                </div>
                <div>
                  <dt>Evento externo</dt>
                  <dd>{detail.webhook.externalEventId ?? "—"}</dd>
                </div>
                <div>
                  <dt>Lead CTWA</dt>
                  <dd>{detail.webhook.leadId ?? "—"}</dd>
                </div>
                <div>
                  <dt>Código de erro</dt>
                  <dd>{detail.webhook.errorCode ?? "—"}</dd>
                </div>
              </dl>

              <section className="audit-payload-panel">
                <header>
                  <div>
                    <span className="micro-label">Payload (dados sensíveis ocultos)</span>
                  </div>
                </header>
                {serialized ? (
                  <pre className="audit-json-viewer">
                    <code>{serialized}</code>
                  </pre>
                ) : (
                  <div className="audit-payload-empty">
                    <Braces aria-hidden="true" size={24} />
                    <strong>Nenhum payload disponível</strong>
                    <span>
                      {detail.payloadAvailable
                        ? "O payload não pôde ser exibido."
                        : "Este webhook não teve payload registrado."}
                    </span>
                  </div>
                )}
              </section>
            </div>
          ) : null}
        </div>
      </dialog>
    </>
  );
}
