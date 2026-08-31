import type {
  BackofficeWhatsappWebhookConnectionDto,
  BackofficeWhatsappWebhookHistoryDto,
  CurrentWorkspaceDto,
  WorkspaceListDto,
} from "@wpptrack/shared";
import { AlertTriangle, CheckCircle2, HelpCircle, Webhook } from "lucide-react";
import Link from "next/link";
import { BackofficeNavigation } from "../../../../components/backoffice-navigation";
import { BackofficeWorkspaceSelector } from "../../../../components/backoffice-workspace-selector";
import { WebhookHistoryDetail } from "../../../../components/webhook-history-detail";
import {
  getAvailableWorkspaces,
  getCurrentWorkspace,
} from "../../../../lib/current-workspace";
import { formatDateTime } from "../../../../lib/date-time";
import { isApiRequestError, serverApiFetch } from "../../../../lib/server-api";

/**
 * Backoffice "Webhooks WhatsApp": platform-admin view of BYO WhatsApp
 * connections (Fase A: `/backoffice/whatsapp-webhooks/*`), with a paginated,
 * analyzable receipt history per connection and a redacted payload viewer.
 * Every number and row below comes straight from the API — no fabricated
 * counters, no invented rows when a call fails.
 */

const PAGE_SIZE = 25;

const SELECT_WORKSPACE_MESSAGE =
  "Selecione um workspace para consultar os webhooks WhatsApp.";

const providerLabels: Record<string, string> = {
  uazapi_byo: "Uazapi (BYO)",
  waha: "WAHA",
  zapi: "Z-API",
  nod_api: "NOD API",
};

const connectionStatusLabels: Record<string, string> = {
  pending_payment: "Pagamento pendente",
  active: "Ativa",
  disconnected: "Desconectada",
  suspended: "Suspensa",
  error: "Erro",
};

type ConnectionsResult =
  | { state: "no_workspace"; message: string }
  | { state: "empty" }
  | { state: "error"; message: string }
  | { state: "real"; connections: BackofficeWhatsappWebhookConnectionDto[] };

type HistoryResult =
  | { state: "empty" }
  | { state: "error"; message: string }
  | { state: "real"; history: BackofficeWhatsappWebhookHistoryDto };

/**
 * Callers MUST gate this on an active workspace context first — see
 * `BackofficeInboundWebhooksPage`, which only calls this once
 * `getSelectedWorkspace()` resolves to a real workspace. Calling it without
 * one just burns a request that the controller rejects with 400 (handled
 * below as a fallback, in case the client-side workspace read is stale).
 */
async function getConnections(): Promise<ConnectionsResult> {
  try {
    const connections = await serverApiFetch<
      BackofficeWhatsappWebhookConnectionDto[]
    >("/backoffice/whatsapp-webhooks/connections");

    return connections.length > 0
      ? { state: "real", connections }
      : { state: "empty" };
  } catch (error) {
    // The controller replies 400 exclusively when the platform admin's
    // session has no workspace context yet (no other validation on this
    // endpoint) — treat that as an actionable "pick a workspace" state,
    // distinct from a genuinely unavailable API (which keeps its own error
    // panel further down).
    if (isApiRequestError(error) && error.status === 400) {
      return {
        state: "no_workspace",
        message: error.message.trim() || SELECT_WORKSPACE_MESSAGE,
      };
    }

    return {
      state: "error",
      message:
        isApiRequestError(error) && error.message.trim()
          ? error.message
          : "Não foi possível carregar as conexões WhatsApp.",
    };
  }
}

async function getWorkspaces(): Promise<WorkspaceListDto> {
  try {
    return await getAvailableWorkspaces();
  } catch {
    return [];
  }
}

async function getSelectedWorkspace(): Promise<CurrentWorkspaceDto | null> {
  try {
    return await getCurrentWorkspace();
  } catch {
    return null;
  }
}

async function getHistory(
  connectionId: string,
  page: number,
): Promise<HistoryResult> {
  try {
    const history = await serverApiFetch<BackofficeWhatsappWebhookHistoryDto>(
      `/backoffice/whatsapp-webhooks/connections/${encodeURIComponent(
        connectionId,
      )}/history?page=${page}&pageSize=${PAGE_SIZE}`,
    );

    return history.items.length > 0
      ? { state: "real", history }
      : { state: "empty" };
  } catch (error) {
    return {
      state: "error",
      message:
        isApiRequestError(error) && error.message.trim()
          ? error.message
          : "Não foi possível carregar o histórico de webhooks.",
    };
  }
}

