import type { WorkspaceInviteInspectionDto } from "@wpptrack/shared";
import { cookies } from "next/headers";
import { serverApiFetch } from "../../../lib/server-api";
import { InviteAcceptForm } from "./invite-accept-form";

type InviteAcceptSearchParams = {
  token?: string | string[];
};

async function inspectInvite(
  token: string,
): Promise<WorkspaceInviteInspectionDto> {
  if (token.length < 16) {
    return { state: "invalid" };
  }

  try {
    return await serverApiFetch<WorkspaceInviteInspectionDto>(
      `/workspaces/invites/inspect?token=${encodeURIComponent(token)}`,
    );
  } catch {
    return { state: "invalid" };
  }
}

async function hasSessionCookie(): Promise<boolean> {
  try {
    return Boolean((await cookies()).get("wpptrack_session")?.value);
  } catch {
    return false;
  }
}

function roleLabel(role: "admin" | "member"): string {
  return role === "admin" ? "Administrador" : "Analista";
}

export default async function WorkspaceInviteAcceptPage({
  searchParams,
}: {
  searchParams?: Promise<InviteAcceptSearchParams>;
}) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const rawToken = resolvedSearchParams.token;
  const token = String(
    Array.isArray(rawToken) ? rawToken[0] : (rawToken ?? ""),
  ).trim();
  const inspection = await inspectInvite(token);

  if (inspection.state === "invalid") {
    return (
      <main className="standalone-page login-page">
        <section className="login-panel" aria-labelledby="invite-title">
          <div>
            <span className="brand-mark" aria-hidden="true">
              W
            </span>
            <p className="eyebrow">Convite de workspace</p>
            <h1 id="invite-title">Convite indisponível</h1>
            <p>
              Este link é inválido, expirou, foi revogado ou já foi utilizado.
            </p>
          </div>
          <div className="login-form">
            <a className="secondary-button" href="/login">
              Ir para o login
            </a>
            <a href="mailto:suporte@rastrack.app">Falar com o suporte</a>
          </div>
        </section>
      </main>
    );
  }

  const sessionAvailable = await hasSessionCookie();

  return (
    <main className="standalone-page login-page">
      <section className="login-panel" aria-labelledby="invite-title">
        <div>
          <span className="brand-mark" aria-hidden="true">
            W
          </span>
          <p className="eyebrow">Convite de workspace</p>
          <h1 id="invite-title">{inspection.workspaceName}</h1>
          <p>
            Acesso como {roleLabel(inspection.role)} para {inspection.emailHint}
            .
          </p>

          <div className="login-status-grid" aria-label="Dados do convite">
            <div className="quality-card">
              <span className="micro-label">Workspace</span>
              <strong>{inspection.workspaceName}</strong>
            </div>
            <div className="quality-card">
              <span className="micro-label">Nível de acesso</span>
              <strong>{roleLabel(inspection.role)}</strong>
            </div>
          </div>
        </div>

        <InviteAcceptForm
          inspection={inspection}
          token={token}
          hasSession={sessionAvailable}
        />
      </section>
    </main>
  );
}
