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
} from "./inbound-recovery-actions";

const labels: Record<StudentInboundReplayResultDto["state"], string> = {
  pending: "Pendente — ainda não enviado",
  processing: "Processando — aguarde confirmação",
  delivered: "Entrega confirmada pela Meta",
  failed: "Falhou — nenhum novo envio autorizado",
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
