import {
  leadLifecycleLabel,
  leadSourceLabel,
  type LeadListItemDto,
  type LeadListPageDto,
  type WhatsappConnectionDto,
} from "@wpptrack/shared";
import {
  ArrowUpRight,
  Filter,
  MessageCircle,
  RotateCcw,
  UserRoundSearch,
} from "lucide-react";
import Link from "next/link";
import { PresentationMask } from "../../../components/presentation-mask";
import { formatDateTime } from "../../../lib/date-time";
import { serverApiFetch } from "../../../lib/server-api";
import {
  hasEditableLeadFilter,
  leadFiltersClearHref,
  leadFiltersHref,
  type LeadFilterValues,
} from "./lead-filter-params";
import { LeadExportMenu } from "./lead-export-menu";
import { LeadFilters } from "./lead-filters";

type LeadsSearchParams = Record<string, string | string[] | undefined>;

type LeadsResult = {
  leads: LeadListItemDto[];
  pagination: LeadListPageDto["pagination"];
  attributionCounts: LeadListPageDto["attributionCounts"];
  state: "real" | "empty" | "error";
};

type LeadFilters = {
  search?: string;
  status?: string;
  eventName?: string;
  label?: string;
  campaignId?: string;
  adSetId?: string;
  adId?: string;
  whatsappInstanceId?: string;
  attribution?: string;
  since?: string;
  until?: string;
  base?: string;
  page: number;
  pageSize: number;
};

type InstanceScope =
  { state: "none" } | { state: "named"; name: string } | { state: "unnamed" };

/**
 * Names the instance the list is scoped to. The leads request itself enforces
 * the scope, so a failed lookup only loses the name, never the filter.
 */
async function getInstanceScope(
  whatsappInstanceId: string | undefined,
): Promise<InstanceScope> {
  if (!whatsappInstanceId) {
    return { state: "none" };
  }

  try {
    // nod: o número é a conexão WhatsApp do workspace.
    const connections = await serverApiFetch<WhatsappConnectionDto[]>(
      "/integrations/whatsapp-connections",
    );
    const connection = connections.find(({ id }) => id === whatsappInstanceId);

    return connection
      ? { state: "named", name: connection.displayName ?? connection.name }
      : { state: "unnamed" };
  } catch {
    return { state: "unnamed" };
  }
}

async function getLeads(filters: LeadFilters): Promise<LeadsResult> {
  try {
    const query = leadQuery(filters);
    const response = await serverApiFetch<LeadListPageDto>(
      `/leads/page?${query}`,
    );

    return {
      leads: response.items,
      pagination: response.pagination,
      attributionCounts: response.attributionCounts,
      state: response.items.length > 0 ? "real" : "empty",
    };
  } catch {
    return {
      leads: [],
      pagination: {
        page: filters.page,
        pageSize: filters.pageSize,
        totalItems: 0,
        totalPages: 0,
      },
      attributionCounts: undefined,
      state: "error",
    };
  }
}

function leadQuery(filters: LeadFilters, page = filters.page): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries({
    search: filters.search,
    status: filters.status,
    eventName: filters.eventName,
    label: filters.label,
    campaignId: filters.campaignId,
    adSetId: filters.adSetId,
    adId: filters.adId,
    whatsappInstanceId: filters.whatsappInstanceId,
    attribution: filters.attribution,
    since: filters.since,
    until: filters.until,
    base: filters.base,
  })) {
    if (value) {
      params.set(key, value);
    }
  }

  params.set("page", String(page));
  params.set("pageSize", String(filters.pageSize));

  return params.toString();
}

function positiveIntegerParam(value: string | undefined, fallback: number) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function asStringParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Same labels as the exported spreadsheet (shared with the API).
const lifecycleLabel = leadLifecycleLabel;

function lifecycleTone(lead: LeadListItemDto): string {
  if (lead.status === "lost") {
    return " bad";
  }

  return lead.lastEventName ? "" : " warn";
}

function lastTouchLabel(value: string | null): string {
  if (!value) {
    return "-";
  }

  return formatDateTime(value, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
  });
}

const sourceLabel = leadSourceLabel;

/** Header badge: says which people the number counts. */
function leadCountBadge(
  count: number,
  base: string | undefined,
  hasPeriod: boolean,
): string {
  if (base === "returning") {
    return count === 1
      ? "1 lead que voltou no período"
      : `${count} leads que voltaram no período`;
  }

  if (base === "repeat") {
    return count === 1
      ? "1 lead com mais de uma conversa no período"
      : `${count} leads com mais de uma conversa no período`;
  }

  if (!hasPeriod) {
    return count === 1 ? "1 lead" : `${count} leads`;
  }

  return count === 1
    ? "1 lead novo (1º contato no período)"
    : `${count} leads novos (1º contato no período)`;
}

