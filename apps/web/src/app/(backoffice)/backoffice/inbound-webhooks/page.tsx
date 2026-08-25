import type {
  InboundWebhookCapabilitiesDto,
  InboundWebhookConnectionDto,
  InboundWebhookConnectionOverviewDto,
  InboundWebhookObservationCountersDto,
} from "@wpptrack/shared";
import { AlertTriangle, Info, Webhook } from "lucide-react";
import { BackofficeNavigation } from "../../../../components/backoffice-navigation";
import { formatDateTime } from "../../../../lib/date-time";
import { serverApiFetch } from "../../../../lib/server-api";

/**
 * Student-edition inbound webhook observation.
 *
 * The PalmUP platform build serves this page from `backoffice/inbound-webhooks`
 * (delivery search, payload viewer, replay/recovery, provider-conversion
 * rollout). This public template ships none of those controllers — the only
 * inbound-webhook endpoints available here are the workspace-scoped
 * `integrations/inbound-webhooks` reads. So this route is deliberately a
 * read-only view of the *current workspace* and says so out loud instead of
 * pretending to be a platform-wide console. Every number below comes from
 * `/:connectionId/overview`; when that call fails the counters render as
 * unavailable rather than as zeros.
 */

type ConnectionView = {
  connection: InboundWebhookConnectionDto;
  counters: InboundWebhookObservationCountersDto | null;
};

type InboundWebhookResult = {
  capabilities: InboundWebhookCapabilitiesDto | null;
  connections: ConnectionView[];
  state: "real" | "empty" | "error";
};

const providerLabels: Record<string, string> = {
  gupshup: "Gupshup",
  uazapi: "UAZAPI",
  umbler: "Umbler Talk",
};

const connectionStatusLabels: Record<string, string> = {
  observation: "Observando",
  paused: "Pausada",
  production: "Envio automático",
};

const parserReleaseLabels: Record<string, string> = {
  certified: "Parser certificado",
  observation_only: "Parser em observação",
  retired: "Parser aposentado",
};

async function getInboundWebhooks(): Promise<InboundWebhookResult> {
  let capabilities: InboundWebhookCapabilitiesDto | null = null;
  let connections: InboundWebhookConnectionDto[];

  const capabilitiesResult = await serverApiFetch<InboundWebhookCapabilitiesDto>(
    "/integrations/inbound-webhooks/capabilities",
  ).then(
    (value) => value,
    () => null,
  );
  capabilities = capabilitiesResult;

  try {
    connections = await serverApiFetch<InboundWebhookConnectionDto[]>(
      "/integrations/inbound-webhooks",
    );
  } catch {
    return { capabilities, connections: [], state: "error" };
  }

  const views = await Promise.all(
    connections.map(async (connection) => {
      const overview = await serverApiFetch<InboundWebhookConnectionOverviewDto>(
        `/integrations/inbound-webhooks/${encodeURIComponent(connection.id)}/overview`,
      ).then(
        (value) => value,
        () => null,
      );

      return {
        connection,
        counters: overview ? overview.counters : null,
      };
    }),
  );

  return {
    capabilities,
    connections: views,
    state: views.length > 0 ? "real" : "empty",
  };
}

export default async function BackofficeInboundWebhooksPage() {
  const result = await getInboundWebhooks();

  return (
    <section className="page-stack standalone-page inbound-deliveries-page">
      <BackofficeNavigation active="webhooks" />

      <header className="page-header">
        <div>
          <span className="eyebrow">Operação da plataforma</span>
          <h1>Webhooks WhatsApp</h1>
          <p>
            Consulta somente leitura das conexões de webhook do workspace atual.
          </p>
        </div>
        {result.state === "error" ? (
          <span className="status-chip bad">API indisponível</span>
        ) : (
          <span className="status-chip neutral">Somente leitura</span>
        )}
      </header>

      <ScopeNotice />

      {result.capabilities ? (
        <CapabilitiesPanel capabilities={result.capabilities} />
      ) : null}

      {result.state === "error" ? (
        <ErrorPanel />
      ) : result.state === "empty" ? (
        <EmptyPanel />
      ) : (
        <ConnectionsPanel connections={result.connections} />
      )}
    </section>
  );
}

function ScopeNotice() {
  return (
    <section className="surface-panel inbound-operator-scope" role="note">
      <div className="section-heading-row">
        <div>
          <span className="eyebrow">Escopo desta edição</span>
          <h2>O que esta página mostra (e o que não mostra)</h2>
          <p>
            Esta instância student não inclui o console multi-cliente da PalmUP.
            A API deste template só expõe leituras de webhook do workspace
            atual, então não há busca de entregas, visualização de payload,
            replay/recuperação nem rollout de conversão por provedor aqui.
          </p>
        </div>
        <span className="status-chip neutral">
          <Info aria-hidden="true" size={14} strokeWidth={2} />
          Workspace atual
        </span>
      </div>

      <p className="muted">
        Para criar, pausar, girar segredo ou rotear canais de uma conexão, use{" "}
        <a href="/integrations">Integrações</a> dentro do workspace. Os números
        abaixo vêm da própria API — quando uma leitura falha, o campo aparece
        como indisponível em vez de zero.
      </p>
    </section>
  );
}

