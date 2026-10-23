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
    return "Login com Google ainda não está configurado.";
  }

  if (error === "google_pending") {
    return "Este email ainda não foi liberado para acessar o WppTrack.";
  }

  if (error === "google_exchange") {
    return "Não foi possível concluir o login com Google.";
  }

  if (error === "google_disabled") {
    return "Login com Google não está disponível neste ambiente.";
  }

  return "Não foi possível autenticar. Tente novamente.";
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
      ? "Troca de cliente concluída. Entre novamente para continuar com o workspace limpo."
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
          <p className="eyebrow">Telemetria de conversões</p>
          <h1 id="login-title">Entrar no {brand.name}</h1>
          <p>
            Acesse o painel para acompanhar leads, campanhas, eventos Pixel e
            diagnósticos da sua operação em uma única tela de controle.
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
              <strong>Atribuição por origem</strong>
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
              <span className="micro-label">Diagnóstico</span>
              <strong>Logs auditáveis</strong>
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