export default async function BackofficeInboundWebhooksPage({
  searchParams,
}: {
  searchParams?: Promise<{ connectionId?: string; page?: string }>;
}) {
  const params = searchParams ? await searchParams : {};
  const [workspaces, selectedWorkspace] = await Promise.all([
    getWorkspaces(),
    getSelectedWorkspace(),
  ]);

  // Never call the connections/history endpoints without an active workspace
  // context — the controller requires it and would just reply 400 for a
  // request we already know is missing that context.
  const connectionsResult: ConnectionsResult = selectedWorkspace
    ? await getConnections()
    : { state: "no_workspace", message: SELECT_WORKSPACE_MESSAGE };

  const connections =
    connectionsResult.state === "real" ? connectionsResult.connections : [];

  const selectedConnectionId =
    connections.find((connection) => connection.id === params.connectionId)
      ?.id ?? connections[0]?.id;

  const requestedPage = Number.parseInt(params.page ?? "1", 10);
  const page =
    Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const historyResult =
    selectedWorkspace && selectedConnectionId
      ? await getHistory(selectedConnectionId, page)
      : null;

  return (
    <section className="page-stack standalone-page inbound-deliveries-page">
      <BackofficeNavigation active="webhooks" />

      <header className="page-header">
        <div>
          <span className="eyebrow">Operação da plataforma</span>
          <h1>Webhooks WhatsApp</h1>
          <p>
            Histórico de recepção de webhooks das conexões WhatsApp BYO, por
            workspace.
          </p>
        </div>
        {connectionsResult.state === "error" ? (
          <span className="status-chip bad">API indisponível</span>
        ) : connectionsResult.state === "no_workspace" ? (
          <span className="status-chip warn">Selecione um workspace</span>
        ) : (
          <span className="status-chip neutral">Somente leitura</span>
        )}
      </header>

      <BackofficeWorkspaceSelector
        selectedWorkspaceId={selectedWorkspace?.id ?? null}
        workspaces={workspaces}
      />

      {connectionsResult.state === "error" ? (
        <ErrorPanel message={connectionsResult.message} />
      ) : connectionsResult.state === "no_workspace" ? (
        <NoWorkspacePanel
          hasWorkspaces={workspaces.length > 0}
          message={connectionsResult.message}
        />
      ) : connectionsResult.state === "empty" ? (
        <EmptyConnectionsPanel />
      ) : (
        <>
          <ConnectionSelector
            connections={connections}
            selectedConnectionId={selectedConnectionId ?? null}
          />

          {selectedConnectionId && historyResult ? (
            <HistoryPanel
              connectionId={selectedConnectionId}
              page={page}
              result={historyResult}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

function ConnectionSelector({
  connections,
  selectedConnectionId,
}: {
  connections: BackofficeWhatsappWebhookConnectionDto[];
  selectedConnectionId: string | null;
}) {
  return (
    <section className="surface-panel">
      <div className="section-heading-row">
        <div>
          <span className="eyebrow">Fontes de mensagens</span>
          <h2>Conexões WhatsApp BYO</h2>
        </div>
        <span className="status-chip neutral">
          {connections.length} conexão(ões)
        </span>
      </div>

      <nav className="backoffice-connection-tabs" aria-label="Conexões WhatsApp">
        {connections.map((connection) => {
          const isActive = connection.id === selectedConnectionId;

          return (
            <Link
              aria-current={isActive ? "page" : undefined}
              className={`button ghost${isActive ? " active" : ""}`}
              href={`/backoffice/inbound-webhooks?connectionId=${encodeURIComponent(
                connection.id,
              )}`}
              key={connection.id}
            >
              <span
                className={`status-dot ${connection.status === "active" ? "active" : ""}`}
                aria-hidden="true"
              />
              {connection.name}
              <span className="muted">
                {providerLabels[connection.provider] ?? connection.provider}
              </span>
              {!connection.webhookConfigured ? (
                <span className="status-chip warn">Webhook não configurado</span>
              ) : null}
            </Link>
          );
        })}
      </nav>
    </section>
  );
}

function HistoryPanel({
  connectionId,
  page,
  result,
}: {
  connectionId: string;
  page: number;
  result: HistoryResult;
}) {
  if (result.state === "error") {
    return <ErrorPanel message={result.message} />;
  }

  if (result.state === "empty") {
    return (
      <section className="surface-panel">
        <div className="inbound-empty-state">
          <Webhook aria-hidden="true" size={20} />
          <div>
            <strong>Nenhum webhook recebido nesta conexão</strong>
            <p className="muted">
              Assim que a Uazapi (ou outro provedor BYO) enviar um webhook para
              esta conexão, ele aparece aqui.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const { history } = result;

  return (
    <section className="surface-panel">
      <div className="section-heading-row">
        <div>
          <span className="eyebrow">Histórico analisável</span>
          <h2>Recepção de webhooks</h2>
        </div>
        <span className="status-chip neutral">
          {history.pagination.total} registro(s)
        </span>
      </div>

      <div className="table-wrap audit-table-scroll">
        <table className="audit-table">
          <thead>
            <tr>
              <th>Hora</th>
              <th>Status</th>
              <th>Provider</th>
              <th>Evento</th>
              <th>Lead CTWA</th>
              <th>Erro</th>
              <th>Detalhe</th>
            </tr>
          </thead>
          <tbody>
            {history.items.map((item) => (
              <tr key={item.id}>
                <td>{formatDateTime(item.receivedAt)}</td>
                <td>
                  <span className={statusChipClass(item.status)}>
                    {item.status}
                  </span>
                </td>
                <td>{providerLabels[item.provider] ?? item.provider}</td>
                <td>{item.eventType}</td>
                <td>
                  {item.leadId ? (
                    <span className="status-chip">
                      <CheckCircle2 aria-hidden="true" size={14} strokeWidth={2} />
                      Sim
                    </span>
                  ) : (
                    <span className="status-chip neutral">
                      <HelpCircle aria-hidden="true" size={14} strokeWidth={2} />
                      Não
                    </span>
                  )}
                </td>
                <td>{item.errorCode ?? "—"}</td>
                <td>
                  <WebhookHistoryDetail
                    connectionId={connectionId}
                    webhookLogId={item.id}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PaginationNav
        connectionId={connectionId}
        page={history.pagination.page}
        totalPages={history.pagination.totalPages}
      />
    </section>
  );
}

function PaginationNav({
  connectionId,
  page,
  totalPages,
}: {
  connectionId: string;
  page: number;
  totalPages: number;
}) {
  function href(target: number) {
    return `/backoffice/inbound-webhooks?connectionId=${encodeURIComponent(
      connectionId,
    )}&page=${target}`;
  }

  return (
    <nav className="report-pagination" aria-label="Paginação do histórico de webhooks">
      <span>
        Página {page} de {Math.max(totalPages, 1)}
      </span>
      <div>
        {page > 1 ? (
          <Link className="button ghost" href={href(page - 1)}>
            Anterior
          </Link>
        ) : (
          <span className="button ghost disabled" aria-disabled="true">
            Anterior
          </span>
        )}
        {page < totalPages ? (
          <Link className="button ghost" href={href(page + 1)}>
            Próxima
          </Link>
        ) : (
          <span className="button ghost disabled" aria-disabled="true">
            Próxima
          </span>
        )}
      </div>
    </nav>
  );
}

function NoWorkspacePanel({
  hasWorkspaces,
  message,
}: {
  hasWorkspaces: boolean;
  message: string;
}) {
  return (
    <section className="surface-panel">
      <div className="inbound-empty-state">
        <Webhook aria-hidden="true" size={20} />
        <div>
          <strong>{message}</strong>
          <p className="muted">
            {hasWorkspaces
              ? "Escolha um workspace no seletor acima para carregar as conexões e o histórico de webhooks."
              : "Nenhum workspace está disponível para o seu usuário. Peça acesso a um workspace para continuar."}
          </p>
        </div>
      </div>
    </section>
  );
}

function EmptyConnectionsPanel() {
  return (
    <section className="surface-panel">
      <div className="inbound-empty-state">
        <Webhook aria-hidden="true" size={20} />
        <div>
          <strong>Nenhuma conexão WhatsApp BYO neste workspace</strong>
          <p className="muted">
            Crie a primeira conexão em <a href="/integrations">Integrações</a>{" "}
            para começar a receber webhooks de um provedor BYO.
          </p>
        </div>
      </div>
    </section>
  );
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <section className="surface-panel" role="alert">
      <div className="inbound-empty-state">
        <AlertTriangle aria-hidden="true" size={20} />
        <div>
          <strong>Não foi possível carregar os dados de webhook</strong>
          <p className="muted">{message}</p>
        </div>
      </div>
    </section>
  );
}

function statusChipClass(status: string): string {
  if (status === "failed" || status === "error" || status === "invalid") {
    return "status-chip bad";
  }

  if (status === "requires_review" || status === "duplicate") {
    return "status-chip warn";
  }

  return "status-chip";
}
