import { AccountActivationForm } from "../account-activation-form";

type ActivationSearchParams = Record<string, string | string[] | undefined>;

function asStringParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AccountActivationPage({
  searchParams,
}: {
  searchParams?: Promise<ActivationSearchParams>;
}) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const token = asStringParam(resolvedSearchParams.token)?.trim() ?? "";

  if (!token) {
    return (
      <main className="standalone-page login-page">
        <section
          className="login-panel"
          aria-labelledby="activation-token-title"
        >
          <div>
            <span className="brand-mark" aria-hidden="true">
              W
            </span>
            <p className="eyebrow">Primeiro acesso</p>
            <h1 id="activation-token-title">Link indisponível</h1>
            <p>
              Este link é inválido, expirou ou já foi utilizado. Solicite um
              novo envio ao responsável pelo seu acesso.
            </p>
          </div>

          <form className="login-form">
            <a className="secondary-button" href="mailto:suporte@rastrack.app">
              Falar com o suporte
            </a>
            <a href="/login">Voltar para login</a>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="standalone-page login-page">
      <section className="login-panel" aria-labelledby="activation-title">
        <div>
          <span className="brand-mark" aria-hidden="true">
            W
          </span>
          <p className="eyebrow">Primeiro acesso</p>
          <h1 id="activation-title">Crie sua senha</h1>
          <p>
            Defina uma senha pessoal. Ao concluir, você entrara diretamente no
            workspace liberado para sua conta.
          </p>
        </div>

        <AccountActivationForm token={token} />
      </section>
    </main>
  );
}
