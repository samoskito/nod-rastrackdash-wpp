"use client";

import type { WhatsappLabelDto } from "@wpptrack/shared";
import { AlertTriangle, Check, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { apiFetch } from "../../../lib/api";

export type UazapiTriggerLabel = { id: string; name: string };

/** API route that lists one Uazapi connection's labels (read live). */
export function whatsappLabelsPath(whatsappInstanceId: string): string {
  return `/integrations/whatsapp-connections/${encodeURIComponent(whatsappInstanceId)}/labels`;
}

function labelLoadErrorMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message.trim() : "";
  // apiFetch falls back to "API request failed: <status>" when the API sent
  // no readable message; that says nothing useful to the student.
  return message && !message.startsWith("API request failed") ? message : null;
}

type LabelLoadState =
  | { status: "loading" }
  | { status: "loaded"; labels: WhatsappLabelDto[] }
  | { status: "error"; message: string | null };

/**
 * Live multi-select of the WhatsApp instance's UAZAPI labels/lists for the
 * "Tag" origin. Falls back to a single free-text name when the instance has
 * no labels yet or the lookup fails, matching the triggerPhrases fallback
 * the backend still accepts.
 */
export function UazapiLabelPicker({
  whatsappInstanceId,
  selectedLabels,
  onLabelsChange,
  fallbackValue,
  onFallbackChange,
}: {
  whatsappInstanceId: string;
  selectedLabels: UazapiTriggerLabel[];
  onLabelsChange: (labels: UazapiTriggerLabel[]) => void;
  fallbackValue: string;
  onFallbackChange: (value: string) => void;
}) {
  const [state, setState] = useState<LabelLoadState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    apiFetch<WhatsappLabelDto[]>(
      whatsappLabelsPath(whatsappInstanceId),
    ).then(
      (labels) => {
        if (!cancelled) setState({ status: "loaded", labels });
      },
      (error: unknown) => {
        if (!cancelled)
          setState({ status: "error", message: labelLoadErrorMessage(error) });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [whatsappInstanceId, reloadKey]);

  function toggleLabel(label: WhatsappLabelDto) {
    const name = label.name.trim();
    if (!name) return;

    const active = selectedLabels.some((item) => item.id === label.id);
    onLabelsChange(
      active
        ? selectedLabels.filter((item) => item.id !== label.id)
        : [...selectedLabels, { id: label.id, name }],
    );
  }

  return (
    <div className="provider-conversion-label-field">
      <span className="field-label">Listas / etiquetas do WhatsApp</span>

      {state.status === "loading" ? (
        <div className="provider-conversion-label-status">
          <RefreshCw size={14} aria-hidden="true" />
          Carregando etiquetas...
        </div>
      ) : null}

      {state.status === "loaded" && state.labels.length > 0 ? (
        <div
          className="provider-conversion-label-chips"
          role="group"
          aria-label="Etiquetas disponíveis no WhatsApp"
        >
          {state.labels.map((label) => {
            const active = selectedLabels.some((item) => item.id === label.id);
            return (
              <button
                key={label.id}
                type="button"
                className={`provider-conversion-label-chip${active ? " active" : ""}`}
                aria-pressed={active}
                onClick={() => toggleLabel(label)}
              >
                {label.colorHex ? (
                  <span
                    className="provider-conversion-label-dot"
                    style={{ backgroundColor: label.colorHex }}
                    aria-hidden="true"
                  />
                ) : null}
                <span>{label.name}</span>
                {active ? <Check size={13} aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {state.status === "loaded" && state.labels.length === 0 ? (
        <div className="provider-conversion-label-fallback">
          <small className="action-note warn">
            <AlertTriangle size={13} aria-hidden="true" />
            Nenhuma etiqueta encontrada nesta conexão.
          </small>
          <input
            value={fallbackValue}
            onChange={(event) => onFallbackChange(event.target.value)}
            maxLength={160}
            placeholder="Nome exato da etiqueta (opcional)"
          />
        </div>
      ) : null}

      {state.status === "error" ? (
        <div className="provider-conversion-label-fallback">
          <small className="action-note warn">
            <AlertTriangle size={13} aria-hidden="true" />
            {state.message
              ? `Não foi possível carregar as etiquetas: ${state.message}`
              : "Não foi possível carregar as etiquetas."}{" "}
            Informe o nome manualmente ou recarregue a lista.
          </small>
          <input
            value={fallbackValue}
            onChange={(event) => onFallbackChange(event.target.value)}
            maxLength={160}
            placeholder="Nome exato da etiqueta"
          />
        </div>
      ) : null}

      {state.status !== "loading" ? (
        <button
          type="button"
          className="provider-conversion-label-reload"
          onClick={() => setReloadKey((value) => value + 1)}
        >
          <RefreshCw size={13} aria-hidden="true" />
          Recarregar etiquetas
        </button>
      ) : null}

      <small className="action-note">
        Dispara quando o contato entrar nesta lista (evento chat_labels).
      </small>
    </div>
  );
}
