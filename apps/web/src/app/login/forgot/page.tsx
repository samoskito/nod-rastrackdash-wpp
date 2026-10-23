import { PasswordResetRequestForm } from "../password-reset-forms";

export default async function ForgotPasswordPage() {
  return (
    <main className="standalone-page login-page">
      <section className="login-panel" aria-labelledby="forgot-password-title">
        <div>
          <span className="brand-mark" aria-hidden="true">
            W
          </span>
          <p className="eyebrow">Acesso seguro</p>
          <h1 id="forgot-password-title">Recuperar senha</h1>
          <p>
            Informe o email da sua conta. O backend registra um token de recuperação e envia as
            instruções quando o provedor de email estiver configurado.
          </p>
        </div>

        <PasswordResetRequestForm />
      </section>
    </main>
  );
}
