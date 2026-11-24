"use client";

import { TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";

type MetaRouteSimulationDialogProps = {
  open: boolean;
  title: string;
  /** One paragraph per line. */
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Confirm shown only when the simulation says leads would be blocked. */
export function MetaRouteSimulationDialog({
  open,
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: MetaRouteSimulationDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) {
      return;
    }

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      className="meta-action-dialog meta-route-simulation-dialog"
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="meta-action-dialog-header">
        <div>
          <span className="micro-label">Confirmar alteração</span>
          <h3 id={titleId}>{title}</h3>
        </div>
        <button
          className="meta-dialog-close"
          type="button"
          aria-label="Fechar confirmação"
          title="Fechar"
          onClick={onCancel}
        >
          <X size={17} aria-hidden="true" />
        </button>
      </div>
      <div className="meta-action-form">
        <div className="meta-disconnect-warning">
          <TriangleAlert size={20} aria-hidden="true" />
          <div>
            {message.split("\n").map((line, index) => (
              <p key={`${index}-${line}`}>{line}</p>
            ))}
          </div>
        </div>
        <div className="meta-action-dialog-footer">
          <button className="button" type="button" onClick={onCancel}>
            Cancelar
          </button>
          <button className="button danger" type="button" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
