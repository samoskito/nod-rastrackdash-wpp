"use client";

import { useState, type FormEvent } from "react";
import { loginSchema } from "@wpptrack/shared";
import { apiFetch } from "../../lib/api";

export function LoginForm({
  initialError = null,
  googleEnabled = false,
  redirectTo = null,
}: {
  initialError?: string | null;
  googleEnabled?: boolean;
  redirectTo?: string | null;
}) {
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(event.currentTarget);
    const payload = loginSchema.parse({
      email: form.get("email"),
      password: form.get("password"),
    });

    try {
      const session = await apiFetch<{
        user: { platformRole?: string | null };
      }>("/auth/login", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      window.location.href =
        redirectTo ??
        (session.user.platformRole ? "/backoffice/clients" : "/overview");
    } catch {
      setError(
        "Não foi possível autenticar. Confira os dados e tente novamente.",
      );
      setLoading(false);
    }
  }

  return (
    <form className="login-form" onSubmit={handleSubmit}>
      <label>
        Email
        <input type="email" name="email" autoComplete="email" />
      </label>
      <label>
        Senha
        <span className="password-field">
          <input
            type={showPassword ? "text" : "password"}
            name="password"
            autoComplete="current-password"
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
        {loading ? "Processando..." : "Entrar"}
      </button>
      {googleEnabled ? (
        <a
          className="secondary-button"
          href={
            redirectTo
              ? `/login/google?redirectTo=${encodeURIComponent(redirectTo)}`
              : "/login/google"
          }
        >
          Entrar com Google
        </a>
      ) : null}
      <a href="/login/forgot">Esqueci minha senha</a>
    </form>
  );
}
