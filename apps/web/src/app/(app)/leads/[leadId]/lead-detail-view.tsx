import type { ManualConversionAccess } from "../../../../lib/manual-conversion-access";
import {
  conversionEventBuilderLabel,
  type LeadDetailConversionEventDto,
  type LeadDetailDto,
} from "@wpptrack/shared";
import { formatDateTime } from "../../../../lib/date-time";
import { CreativePreview } from "./creative-preview";
import {
  CancelManualConversionButton,
  ManualConversionButton,
} from "./manual-conversion-dialog";
import { PresentationMask } from "../../../../components/presentation-mask";

/**
 * Content of the lead detail, shared by the lead page (server render) and the
 * CRM Kanban modal (client render). No data fetching and no server-only
 * import here: the caller passes the detail and the manual conversion access.
 */

function ManualConversionMeta({
  leadId,
  event,
  canManage,
  onChanged,
}: {
  leadId: string;
  event: LeadDetailConversionEventDto;
  canManage: boolean;
  onChanged?: () => void;
}) {
  if (!event.manual) return null;
  const action =
    event.status === "sent" ? (
      <span className="manual-conversion-sent">
        Enviado — não pode ser desfeito
      </span>
    ) : canManage && event.manual.canCancel ? (
      <CancelManualConversionButton
        leadId={leadId}
        conversionEventLogId={event.id}
        onCanceled={onChanged}
      />
    ) : null;
  return (
    <span className="manual-conversion-meta">
      <span className="manual-conversion-meta-head">
        <span className="event-chip manual">
          {event.manual.origin === "kanban" ? "Manual (Kanban)" : "Manual"}
        </span>
        <span className="manual-conversion-author">
          <span>por</span>
          <span className="manual-conversion-author-name">
            <PresentationMask placeholder="Usuário oculto">
              {event.manual.createdByName ?? "usuário"}
            </PresentationMask>
          </span>
        </span>
      </span>
      {event.manual.note ? (
        <span className="manual-conversion-note">{event.manual.note}</span>
      ) : null}
      {action ? (
        <span className="manual-conversion-meta-action">{action}</span>
      ) : null}
    </span>
  );
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

/**
 * Dot color of a conversion status, consistent with the manual outcome chip:
 * sent green; queued/sending blue; only in the panel/canceled gray; expired
 * or unconfirmed amber.
 */
function conversionStatusTone(event: {
  status: string;
  errorCode?: string | null;
}) {
  if (event.status === "sent") return "";
  if (["ready_to_send", "queued", "dispatching"].includes(event.status))
    return " info";
  if (
    event.status === "delivery_unknown" ||
    (event.status === "not_eligible" &&
      event.errorCode === "MetaEventTimeExpired")
  )
    return " warn";
  if (["not_eligible", "skipped", "imported", "shadow_observed"].includes(event.status))
    return " neutral";
  return statusTone(event.status);
}

/**
 * Portuguese status of a conversion (never the raw code). Manual conversions
 * get their own wording for "só no painel", "expirou" and "cancelado".
 */
function eventStatusLabel(
  status: string,
  event?: { errorCode?: string | null; manual?: unknown },
) {
  if (event?.manual) {
    if (status === "not_eligible")
      return event.errorCode === "MetaEventTimeExpired"
        ? "Expirou antes do envio"
        : "Só no painel";
    if (status === "skipped") return "Cancelado";
  }
  const labels: Record<string, string> = {
    sent: "Enviado",
    processed: "Processado",
    pending: "Pendente",
    ready_to_send: "Na fila de envio",
    queued: "Na fila de envio",
    dispatching: "Enviando à Meta",
    delivery_unknown: "Envio não confirmado",
    pending_meta_context: "Bloqueado: sem contexto do anúncio",
    pending_value: "Bloqueado: sem valor",
    not_configured: "Bloqueado: destino Meta não configurado",
    failed: "Falhou",
    error: "Falhou",
    imported: "Importado",
    shadow_observed: "Observado em sombra",
    not_eligible: "Não elegível para CAPI",
    skipped: "Descartado",
  };

  return labels[status] ?? status;
}

/** Portuguese label of the conversion catalog (falls back to the raw name). */
function eventNameLabel(eventName: string) {
  return conversionEventBuilderLabel(eventName);
}

function triggerLabel(trigger: string) {
  const labels: Record<string, string> = {
    conversation_started: "Início de conversa",
    keyword: "Palavra-chave",
    whatsapp_label: "Etiqueta do WhatsApp",
    manual_conversion: "Registro manual",
    auto_lead: "Entrada do WhatsApp",
    meta_lead_form_crm: "Formulário Meta (CRM)",
  };

  return labels[trigger] ?? trigger;
}

function sourceLabel(source: string | null) {
  const labels: Record<string, string> = {
    external_mysql: "Integração externa",
    meta_lead_form: "Formulário Meta",
    dashboard_leads: "Dashboard Leads (importado)",
    umbler_talk: "Umbler Talk",
    uazapi: "NOD API",
  };

  return source ? (labels[source] ?? source) : "-";
}

export function leadStatusLabel(status: string) {
  const labels: Record<string, string> = {
    new: "Novo",
    active: "Atendimento ativo",
    qualified: "Lead qualificado",
    converted: "Compra atribuída",
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
  const resolvedName = name ?? "Não resolvido";
  const hiddenName =
    label === "Campanha"
      ? "Campanha oculta"
      : label === "Conjunto"
        ? "Conjunto oculto"
        : "Anúncio oculto";

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
          {id ? `ID ${id}` : "ID indisponível"}
        </PresentationMask>
      </small>
    </li>
  );
}

/**
 * Everything below the lead header: attribution and creative, tracking
 * facts, conversion history (with "Registrar conversão manual") and
 * webhooks. `onChanged` (CRM modal) replaces the page refresh after a manual
 * conversion is registered or canceled.
 */
export function LeadDetailView({
  detail,
  manualAccess,
  onChanged,
}: {
  detail: LeadDetailDto;
  manualAccess: ManualConversionAccess;
  onChanged?: () => void;
}) {
  const { lead } = detail;

  return (
    <>
      <div
        className={`lead-attribution-layout${lead.adId ? " has-creative" : ""}`}
      >
        <section className="lead-attribution-panel">
          <header className="lead-attribution-heading">
            <span className="eyebrow">Atribuição</span>
            <h2>Origem do anúncio</h2>
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
              label="Anúncio"
              name={detail.attribution.adName ?? lead.adId}
            />
          </ol>

          <footer className="lead-latest-event">
            <span className="micro-label">Último evento</span>
            <strong>
              {lead.lastEventName
                ? eventNameLabel(lead.lastEventName)
                : "Sem evento"}
            </strong>
          </footer>
        </section>

        {lead.adId ? (
          <CreativePreview
            adId={lead.adId}
            adName={detail.attribution.adName ?? lead.adId}
            destinationUrl={detail.attribution.creative?.destinationUrl ?? null}
            thumbnailUrl={detail.attribution.creative?.thumbnailUrl ?? null}
            thumbnailVersion={
              detail.attribution.creative?.thumbnailVersion ?? null
            }
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
            <dt>Última mensagem</dt>
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
        <header className="lead-detail-section-header manual-conversion-header">
          <div>
            <span className="eyebrow">Conversões</span>
            <h2>Eventos do Pixel/CAPI</h2>
          </div>
          {manualAccess.canManage ? (
            <ManualConversionButton
              leadId={lead.id}
              defaultCurrency={manualAccess.currency}
              licenseLocked={manualAccess.licenseLocked}
              onRecorded={onChanged}
            />
          ) : null}
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
                          className={`event-chip${conversionStatusTone(event)}`}
                        >
                          {eventStatusLabel(event.status, event)}
                        </span>
                        {event.errorMessage ? (
                          <span>{event.errorMessage}</span>
                        ) : null}
                      </td>
                      <td>
                        {triggerLabel(event.sourceTrigger)}
                        <ManualConversionMeta
                          leadId={lead.id}
                          event={event}
                          canManage={manualAccess.canManage}
                          onChanged={onChanged}
                        />
                      </td>
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
                    <span className={`event-chip${conversionStatusTone(event)}`}>
                      {eventStatusLabel(event.status, event)}
                    </span>
                  </header>
                  <dl>
                    <div>
                      <dt>Gatilho</dt>
                      <dd>
                        {triggerLabel(event.sourceTrigger)}
                        <ManualConversionMeta
                          leadId={lead.id}
                          event={event}
                          canManage={manualAccess.canManage}
                          onChanged={onChanged}
                        />
                      </dd>
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
            <strong>Nenhum evento de conversão</strong>
            <span>Eventos por palavra-chave ou etiqueta aparecerão aqui.</span>
          </div>
        )}
      </section>

      <section className="lead-detail-section">
        <header className="lead-detail-section-header">
          <span className="eyebrow">Webhooks</span>
          <h2>Webhooks e diagnósticos vinculados</h2>
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
              Quando houver logs com este lead/telefone, eles aparecerão aqui.
            </span>
          </div>
        )}
      </section>
    </>
  );
}
