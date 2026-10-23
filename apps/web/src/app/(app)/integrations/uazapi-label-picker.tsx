"use client";

import type { WhatsappLabelDto } from "@wpptrack/shared";
import { AlertTriangle, Check, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { apiFetch } from "../../../lib/api";

export type UazapiTriggerLabel = { id: string; name: string };

type LabelLoadState =
  | { status: "loading" }
  | { status: "loaded"; labels: WhatsappLabelDto[] }
  | { status: "error" };

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

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    apiFetch<WhatsappLabelDto[]>(
      `/integrations/whatsapp/instances/${encodeURIComponent(whatsappInstanceId)}/labels`,
    ).then(
      (labels) => {
        if (!cancelled) setState({ status: "loaded", labels });
      },
      () => {
        if (!cancelled) setState({ status: "error" });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [whatsappInstanceId]);

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
            Não foi possível carregar as etiquetas. Informe o nome manualmente.
          </small>
          <input
            value={fallbackValue}
            onChange={(event) => onFallbackChange(event.target.value)}
            maxLength={160}
            placeholder="Nome exato da etiqueta"
          />
        </div>
      ) : null}

      <small className="action-note">
        Dispara quando o contato entrar nesta lista (evento chat_labels).
      </small>
    </div>
  );
}
