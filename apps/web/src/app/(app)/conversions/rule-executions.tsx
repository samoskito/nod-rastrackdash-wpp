"use client";

import type { ProviderConversionRuleExecutionAuditDto } from "@wpptrack/shared";
import { formatMoney } from "@wpptrack/shared";
import { ArrowUpRight, RefreshCw, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PresentationMask } from "../../../components/presentation-mask";
import { executionReasonLabel } from "../settings/provider-conversion-labels";
import type {
  ConversionScreenActionResult,
  ProviderConversionRuleActionResult,
} from "./actions";

type LoadAction = (
  formData: FormData,
) => Promise<ProviderConversionRuleActionResult>;

type ReprocessAction = (
  formData: FormData,
) => Promise<ConversionScreenActionResult>;

const statusLabels: Record<
  ProviderConversionRuleExecutionAuditDto["items"][number]["status"],
  { label: string; tone: "" | "warn" | "bad" | "neutral" }
> = {
  observed: { label: "Reconhecida em observação", tone: "neutral" },
  eligible: { label: "Na fila de envio", tone: "neutral" },
  materialized: { label: "Evento enviado", tone: "" },
  duplicate: { label: "Repetida", tone: "warn" },
  blocked: { label: "Bloqueada", tone: "warn" },
  failed: { label: "Falhou", tone: "bad" },
};

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  });
}

/**
 * Last executions of one rule (GET .../executions), the same audit the old
 * view shows, read on demand when the modal opens.
 */
