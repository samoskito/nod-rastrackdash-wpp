"use client";

import type { MetaLeadFormConnectionDto } from "@wpptrack/shared";
import { BackofficeActionForm } from "../../../components/backoffice-action-form";
import { PendingSubmitButton } from "../../../components/pending-submit-button";
import { PresentationMask } from "../../../components/presentation-mask";
import { formatDateTime } from "../../../lib/date-time";
import {
  createMetaLeadFormConnectionAction,
  deleteMetaLeadFormConnectionAction,
  setMetaLeadFormConnectionActiveAction,
  subscribeMetaLeadFormPageAction,
} from "./meta-lead-form-actions";

function when(value: string | null) {
  return value
    ? formatDateTime(value, {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "-";
}

function ConnectionCard({
  connection,
  canManage,
}: {
  connection: MetaLeadFormConnectionDto;
  canManage: boolean;
}) {
  return (
    <article className="meta-lead-form-card">
      <header>
        <strong>{connection.label}</strong>
        <span className={`status-chip${connection.active ? "" : " warn"}`}>
          {connection.active ? "Ativa" : "Pausada"}
        </span>
        <span
          className={`status-chip${connection.pageSubscribedAt ? "" : " warn"}`}
        >
          {connection.pageSubscribedAt ? "Pagina assinada" : "Pagina nao assinada"}
        </span>
      </header>
      <dl className="lead-facts">
        <div>
          <dt>Pagina</dt>
          <dd>
            <PresentationMask placeholder="ID oculto">
              {connection.pageId}
            </PresentationMask>
          </dd>
        </div>
        <div>
          <dt>Formularios</dt>
          <dd>
            {connection.formIds.length
              ? connection.formIds.join(", ")
              : "Todos da Pagina"}
          </dd>
        </div>
        <div>
          <dt>Dataset CRM / evento</dt>
          <dd>
            <PresentationMask placeholder="Dataset oculto">
              {connection.crmDatasetId ?? "Sem dataset (nao envia a Meta)"}
            </PresentationMask>{" "}
            / {connection.qualifiedEventName}
          </dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>
            Graph ...{connection.graphTokenLast4}
            {connection.capiTokenLast4
              ? ` / Dataset ...${connection.capiTokenLast4}`
              : " / Dataset usa o token Graph"}
          </dd>
        </div>
        <div>
          <dt>Leads recebidos</dt>
          <dd>
            {connection.submissionCount} (ultimo{" "}
            {when(connection.lastSubmissionAt)})
          </dd>
        </div>
      </dl>
      {canManage ? (
        <div className="lead-status-controls">
          <BackofficeActionForm action={subscribeMetaLeadFormPageAction}>
            <input type="hidden" name="connectionId" value={connection.id} />
            <PendingSubmitButton
              label={
                connection.pageSubscribedAt
                  ? "Assinar Pagina de novo"
                  : "Assinar Pagina"
              }
              pendingLabel="Assinando..."
              className="button primary"
            />
          </BackofficeActionForm>
          <BackofficeActionForm action={setMetaLeadFormConnectionActiveAction}>
            <input type="hidden" name="connectionId" value={connection.id} />
            <input
              type="hidden"
              name="active"
              value={connection.active ? "false" : "true"}
            />
            <PendingSubmitButton
              label={connection.active ? "Pausar" : "Ativar"}
              pendingLabel="Salvando..."
            />
          </BackofficeActionForm>
          <BackofficeActionForm action={deleteMetaLeadFormConnectionAction}>
            <input type="hidden" name="connectionId" value={connection.id} />
            <button
              className="button"
              type="submit"
              onClick={(event) => {
                if (
                  !window.confirm(
                    "Remover a conexao apaga o historico de formularios dela. Os leads continuam. Continuar?",
                  )
                ) {
                  event.preventDefault();
                }
              }}
            >
              Remover
            </button>
          </BackofficeActionForm>
        </div>
      ) : null}
    </article>
  );
}

/**
 * Meta instant forms (Lead Ads), Dashboard Leads parity: each Page with its
 * System User token; "Qualificado" on the lead screen sends the CRM stage to
 * the dataset.
 */
export function MetaLeadFormsPanel({
  connections,
  canManage,
  loadFailed,
}: {
  connections: MetaLeadFormConnectionDto[];
  canManage: boolean;
  loadFailed: boolean;
}) {
  const webhookUrl = connections[0]?.webhookUrl;

  return (
    <div className="meta-config-section">
      <div>
        <span className="eyebrow">Formularios Meta</span>
        <h2>Leads de formulario instantaneo (Lead Ads)</h2>
        <p className="muted">
          Cada Pagina recebe os leads por webhook. Ao marcar um lead como
          Qualificado, o evento de etapa vai para o dataset do CRM (Conversions
          API for CRM).
          {webhookUrl ? (
            <>
              {" "}
              No app Meta, o webhook do objeto Page (campo leadgen) aponta para{" "}
              <code>{webhookUrl}</code>.
            </>
          ) : null}
        </p>
      </div>

      {loadFailed ? (
        <p className="muted">Nao foi possivel carregar as conexoes agora.</p>
      ) : null}

      {connections.map((connection) => (
        <ConnectionCard
          key={connection.id}
          connection={connection}
          canManage={canManage}
        />
      ))}

      {canManage ? (
        <BackofficeActionForm
          action={createMetaLeadFormConnectionAction}
          className="filter-bar"
          resetOnSuccess
        >
          <label className="filter-field">
            <span>Nome</span>
            <input name="label" required maxLength={80} placeholder="Locaville" />
          </label>
          <label className="filter-field">
            <span>ID da Pagina</span>
            <input name="pageId" required inputMode="numeric" />
          </label>
          <label className="filter-field">
            <span>IDs dos formularios (opcional)</span>
            <input name="formIds" placeholder="vazio = todos" />
          </label>
          <label className="filter-field">
            <span>Dataset CRM</span>
            <input name="crmDatasetId" inputMode="numeric" />
          </label>
          <label className="filter-field">
            <span>Evento ao qualificar</span>
            <input
              name="qualifiedEventName"
              defaultValue="LeadQualificado"
              maxLength={50}
            />
          </label>
          <label className="filter-field">
            <span>Token Graph (System User)</span>
            <input
              name="graphToken"
              type="password"
              required
              autoComplete="off"
            />
          </label>
          <label className="filter-field">
            <span>Token do dataset CRM (opcional)</span>
            <input name="capiToken" type="password" autoComplete="off" />
          </label>
          <PendingSubmitButton
            label="Salvar conexao"
            pendingLabel="Salvando..."
            className="button primary"
          />
        </BackofficeActionForm>
      ) : (
        <p className="muted">Sem permissao para alterar formularios Meta.</p>
      )}
    </div>
  );
}
