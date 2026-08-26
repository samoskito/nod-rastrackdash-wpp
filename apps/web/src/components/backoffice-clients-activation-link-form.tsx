"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  generateActivationLinkAction,
  type BackofficeClientsActionState,
} from "../lib/backoffice-clients-actions";
import { formatDateTime } from "../lib/date-time";
import { CopyLinkButton } from "./copy-link-button";
import { PendingSubmitButton } from "./pending-submit-button";

const initialState: BackofficeClientsActionState = {
  status: "idle",
  message: "",
  nonce: 0,
};

/**
 * The manual activation link is one-time and shown once: it lives only in
 * this component's local state (never in a global store, never logged) and
 * disappears the moment the operator navigates away or requests a new one.
 */
export function BackofficeClientsActivationLinkForm({
  workspaceId,
  ownerUserId,
}: {
  workspaceId: string;
  ownerUserId: string;
}) {
  const [state, formAction, isPending] = useActionState(
    generateActivationLinkAction,
    initialState,
  );
  const [link, setLink] = useState<{ expiresAt: string; url: string } | null>(
    null,
  );
  const handledNonceRef = useRef(0);

  // Clear any previously shown link the moment a new submission starts, so a
  // failed regeneration never leaves a stale link on screen.
  useEffect(() => {
    if (isPending) {
      setLink(null);
    }
  }, [isPending]);

  useEffect(() => {
    if (!state.nonce || handledNonceRef.current === state.nonce) {
      return;
    }

    handledNonceRef.current = state.nonce;

    if (
      state.status === "success" &&
      state.activationUrl &&
      state.activationExpiresAt
    ) {
      setLink({
        expiresAt: state.activationExpiresAt,
        url: state.activationUrl,
      });
    } else if (state.status === "error") {
      setLink(null);
    }
  }, [state]);

  return (
    <div className="link-result-action">
      <form action={formAction}>
        <input name="workspaceId" type="hidden" value={workspaceId} />
        <input name="ownerUserId" type="hidden" value={ownerUserId} />
        <PendingSubmitButton
          className="button ghost compact-button"
          label="Gerar link de ativação"
          pendingLabel="Gerando..."
        />
      </form>

      {state.status === "error" && state.nonce ? (
        <p className="action-note warn" role="alert">
          {state.message}
        </p>
      ) : null}

      {link ? (
        <>
          <p className="action-note warn">
            Este link é exibido apenas uma vez. Copie agora.
          </p>
          <div className="link-result-box">
            <input
              onFocus={(event) => event.currentTarget.select()}
              readOnly
              value={link.url}
            />
            <CopyLinkButton url={link.url} />
          </div>
          <p className="muted">Expira em {formatDateTime(link.expiresAt)}</p>
        </>
      ) : null}
    </div>
  );
}
