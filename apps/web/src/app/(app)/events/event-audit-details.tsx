"use client";

import type {
  ConversionAuditDeliveryStateDto,
  ConversionAuditEventDetailDto,
  ConversionAuditPayloadSnapshotDto,
} from "@wpptrack/shared";
import {
  Braces,
  Check,
  Copy,
  Eye,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { BackofficeActionForm } from "../../../components/backoffice-action-form";
import { PresentationMask } from "../../../components/presentation-mask";
import { usePresentationMode } from "../../../components/presentation-mode-toggle";
import { apiFetch } from "../../../lib/api";
import { retryMetaEventAction } from "./actions";

type AuditTab = "summary" | "source" | "request" | "response";

const tabs: Array<{ id: AuditTab; label: string }> = [
  { id: "summary", label: "Resumo" },
  { id: "source", label: "Entrada" },
  { id: "request", label: "Envio Meta" },
  { id: "response", label: "Resposta Meta" },
];

function stateChipClass(state: ConversionAuditDeliveryStateDto): string {
  if (state === "failed") {
    return "event-chip bad";
  }

  if (state === "queued" || state === "blocked") {
    return "event-chip warn";
  }

  if (
    state === "not_eligible" ||
    state === "shadow" ||
    state === "historical" ||
    state === "discarded"
  ) {
    return "event-chip neutral";
  }

  return "event-chip";
}

/** Reasons the screen names itself (older APIs answer a generic text). */
const auditReasonLabels: Record<string, string> = {
  // Porte do SaaS #155: entry receipt; the provider rule sends the LeadSubmitted.
  lead_submitted_deferred_to_rule:
    "Lead recebido adiado: será enviado pela regra",
};

export function auditReasonLabel(
  reasonCode: string | null | undefined,
  reason: string,
): string {
  return (reasonCode && auditReasonLabels[reasonCode]) || reason;
}

function missingFieldLabel(field: string): string {
  const labels: Record<string, string> = {
    phone_hash: "Telefone identificável",
    ad_id: "Anúncio de origem",
    ctwa_clid: "Identificador de clique",
    value: "Valor da conversão",
    pixel_id: "Pixel Meta",
    page_id: "Página Facebook",
  };

  return labels[field] ?? field;
}

/**
 * Tarefa 21: author and note of a manual conversion, shown on top of the
 * "Entrada" tab (the note stays in the panel; it is never sent to Meta).
 */
export function ManualConversionNote({ payload }: { payload: unknown }) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    (payload as Record<string, unknown>).processingMode !== "manual_conversion"
  )
    return null;
  const record = payload as Record<string, unknown>;
  const author =
    typeof record.createdByName === "string" ? record.createdByName : null;
  const note = typeof record.note === "string" ? record.note : null;
  const orderRef = typeof record.orderRef === "string" ? record.orderRef : null;
  return (
    <section className="event-audit-manual-note">
      <span className="micro-label">
        Registro manual{author ? ` por ${author}` : ""}
      </span>
      {orderRef ? <p>Pedido/venda: {orderRef}</p> : null}
      <p>{note ?? "Sem observação."}</p>
    </section>
  );
}

function JsonSnapshot({
  snapshot,
}: {
  snapshot: ConversionAuditPayloadSnapshotDto;
}) {
  const [copied, setCopied] = useState(false);
  const presentationMode = usePresentationMode();
  const serialized = snapshot.payload
    ? JSON.stringify(snapshot.payload, null, 2)
    : null;

  async function copyPayload() {
    if (!serialized) {
      return;
    }

    await navigator.clipboard.writeText(serialized);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <section className="audit-payload-panel">
      <header>
        <div>
          <span className="micro-label">Disponibilidade</span>
          <strong>{snapshot.label}</strong>
        </div>
        {serialized && !presentationMode ? (
          <button
            className="button ghost audit-copy-button"
            onClick={copyPayload}
            type="button"
          >
            {copied ? (
              <Check aria-hidden="true" size={15} />
            ) : (
              <Copy aria-hidden="true" size={15} />
            )}
            {copied ? "Copiado" : "Copiar JSON"}
          </button>
        ) : null}
      </header>
      {serialized && presentationMode ? (
        <div className="audit-payload-empty presentation-payload-hidden">
          <ShieldCheck aria-hidden="true" size={24} />
          <strong>Payload oculto no modo de apresentação</strong>
          <span>Desative o modo para inspecionar os dados técnicos.</span>
        </div>
      ) : serialized ? (
        <pre className="audit-json-viewer">
          <code>{serialized}</code>
        </pre>
      ) : (
        <div className="audit-payload-empty">
          <Braces aria-hidden="true" size={24} />
          <strong>Nenhum payload disponível</strong>
          <span>{snapshot.label}</span>
        </div>
      )}
    </section>
  );
}

function RetrySubmitButton({
  blocked,
  compact = false,
}: {
  blocked: boolean;
  compact?: boolean;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      className={`button audit-retry-button${compact ? " ghost" : " primary"}`}
      disabled={pending}
      title={
        blocked
          ? "Tentar enviar de novo com a conexão Meta atual"
          : "Reenviar falha de comunicação com a Meta"
      }
      type="submit"
    >
      <RefreshCw aria-hidden="true" size={16} />
      {pending ? "Enviando..." : "Reenviar"}
    </button>
  );
}

