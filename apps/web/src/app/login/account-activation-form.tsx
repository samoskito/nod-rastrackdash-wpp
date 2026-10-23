"use client";

import { useState, type FormEvent } from "react";
import { accountActivationConfirmInputSchema } from "@wpptrack/shared";
import { SecurePasswordInput } from "../../components/secure-password-input";
import { apiFetch } from "../../lib/api";

export function AccountActivationForm({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    const passwordConfirmation = String(form.get("passwordConfirmation") ?? "");

    if (password !== passwordConfirmation) {
      setError("As senhas informadas não são iguais.");
      return;
    }

    const parsed = accountActivationConfirmInputSchema.safeParse({
      token,
      password,
    });

    if (!parsed.success) {
      setError("Use uma senha com pelo menos 8 caracteres.");
      return;
    }

    setLoading(true);

    try {
      await apiFetch("/auth/account/activate", {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      window.location.assign("/overview");
    } catch {
      setError(
        "Este link é inválido, expirou ou já foi utilizado. Solicite um novo envio.",
      );
      setLoading(false);
    }
  }

  return (
    <form className="login-form" onSubmit={handleSubmit}>
      <SecurePasswordInput label="Nova senha" name="password" />
      <SecurePasswordInput
        label="Confirmar senha"
        name="passwordConfirmation"
      />
      {error ? <p className="form-error">{error}</p> : null}
      <button type="submit" disabled={loading}>
        {loading ? "Ativando acesso..." : "Criar senha e acessar"}
      </button>
      <a href="/login">Voltar para login</a>
    </form>
  );
}