function CapabilitiesPanel({
  capabilities,
}: {
  capabilities: InboundWebhookCapabilitiesDto;
}) {
  return (
    <section className="surface-panel">
      <div className="section-heading-row">
        <div>
          <span className="eyebrow">Configuração da instância</span>
          <h2>Recursos de webhook habilitados</h2>
        </div>
      </div>

      <dl className="account-facts">
        <div>
          <dt>Recepção de webhooks</dt>
          <dd>{capabilities.enabled ? "Habilitada" : "Desabilitada"}</dd>
        </div>
        <div>
          <dt>Envio automático (produção)</dt>
          <dd>
            {capabilities.productionEnabled ? "Habilitado" : "Desabilitado"}
          </dd>
        </div>
        <div>
          <dt>Provedores disponíveis</dt>
          <dd>
            {capabilities.providers.length > 0
              ? capabilities.providers
                  .map(
                    (provider) =>
                      providerLabels[provider.provider] ?? provider.provider,
                  )
                  .join(", ")
              : "Nenhum"}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function ConnectionsPanel({
  connections,
}: {
  connections: ConnectionView[];
}) {
  const degraded = connections.some((view) => view.counters === null);

  return (
    <section className="surface-panel">
      <div className="section-heading-row">
        <div>
          <span className="eyebrow">Fontes de mensagens</span>
          <h2>Conexões do workspace</h2>
        </div>
        <span className="status-chip neutral">
          {connections.length} conexão(ões)
        </span>
      </div>

      {degraded ? (
        <p className="action-note warn">
          Parte dos contadores de observação está temporariamente indisponível.
        </p>
      ) : null}

      <div className="inbound-connection-list">
        {connections.map(({ connection, counters }) => (
          <details className="inbound-connection" key={connection.id}>
            <summary>
              <div className="inbound-connection-identity">
                <span
                  className={`status-dot ${connection.status !== "paused" ? "active" : ""}`}
                  aria-hidden="true"
                />
                <div>
                  <strong>{connection.displayName}</strong>
                  <span>
                    {providerLabels[connection.provider] ?? connection.provider}{" "}
                    -{" "}
                    {connectionStatusLabels[connection.status] ??
                      connection.status}
                  </span>
                </div>
              </div>
              <div className="inbound-connection-health">
                <span>
                  Última entrega: {optionalDateTime(connection.lastDeliveryAt)}
                </span>
                <span>
                  Último parse: {optionalDateTime(connection.lastSuccessfulParseAt)}
                </span>
              </div>
            </summary>

            <div className="inbound-connection-body">
              <dl className="account-facts">
                <div>
                  <dt>Parser</dt>
                  <dd>
                    {connection.parserVersion}
                    {connection.parserReleaseStatus
                      ? ` — ${
                          parserReleaseLabels[connection.parserReleaseStatus] ??
                          connection.parserReleaseStatus
                        }`
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt>Envio automático desde</dt>
                  <dd>{optionalDateTime(connection.productionActivatedAt)}</dd>
                </div>
                <div>
                  <dt>Criada em</dt>
                  <dd>{optionalDateTime(connection.createdAt)}</dd>
                </div>
                <div>
                  <dt>Atualizada em</dt>
                  <dd>{optionalDateTime(connection.updatedAt)}</dd>
                </div>
              </dl>

              {counters ? (
                <div className="inbound-counter-grid">
                  <ObservationCounter
                    label="CTWA roteado"
                    tone="success"
                    value={counters.eligibleRouted}
                  />
                  <ObservationCounter
                    label="CTWA pendente"
                    tone="warn"
                    value={counters.eligibleUnresolved}
                  />
                  <ObservationCounter
                    label="Sem CTWA"
                    value={counters.ignoredNoCtwa}
                  />
                  <ObservationCounter
                    label="Duplicados"
                    value={counters.duplicate}
                  />
                  <ObservationCounter
                    label="Inválidos"
                    tone="error"
                    value={counters.invalid}
                  />
                </div>
              ) : (
                <p className="action-note warn">
                  Contadores de observação indisponíveis para esta conexão.
                </p>
              )}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

function EmptyPanel() {
  return (
    <section className="surface-panel">
      <div className="inbound-empty-state">
        <Webhook aria-hidden="true" size={20} />
        <div>
          <strong>Nenhuma conexão de webhook neste workspace</strong>
          <p className="muted">
            Crie a primeira conexão em <a href="/integrations">Integrações</a>{" "}
            para começar a receber payloads do provedor WhatsApp.
          </p>
        </div>
      </div>
    </section>
  );
}

function ErrorPanel() {
  return (
    <section className="surface-panel" role="alert">
      <div className="inbound-empty-state">
        <AlertTriangle aria-hidden="true" size={20} />
        <div>
          <strong>Não foi possível carregar as conexões de webhook</strong>
          <p className="muted">
            Verifique se a API está no ar e se a sessão continua válida, depois
            recarregue esta página. Nenhum dado é exibido enquanto a leitura
            falha.
          </p>
        </div>
      </div>
    </section>
  );
}

function ObservationCounter({
  label,
  tone = "",
  value,
}: {
  label: string;
  tone?: "" | "error" | "success" | "warn";
  value: number;
}) {
  return (
    <div className={`inbound-counter${tone ? ` ${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function optionalDateTime(value: string | null): string {
  return value ? formatDateTime(value) : "—";
}