export function EventAuditDetails({
  canRetry,
  deliveryState,
  eventId,
  eventLabel,
}: {
  canRetry: boolean;
  deliveryState?: ConversionAuditDeliveryStateDto;
  eventId: string;
  eventLabel: string;
}) {
  // Bloqueado por configuracao nao e falha de rede: o reenvio usa a conexao atual.
  const blocked = deliveryState === "blocked";
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [retryAvailable, setRetryAvailable] = useState(canRetry);
  const [activeTab, setActiveTab] = useState<AuditTab>("summary");
  const [detail, setDetail] = useState<ConversionAuditEventDetailDto | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setRetryAvailable(canRetry);
  }, [canRetry]);

  async function openDetails() {
    dialogRef.current?.showModal();

    if (detail || loading) {
      return;
    }

    setLoading(true);
    setFailed(false);

    try {
      setDetail(
        await apiFetch<ConversionAuditEventDetailDto>(
          `/reports/conversions/audit/${encodeURIComponent(eventId)}`,
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

  function handleRetrySuccess() {
    setRetryAvailable(false);
    setDetail((current) =>
      current
        ? {
            ...current,
            canRetry: false,
            deliveryState: "queued",
            status: "ready_to_send",
            statusLabel: "Aguardando",
            statusDetail: "Reenvio enfileirado",
            errorCode: null,
            errorMessage: null,
            reason: null,
            reasonCode: null,
          }
        : current,
    );
  }

  return (
    <>
      <div className={`audit-row-actions${retryAvailable ? " has-retry" : ""}`}>
        <button
          className="button ghost audit-inspect-button"
          onClick={openDetails}
          title="Inspecionar evento"
          type="button"
        >
          <Eye aria-hidden="true" size={16} />
          Inspecionar
        </button>
        {retryAvailable ? (
          <BackofficeActionForm
            action={retryMetaEventAction}
            onSuccess={handleRetrySuccess}
          >
            <input name="eventId" type="hidden" value={eventId} />
            <RetrySubmitButton blocked={blocked} compact />
          </BackofficeActionForm>
        ) : null}
      </div>

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
              <span className="micro-label">Auditoria do evento</span>
              <h3>{detail?.eventLabel ?? eventLabel}</h3>
              <span className="event-audit-id">
                <PresentationMask placeholder="ID do evento oculto">
                  {eventId}
                </PresentationMask>
              </span>
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
            <div className="event-audit-loading">Carregando auditoria...</div>
          ) : failed ? (
            <div className="event-audit-loading error">
              Não foi possível carregar os detalhes deste evento.
            </div>
          ) : detail ? (
            <>
              <nav className="event-audit-tabs" aria-label="Dados do evento">
                {tabs.map((tab) => (
                  <button
                    aria-current={activeTab === tab.id ? "page" : undefined}
                    className={activeTab === tab.id ? "active" : undefined}
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    type="button"
                  >
                    {tab.label}
                  </button>
                ))}
              </nav>

              <div className="event-audit-dialog-body">
                {activeTab === "summary" ? (
                  <section className="event-audit-summary-detail">
                    <div className="event-audit-summary-line">
                      <span className={stateChipClass(detail.deliveryState)}>
                        {detail.statusLabel}
                      </span>
                      <strong>{detail.statusDetail}</strong>
                    </div>

                    <dl className="event-audit-facts">
                      <div>
                        <dt>Origem</dt>
                        <dd>{detail.sourceLabel}</dd>
                      </div>
                      <div>
                        <dt>Evento</dt>
                        <dd>{detail.eventName}</dd>
                      </div>
                      <div>
                        <dt>Pixel</dt>
                        <dd>
                          <PresentationMask placeholder="Pixel oculto">
                            {detail.pixelId ?? "Não resolvido"}
                          </PresentationMask>
                        </dd>
                      </div>
                      <div>
                        <dt>Página</dt>
                        <dd>
                          <PresentationMask placeholder="Página oculta">
                            {detail.pageId ?? "Não resolvida"}
                          </PresentationMask>
                        </dd>
                      </div>
                    </dl>

                    {detail.reason ? (
                      <div className="event-audit-reason">
                        <span className="micro-label">Motivo técnico</span>
                        <strong>
                          {auditReasonLabel(detail.reasonCode, detail.reason)}
                        </strong>
                        {detail.reasonCode ? (
                          <code>{detail.reasonCode}</code>
                        ) : null}
                      </div>
                    ) : null}

                    {detail.canRetry ? (
                      <div className="event-audit-retry">
                        {detail.deliveryState === "blocked" ? (
                          <span>
                            <strong>Bloqueado pela conexão com a Meta</strong>
                            <small>
                              Se a conexão já foi ajustada, uma nova tentativa
                              usa a configuração atual e o mesmo identificador
                              do evento.
                            </small>
                          </span>
                        ) : (
                          <span>
                            <strong>Falha transitória de comunicação</strong>
                            <small>
                              Uma nova tentativa reutiliza o mesmo
                              identificador do evento.
                            </small>
                          </span>
                        )}
                        <BackofficeActionForm
                          action={retryMetaEventAction}
                          onSuccess={handleRetrySuccess}
                        >
                          <input name="eventId" type="hidden" value={eventId} />
                          <RetrySubmitButton
                            blocked={detail.deliveryState === "blocked"}
                          />
                        </BackofficeActionForm>
                      </div>
                    ) : null}

                    {detail.missingFields.length ? (
                      <div className="event-audit-missing">
                        <span className="micro-label">Dados ausentes</span>
                        <div>
                          {detail.missingFields.map((field) => (
                            <span className="tag" key={field}>
                              {missingFieldLabel(field)}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </section>
                ) : null}
                {activeTab === "source" ? (
                  <>
                    <ManualConversionNote
                      payload={detail.sourceSnapshot.payload}
                    />
                    <JsonSnapshot snapshot={detail.sourceSnapshot} />
                  </>
                ) : null}
                {activeTab === "request" ? (
                  <JsonSnapshot snapshot={detail.metaRequest} />
                ) : null}
                {activeTab === "response" ? (
                  <JsonSnapshot snapshot={detail.metaResponse} />
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </dialog>
    </>
  );
}
