import { BrandMark } from "../../../components/brand";
import { getBrandConfig } from "../../../lib/brand";
import { PasswordResetConfirmForm } from "../password-reset-forms";

type ResetPasswordSearchParams = Record<string, string | string[] | undefined>;

function asStringParam(
  value: string | string[] | undefined
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ResetPasswordPage({
  searchParams
}: {
  searchParams?: Promise<ResetPasswordSearchParams>;
}) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const token = asStringParam(resolvedSearchParams.token)?.trim() ?? "";
  const brand = getBrandConfig();

  if (!token) {
    return (
      <main className="standalone-page login-page">
        <section className="login-panel" aria-labelledby="reset-token-title">
          <div>
            <BrandMark brand={brand} />
            <p className="eyebrow">Acesso seguro</p>
            <h1 id="reset-token-title">Token inválido</h1>
            <p>O link de recuperação não trouxe um token válido para redefinir a senha.</p>
          </div>

          <form className="login-form">
            <a className="secondary-button" href="/login/forgot">
              Solicitar novo link
            </a>
            <a href="/login">Voltar para login</a>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="standalone-page login-page">
      <section className="login-panel" aria-labelledby="reset-password-title">
        <div>
          <BrandMark brand={brand} />
          <p className="eyebrow">Acesso seguro</p>
          <h1 id="reset-password-title">Nova senha</h1>
          <p>Defina uma nova senha para voltar ao painel {brand.name}.</p>
        </div>

        <PasswordResetConfirmForm token={token} />
      </section>
    </main>
  );
}
