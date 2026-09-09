"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  deleteBackofficeWorkspaceAction,
  type BackofficeClientsActionState,
} from "../lib/backoffice-clients-actions";
import { PendingSubmitButton } from "./pending-submit-button";

const initialState: BackofficeClientsActionState = {
  status: "idle",
  message: "",
  nonce: 0,
};

/**
 * Destructive action, so it stays collapsed behind an explicit "Excluir"
 * click and only becomes submittable once the operator types the exact
 * workspace slug (shown on screen, not hidden in a tooltip). The slug check
 * happens client-side for a responsive UI and again in the server action,
 * which never calls the API on a missing/mismatched confirmation.
 */
export function BackofficeClientsDeleteWorkspaceForm({
  workspaceId,
  workspaceName,
  workspaceSlug,
}: {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
}) {
  const [state, formAction] = useActionState(
    deleteBackofficeWorkspaceAction,
    initialState,
  );
  const [isOpen, setIsOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const handledNonceRef = useRef(0);
  const isConfirmed = confirmation.trim() === workspaceSlug;

  useEffect(() => {
    if (!state.nonce || handledNonceRef.current === state.nonce) {
      return;
    }

    handledNonceRef.current = state.nonce;

    if (state.status === "success") {
      setIsOpen(false);
      setConfirmation("");
    }
  }, [state]);

  function handleCancel() {
    setIsOpen(false);
    setConfirmation("");
  }

  if (!isOpen) {
    return (
      <div className="delete-workspace-action">
        <button
          aria-label={`Excluir workspace ${workspaceName}`}
          className="button danger compact-button"
          onClick={() => setIsOpen(true)}
          type="button"
        >
          Excluir
        </button>
        {state.status === "success" && state.nonce ? (
          <p className="action-note" role="status">
            {state.message}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="delete-workspace-action">
      <p className="action-note warn">
        Esta ação não pode ser desfeita. Para confirmar, digite o slug{" "}
        <strong>{workspaceSlug}</strong> abaixo.
      </p>
      <form action={formAction}>
        <input name="workspaceId" type="hidden" value={workspaceId} />
        <input name="workspaceName" type="hidden" value={workspaceName} />
        <input name="workspaceSlug" type="hidden" value={workspaceSlug} />
        <label>
          <span>Slug do workspace</span>
          <input
            aria-label={`Confirmar exclusão do workspace ${workspaceName} digitando o slug`}
            autoComplete="off"
            name="confirmation"
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder={workspaceSlug}
            type="text"
            value={confirmation}
          />
        </label>
        <div className="delete-workspace-action-buttons">
          <PendingSubmitButton
            className="button danger compact-button"
            disabled={!isConfirmed}
            label="Confirmar exclusão"
            pendingLabel="Excluindo..."
          />
          <button
            className="button ghost compact-button"
            onClick={handleCancel}
            type="button"
          >
            Cancelar
          </button>
        </div>
      </form>
      {state.status === "error" && state.nonce ? (
        <p className="action-note warn" role="alert">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
