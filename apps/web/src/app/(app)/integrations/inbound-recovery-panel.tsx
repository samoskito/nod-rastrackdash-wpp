"use client";

import { useEffect, useState } from "react";
import type {
  StudentInboundReplayPreviewDto,
  StudentInboundReplayResultDto,
} from "@wpptrack/shared";
import {
  authorizeInboundRecoveryAction,
  inboundRecoveryResultAction,
  previewInboundRecoveryAction,
  retryInboundRecoveryAction,
} from "./inbound-recovery-actions";

const labels: Record<StudentInboundReplayResultDto["state"], string> = {
  pending: "Pendente — ainda não enviado",
  processing: "Processando — aguarde confirmação",
  delivered: "Entrega confirmada pela Meta",
  failed: "Falhou",
  delivery_unknown: "Entrega incerta (UNKNOWN) — não tente reenviar",
};

export function InboundRecoveryPanel({
  connectionId,
  channelId,
  connectionName,
}: {
  connectionId: string;
  channelId: string;
  connectionName: string;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<StudentInboundReplayPreviewDto | null>(
    null,
  );
  const [result, setResult] = useState<StudentInboundReplayResultDto | null>(
    null,
  );
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await previewInboundRecoveryAction(
        connectionId,
        channelId,
      );
      if (response.ok) {
        setPreview(response.data);
        setResult(response.data.latestBatch);
      } else {
        setPreview(null);
        setMessage(response.message);
      }
    } catch {
      setPreview(null);
      setMessage("A consulta falhou. Atualize a prévia antes de enviar.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!open || !result || !["pending", "processing"].includes(result.state))
      return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let terminal = false;
      try {
        const response = await inboundRecoveryResultAction(
          connectionId,
          channelId,
          result.batchId,
        );
        if (cancelled) return;
        if (response.ok) {
          setMessage(null);
          setResult(response.data);
          if (
            ["delivered", "failed", "delivery_unknown"].includes(
              response.data.state,
            )
          ) {
            terminal = true;
            const next = await previewInboundRecoveryAction(
              connectionId,
              channelId,
            );
            if (!cancelled) {
              if (next.ok) setPreview(next.data);
              else {
                setPreview(null);
                setMessage(next.message);
              }
            }
          }
        } else {
          setMessage(response.message);
        }
      } catch {
        if (!cancelled)
          setMessage(
            "Não foi possível atualizar o resultado. Use Atualizar prévia e resultado.",
          );
      } finally {
        if (!cancelled && !terminal) timeout = setTimeout(poll, 3000);
      }
    };
    timeout = setTimeout(poll, 3000);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [open, result, connectionId, channelId]);

  /** Fase 6.1c (porte do SaaS #91): reenvia os itens que falharam. */
  async function retryFailed() {
    if (
      !result ||
      busy ||
      result.retryableFailed === 0 ||
      confirmation !== connectionName
    )
      return;
    const text = `Reenviar ${result.retryableFailed} ${result.retryableFailed === 1 ? "item que falhou" : "itens que falharam"}? Cada um é conferido de novo e enviado como conversão CTWA real para a Meta.`;
    if (!window.confirm(text)) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await retryInboundRecoveryAction(
        connectionId,
        channelId,
        result.batchId,
        { confirmation },
      );
      if (response.ok) {
        setResult(response.data);
        setConfirmation("");
      } else {
        setMessage(response.message);
      }
    } catch {
      setMessage(
        "Não foi possível confirmar o reenvio. Atualize o resultado antes de tentar de novo.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function authorize(selection: "canary_1" | "remaining") {
    if (
      !preview?.previewToken ||
      busy ||
      confirmation !== connectionName ||
      (selection === "remaining" && !preview.canSendRemaining)
    )
      return;
    const text =
      selection === "canary_1"
        ? "Enviar um de teste? Esta ação envia UMA conversão CTWA real para a Meta. Não é uma simulação."
        : "Recuperar os demais? Esta ação envia conversões CTWA reais para a Meta, até 500 neste lote.";
    if (!window.confirm(text)) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await authorizeInboundRecoveryAction(
        connectionId,
        channelId,
        { previewToken: preview.previewToken, confirmation, selection },
      );
      if (response.ok) {
        setResult(response.data);
        setPreview({ ...preview, previewToken: null, canSendRemaining: false });
        setConfirmation("");
      } else {
        setMessage(response.message);
        setPreview({ ...preview, previewToken: null, canSendRemaining: false });
      }
    } catch {
      setMessage(
        "Não foi possível confirmar o resultado. Consulte o lote antes de qualquer nova tentativa.",
      );
      setPreview({ ...preview, previewToken: null, canSendRemaining: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="inbound-recovery-panel"
      aria-label="Recuperação de CTWAs anteriores"
    >
      <button
        className="button"
        type="button"
        disabled={busy}
        onClick={() => {
          setOpen(!open);
          if (!open) void refresh();
        }}
      >
        Recuperar CTWAs anteriores
      </button>
      {open ? (
        <div>
          <p>
            A prévia consulta eventos deste canal sem enviar nada. Enviar um de
            teste envia uma conversão real para a Meta. O restante exige entrega
            confirmada do teste é outra confirmação sua.
          </p>
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={() => void refresh()}
          >
            Atualizar prévia e resultado
          </button>
          {message ? <p role="alert">{message}</p> : null}
          {preview ? (
            <>
              <p>
                {preview.eligible} CTWAs elegíveis nos {preview.scanned} eventos
                consultados (limite de consulta: {preview.scanLimit}; lote: até{" "}
                {preview.batchLimit}). Apenas payloads ainda retidos e dentro de
                7 dias podem ser recuperados.
              </p>
              {preview.unavailableReason ? (
                <p role="alert">{preview.unavailableReason}</p>
              ) : null}
              {!preview.unavailableReason && preview.eligible === 0 ? (
                <p>
                  Nenhum CTWA anterior elegível neste canal. Eventos expirados,
                  sem CTWA, sem payload, já enviados ou com entrega incerta
                  ficam de fora.
                </p>
              ) : null}
              {preview.previewToken ? (
                <>
                  <label>
                    Digite o nome da conexão para confirmar: {connectionName}
                    <input
                      aria-label="Nome da conexão para confirmar"
                      value={confirmation}
                      onChange={(event) => setConfirmation(event.target.value)}
                      autoComplete="off"
                    />
                  </label>
                  <button
                    className="button primary"
                    type="button"
                    disabled={busy || confirmation !== connectionName}
                    onClick={() => void authorize("canary_1")}
                  >
                    Enviar um de teste
                  </button>
                  <button
                    className="button"
                    type="button"
                    disabled={
                      busy ||
                      confirmation !== connectionName ||
                      !preview.canSendRemaining
                    }
                    onClick={() => void authorize("remaining")}
                  >
                    Recuperar os demais (até 500)
                  </button>
                  {!preview.canSendRemaining ? (
                    <p>
                      Os demais ficam bloqueados até um teste deste canal ter
                      entrega confirmada com a mesma configuração.
                    </p>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
          {result ? (
            <div role="status">
              <p>
                Lote {result.batchId}: {labels[result.state]}
              </p>
              <p>
                {result.delivered} entregues; {result.pending}{" "}
                pendentes/processando; {result.failed} falhas; {result.unknown}{" "}
                com entrega incerta.
              </p>
              <ul>
                {result.items.map((item) => (
                  <li key={item.id}>
                    {item.id}: {labels[item.state]}
                  </li>
                ))}
              </ul>
              {result.retryableFailed > 0 ? (
                <div className="inbound-recovery-retry">
                  <p>
                    {result.retryableFailed}{" "}
                    {result.retryableFailed === 1
                      ? "item que falhou ainda pode ser reenviado"
                      : "itens que falharam ainda podem ser reenviados"}{" "}
                    (o payload original continua guardado).
                  </p>
                  {!preview?.previewToken ? (
                    <label>
                      Digite o nome da conexão para confirmar: {connectionName}
                      <input
                        aria-label="Nome da conexão para confirmar o reenvio"
                        value={confirmation}
                        onChange={(event) =>
                          setConfirmation(event.target.value)
                        }
                        autoComplete="off"
                      />
                    </label>
                  ) : null}
                  <button
                    className="button"
                    type="button"
                    disabled={busy || confirmation !== connectionName}
                    onClick={() => void retryFailed()}
                  >
                    Reenviar os que falharam
                  </button>
                </div>
              ) : result.failed > 0 ? (
                <p>
                  As falhas deste lote não podem ser reenviadas: o payload
                  original já não está guardado ou o CTWA já gerou um evento.
                </p>
              ) : null}
              <p>
                Entrar na fila não significa enviado. Uma entrega incerta
                bloqueia nova tentativa; não há reenvio automático pela
                recuperação.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
