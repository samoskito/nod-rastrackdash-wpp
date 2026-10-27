import type {
  CurrentWorkspaceDto,
  ProviderConversionRuleDto,
  PurchaseReviewDto,
  PurchaseReviewListDto,
  PurchaseReviewStatusDto,
  PurchaseReviewViewDto,
} from "@wpptrack/shared";
import Link from "next/link";
import { serverApiFetch } from "../../../../lib/server-api";
import { PurchaseReviewPanel } from "./purchase-review-panel";
import {
  PurchaseReviewFilters,
  type PurchaseReviewRuleOption,
} from "./purchase-review-filters";

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

/**
 * Regras de compra do workspace. A regra filtrada nunca some do select, senao
 * o filtro parece limpo enquanto a lista continua filtrada; o nome vem da API
 * (regras ou revisoes da pagina) e, sem ele, um rotulo neutro, nunca inventado.
 */
function ruleFilterOptions(
  rules: ProviderConversionRuleDto[],
  reviews: PurchaseReviewDto[],
  selectedRuleId: string | undefined,
): PurchaseReviewRuleOption[] {
  const options = rules
    .filter((rule) => rule.conversionRule.eventName === "Purchase")
    .map((rule) => ({ id: rule.id, label: rule.conversionRule.name }));

  if (selectedRuleId && !options.some((rule) => rule.id === selectedRuleId)) {
    const label =
      rules.find((rule) => rule.id === selectedRuleId)?.conversionRule.name ??
      reviews.find((review) => review.providerRuleId === selectedRuleId)
        ?.ruleName ??
      "Regra indisponível";

    options.push({ id: selectedRuleId, label });
  }

  return options;
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
        <PurchaseReviewFilters
          applied={{
            since,
            until,
            view,
            status: status ?? "",
            providerRuleId: providerRuleId ?? "",
          }}
          page={page}
          ruleOptions={ruleFilterOptions(
            rules,
            data?.reviews ?? [],
            providerRuleId,
          )}
          totalItems={pagination.totalItems}
        />
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
