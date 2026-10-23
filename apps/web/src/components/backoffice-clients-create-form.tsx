"use client";

import { UserPlus } from "lucide-react";
import { createBackofficeWorkspaceAction } from "../lib/backoffice-clients-actions";
import { BackofficeActionForm } from "./backoffice-action-form";
import { SubmitButton } from "./submit-button";

export function BackofficeClientsCreateForm() {
  return (
    <BackofficeActionForm
      action={createBackofficeWorkspaceAction}
      className="client-admin-form"
      resetOnSuccess
    >
      <label>
        <span>Nome do workspace</span>
        <input name="workspaceName" placeholder="Cliente Exemplo" required />
      </label>

      <label>
        <span>Nome do responsável</span>
        <input name="responsibleName" placeholder="Nome completo" required />
      </label>

      <label>
        <span>E-mail do responsável</span>
        <input
          name="responsibleEmail"
          placeholder="responsável@cliente.com"
          required
          type="email"
        />
      </label>

      <label className="member-manager-toggle">
        <input name="reuseExistingUser" type="checkbox" />
        <span>Reutilizar usuário existente com este e-mail</span>
      </label>

      <div className="form-command-row">
        <span>
          SMTP é opcional. O workspace é criado mesmo sem e-mail configurado;
          se não houver SMTP nesta instância ou o envio falhar, gere e envie
          o link de ativação manual para o responsável na lista abaixo.
        </span>
        <SubmitButton pendingLabel="Criando...">
          <UserPlus aria-hidden="true" size={16} strokeWidth={2} />
          Criar workspace
        </SubmitButton>
      </div>
    </BackofficeActionForm>
  );
}
