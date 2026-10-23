"use client";

import { useState, type FormEvent } from "react";
import {
  passwordResetConfirmInputSchema,
  passwordResetRequestInputSchema,
  type PasswordResetRequestDto,
} from "@wpptrack/shared";
import { apiFetch } from "../../lib/api";

export function PasswordResetRequestForm() {
  const [message, setMessage] = useState<string | null>(null);
  const [devToken, setDevToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setDevToken(null);
    setError(null);
    setLoading(true);

    const form = new FormData(event.currentTarget);
    const payload = passwordResetRequestInputSchema.parse({
      email: form.get("email"),
    });

    try {
      const result = await apiFetch<PasswordResetRequestDto>(
        "/auth/password/forgot",
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
      );

      setMessage(
        "Se houver uma conta elegível para este email, enviaremos as instruções de recuperação.",
      );
      setDevToken(result.devToken);
    } catch {
      setError("Não foi possível solicitar a recuperação agora.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="login-form" onSubmit={handleSubmit}>
      <label>
        Email
        <input type="email" name="email" autoComplete="email" />
      </label>
      {message ? <p className="form-success">{message}</p> : null}
      {devToken ? (
        <p className="form-success">
          Token de desenvolvimento: <code>{devToken}</code>
        </p>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
      <button type="submit" disabled={loading}>
        {loading ? "Enviando..." : "Enviar link de recuperação"}
      </button>
      <a href="/login">Voltar para login</a>
    </form>
  );
}

export function PasswordResetConfirmForm({ token }: { token: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    setLoading(true);

    const form = new FormData(event.currentTarget);
    const payload = passwordResetConfirmInputSchema.parse({
      token: form.get("token"),
      password: form.get("password"),
    });

    try {
      await apiFetch("/auth/password/reset", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setMessage("Senha redefinida. Você já pode entrar novamente.");
    } catch {
      setError("Este link é inválido, expirou ou já foi utilizado.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="login-form" onSubmit={handleSubmit}>
      <input type="hidden" name="token" value={token} />
      <label>
        Nova senha
        <input type="password" name="password" autoComplete="new-password" />
      </label>
      {message ? <p className="form-success">{message}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
      <button type="submit" disabled={loading}>
        {loading ? "Redefinindo..." : "Redefinir senha"}
      </button>
      <a href="/login">Voltar para login</a>
    </form>
  );
}
