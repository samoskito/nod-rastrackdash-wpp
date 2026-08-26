"use client";

import type { BackofficeWorkspaceResponsibleDto } from "@wpptrack/shared";
import { resendActivationEmailAction } from "../lib/backoffice-clients-actions";
import { BackofficeActionForm } from "./backoffice-action-form";
import { BackofficeClientsActivationLinkForm } from "./backoffice-clients-activation-link-form";
import { PendingSubmitButton } from "./pending-submit-button";

export function BackofficeClientsResponsibleCell({
  workspaceId,
  responsible,
}: {
  workspaceId: string;
  responsible: BackofficeWorkspaceResponsibleDto | null;
}) {
  if (!responsible) {
    return <span className="muted">Sem responsável cadastrado</span>;
  }

  const pending = responsible.status === "pending_activation";

  return (
    <div className="client-operator-list">
      <div>
        <strong>{responsible.name ?? responsible.email}</strong>
        <br />
        <small>{responsible.email}</small>{" "}
        <span className={`status-chip${pending ? " warn" : ""}`}>
          {pending ? "Ativação pendente" : "Ativo"}
        </span>
      </div>

      {pending ? (
        <div className="client-operator-actions">
          <BackofficeActionForm action={resendActivationEmailAction}>
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <input name="ownerUserId" type="hidden" value={responsible.id} />
            <PendingSubmitButton
              className="button ghost compact-button"
              label="Reenviar e-mail"
              pendingLabel="Enviando..."
            />
          </BackofficeActionForm>

          <BackofficeClientsActivationLinkForm
            ownerUserId={responsible.id}
            workspaceId={workspaceId}
          />
        </div>
      ) : null}
    </div>
  );
}
