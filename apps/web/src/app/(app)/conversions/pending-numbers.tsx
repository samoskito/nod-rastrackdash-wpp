"use client";

import type { ProviderConversionRulePendingNumberDto } from "@wpptrack/shared";
import { AlertTriangle, ArrowUpRight, Play } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { PresentationMask } from "../../../components/presentation-mask";
import type { ConversionScreenActionResult } from "./actions";
import {
  pendingNumbersTitle,
  pendingNumberViews,
  type ConversionNumber,
} from "./conversion-rules-view";

type ActivateAction = (
  formData: FormData,
) => Promise<ConversionScreenActionResult>;

const integrationsHref = "/integrations";

/**
 * Aviso de uma regra para todos os números cujos números cobertos ainda não
 * enviam todos (porte do incidente do SaaS: toda decisão ficava bloqueada
 * porque os números nunca eram ativados). Regras em produção listam todos os
 * números pendentes; uma regra ainda em observação lista só o que ativar a
 * regra NÃO resolve (conexão WhatsApp não ativa, rota Meta, conexão pausada), já
 * que os demais números passam a enviar junto com ela.
 */
export function PendingNumbersWarning({
  ruleId,
  pendingNumbers,
  numbers,
  mode,
  canManage,
  activateAction,
  onChanged,
}: {
  ruleId: string;
  pendingNumbers: readonly ProviderConversionRulePendingNumberDto[];
  numbers: readonly ConversionNumber[];
  mode: "observation" | "production" | null;
  canManage: boolean;
  activateAction?: ActivateAction;
  onChanged?: () => void;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "warn";
    message: string;
  } | null>(null);
  const all = pendingNumberViews(pendingNumbers, numbers, mode);
  const views =
    mode === "production"
      ? all
      : all.filter((view) => view.action === "integrations");
  const autoPromoted = all.length - views.length;

  if (views.length === 0 && !feedback) return null;

  async function activate(channelId: string, label: string) {
    if (!activateAction || pendingId) return;
    if (
      !window.confirm(
        `Ativar o envio de ${label}? As próximas conversas reconhecidas nele passam a ser enviadas para a Meta.`,
      )
    ) {
      return;
    }
    setPendingId(channelId);
    setFeedback(null);
    const formData = new FormData();
    formData.set("ruleId", ruleId);
    formData.set("channelId", channelId);
    try {
      const result = await activateAction(formData);
      setFeedback({
        tone: result.ok ? "success" : "warn",
        message: result.message,
      });
      if (result.ok || result.numberActivation) onChanged?.();
    } catch {
      setFeedback({
        tone: "warn",
        message:
          "Não deu para confirmar a ativação. Atualize a página para conferir o número.",
      });
    } finally {
      setPendingId(null);
    }
  }

  return (
    <section
      className="conversion-pending-numbers"
      aria-label="Números que ainda não enviam"
      data-mode={mode ?? "unknown"}
    >
      {views.length > 0 ? (
        <>
          <p className="conversion-pending-title">
            <AlertTriangle size={15} aria-hidden="true" />
            <strong>{pendingNumbersTitle(views.length, mode)}</strong>
          </p>
          <p className="conversion-pending-lead">
            {mode === "production"
              ? "A regra vale para todos os números, mas as conversas destes ficam bloqueadas até o envio deles estar ativo:"
              : "Os outros números passam a enviar junto com a regra. Estes precisam de uma ação antes:"}
          </p>
          <ul className="conversion-pending-list" role="list">
            {views.map((view) => (
              <li key={view.channelId}>
                <div className="conversion-pending-number">
                  <strong>
                    <PresentationMask placeholder="Número oculto">
                      {view.label}
                    </PresentationMask>
                  </strong>
                  <small>{view.detail}</small>
                </div>
                {canManage && view.action === "activate" && activateAction ? (
                  <button
                    className="button ghost compact-button"
                    type="button"
                    disabled={pendingId !== null}
                    data-pending={pendingId === view.channelId ? "true" : undefined}
                    onClick={() => void activate(view.channelId, view.label)}
                  >
                    <Play size={14} aria-hidden="true" />
                    {pendingId === view.channelId
                      ? "Ativando..."
                      : "Ativar envio neste número"}
                  </button>
                ) : canManage && view.action === "integrations" ? (
                  <Link
                    className="button ghost compact-button"
                    href={integrationsHref}
                  >
                    Resolver em Integrações
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
          {mode !== "production" && autoPromoted > 0 ? (
            <p className="conversion-pending-lead">
              {autoPromoted === 1
                ? "Outro número passa a enviar assim que você ativar o envio automático."
                : `Outros ${autoPromoted} números passam a enviar assim que você ativar o envio automático.`}
            </p>
          ) : null}
        </>
      ) : null}
      {feedback ? (
        <p className={`action-note${feedback.tone === "warn" ? " warn" : ""}`} role="status">
          {feedback.message}
        </p>
      ) : null}
    </section>
  );
}
