"use client";

import { Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Modal } from "../../../components/modal";
import { PresentationMask } from "../../../components/presentation-mask";
import type { ConversionScreenActionResult } from "./actions";
import type { ConversionRuleRow } from "./conversion-rules-view";

/**
 * "Excluir selecionadas" of the Conversions list. Deleting a rule that was
 * folded into a rule for all numbers ("unificada") stops its OLD URL from
 * being forwarded, so the confirmation shows, per rule, when that URL last
 * received an event and warns when it is still in use.
 */

type BulkAction = (formData: FormData) => Promise<ConversionScreenActionResult>;

/** An old URL that received an event in this window is "still in use". */
export const oldUrlRecentDays = 7;

export type BulkDeleteKind =
  /** "Vale para todos os números": other rules were unified into it. */
  | "target"
  /** Unified into another rule; its old URL still forwards events. */
  | "unified"
  /** Its number/connection was removed: nothing can reach it any more. */
  | "orphan"
  | "plain";

export type BulkDeleteItem = {
  row: ConversionRuleRow;
  kind: BulkDeleteKind;
  /** Last event through the old URL (unified rules only). */
  lastOldUrlEventAt: string | null;
  /** The old URL got an event in the last oldUrlRecentDays days. */
  stillReceiving: boolean;
};

export function bulkDeleteKind(row: ConversionRuleRow): BulkDeleteKind {
  if (row.isUnifyTarget) return "target";
  if (row.numberRemoved) return "orphan";
  if (row.unifiedIntoRuleId) return "unified";
  return "plain";
}

export function bulkDeleteItems(
  rows: readonly ConversionRuleRow[],
  now: number = Date.now(),
): BulkDeleteItem[] {
  const windowMs = oldUrlRecentDays * 24 * 60 * 60 * 1000;
  return rows.map((row) => {
    const kind = bulkDeleteKind(row);
    const lastOldUrlEventAt =
      kind === "unified" ? (row.oldUrlLastDeliveryAt ?? null) : null;
    const lastTime = lastOldUrlEventAt ? Date.parse(lastOldUrlEventAt) : NaN;
    return {
      row,
      kind,
      lastOldUrlEventAt,
      stillReceiving:
        kind === "unified" && Number.isFinite(lastTime) && now - lastTime <= windowMs,
    };
  });
}

/**
 * Shortcut "Selecionar unificadas e de número removido": provider rules that
 * are paused because they were folded into another rule, or whose number was
 * removed. The rule that "vale para todos os números" is never included.
 */
export function cleanupCandidateIds(rows: readonly ConversionRuleRow[]): string[] {
  return rows
    .filter(
      (row) =>
        row.kind === "provider" &&
        !row.isUnifyTarget &&
        (row.status === "unified" || (!row.active && row.numberRemoved === true)),
    )
    .map((row) => row.id);
}

export function oldUrlWarningText(providerName: string | null | undefined): string {
  // nod: "no Unnichat", "na Umbler", "na plataforma".
  const where =
    providerName === "Unnichat"
      ? "no Unnichat"
      : `na ${providerName ?? "plataforma"}`;
  return `Ainda recebe eventos pela URL antiga — troque a URL ${where} antes de excluir.`;
}

function formatDay(value: string): string {
  return new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  });
}

