"use client";

import { useState, type FormEvent } from "react";
import {
  workspaceInviteAcceptInputSchema,
  workspaceInviteNewUserAcceptInputSchema,
  type WorkspaceInviteAcceptDto,
  type WorkspaceInviteInspectionDto,
} from "@wpptrack/shared";
import { apiFetch } from "../../../lib/api";

type ValidInviteInspection = Extract<
  WorkspaceInviteInspectionDto,
  { state: "valid" }
>;

export function InviteAcceptForm({
  inspection,
  token,
  hasSession,
}: {
  inspection: ValidInviteInspection;
  token: string;
  hasSession: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const invitePath = `/invite/accept?token=${encodeURIComponent(token)}`;
  const loginHref = `/login?redirectTo=${encodeURIComponent(invitePath)}`;

  async function acceptExistingUser() {
    setError(null);
    setLoading(true);

    try {
      const payload = workspaceInviteAcceptInputSchema.parse({ token });
      await apiFetch<WorkspaceInviteAcceptDto>("/workspaces/invites/accept", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      window.location.assign("/overview");
    } catch {
      setError(
        "Não foi possível aceitar este convite. Entre com o email convidado ou solicite um novo link.",
      );
      setLoading(false);
    }
  }

  async function acceptNewUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const form = new FormData(event.currentTarget);
      const payload = workspaceInviteNewUserAcceptInputSchema.parse({
        token,
        name: form.get("name"),
        password: form.get("password"),
      });
      await apiFetch<WorkspaceInviteAcceptDto>(
        "/workspaces/invites/accept/new",
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
      );
      window.location.assign("/overview");
    } catch {
      setError(
        "Não foi possível concluir este convite. O link pode ter expirado ou já ter sido utilizado.",
      );
      setLoading(false);
    }
  }

  if (inspection.accountMode === "login") {
    return (
      <div className="login-form">
        {error ? <p className="form-error">{error}</p> : null}
        {hasSession ? (
          <button type="button" disabled={loading} onClick={acceptExistingUser}>
            {loading ? "Confirmando..." : "Aceitar convite"}
          </button>
        ) : (
          <a className="secondary-button" href={loginHref}>
            Entrar para aceitar
          </a>
        )}
        {hasSession ? <a href={loginHref}>Entrar com outra conta</a> : null}
      </div>
    );
  }

  return (
    <form className="login-form" onSubmit={acceptNewUser}>
      <label>
        Nome
        <input
          type="text"
          name="name"
          minLength={2}
          maxLength={120}
          autoComplete="name"
          required
        />
      </label>
      <label>
        Criar senha
        <span className="password-field">
          <input
            type={showPassword ? "text" : "password"}
            name="password"
            minLength={8}
            maxLength={128}
            autoComplete="new-password"
            required
          />
          <button
            type="button"
            className="password-toggle"
            aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
            aria-pressed={showPassword}
            onClick={() => setShowPassword((current) => !current)}
          >
            <span className="password-toggle-icon" aria-hidden="true" />
          </button>
        </span>
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      <button type="submit" disabled={loading}>
        {loading ? "Criando acesso..." : "Criar acesso e entrar"}
      </button>
      <a href="/login">Já tenho uma conta</a>
    </form>
  );
}