export function RuleExecutions({
  ruleId,
  loadAction,
  purchaseReviewHref = null,
  canManage = false,
  reprocessAction,
}: {
  ruleId: string;
  loadAction: LoadAction;
  /** Purchase rules: where each recognized purchase is reviewed. */
  purchaseReviewHref?: string | null;
  /** Quem gerencia integrações e com a licença liberada. */
  canManage?: boolean;
  /** "Reprocessar bloqueadas" (só para quem gerencia). */
  reprocessAction?: ReprocessAction;
}) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "loaded"; audit: ProviderConversionRuleExecutionAuditDto }
  >({ status: "loading" });
  const [reprocessing, setReprocessing] = useState(false);
  const [reprocessNote, setReprocessNote] = useState<{
    tone: "success" | "warn";
    message: string;
  } | null>(null);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    const formData = new FormData();
    formData.set("ruleId", ruleId);
    try {
      const result = await loadAction(formData);
      setState(
        result.ok && result.executionAudit
          ? { status: "loaded", audit: result.executionAudit }
          : { status: "error", message: result.message },
      );
    } catch {
      setState({
        status: "error",
        message: "Não foi possível carregar as execuções agora.",
      });
    }
  }, [loadAction, ruleId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function reprocess() {
    if (!reprocessAction || reprocessing) return;
    setReprocessing(true);
    setReprocessNote(null);
    const formData = new FormData();
    formData.set("ruleId", ruleId);
    try {
      const result = await reprocessAction(formData);
      setReprocessNote({
        tone:
          result.ok && (result.reprocess?.reprocessed ?? 0) > 0
            ? "success"
            : "warn",
        message: result.message,
      });
      if (result.ok) await load();
    } catch {
      setReprocessNote({
        tone: "warn",
        message:
          "Não deu para confirmar o reprocessamento. Atualize as execuções: repetir não envia nada duas vezes.",
      });
    } finally {
      setReprocessing(false);
    }
  }

  if (state.status === "loading") {
    return (
      <p className="muted" role="status">
        Carregando execuções...
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <div className="conversion-executions-error" role="alert">
        <p className="action-note warn">{state.message}</p>
        <button className="button" type="button" onClick={() => void load()}>
          <RefreshCw size={15} aria-hidden="true" />
          Tentar de novo
        </button>
      </div>
    );
  }

  const { audit } = state;

  return (
    <div className="conversion-executions">
      <dl className="conversion-executions-summary">
        <div>
          <dt>Total</dt>
          <dd>{audit.summary.total}</dd>
        </div>
        <div>
          <dt>Enviadas</dt>
          <dd>{audit.summary.materialized}</dd>
        </div>
        <div>
          <dt>Em observação</dt>
          <dd>{audit.summary.observed}</dd>
        </div>
        <div>
          <dt>Bloqueadas ou com falha</dt>
          <dd>{audit.summary.blocked + audit.summary.failed}</dd>
        </div>
      </dl>
      <BlockedReprocessPanel
        summary={audit.blockedReprocess}
        canManage={canManage && Boolean(reprocessAction)}
        pending={reprocessing}
        note={reprocessNote}
        onReprocess={() => void reprocess()}
      />
      {audit.items.length === 0 ? (
        <p className="muted">
          Esta regra ainda não reconheceu nenhuma conversa.
        </p>
      ) : (
        <ul className="conversion-executions-list" role="list">
          {audit.items.map((item) => {
            const status = statusLabels[item.status];
            return (
              <li key={item.executionId}>
                <div className="conversion-executions-head">
                  <span
                    className={`status-chip${status.tone ? ` ${status.tone}` : ""}`}
                  >
                    {status.label}
                  </span>
                  <time dateTime={item.occurredAt}>
                    {formatDateTime(item.occurredAt)}
                  </time>
                </div>
                <p>{executionReasonLabel(item.reasonCode)}</p>
                <p className="muted">
                  {item.channel ? (
                    <PresentationMask placeholder="Número oculto">
                      {item.channel.name ?? item.channel.connectedPhone}
                    </PresentationMask>
                  ) : (
                    "Número não identificado"
                  )}
                  {item.leadName || item.phoneDisplay ? (
                    <>
                      {" · "}
                      <PresentationMask placeholder="Lead oculto">
                        {item.leadName ?? item.phoneDisplay}
                      </PresentationMask>
                    </>
                  ) : null}
                  {item.valueCents && item.currency
                    ? ` · ${formatMoney(item.valueCents, item.currency)}`
                    : ""}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {audit.pagination.totalItems > audit.items.length ? (
        <p className="action-note">
          Mostrando as {audit.items.length} mais recentes de{" "}
          {audit.pagination.totalItems}.
        </p>
      ) : null}
      {purchaseReviewHref ? (
        <Link className="conversion-inline-link" href={purchaseReviewHref}>
          Revisar as compras desta regra
          <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}

function countLabel(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * "Reprocessar bloqueadas": conversas paradas só porque o número ainda não
 * enviava. Habilitado só quando ao menos uma está pronta (o número já envia
 * e a conversa está dentro da janela de 7 dias da Meta).
 */
function BlockedReprocessPanel({
  summary,
  canManage,
  pending,
  note,
  onReprocess,
}: {
  summary: ProviderConversionRuleExecutionAuditDto["blockedReprocess"];
  canManage: boolean;
  pending: boolean;
  note: { tone: "success" | "warn"; message: string } | null;
  onReprocess: () => void;
}) {
  if (!summary) return null;
  const rulePaused = summary.ruleSendsNow === false;
  const total = summary.ready + summary.stillBlocked + summary.expired;
  if (total === 0 && !note) return null;

  return (
    <section
      className="conversion-reprocess"
      aria-label="Conversas bloqueadas antes do envio"
    >
      {total > 0 ? (
        <>
          <p className="conversion-reprocess-title">
            <strong>
              {countLabel(
                total,
                "conversa bloqueada antes do envio",
                "conversas bloqueadas antes do envio",
              )}
            </strong>
          </p>
          <ul className="conversion-reprocess-counts" role="list">
            <li>
              <span className="status-chip">{summary.ready}</span>{" "}
              {summary.ready === 1 ? "pronta para reenviar" : "prontas para reenviar"}
            </li>
            <li>
              <span className="status-chip warn">{summary.stillBlocked}</span>{" "}
              {summary.stillBlocked === 1 ? "fica como está" : "ficam como estão"}
            </li>
            <li>
              <span className="status-chip neutral">{summary.expired}</span>{" "}
              {summary.expired === 1 ? "expirada" : "expiradas"} (mais de{" "}
              {summary.windowDays} dias)
            </li>
          </ul>
          <p className="muted">
            Reenviamos só conversas dos últimos {summary.windowDays} dias
            (limite da Meta) e nunca enviamos a mesma conversão duas vezes.
            Conversas de números sem envio ativo, pausados de propósito na época
            ou que não são QR ficam como estão.
          </p>
          {rulePaused ? (
            <p className="action-note warn">
              A regra está pausada ou em observação: nada é reenviado até
              você ativar o envio automático dela.
            </p>
          ) : summary.ready === 0 && summary.stillBlocked > 0 ? (
            <p className="action-note warn">
              Nenhuma destas conversas pode ser reenviada agora. Se o número
              ainda não envia, ative o envio dele e depois reprocesse.
            </p>
          ) : null}
          {canManage && !rulePaused ? (
            <button
              className="button compact-button"
              type="button"
              disabled={pending || summary.ready === 0}
              data-pending={pending ? "true" : undefined}
              onClick={onReprocess}
            >
              <RotateCcw size={14} aria-hidden="true" />
              {pending ? "Reprocessando..." : "Reprocessar bloqueadas"}
            </button>
          ) : null}
        </>
      ) : null}
      {note ? (
        <p
          className={`action-note${note.tone === "warn" ? " warn" : ""}`}
          role="status"
        >
          {note.message}
        </p>
      ) : null}
    </section>
  );
}
