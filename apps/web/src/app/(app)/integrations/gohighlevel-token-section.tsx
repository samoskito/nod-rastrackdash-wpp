"use client";

import { ShieldCheck, Trash2 } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";

/**
 * GoHighLevel connection (one per location): the OPTIONAL Private Integration
 * Token that lets the rule screen list the location's pipelines and stages.
 * Write-only: the API only says whether it is saved. Without it the rules
 * simply have no stage filter.
 */
export function GoHighLevelTokenSection({
  configured,
  canManage,
  pending,
  onSave,
  onRemove,
}: {
  configured: boolean;
  canManage: boolean;
  pending: boolean;
  onSave: (token: string) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const token = String(form.get("token") ?? "").trim();
    if (!token) return;
    await onSave(token);
    event.currentTarget.reset();
    setEditing(false);
  }

  return (
    <details
      className="inbound-instance-activity"
      aria-label="Token do GoHighLevel"
    >
      <summary>
        Token do GoHighLevel (opcional) ·{" "}
        {configured ? "configurado" : "não configurado"}
      </summary>
      <p className="muted inbound-counter-note">
        Com o token, a regra deixa você escolher pipeline e etapa numa lista.
        Sem ele, a regra vale para todas as etapas. Para gerar: no GoHighLevel,
        abra Configurações → Private Integrations, crie uma integração com o
        escopo opportunities.readonly (leitura de oportunidades) e copie o
        token. Depois de salvo, o token não é exibido de novo.
      </p>
      {canManage ? (
        editing || !configured ? (
          <form className="inbound-webhook-create" onSubmit={handleSubmit}>
            <label>
              <span className="field-label">
                {configured ? "Novo token" : "Token (Private Integration)"}
              </span>
              <input
                name="token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                minLength={20}
                maxLength={512}
                required
                disabled={pending}
              />
            </label>
            <button className="button primary" type="submit" disabled={pending}>
              <ShieldCheck size={16} aria-hidden="true" />
              {pending ? "Salvando..." : "Salvar token"}
            </button>
            {configured ? (
              <button
                className="button"
                type="button"
                disabled={pending}
                onClick={() => setEditing(false)}
              >
                Cancelar
              </button>
            ) : null}
          </form>
        ) : (
          <div className="inbound-connection-actions">
            <button
              className="button"
              type="button"
              disabled={pending}
              onClick={() => setEditing(true)}
            >
              Trocar token
            </button>
            <button
              className="button"
              type="button"
              disabled={pending}
              onClick={() => void onRemove()}
            >
              <Trash2 size={16} aria-hidden="true" />
              Remover token
            </button>
          </div>
        )
      ) : null}
    </details>
  );
}
