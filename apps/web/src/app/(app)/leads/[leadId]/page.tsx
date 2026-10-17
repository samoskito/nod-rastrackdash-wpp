import type { LeadDetailDto } from "@wpptrack/shared";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { formatDateTime } from "../../../../lib/date-time";
import { serverApiFetch } from "../../../../lib/server-api";
import { CreativePreview } from "./creative-preview";
import { LeadStatusControls } from "./lead-status-controls";
import { PresentationMask } from "../../../../components/presentation-mask";

type LeadDetailParams = {
  leadId: string;
};

type LeadDetailResult = {
  detail: LeadDetailDto | null;
  state: "real" | "error";
};

async function getLeadDetail(leadId: string): Promise<LeadDetailResult> {
  try {
    return {
      detail: await serverApiFetch<LeadDetailDto>(`/leads/${leadId}`),
      state: "real",
    };
  } catch {
    return {
      detail: null,
      state: "error",
    };
  }
}

function dateTime(value: string | null) {
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

function statusTone(status: string) {
  return ["error", "failed", "not_configured", "pending_meta_context"].includes(
    status,
  )
    ? " warn"
    : "";
}

function eventStatusLabel(status: string) {
  const labels: Record<string, string> = {
    sent: "Enviado",
    processed: "Processado",
    pending: "Pendente",
    queued: "Na fila",
    failed: "Falhou",
    error: "Falhou",
    imported: "Importado",
    shadow_observed: "Observado em sombra",
    not_eligible: "Nao elegivel para CAPI",
  };

  return labels[status] ?? status;
}

function eventNameLabel(eventName: string) {
  const labels: Record<string, string> = {
    LeadSubmitted: "Conversa iniciada",
    QualifiedLead: "Lead qualificado",
    Purchase: "Compra atribuida",
  };

  return labels[eventName] ?? eventName;
}

function triggerLabel(trigger: string) {
  const labels: Record<string, string> = {
    conversation_started: "Inicio de conversa",
    keyword: "Palavra-chave",
    whatsapp_label: "Etiqueta do WhatsApp",
    manual_status: "Marcado na tela do lead",
    meta_lead_form_crm: "Formulario Meta (CRM)",
  };

  return labels[trigger] ?? trigger;
}

function sourceLabel(source: string | null) {
  const labels: Record<string, string> = {
    external_mysql: "Integracao externa",
    meta_lead_form: "Formulario Meta",
    dashboard_leads: "Dashboard Leads (importado)",
    umbler_talk: "Umbler Talk",
    uazapi: "NOD API",
  };

  return source ? (labels[source] ?? source) : "-";
}

function leadStatusLabel(status: string) {
  const labels: Record<string, string> = {
    new: "Novo",
    active: "Atendimento ativo",
    qualified: "Lead qualificado",
    converted: "Compra atribuida",
    lost: "Perdido",
  };

  return labels[status] ?? status;
}

function webhookEventLabel(eventType: string) {
  const labels: Record<string, string> = {
    Message: "Mensagem",
    message: "Mensagem",
    NewConversation: "Nova conversa",
    new_conversation: "Nova conversa",
  };

  return labels[eventType] ?? eventType;
}

function webhookSourceLabel(source: string) {
  const labels: Record<string, string> = {
    umbler_talk: "Umbler Talk",
    uazapi: "NOD API",
  };

  return labels[source] ?? source;
}

function eventTechnicalName(eventName: string, id: string) {
  return `${eventName} / ${id}`;
}

function webhookTechnicalName(eventType: string, id: string) {
  return `${eventType} / ${id}`;
}

function AttributionStep({
  id,
  index,
  label,
  name,
}: {
  id: string | null;
  index: string;
  label: string;
  name: string | null;
}) {
  const resolvedName = name ?? "Nao resolvido";
  const hiddenName =
    label === "Campanha"
      ? "Campanha oculta"
      : label === "Conjunto"
        ? "Conjunto oculto"
        : "Anuncio oculto";

  return (
    <li className="lead-attribution-step">
      <div className="lead-attribution-meta">
        <span>{index}</span>
        <span>{label}</span>
      </div>
      <strong>
        <PresentationMask placeholder={hiddenName}>
          {resolvedName}
        </PresentationMask>
      </strong>
      <small>
        <PresentationMask placeholder="ID oculto">
          {id ? `ID ${id}` : "ID indisponivel"}
        </PresentationMask>
      </small>
    </li>
  );
}

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<LeadDetailParams>;
}) {
  const { leadId } = await params;
  const result = await getLeadDetail(leadId);
  const detail = result.detail;

  if (!detail) {
    return (
      <section className="page-stack page-standard">
        <header className="page-header">
          <div>
            <span className="eyebrow">Leads</span>
            <h1>Nao foi possivel carregar o lead</h1>
            <p>Confira a API antes de analisar a jornada deste contato.</p>
          </div>
          <div className="header-actions">
            <span className="status-chip warn">API indisponivel</span>
            <Link className="button" href="/leads">
              <ArrowLeft aria-hidden="true" size={17} strokeWidth={2.2} />
              Voltar
            </Link>
          </div>
        </header>
      </section>
    );
  }

  const { lead } = detail;

  return (
    <section className="page-stack page-wide lead-detail-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">Lead</span>
          <h1>
            <PresentationMask placeholder="Lead oculto">
              {lead.name ?? "Lead sem nome"}
            </PresentationMask>
          </h1>
          <p>
            <PresentationMask placeholder="(00) 00000-0000">
              {lead.phoneDisplay ?? lead.phoneHash}
            </PresentationMask>
          </p>
        </div>
        <div className="header-actions">
          <span className="status-chip">{leadStatusLabel(lead.status)}</span>
          <Link className="button" href="/leads">
            <ArrowLeft aria-hidden="true" size={17} strokeWidth={2.2} />
            Voltar
          </Link>
        </div>
      </header>

      <section className="lead-detail-section">
        <header className="lead-detail-section-header">
          <span className="eyebrow">Qualificacao</span>
          <h2>Status do lead</h2>
        </header>
        <LeadStatusControls leadId={lead.id} status={lead.status} />
      </section>

      <div
        className={`lead-attribution-layout${lead.adId ? " has-creative" : ""}`}
      >
        <section className="lead-attribution-panel">
          <header className="lead-attribution-heading">
            <span className="eyebrow">Atribuicao</span>
            <h2>Origem do anuncio</h2>
          </header>

          <ol className="lead-attribution-path">
            <AttributionStep
              id={lead.campaignId}
              index="01"
              label="Campanha"
              name={detail.attribution.campaignName}
            />
            <AttributionStep
              id={lead.adSetId}
              index="02"
              label="Conjunto"
              name={detail.attribution.adSetName ?? lead.adSetId}
            />
            <AttributionStep
              id={lead.adId}
              index="03"
              label="Anuncio"
              name={detail.attribution.adName ?? lead.adId}
            />
          </ol>

          <footer className="lead-latest-event">
            <span className="micro-label">Ultimo evento</span>
            <strong>
              {lead.lastEventName
                ? eventNameLabel(lead.lastEventName)
                : "Sem evento"}
            </strong>
          </footer>
        </section>

        {lead.adId ? (
          <CreativePreview
            adName={detail.attribution.adName ?? lead.adId}
            destinationUrl={detail.attribution.creative?.destinationUrl ?? null}
            thumbnailUrl={detail.attribution.creative?.thumbnailUrl ?? null}
          />
        ) : null}
      </div>

      <section className="lead-detail-section">
        <header className="lead-detail-section-header">
          <span className="eyebrow">Jornada</span>
          <h2>Rastreamento do lead</h2>
        </header>
        <dl className="lead-facts">
          <div>
            <dt>Origem</dt>
            <dd>{sourceLabel(lead.source)}</dd>
          </div>
          <div>
            <dt>Primeira mensagem</dt>
            <dd>{dateTime(lead.firstMessageAt)}</dd>
          </div>
          <div>
            <dt>Ultima mensagem</dt>
            <dd>{dateTime(lead.lastMessageAt)}</dd>
          </div>
          <div>
            <dt>IDs Meta</dt>
            <dd>
              <PresentationMask placeholder="IDs ocultos">
                {[lead.campaignId, lead.adSetId, lead.adId]
                  .filter(Boolean)
                  .join(" / ") || "-"}
              </PresentationMask>
            </dd>
          </div>
        </dl>
      </section>

      <section className="lead-detail-section">
        <header className="lead-detail-section-header">
          <span className="eyebrow">Conversoes</span>
          <h2>Eventos do Pixel/CAPI</h2>
        </header>
        {detail.conversionEvents.length > 0 ? (
          <>
            <div className="table-wrap lead-detail-table">
              <table>
                <thead>
                  <tr>
                    <th>Evento</th>
                    <th>Status</th>
                    <th>Gatilho</th>
                    <th>Pixel</th>
                    <th>Ocorrido em</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.conversionEvents.map((event) => (
                    <tr key={event.id}>
                      <td>
                        <strong>{eventNameLabel(event.eventName)}</strong>
                        <span>
                          {eventTechnicalName(event.eventName, event.id)}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`event-chip${statusTone(event.status)}`}
                        >
                          {eventStatusLabel(event.status)}
                        </span>
                        {event.errorMessage ? (
                          <span>{event.errorMessage}</span>
                        ) : null}
                      </td>
                      <td>{triggerLabel(event.sourceTrigger)}</td>
                      <td>
                        <PresentationMask placeholder="Pixel oculto">
                          {event.pixelId ?? "-"}
                        </PresentationMask>
                      </td>
                      <td>{dateTime(event.occurredAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="lead-detail-mobile-list">
              {detail.conversionEvents.map((event) => (
                <article className="lead-detail-mobile-card" key={event.id}>
                  <header>
                    <div>
                      <strong>{eventNameLabel(event.eventName)}</strong>
                      <span>
                        {eventTechnicalName(event.eventName, event.id)}
                      </span>
                    </div>
                    <span className={`event-chip${statusTone(event.status)}`}>
                      {eventStatusLabel(event.status)}
                    </span>
                  </header>
                  <dl>
                    <div>
                      <dt>Gatilho</dt>
                      <dd>{triggerLabel(event.sourceTrigger)}</dd>
                    </div>
                    <div>
                      <dt>Ocorrido em</dt>
                      <dd>{dateTime(event.occurredAt)}</dd>
                    </div>
                    <div>
                      <dt>Pixel</dt>
                      <dd>
                        <PresentationMask placeholder="Pixel oculto">
                          {event.pixelId ?? "-"}
                        </PresentationMask>
                      </dd>
                    </div>
                  </dl>
                  {event.errorMessage ? (
                    <p className="lead-detail-event-error">
                      {event.errorMessage}
                    </p>
                  ) : null}
                </article>
              ))}
            </div>
          </>
        ) : (
          <div className="lead-detail-empty-state">
            <strong>Nenhum evento de conversao</strong>
            <span>Eventos por palavra-chave ou etiqueta aparecerao aqui.</span>
          </div>
        )}
      </section>

      <section className="lead-detail-section">
        <header className="lead-detail-section-header">
          <span className="eyebrow">Webhooks</span>
          <h2>Webhooks e diagnosticos vinculados</h2>
        </header>
        {detail.webhookEvents.length > 0 ? (
          <>
            <div className="table-wrap lead-detail-table">
              <table>
                <thead>
                  <tr>
                    <th>Webhook</th>
                    <th>Status</th>
                    <th>Recebido</th>
                    <th>Processado</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.webhookEvents.map((event) => (
                    <tr key={event.id}>
                      <td>
                        <strong>
                          Webhook {webhookSourceLabel(event.source)}
                        </strong>
                        <span>
                          {webhookTechnicalName(event.eventType, event.id)}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`event-chip${statusTone(event.status)}`}
                        >
                          {eventStatusLabel(event.status)}
                        </span>
                        {event.errorMessage ? (
                          <span>{event.errorMessage}</span>
                        ) : null}
                      </td>
                      <td>{dateTime(event.receivedAt)}</td>
                      <td>{dateTime(event.processedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="lead-detail-mobile-list">
              {detail.webhookEvents.map((event) => (
                <article className="lead-detail-mobile-card" key={event.id}>
                  <header>
                    <div>
                      <strong>
                        Webhook {webhookSourceLabel(event.source)}
                      </strong>
                      <span>
                        {webhookEventLabel(event.eventType)} / {event.id}
                      </span>
                    </div>
                    <span className={`event-chip${statusTone(event.status)}`}>
                      {eventStatusLabel(event.status)}
                    </span>
                  </header>
                  <dl>
                    <div>
                      <dt>Recebido</dt>
                      <dd>{dateTime(event.receivedAt)}</dd>
                    </div>
                    <div>
                      <dt>Processado</dt>
                      <dd>{dateTime(event.processedAt)}</dd>
                    </div>
                  </dl>
                  {event.errorMessage ? (
                    <p className="lead-detail-event-error">
                      {event.errorMessage}
                    </p>
                  ) : null}
                </article>
              ))}
            </div>
          </>
        ) : (
          <div className="lead-detail-empty-state">
            <strong>Nenhum webhook vinculado</strong>
            <span>
              Quando houver logs com este lead/telefone, eles aparecerao aqui.
            </span>
          </div>
        )}
      </section>
    </section>
  );
}
