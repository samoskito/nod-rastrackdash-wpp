import { EmailVerificationConfirmForm } from "../email-verification-form";

type EmailVerificationSearchParams = Record<
  string,
  string | string[] | undefined
>;

function asStringParam(
  value: string | string[] | undefined
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function EmailVerificationPage({
  searchParams
}: {
  searchParams?: Promise<EmailVerificationSearchParams>;
}) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const token = asStringParam(resolvedSearchParams.token)?.trim() ?? "";

  if (!token) {
    return (
      <main className="standalone-page login-page">
        <section className="login-panel" aria-labelledby="verify-token-title">
          <div>
            <span className="brand-mark" aria-hidden="true">
              W
            </span>
            <p className="eyebrow">Acesso seguro</p>
            <h1 id="verify-token-title">Token inválido</h1>
            <p>O link de verificação não trouxe um token válido para confirmar o email.</p>
          </div>

          <form className="login-form">
            <a className="secondary-button" href="/settings">
              Voltar para configurações
            </a>
            <a href="/login">Voltar para login</a>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="standalone-page login-page">
      <section className="login-panel" aria-labelledby="verify-email-title">
        <div>
          <span className="brand-mark" aria-hidden="true">
            W
          </span>
          <p className="eyebrow">Acesso seguro</p>
          <h1 id="verify-email-title">Confirmar email</h1>
          <p>Valide o email da conta para manter o acesso seguro ao painel WppTrack.</p>
        </div>

        <EmailVerificationConfirmForm token={token} />
      </section>
    </main>
  );
}