function attributionChipLabel(attribution: string | undefined): string {
  return attribution === "paid"
    ? "Origem: anúncio"
    : attribution === "organic"
      ? "Origem: orgânico"
      : "Origem: todas";
}

function LeadIdentity({ lead }: { lead: LeadListItemDto }) {
  return (
    <>
      <PresentationMask placeholder="Lead oculto">
        <Link href={`/leads/${lead.id}`}>{lead.name ?? "Lead sem nome"}</Link>
      </PresentationMask>
      <PresentationMask placeholder="(00) 00000-0000">
        <span>{lead.phoneDisplay ?? lead.phoneHash}</span>
      </PresentationMask>
    </>
  );
}

function LeadLabels({ labels }: { labels: string[] }) {
  if (labels.length === 0) {
    return null;
  }

  return (
    <span className="lead-label-list">
      {labels.map((label) => (
        <small key={label}>{label}</small>
      ))}
    </span>
  );
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams?: Promise<LeadsSearchParams>;
}) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const search = asStringParam(resolvedSearchParams.search);
  const status = asStringParam(resolvedSearchParams.status);
  const eventName = asStringParam(resolvedSearchParams.eventName);
  const label = asStringParam(resolvedSearchParams.label);
  const campaignId = asStringParam(resolvedSearchParams.campaignId);
  const adSetId = asStringParam(resolvedSearchParams.adSetId);
  const adId = asStringParam(resolvedSearchParams.adId);
  const whatsappInstanceId =
    asStringParam(resolvedSearchParams.whatsappInstanceId)?.trim() || undefined;
  const attribution = asStringParam(resolvedSearchParams.attribution);
  // Only "returning"/"repeat" change the list; anything else is the default
  // (novos).
  const requestedBase = asStringParam(resolvedSearchParams.base);
  const base =
    requestedBase === "returning" || requestedBase === "repeat"
      ? requestedBase
      : undefined;
  const since = asStringParam(resolvedSearchParams.since);
  const until = asStringParam(resolvedSearchParams.until);
  const page = positiveIntegerParam(
    asStringParam(resolvedSearchParams.page),
    1,
  );
  const pageSize = Math.min(
    positiveIntegerParam(asStringParam(resolvedSearchParams.pageSize), 25),
    100,
  );
  const hasReportScope = Boolean(campaignId || adSetId || adId);
  const hasReportFilter = hasReportScope || Boolean(attribution);
  const hasPeriodFilter = Boolean(since || until);
  const leadFilters: LeadFilters = {
    search,
    status,
    eventName,
    label,
    campaignId,
    adSetId,
    adId,
    whatsappInstanceId,
    attribution,
    since,
    until,
    base,
    page,
    pageSize,
  };
  const appliedFilters: LeadFilterValues = {
    search: search ?? "",
    status: status ?? "",
    eventName: eventName ?? "",
    label: label ?? "",
    campaignId: campaignId ?? "",
    adSetId: adSetId ?? "",
    adId: adId ?? "",
    whatsappInstanceId: whatsappInstanceId ?? "",
    attribution: attribution ?? "",
    since: since ?? "",
    until: until ?? "",
    base: base ?? "",
    pageSize: String(pageSize),
  };
  const [result, instanceScope] = await Promise.all([
    getLeads(leadFilters),
    getInstanceScope(whatsappInstanceId),
  ]);
  const { leads } = result;
  const pendingCount = leads.filter((lead) => !lead.lastEventName).length;
  const pageStart =
    result.pagination.totalItems > 0
      ? (result.pagination.page - 1) * result.pagination.pageSize + 1
      : 0;
  const pageEnd = Math.min(
    result.pagination.page * result.pagination.pageSize,
    result.pagination.totalItems,
  );
  const emptyTitle =
    result.state === "error"
      ? "Não foi possível carregar leads"
      : "Nenhum lead encontrado";
  const emptyDescription =
    result.state === "error"
      ? "Confira a API antes de analisar conversas."
      : base === "returning" && !since
        ? "Escolha a data de início do período para ver quem voltou por anúncio."
        : base === "returning"
          ? "Ninguém que já tinha falado com você voltou por anúncio neste período."
          : base === "repeat" && !since && !until
            ? "Escolha o período para ver quem conversou mais de uma vez por anúncio."
            : base === "repeat"
              ? "Ninguém iniciou mais de uma conversa por anúncio neste período."
              : "Quando uma integração ativa receber conversas, elas aparecem aqui.";
  const attributionCounts = result.attributionCounts;
  // Organic leads get their own count so the paid one matches the overview.
  const showAttributionSplit =
    !attribution &&
    result.state !== "error" &&
    attributionCounts !== undefined &&
    attributionCounts.organic > 0;
  const clearHref = leadFiltersClearHref(appliedFilters);
  // Only scope applied: clearing would reload the same list, so the scope
  // banners own the way out.
  const emptyActionHref =
    result.state === "error"
      ? `/leads?${leadQuery(leadFilters)}`
      : hasEditableLeadFilter(appliedFilters) ||
          !(whatsappInstanceId || hasReportScope)
        ? clearHref
        : null;

  return (
    <section className="page-stack page-wide leads-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">Leads</span>
          <h1>Leads rastreados pelo WhatsApp</h1>
          <p>
            Encontre conversas, confirme a atribuição e acompanhe a etapa atual
            de cada lead.
          </p>
        </div>
        <div className="header-actions">
          {result.state === "error" ? (
            <span className="status-chip warn">API indisponível</span>
          ) : null}
          <span className="status-chip">
            {leadCountBadge(
              result.pagination.totalItems,
              base,
              hasPeriodFilter,
            )}
          </span>
          <span className="status-chip">
            {attributionChipLabel(attribution)}
          </span>
          {showAttributionSplit ? (
            <>
              <Link
                className="status-chip"
                href={leadFiltersHref({
                  ...appliedFilters,
                  attribution: "paid",
                })}
              >
                {attributionCounts.paid} de anúncio
              </Link>
              <Link
                className="status-chip"
                href={leadFiltersHref({
                  ...appliedFilters,
                  attribution: "organic",
                })}
              >
                {attributionCounts.organic}{" "}
                {attributionCounts.organic === 1 ? "orgânico" : "orgânicos"}
              </Link>
            </>
          ) : null}
        </div>
      </header>

      <LeadFilters applied={appliedFilters} page={page} />

      {instanceScope.state !== "none" ? (
        <div
          className="lead-filter-context lead-instance-context"
          role="status"
        >
          <MessageCircle aria-hidden="true" size={16} strokeWidth={2} />
          <strong>Número WhatsApp</strong>
          <span>
            Exibindo leads associados atualmente a{" "}
            {instanceScope.state === "named" ? (
              <PresentationMask placeholder="número oculto">
                {instanceScope.name}
              </PresentationMask>
            ) : (
              "número selecionado"
            )}
            . O vínculo é o atual de cada lead, não o histórico de mensagens.
          </span>
          <Link
            className="button ghost"
            href={leadFiltersHref({
              ...appliedFilters,
              whatsappInstanceId: "",
            })}
          >
            Ver todos os números
          </Link>
        </div>
      ) : null}

      {hasReportFilter || hasPeriodFilter || base ? (
        <div className="lead-filter-context" role="status">
          <Filter aria-hidden="true" size={16} strokeWidth={2} />
          <strong>Recorte ativo</strong>
          <span>
            {base === "returning"
              ? "Leads que já tinham falado com você e voltaram por anúncio"
              : base === "repeat"
                ? "Leads que iniciaram mais de uma conversa por anúncio"
                : attribution === "organic"
                  ? "Leads novos sem anúncio (orgânicos)"
                  : attribution === "paid"
                    ? "Leads novos vindos de anúncio"
                    : hasReportFilter
                      ? "Filtro do relatório aplicado"
                      : "Leads novos (1º contato no período)"}
            {since || until
              ? `: ${since ?? "início"} até ${until ?? "hoje"}`
              : "."}
          </span>
          {hasReportScope ? (
            // Limpar keeps the drill-down; this is the way out of it.
            <Link
              className="button ghost"
              href={leadFiltersHref({
                ...appliedFilters,
                campaignId: "",
                adSetId: "",
                adId: "",
              })}
            >
              Remover recorte do relatório
            </Link>
          ) : null}
        </div>
      ) : null}

      <section className="lead-results-section" aria-labelledby="lead-results">
        <header className="lead-results-header">
          <div>
            <span className="eyebrow">Histórico</span>
            <h2 id="lead-results">Conversas recebidas</h2>
            <p>
              {result.pagination.totalItems > 0
                ? `Mostrando ${pageStart}-${pageEnd} de ${result.pagination.totalItems} leads.`
                : "Nenhuma conversa disponível neste recorte."}
            </p>
          </div>
          {leads.length > 0 ? (
            <div className="lead-results-actions">
              <div className="lead-results-summary">
                <span className="status-chip">
                  Página {result.pagination.page} de{" "}
                  {Math.max(result.pagination.totalPages, 1)}
                </span>
                <span
                  className={`status-chip${pendingCount > 0 ? " warn" : ""}`}
                >
                  {pendingCount} sem etapa nesta página
                </span>
              </div>
              <LeadExportMenu applied={appliedFilters} />
            </div>
          ) : null}
        </header>

        {leads.length > 0 ? (
          <>
            <div className="table-wrap leads-table-wrap">
              <table className="leads-table">
                <thead>
                  <tr>
                    <th>Lead</th>
                    <th>Campanha / origem</th>
                    <th>Etapa atual</th>
                    <th>Recebido</th>
                    <th>Última atividade</th>
                    <th>
                      <span className="sr-only">Abrir lead</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {leads.map((lead) => (
                    <tr key={lead.id}>
                      <td className="lead-identity-cell">
                        <div className="lead-identity-content">
                          <LeadIdentity lead={lead} />
                        </div>
                      </td>
                      <td className="lead-source-cell">
                        <strong>
                          <PresentationMask placeholder="Campanha oculta">
                            {lead.campaignName ?? "Campanha não resolvida"}
                          </PresentationMask>
                        </strong>
                        <span>{sourceLabel(lead.source, lead.adId)}</span>
                        <LeadLabels labels={lead.labels} />
                      </td>
                      <td>
                        <span className={`event-chip${lifecycleTone(lead)}`}>
                          {lifecycleLabel(lead)}
                        </span>
                      </td>
                      <td className="lead-date-cell">
                        {lastTouchLabel(lead.firstMessageAt)}
                      </td>
                      <td className="lead-date-cell">
                        {lastTouchLabel(lead.lastMessageAt)}
                      </td>
                      <td className="lead-action-cell">
                        <Link
                          className="icon-button lead-open-action"
                          href={`/leads/${lead.id}`}
                          aria-label={`Abrir ${lead.name ?? "lead sem nome"}`}
                          title="Abrir lead"
                        >
                          <ArrowUpRight
                            aria-hidden="true"
                            size={17}
                            strokeWidth={2.2}
                          />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="lead-mobile-list">
              {leads.map((lead) => (
                <article className="lead-mobile-card" key={lead.id}>
                  <header>
                    <div className="lead-mobile-identity">
                      <LeadIdentity lead={lead} />
                    </div>
                    <Link
                      className="icon-button lead-open-action"
                      href={`/leads/${lead.id}`}
                      aria-label={`Abrir ${lead.name ?? "lead sem nome"}`}
                    >
                      <ArrowUpRight
                        aria-hidden="true"
                        size={17}
                        strokeWidth={2.2}
                      />
                    </Link>
                  </header>
                  <div className="lead-mobile-source">
                    <span className="micro-label">Campanha / origem</span>
                    <strong>
                      <PresentationMask placeholder="Campanha oculta">
                        {lead.campaignName ?? "Campanha não resolvida"}
                      </PresentationMask>
                    </strong>
                    <span>{sourceLabel(lead.source, lead.adId)}</span>
                    <LeadLabels labels={lead.labels} />
                  </div>
                  <div className="lead-mobile-stage">
                    <span className="micro-label">Etapa atual</span>
                    <span className={`event-chip${lifecycleTone(lead)}`}>
                      {lifecycleLabel(lead)}
                    </span>
                  </div>
                  <dl>
                    <div>
                      <dt>Recebido</dt>
                      <dd>{lastTouchLabel(lead.firstMessageAt)}</dd>
                    </div>
                    <div>
                      <dt>Última atividade</dt>
                      <dd>{lastTouchLabel(lead.lastMessageAt)}</dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>

            <nav className="report-pagination" aria-label="Paginação de leads">
              <span>
                Página {result.pagination.page} de{" "}
                {Math.max(result.pagination.totalPages, 1)} -{" "}
                {result.pagination.totalItems} leads
              </span>
              <div>
                {result.pagination.page > 1 ? (
                  <Link
                    className="button ghost"
                    href={`/leads?${leadQuery(leadFilters, result.pagination.page - 1)}`}
                  >
                    Anterior
                  </Link>
                ) : (
                  <span className="button ghost disabled" aria-disabled="true">
                    Anterior
                  </span>
                )}
                {result.pagination.page < result.pagination.totalPages ? (
                  <Link
                    className="button ghost"
                    href={`/leads?${leadQuery(leadFilters, result.pagination.page + 1)}`}
                  >
                    Próxima
                  </Link>
                ) : (
                  <span className="button ghost disabled" aria-disabled="true">
                    Próxima
                  </span>
                )}
              </div>
            </nav>
          </>
        ) : (
          <div className={`lead-empty-state ${result.state}`}>
            <UserRoundSearch aria-hidden="true" size={28} strokeWidth={1.8} />
            <div>
              <strong>{emptyTitle}</strong>
              <span>{emptyDescription}</span>
            </div>
            {emptyActionHref ? (
              <Link className="button ghost" href={emptyActionHref}>
                <RotateCcw aria-hidden="true" size={16} strokeWidth={2} />
                {result.state === "error"
                  ? "Tentar novamente"
                  : "Limpar filtros"}
              </Link>
            ) : null}
          </div>
        )}
      </section>
    </section>
  );
}
