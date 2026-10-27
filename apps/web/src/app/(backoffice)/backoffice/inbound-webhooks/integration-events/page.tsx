import type { BackofficeIntegrationEventListDto } from "@wpptrack/shared";
import { backofficeIntegrationEventListSchema } from "@wpptrack/shared";
import { ChevronRight, ShieldAlert, SlidersHorizontal } from "lucide-react";
import { BackofficeNavigation } from "../../../../../components/backoffice-navigation";
import {
  isApiRequestError,
  serverApiFetch,
} from "../../../../../lib/server-api";
import { WebhooksViewSwitch } from "../webhooks-view-switch";
import { loadBackofficeIntegrationEventPayloadAction } from "./actions";
import {
  filterParams,
  integrationEventsPath,
  integrationEventsTitle,
  mappedEventOptions,
  pageHref,
  providerOptions,
  readFilters,
  statusFilterOptions,
  type IntegrationEventsFilters,
} from "./integration-events-copy";
import { IntegrationEventsTable } from "./integration-events-table";

type SearchParams = Record<string, string | string[] | undefined>;

type LoadResult =
  | { state: "real"; data: BackofficeIntegrationEventListDto }
  | { state: "forbidden" | "error" };

async function load(filters: IntegrationEventsFilters): Promise<LoadResult> {
  const query = filterParams(filters, { cursor: filters.cursor }).toString();
  try {
    const response = await serverApiFetch<unknown>(
      `/backoffice/integration-events${query ? `?${query}` : ""}`,
    );
    const parsed = backofficeIntegrationEventListSchema.safeParse(response);
    return parsed.success
      ? { state: "real", data: parsed.data }
      : { state: "error" };
  } catch (error) {
    if (isApiRequestError(error) && error.status === 403) {
      return { state: "forbidden" };
    }
    return { state: "error" };
  }
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="inbound-empty-state" role="alert">
      <ShieldAlert aria-hidden="true" size={20} strokeWidth={2} />
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
    </div>
  );
}

/**
 * Backoffice "Recebimentos das URLs únicas" (porte do SaaS #170, fase 6.5):
 * tudo o que chegou pelas URLs únicas (Payt, Braip) e pelas URLs por evento
 * (Unnichat, Umbler), de todos os workspaces da instalação. Só leitura.
 */
export default async function IntegrationEventsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const filters = readFilters(searchParams ? await searchParams : {});
  const result = await load(filters);
  const data = result.state === "real" ? result.data : null;

  return (
    <section className="page-stack standalone-page integration-receipts-page">
      <BackofficeNavigation active="webhooks" />

      <header className="page-header">
        <div>
          <span className="eyebrow">Auditoria das integrações</span>
          <h1>{integrationEventsTitle}</h1>
          <p>
            Tudo o que chegou pelas URLs únicas (Payt, Braip) e pelas URLs por
            evento (Unnichat, Umbler), de todos os workspaces: entregue a uma
            regra, sem atribuição, ignorado, inválido ou recusado.
          </p>
        </div>
        <span className="status-chip neutral">Somente leitura</span>
      </header>

      <WebhooksViewSwitch active="integration-events" />

      <form
        className="filter-bar integration-receipts-filter"
        action={integrationEventsPath}
      >
        <label className="filter-field">
          <span>Cliente</span>
          <input
            type="search"
            name="workspace"
            defaultValue={filters.workspace ?? ""}
            placeholder="Nome ou ID do workspace"
          />
        </label>
        <label className="filter-field">
          <span>Plataforma</span>
          <select name="provider" defaultValue={filters.provider ?? ""}>
            <option value="">Todas</option>
            {providerOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          <span>Status</span>
          <select name="status" defaultValue={filters.status ?? "all"}>
            {statusFilterOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          <span>Evento mapeado</span>
          <select name="eventName" defaultValue={filters.eventName ?? ""}>
            <option value="">Todos</option>
            {mappedEventOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          <span>De</span>
          <input type="date" name="from" defaultValue={filters.from ?? ""} />
        </label>
        <label className="filter-field">
          <span>Até</span>
          <input type="date" name="to" defaultValue={filters.to ?? ""} />
        </label>
        <button className="button" type="submit">
          <SlidersHorizontal aria-hidden="true" size={16} strokeWidth={2} />
          Filtrar
        </button>
        <a className="button ghost" href={integrationEventsPath}>
          Limpar
        </a>
      </form>

      {result.state === "forbidden" ? (
        <Notice
          title="Área restrita aos administradores da plataforma"
          body="Entre com uma conta de proprietário ou operador do Backoffice para ver os recebimentos de todos os workspaces."
        />
      ) : !data ? (
        <Notice
          title="Não deu para carregar os recebimentos"
          body="Tente de novo em alguns instantes."
        />
      ) : (
        <section
          className="integration-receipts-section"
          aria-label={integrationEventsTitle}
        >
          {data.matchedWorkspaces && filters.workspace ? (
            <p className="muted">
              {data.matchedWorkspaces.length === 0
                ? "Nenhum workspace com esse nome ou ID."
                : `Workspaces encontrados: ${data.matchedWorkspaces
                    .map((workspace) => workspace.name)
                    .join(", ")}`}
            </p>
          ) : null}
          <p className="muted">
            Mais recentes primeiro. Os dados recebidos ficam guardados com
            criptografia por 7 dias; sem token válido só os metadados são
            guardados.
          </p>
          <IntegrationEventsTable
            items={data.items}
            loadPayload={loadBackofficeIntegrationEventPayloadAction}
          />
          <nav
            className="report-pagination"
            aria-label="Paginação dos recebimentos"
          >
            <span>{data.items.length} recebimentos nesta página</span>
            <div>
              {filters.cursor ? (
                <a className="button ghost" href={pageHref(filters)}>
                  Mais recentes
                </a>
              ) : null}
              {data.nextCursor ? (
                <a
                  className="button ghost"
                  href={pageHref(filters, data.nextCursor)}
                >
                  Mais antigos
                  <ChevronRight aria-hidden="true" size={16} strokeWidth={2} />
                </a>
              ) : (
                <span className="button ghost disabled">
                  Mais antigos
                  <ChevronRight aria-hidden="true" size={16} strokeWidth={2} />
                </span>
              )}
            </div>
          </nav>
        </section>
      )}
    </section>
  );
}
