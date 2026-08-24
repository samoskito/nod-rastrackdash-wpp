import { BrandFooter } from "../../components/brand-footer";
import { getBrandConfig } from "../../lib/brand";
import { LoginForm } from "./login-form";

type LoginSearchParams = Record<string, string | string[] | undefined>;

function asStringParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function loginErrorMessage(error: string | undefined): string | null {
  if (!error) {
    return null;
  }

  if (error === "google_env") {
    return "Login com Google ainda nao esta configurado.";
  }

  if (error === "google_pending") {
    return "Este email ainda nao foi liberado para acessar o WppTrack.";
  }

  if (error === "google_exchange") {
    return "Nao foi possivel concluir o login com Google.";
  }

  if (error === "google_disabled") {
    return "Login com Google nao esta disponivel neste ambiente.";
  }

  return "Nao foi possivel autenticar. Tente novamente.";
}

function safeRedirectPath(value: string | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return null;
  }

  try {
    const parsed = new URL(value, "http://wpptrack.local");

    if (parsed.origin !== "http://wpptrack.local") {
      return null;
    }

    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<LoginSearchParams>;
}) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const initialError = loginErrorMessage(
    asStringParam(resolvedSearchParams.error),
  );
  const redirectTo = safeRedirectPath(
    asStringParam(resolvedSearchParams.redirectTo),
  );
  const swappedNotice =
    asStringParam(resolvedSearchParams.swapped) === "1"
      ? "Troca de cliente concluida. Entre novamente para continuar com o workspace limpo."
      : null;
  const googleEnabled =
    process.env.AUTH_GOOGLE_ENABLED?.trim().toLowerCase() === "true";
  const brand = getBrandConfig();

  return (
    <main className="standalone-page login-page">
      <section className="login-panel" aria-labelledby="login-title">
        <div>
          {brand.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- arbitrary
            // student-provided logo URL, outside next/image's static domain config.
            <img className="brand-mark brand-mark-logo" src={brand.logoUrl} alt="" />
          ) : (
            <span className="brand-mark" aria-hidden="true">
              {brand.name.trim().charAt(0).toUpperCase() || "R"}
            </span>
          )}
          <p className="eyebrow">Telemetria de conversoes</p>
          <h1 id="login-title">Entrar no {brand.name}</h1>
          <p>
            Acesse o painel para acompanhar leads, campanhas, eventos Pixel e
            diagnosticos da sua operacao em uma unica tela de controle.
          </p>
          {swappedNotice ? (
            <p className="form-success" role="status">
              {swappedNotice}
            </p>
          ) : null}

          <div
            className="login-status-grid"
            aria-label="Cobertura da plataforma"
          >
            <div className="quality-card">
              <span className="micro-label">Leads rastreados</span>
              <strong>Atribuicao por origem</strong>
            </div>
            <div className="quality-card">
              <span className="micro-label">Campanhas Meta</span>
              <strong>Funil por campanha</strong>
            </div>
            <div className="quality-card">
              <span className="micro-label">Eventos Pixel</span>
              <strong>Envio server-side</strong>
            </div>
            <div className="quality-card">
              <span className="micro-label">Diagnostico</span>
              <strong>Logs auditaveis</strong>
            </div>
          </div>
        </div>

        <LoginForm
          initialError={initialError}
          googleEnabled={googleEnabled}
          redirectTo={redirectTo}
        />
      </section>
      <BrandFooter brand={brand} className="standalone-footer" />
    </main>
  );
}