export function BulkDeleteModal({
  open,
  rows: currentRows,
  action,
  onClose,
  onDone,
}: {
  open: boolean;
  rows: ConversionRuleRow[];
  action: BulkAction;
  onClose: () => void;
  /** Rules removed (fully or partly): the caller refreshes and clears them. */
  onDone: (removedIds: string[], message: string, allRemoved: boolean) => void;
}) {
  // The dialog is about the rules chosen when it opened: the list refreshing
  // behind it (after a partial success) must not change what it shows.
  const [rows] = useState(currentRows);
  const items = useMemo(() => bulkDeleteItems(rows), [rows]);
  const [confirmedTargets, setConfirmedTargets] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<
    { ruleId: string; status: string; message: string | null }[] | null
  >(null);

  const targets = items.filter((item) => item.kind === "target");
  const unconfirmed = targets.some((item) => !confirmedTargets.has(item.row.id));
  const names = new Map(rows.map((row) => [row.id, row.name]));

  async function submit() {
    if (pending || unconfirmed || rows.length === 0) return;
    setPending(true);
    setError(null);
    const formData = new FormData();
    for (const row of rows) formData.append("ruleId", row.id);
    for (const item of targets) formData.append("confirmTargetId", item.row.id);
    try {
      const result = await action(formData);
      const report = result.bulkRemove;
      if (report) {
        const removed = report.results
          .filter((item) => item.status === "removed")
          .map((item) => item.ruleId);
        if (report.results.every((item) => item.status === "removed")) {
          onDone(removed, result.message, true);
          return;
        }
        setOutcome(report.results.filter((item) => item.status !== "removed"));
        if (removed.length > 0) onDone(removed, result.message, false);
      } else {
        setError(result.message);
      }
    } catch {
      setError(
        "Não deu para confirmar a exclusão. Atualize a página para ver quais regras saíram.",
      );
    }
    setPending(false);
  }

  return (
    <Modal
      open={open}
      onClose={() => (pending ? undefined : onClose())}
      title={`Excluir ${rows.length} ${rows.length === 1 ? "regra" : "regras"}?`}
      description="Elas param de reconhecer conversões na hora. O histórico continua salvo. Não dá para desfazer."
      size="wide"
      id="conversion-bulk-delete"
    >
      <div className="conversion-confirm conversion-bulk-delete">
        {outcome ? (
          <>
            <p className="action-note warn" role="alert">
              Algumas regras não foram excluídas. As outras já saíram da lista.
            </p>
            <ul className="conversion-bulk-list" role="list">
              {outcome.map((item) => (
                <li key={item.ruleId} className="conversion-bulk-item">
                  <strong>
                    <PresentationMask placeholder="Regra oculta">
                      {names.get(item.ruleId) ?? item.ruleId}
                    </PresentationMask>
                  </strong>
                  <small>{item.message ?? "Não foi possível excluir."}</small>
                </li>
              ))}
            </ul>
            <div className="conversion-flow-actions">
              <button className="button" type="button" onClick={onClose}>
                Concluir
              </button>
            </div>
          </>
        ) : (
          <>
            <ul className="conversion-bulk-list" role="list">
              {items.map((item) => (
                <li key={item.row.id} className="conversion-bulk-item">
                  <strong>
                    <PresentationMask placeholder="Regra oculta">
                      {item.row.name}
                    </PresentationMask>
                  </strong>
                  <small>
                    {item.row.eventLabel} · {item.row.statusLabel}
                    {item.kind === "orphan" ? " · número removido" : ""}
                  </small>
                  {item.kind === "unified" ? (
                    <small className="conversion-bulk-old-url">
                      Último evento pela URL antiga:{" "}
                      {item.lastOldUrlEventAt ? (
                        <time dateTime={item.lastOldUrlEventAt}>
                          {formatDay(item.lastOldUrlEventAt)}
                        </time>
                      ) : (
                        "nenhum"
                      )}
                    </small>
                  ) : null}
                  {item.stillReceiving ? (
                    <p className="action-note warn conversion-bulk-warning" role="alert">
                      {oldUrlWarningText(item.row.providerName)}
                    </p>
                  ) : null}
                  {item.kind === "target" ? (
                    <div className="feedback-banner warn conversion-bulk-target" role="alert">
                      <strong>Esta é a regra que vale para todos os números</strong>
                      <span>
                        Outras regras unificadas encaminham as URLs antigas para
                        ela. Excluir esta regra para de reconhecer conversões
                        em todos os números.
                      </span>
                      <label className="conversion-check">
                        <input
                          type="checkbox"
                          checked={confirmedTargets.has(item.row.id)}
                          onChange={(event) => {
                            const next = new Set(confirmedTargets);
                            if (event.target.checked) next.add(item.row.id);
                            else next.delete(item.row.id);
                            setConfirmedTargets(next);
                          }}
                        />
                        <span>
                          Quero excluir também “
                          <PresentationMask placeholder="Regra oculta">
                            {item.row.name}
                          </PresentationMask>
                          ”
                        </span>
                      </label>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
            {error ? (
              <p className="action-note warn" role="alert">
                {error}
              </p>
            ) : null}
            <div className="conversion-flow-actions">
              <button
                className="button"
                type="button"
                onClick={onClose}
                disabled={pending}
              >
                Cancelar
              </button>
              <button
                className="button danger"
                type="button"
                onClick={() => void submit()}
                disabled={pending || unconfirmed}
                data-pending={pending ? "true" : undefined}
              >
                <Trash2 size={15} aria-hidden="true" />
                {pending
                  ? "Excluindo..."
                  : `Excluir ${rows.length} ${rows.length === 1 ? "regra" : "regras"}`}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
