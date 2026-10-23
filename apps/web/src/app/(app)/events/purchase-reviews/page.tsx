import type {
  CurrentWorkspaceDto,
  ProviderConversionRuleDto,
  PurchaseReviewListDto,
  PurchaseReviewStatusDto,
  PurchaseReviewViewDto,
} from "@wpptrack/shared";
import { Filter, ShoppingCart } from "lucide-react";
import Link from "next/link";
import { serverApiFetch } from "../../../../lib/server-api";
import { PurchaseReviewPanel } from "./purchase-review-panel";

type SearchParams = Record<string, string | string[] | undefined>;

function param(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function purchaseReviewView(value: string | undefined): PurchaseReviewViewDto {
  return value === "history" || value === "all" ? value : "actionable";
}

function period() {
  const until = dateOnlyInSaoPaulo(new Date());
  const since = new Date(`${until}T12:00:00.000Z`);
  since.setUTCDate(since.getUTCDate() - 6);
  return {
    since: since.toISOString().slice(0, 10),
    until,
  };
}

function dateOnlyInSaoPaulo(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

export default async function PurchaseReviewsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const params = searchParams ? await searchParams : {};
  const defaults = period();
  const since = param(params.since) ?? defaults.since;
  const until = param(params.until) ?? defaults.until;
  const status = param(params.status) as PurchaseReviewStatusDto | undefined;
  const view = purchaseReviewView(param(params.view));
  const providerRuleId = param(params.providerRuleId);
  const page = Math.max(1, Number(param(params.page)) || 1);
  const query = new URLSearchParams({
    since,
    until,
    page: String(page),
    pageSize: "25",
    view,
  });
  if (status) query.set("status", status);
  if (providerRuleId) query.set("providerRuleId", providerRuleId);

  let data: PurchaseReviewListDto | null = null;
  let rules: ProviderConversionRuleDto[] = [];
  let workspace: CurrentWorkspaceDto | null = null;
  try {
    [data, rules, workspace] = await Promise.all([
      serverApiFetch<PurchaseReviewListDto>(`/purchase-reviews?${query}`),
      serverApiFetch<ProviderConversionRuleDto[]>(
        "/conversion-rules/providers",
      ),
      serverApiFetch<CurrentWorkspaceDto>("/workspaces/current"),
    ]);
  } catch {
    data = null;
  }

  const pagination = data?.pagination ?? {
    page,
    pageSize: 25,
    totalItems: 0,
    totalPages: 0,
  };

  return (
    <section className="page-stack page-wide audit-page purchase-review-page">
      <header className="page-header audit-page-header">
        <div>
          <span className="eyebrow">Eventos Meta</span>
          <h1>Auditoria de conversões</h1>
          <p>
            Revise compras reconhecidas antes do envio e corrija valores do
            painel com histórico.
          </p>
        </div>
        <span
          className={data?.pendingCount ? "status-chip warn" : "status-chip"}
        >
          {data
            ? `${data.pendingCount} aguardando decisão`
            : "API indisponível"}
        </span>
      </header>

      <nav
        className="report-view-tabs audit-view-tabs"
        aria-label="Visões de eventos Meta"
      >
        <Link href="/events">Conversões</Link>
        <Link className="active" href="/events/purchase-reviews">
          Revisão de compras
        </Link>
      </nav>

      <section className="surface-panel purchase-review-command-panel">
        <form
          action="/events/purchase-reviews"
          className="purchase-review-filter-form"
        >
          <div className="purchase-review-filter-title">
            <ShoppingCart aria-hidden="true" size={18} />
            <span>
              <strong>Fila operacional</strong>
              <small>{pagination.totalItems} compra(s) no período</small>
            </span>
          </div>
          <label className="filter-field">
            <span>Início</span>
            <input
              className="input-field"
              defaultValue={since}
              name="since"
              type="date"
            />
          </label>
          <label className="filter-field">
            <span>Fim</span>
            <input
              className="input-field"
              defaultValue={until}
              name="until"
              type="date"
            />
          </label>
          <label className="filter-field">
            <span>Visualização</span>
            <select className="filter-control" defaultValue={view} name="view">
              <option value="actionable">Pendências</option>
              <option value="history">Histórico concluído</option>
              <option value="all">Todas</option>
            </select>
          </label>
          <label className="filter-field">
            <span>Estado</span>
            <select
              className="filter-control"
              defaultValue={status ?? ""}
              name="status"
            >
              <option value="">Todos</option>
              <option value="review_required">Revisão necessária</option>
              <option value="awaiting_data">Aguardando dados</option>
              <option value="recognized">Reconhecidas</option>
              <option value="approved">Na fila</option>
              <option value="sent">Enviadas</option>
              <option value="failed">Falhas</option>
              <option value="duplicate">Duplicadas</option>
              <option value="rejected">Rejeitadas</option>
              <option value="corrected_after_send">Corrigidas no painel</option>
            </select>
          </label>
          <label className="filter-field">
            <span>Regra</span>
            <select
              className="filter-control"
              defaultValue={providerRuleId ?? ""}
              name="providerRuleId"
            >
              <option value="">Todas as regras</option>
              {rules
                .filter((rule) => rule.conversionRule.eventName === "Purchase")
                .map((rule) => (
                  <option key={rule.id} value={rule.id}>
                    {rule.conversionRule.name}
                  </option>
                ))}
            </select>
          </label>
          <button className="button" type="submit">
            <Filter aria-hidden="true" size={15} />
            Aplicar
          </button>
        </form>
      </section>

      {data ? (
        <PurchaseReviewPanel
          canManage={Boolean(workspace?.permissions.canManageIntegrations)}
          providerRules={rules}
          reviews={data.reviews}
        />
      ) : (
        <div className="surface-panel purchase-review-empty">
          <strong>Não foi possível carregar a revisão</strong>
          <span>
            A API não respondeu. Atualize a página depois de conferir o deploy.
          </span>
        </div>
      )}

      <nav
        className="report-pagination"
        aria-label="Paginação da revisão de compras"
      >
        <span>
          Página {pagination.page} de {Math.max(pagination.totalPages, 1)} /{" "}
          {pagination.totalItems} compras
        </span>
        <div>
          {pagination.page > 1 ? (
            <Link
              className="button ghost"
              href={`/events/purchase-reviews?${new URLSearchParams({ ...Object.fromEntries(query), page: String(pagination.page - 1) })}`}
            >
              Anterior
            </Link>
          ) : (
            <span className="button ghost disabled">Anterior</span>
          )}
          {pagination.page < pagination.totalPages ? (
            <Link
              className="button ghost"
              href={`/events/purchase-reviews?${new URLSearchParams({ ...Object.fromEntries(query), page: String(pagination.page + 1) })}`}
            >
              Próxima
            </Link>
          ) : (
            <span className="button ghost disabled">Próxima</span>
          )}
        </div>
      </nav>
    </section>
  );
}
