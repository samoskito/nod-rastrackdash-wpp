import type { BackofficeWorkspaceListDto } from "@wpptrack/shared";
import { AlertTriangle, UsersRound } from "lucide-react";
import { BackofficeNavigation } from "../../../../components/backoffice-navigation";
import { BackofficeClientsCreateForm } from "../../../../components/backoffice-clients-create-form";
import { BackofficeClientsWorkspaceTable } from "../../../../components/backoffice-clients-workspace-table";
import { isApiRequestError, serverApiFetch } from "../../../../lib/server-api";

/**
 * Backoffice "Clientes e acessos", backed by the multi-client controllers
 * committed in this branch (`backoffice/workspaces` and the owner activation
 * endpoints). Every row and every KPI below comes straight from the API — no
 * fabricated counters, no invented rows when a call fails.
 */

type WorkspacesResult =
  | { state: "empty" }
  | { state: "error"; message: string }
  | { state: "real"; workspaces: BackofficeWorkspaceListDto };

async function getWorkspaces(): Promise<WorkspacesResult> {
  try {
    const workspaces = await serverApiFetch<BackofficeWorkspaceListDto>(
      "/backoffice/workspaces",
    );

    return workspaces.length > 0
      ? { state: "real", workspaces }
      : { state: "empty" };
  } catch (error) {
    return {
      state: "error",
      message:
        isApiRequestError(error) && error.message.trim()
          ? error.message
          : "Não foi possível carregar os workspaces.",
    };
  }
}

export default async function BackofficeClientsPage() {
  const result = await getWorkspaces();

  return (
    <section className="page-stack standalone-page client-admin-page">
      <BackofficeNavigation active="clients" />

      <header className="page-header client-admin-header">
        <div>
          <span className="eyebrow">Operação da plataforma</span>
          <h1>Clientes e acessos</h1>
          <p>
            Crie o workspace de um cliente e gerencie o acesso do responsável
            por ele.
          </p>
        </div>
        {result.state === "error" ? (
          <span className="status-chip bad">API indisponível</span>
        ) : (
          <span className="status-chip neutral">
            <UsersRound aria-hidden="true" size={14} strokeWidth={2} />
            {result.state === "real"
              ? `${result.workspaces.length} ${
                  result.workspaces.length === 1 ? "workspace" : "workspaces"
                }`
              : "Nenhum workspace"}
          </span>
        )}
      </header>

      <section className="surface-panel">
        <div className="section-heading-row">
          <div>
            <span className="eyebrow">Novo cliente</span>
            <h2>Criar workspace</h2>
            <p>
              O primeiro responsável do workspace recebe um e-mail de ativação.
              Se a entrega falhar, gere um link manual depois na lista abaixo.
            </p>
          </div>
        </div>

        <BackofficeClientsCreateForm />
      </section>

      <section className="surface-panel">
        <div className="section-heading-row">
          <div>
            <span className="eyebrow">Clientes cadastrados</span>
            <h2>Workspaces</h2>
          </div>
        </div>

        {result.state === "error" ? (
          <ErrorPanel message={result.message} />
        ) : result.state === "empty" ? (
          <EmptyPanel />
        ) : (
          <BackofficeClientsWorkspaceTable workspaces={result.workspaces} />
        )}
      </section>
    </section>
  );
}

function EmptyPanel() {
  return (
    <div className="inbound-empty-state">
      <UsersRound aria-hidden="true" size={20} />
      <div>
        <strong>Nenhum workspace cadastrado ainda</strong>
        <p className="muted">
          Use o formulário acima para criar o primeiro cliente.
        </p>
      </div>
    </div>
  );
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="inbound-empty-state" role="alert">
      <AlertTriangle aria-hidden="true" size={20} />
      <div>
        <strong>Não foi possível carregar os workspaces</strong>
        <p className="muted">{message}</p>
      </div>
    </div>
  );
}
