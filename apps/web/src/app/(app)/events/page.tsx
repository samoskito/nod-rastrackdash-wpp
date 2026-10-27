import { conversionEventDisplayLabel } from "@wpptrack/shared";
import type {
  ConversionAuditDeliveryStateDto,
  ConversionAuditEventOptionDto,
  ConversionAuditOverviewDto,
  ConversionAuditSourceDto,
} from "@wpptrack/shared";
import {
  AlertTriangle,
  Archive,
  Ban,
  CheckCircle2,
  Clock3,
  History,
  MoonStar,
  ShieldAlert,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { PresentationMask } from "../../../components/presentation-mask";
import { getCurrentWorkspace } from "../../../lib/current-workspace";
import { formatDateTime } from "../../../lib/date-time";
import { serverApiFetch } from "../../../lib/server-api";
import { EventAuditDetails } from "./event-audit-details";
import { EventFilters } from "./event-filters";
import { RetryBlockedEvents } from "./retry-blocked-events";
import { RetryRejectedEvents } from "./retry-rejected-events";

type EventsSearchParams = Record<string, string | string[] | undefined>;

type AuditFilters = {
  since: string;
  until: string;
  eventName?: string;
  status?: ConversionAuditDeliveryStateDto;
  source?: ConversionAuditSourceDto;
  page: number;
  pageSize: number;
};

type AuditResult =
  | { state: "real" | "empty"; report: ConversionAuditOverviewDto }
  | { state: "error"; report: null };

type AuditEvent = ConversionAuditOverviewDto["events"][number];

const emptySummary = {
  total: 0,
  sent: 0,
  queued: 0,
  blocked: 0,
  failed: 0,
  notEligible: 0,
  shadowObserved: 0,
  historical: 0,
  discarded: 0,
  metaAuthRetryable: 0,
  metaRejectedRetryable: 0,
};

function asStringParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function positiveIntegerParam(value: string | undefined, fallback: number) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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

function defaultPeriod() {
  const until = dateOnlyInSaoPaulo(new Date());
  const sinceDate = new Date(`${until}T12:00:00.000Z`);
  sinceDate.setUTCDate(sinceDate.getUTCDate() - 6);

  return { since: sinceDate.toISOString().slice(0, 10), until };
}

function auditQuery(filters: AuditFilters, page = filters.page): string {
  const params = new URLSearchParams({
    since: filters.since,
    until: filters.until,
    page: String(page),
    pageSize: String(filters.pageSize),
  });

  if (filters.eventName) {
    params.set("eventName", filters.eventName);
  }

  if (filters.status) {
    params.set("status", filters.status);
  }

  if (filters.source) {
    params.set("source", filters.source);
  }

  return params.toString();
}

/**
 * Qualquer evento configurado no workspace tem que aparecer no filtro. A lista
 * vem da API (mesma fonte do funil, ja escopada por workspace). Sem ela, cai nos
 * eventos realmente presentes na pagina — nunca numa lista fabricada.
 */
function eventFilterOptions(
  report: ConversionAuditOverviewDto | null,
  selectedEventName: string | undefined,
): ConversionAuditEventOptionDto[] {
  const labelsByEvent = new Map<string, string>();

  for (const option of report?.availableEvents ?? []) {
    labelsByEvent.set(option.eventName, option.label);
  }

  for (const event of report?.events ?? []) {
    if (!labelsByEvent.has(event.eventName)) {
      labelsByEvent.set(event.eventName, event.eventLabel);
    }
  }

  // O evento selecionado nunca some do select, senao o filtro se auto-limpa ao
  // trocar de periodo.
  if (selectedEventName && !labelsByEvent.has(selectedEventName)) {
    labelsByEvent.set(
      selectedEventName,
      conversionEventDisplayLabel(selectedEventName),
    );
  }

  return Array.from(labelsByEvent, ([eventName, label]) => ({
    eventName,
    label,
  }));
}

async function getAudit(filters: AuditFilters): Promise<AuditResult> {
  try {
    const report = await serverApiFetch<ConversionAuditOverviewDto>(
      `/reports/conversions/audit?${auditQuery(filters)}`,
    );

    return {
      state: report.events.length ? "real" : "empty",
      report,
    };
  } catch {
    return { state: "error", report: null };
  }
}

/**
 * Mesma regra da API para reenviar eventos Meta: owner do workspace, ou o
 * platform_owner em modo suporte. Sem workspace legivel, o botao nao aparece.
 */
async function canRetryMetaEvents(): Promise<boolean> {
  try {
    const workspace = await getCurrentWorkspace();

    if (workspace.accessMode === "platform_support") {
      return workspace.platformRole === "platform_owner";
    }

    return workspace.role === "owner";
  } catch {
    return false;
  }
}

/**
 * "Reenviar recusados" (1.3.1): owner ou admin do workspace, ou o
 * platform_owner em modo suporte (mesma regra da API).
 */
async function canRetryRejectedMetaEvents(): Promise<boolean> {
  try {
    const workspace = await getCurrentWorkspace();

    if (workspace.accessMode === "platform_support") {
      return workspace.platformRole === "platform_owner";
    }

    return workspace.role === "owner" || workspace.role === "admin";
  } catch {
    return false;
  }
}

function stateChipClass(state: ConversionAuditDeliveryStateDto): string {
  if (state === "failed") {
    return "event-chip bad";
  }

  if (state === "queued" || state === "blocked") {
    return "event-chip warn";
  }

  if (
    state === "not_eligible" ||
    state === "shadow" ||
    state === "historical" ||
    state === "discarded"
  ) {
    return "event-chip neutral";
  }

  return "event-chip";
}

function auditDate(value: string | null): string {
  if (!value) {
    return "-";
  }

  return formatDateTime(value, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function AuditLead({ event }: { event: AuditEvent }) {
  return (
    <div className="audit-context-block">
      <span className="micro-label">Lead</span>
      <strong>
        {event.leadId ? (
          <PresentationMask placeholder="Lead oculto">
            <Link href={`/leads/${event.leadId}`}>
              {event.leadName ?? "Lead sem nome"}
            </Link>
          </PresentationMask>
        ) : (
          "Lead não vinculado"
        )}
      </strong>
      <span>
        <PresentationMask placeholder="(00) 00000-0000">
          {event.phoneDisplay ?? "Telefone indisponível"}
        </PresentationMask>
      </span>
    </div>
  );
}

function AuditCampaign({ event }: { event: AuditEvent }) {
  return (
    <div className="audit-context-block audit-campaign-context">
      <span className="micro-label">Campanha</span>
      <strong>
        <PresentationMask placeholder="Campanha oculta">
          {event.campaignName ?? "Campanha não resolvida"}
        </PresentationMask>
      </strong>
      <span>
        <PresentationMask placeholder="Conjunto oculto">
          {event.adSetName ?? "Conjunto não resolvido"}
        </PresentationMask>
      </span>
      <span>
        <PresentationMask placeholder="Anúncio oculto">
          {event.adName ?? "Anúncio não resolvido"}
        </PresentationMask>
      </span>
    </div>
  );
}

function AuditDelivery({ event }: { event: AuditEvent }) {
  return (
    <div className="audit-delivery-copy">
      <span className={stateChipClass(event.deliveryState)}>
        {event.statusLabel}
      </span>
      <span>{event.statusDetail}</span>
      {event.errorMessage ? (
        <span
          className={
            event.deliveryState === "failed" ||
            event.deliveryState === "blocked"
              ? "audit-error-copy"
              : "audit-reason-copy"
          }
        >
          {event.errorMessage}
        </span>
      ) : null}
    </div>
  );
}

function AuditMobileEventCard({ event }: { event: AuditEvent }) {
  return (
    <article className={`audit-mobile-event-card ${event.deliveryState}`}>
      <header>
        <div>
          <span className="micro-label">{event.sourceLabel}</span>
          <h3>{event.eventLabel}</h3>
          <code>{event.eventName}</code>
        </div>
        <span className={stateChipClass(event.deliveryState)}>
          {event.statusLabel}
        </span>
      </header>

      <div className="audit-mobile-event-body">
        <AuditLead event={event} />
        <div className="audit-context-block">
          <span className="micro-label">Ocorrido</span>
          <strong>{auditDate(event.occurredAt)}</strong>
          <span>
            {event.sentAt
              ? `Enviado ${auditDate(event.sentAt)}`
              : "Ainda não enviado"}
          </span>
        </div>
        <AuditCampaign event={event} />
        <div className="audit-mobile-delivery-detail">
          <span className="micro-label">Entrega</span>
          <AuditDelivery event={event} />
        </div>
      </div>

      <footer>
        <EventAuditDetails
          canRetry={event.canRetry}
          deliveryState={event.deliveryState}
          eventId={event.id}
          eventLabel={event.eventLabel}
        />
      </footer>
    </article>
  );
}

function AuditPrimaryMetric({
  detail,
  icon: Icon,
  label,
  tone,
  value,
}: {
  detail: string;
  icon: LucideIcon;
  label: string;
  tone: string;
  value: number;
}) {
  return (
    <article className={`audit-primary-metric ${tone}`}>
      <div>
        <Icon aria-hidden="true" size={17} strokeWidth={2.1} />
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

export default async function EventsPage({
  searchParams,
}: {
  searchParams?: Promise<EventsSearchParams>;
}) {
  const params = searchParams ? await searchParams : {};
  const period = defaultPeriod();
  const since = asStringParam(params.since) ?? period.since;
  const until = asStringParam(params.until) ?? period.until;
  const eventName = asStringParam(params.eventName);
  const status = asStringParam(params.status) as
    ConversionAuditDeliveryStateDto | undefined;
  const source = asStringParam(params.source) as
    ConversionAuditSourceDto | undefined;
  const page = positiveIntegerParam(asStringParam(params.page), 1);
  const pageSize = Math.min(
    positiveIntegerParam(asStringParam(params.pageSize), 25),
    100,
  );
  const filters: AuditFilters = {
    since,
    until,
    eventName,
    status,
    source,
    page,
    pageSize,
  };
  const [result, canRetryBlocked, canRetryRejected] = await Promise.all([
    getAudit(filters),
    canRetryMetaEvents(),
    canRetryRejectedMetaEvents(),
  ]);
  const report = result.report;
  const summary = report?.summary ?? emptySummary;
  const pagination = report?.pagination ?? {
    page,
    pageSize,
    totalItems: 0,
    totalPages: 0,
  };
  const hasAttention = summary.blocked + summary.failed > 0;
  const eventOptions = eventFilterOptions(report, eventName);
  const primaryMetrics = [
    {
      detail: "Recebidos pela Meta",
      icon: CheckCircle2,
      label: "Enviados",
      tone: "sent",
      value: summary.sent,
    },
    {
      detail: "Aguardando processamento",
      icon: Clock3,
      label: "Na fila",
      tone: "queued",
      value: summary.queued,
    },
    {
      detail: "Dependem de configuração",
      icon: ShieldAlert,
      label: "Bloqueados",
      tone: "blocked",
      value: summary.blocked,
    },
    {
      detail: "Envio não concluído",
      icon: AlertTriangle,
      label: "Falhas",
      tone: "failed",
      value: summary.failed,
    },
  ];
  const classifiedMetrics = [
    {
      icon: Ban,
      label: "Não elegíveis",
      tone: "not_eligible",
      value: summary.notEligible,
    },
    {
      icon: MoonStar,
      label: "Em sombra",
      tone: "shadow",
      value: summary.shadowObserved,
    },
    {
      icon: Archive,
      label: "Históricos",
      tone: "historical",
      value: summary.historical,
    },
    {
      icon: Trash2,
      label: "Descartados",
      tone: "discarded",
      value: summary.discarded,
    },
  ];

  return (
    <section className="page-stack page-wide audit-page">
      <header className="page-header audit-page-header">
        <div>
          <span className="eyebrow">Eventos Meta</span>
          <h1>Auditoria de conversões</h1>
          <p>
            Acompanhe o que foi enviado, o que está aguardando e o que precisa
            de atenção antes de chegar a Meta.
          </p>
        </div>
        <div className="header-actions">
          {result.state === "error" ? (
            <span className="status-chip bad">API indisponível</span>
          ) : hasAttention ? (
            <span className="status-chip warn">Requer atenção</span>
          ) : (
            <span className="status-chip">Fluxo acompanhado</span>
          )}
        </div>
      </header>

      <nav
        className="report-view-tabs audit-view-tabs"
        aria-label="Visões de eventos Meta"
      >
        <Link className="active" href="/events">
          Conversões
        </Link>
        <Link href="/events/purchase-reviews">Revisão de compras</Link>
      </nav>

      <section
        className="surface-panel audit-command-panel"
        aria-label="Controles da auditoria Meta"
      >
        <EventFilters
          applied={{
            since,
            until,
            pageSize: String(pageSize),
            eventName: eventName ?? "",
            status: status ?? "",
            source: source ?? "",
          }}
          eventOptions={eventOptions}
          page={page}
          rangeLabel={report?.rangeLabel ?? `${since} a ${until}`}
        />
      </section>

      <section
        className="surface-panel audit-health-panel"
        aria-labelledby="audit-health-title"
      >
        <header className="audit-health-heading">
          <div className="audit-heading-copy">
            <span className="audit-heading-icon" aria-hidden="true">
              <ShieldAlert size={18} strokeWidth={2.1} />
            </span>
            <div>
              <span className="eyebrow">Saúde da entrega</span>
              <h2 id="audit-health-title">Fluxo para a Meta</h2>
              <p>Estados operacionais primeiro; classificações em seguida.</p>
            </div>
          </div>
          <span className="status-chip neutral">
            {summary.total} eventos no período
          </span>
        </header>

        <div className="audit-primary-metrics">
          {primaryMetrics.map((metric) => (
            <AuditPrimaryMetric key={metric.tone} {...metric} />
          ))}
        </div>

        <div className="audit-classification-strip">
          <span className="audit-classification-label">
            Fora da fila de envio
          </span>
          <div>
            {classifiedMetrics.map((metric) => {
              const Icon = metric.icon;

              return (
                <span
                  className={`audit-classification-item ${metric.tone}`}
                  key={metric.tone}
                >
                  <Icon aria-hidden="true" size={14} strokeWidth={2.1} />
                  <span>{metric.label}</span>
                  <strong>{metric.value}</strong>
                </span>
              );
            })}
          </div>
        </div>
      </section>

      <div className="audit-section-heading">
        <div className="audit-heading-copy">
          <span className="audit-heading-icon" aria-hidden="true">
            <History size={18} strokeWidth={2.1} />
          </span>
          <div>
            <span className="eyebrow">Histórico de entrega</span>
            <h2>Eventos do período</h2>
          </div>
        </div>
        <div className="audit-history-context">
          <span className="status-chip neutral">
            {pagination.totalItems} registro(s)
          </span>
          <span className="muted">
            {report?.rangeLabel ?? `${since} a ${until}`}
          </span>
          {canRetryBlocked && result.state !== "error" ? (
            <>
              <RetryBlockedEvents
                blockedCount={
                  summary.blocked + (summary.metaAuthRetryable ?? 0)
                }
                filters={{
                  since,
                  until,
                  eventName: eventName ?? "",
                  status: status ?? "",
                  source: source ?? "",
                }}
              />
              <span className="muted">
                Até 500 por vez, com os filtros atuais. Eventos já enviados não
                são reenviados; os com mais de 7 dias ficam de fora.
              </span>
            </>
          ) : null}
          {canRetryRejected && result.state !== "error" ? (
            <RetryRejectedEvents
              rejectedCount={summary.metaRejectedRetryable ?? 0}
              filters={{
                since,
                until,
                eventName: eventName ?? "",
                status: status ?? "",
                source: source ?? "",
              }}
            />
          ) : null}
        </div>
      </div>

      <div className="table-wrap audit-table-scroll audit-desktop-history">
        <table className="audit-table">
          <thead>
            <tr>
              <th>Evento / origem</th>
              <th>Lead e campanha</th>
              <th>Entrega</th>
              <th>Ocorrido / enviado</th>
              <th>Auditoria</th>
            </tr>
          </thead>
          <tbody>
            {report?.events.length ? (
              report.events.map((event) => (
                <tr key={event.id}>
                  <td>
                    <strong>{event.eventLabel}</strong>
                    <span>{event.eventName}</span>
                    <span>{event.sourceLabel}</span>
                  </td>
                  <td>
                    <div className="audit-context-stack">
                      <AuditLead event={event} />
                      <AuditCampaign event={event} />
                    </div>
                  </td>
                  <td>
                    <AuditDelivery event={event} />
                  </td>
                  <td>
                    <strong>{auditDate(event.occurredAt)}</strong>
                    <span>
                      {event.sentAt
                        ? `Enviado ${auditDate(event.sentAt)}`
                        : "Ainda não enviado"}
                    </span>
                  </td>
                  <td>
                    <EventAuditDetails
                      canRetry={event.canRetry}
                      deliveryState={event.deliveryState}
                      eventId={event.id}
                      eventLabel={event.eventLabel}
                    />
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5}>
                  <strong>
                    {result.state === "error"
                      ? "Não foi possível carregar a auditoria"
                      : "Nenhum evento encontrado"}
                  </strong>
                  <span>
                    {result.state === "error"
                      ? "A leitura falhou. Tente novamente depois que a API responder."
                      : "Ajuste o período ou aguarde a chegada de novos eventos."}
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="audit-mobile-history" role="list">
        {report?.events.length ? (
          report.events.map((event) => (
            <AuditMobileEventCard event={event} key={event.id} />
          ))
        ) : (
          <div className="audit-mobile-empty">
            <strong>
              {result.state === "error"
                ? "Não foi possível carregar a auditoria"
                : "Nenhum evento encontrado"}
            </strong>
            <span>
              {result.state === "error"
                ? "A leitura falhou. Tente novamente depois que a API responder."
                : "Ajuste o período ou aguarde a chegada de novos eventos."}
            </span>
          </div>
        )}
      </div>

      <nav className="report-pagination" aria-label="Paginação de eventos Meta">
        <span>
          Página {pagination.page} de {Math.max(pagination.totalPages, 1)} /{" "}
          {pagination.totalItems} eventos
        </span>
        <div>
          {pagination.page > 1 ? (
            <Link
              className="button ghost"
              href={`/events?${auditQuery(filters, pagination.page - 1)}`}
            >
              Anterior
            </Link>
          ) : (
            <span className="button ghost disabled" aria-disabled="true">
              Anterior
            </span>
          )}
          {pagination.page < pagination.totalPages ? (
            <Link
              className="button ghost"
              href={`/events?${auditQuery(filters, pagination.page + 1)}`}
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
    </section>
  );
}
