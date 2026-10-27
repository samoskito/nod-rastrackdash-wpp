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
  updateMetaLeadFormConnectionAction,
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
  // Decisão de 27/10/2026: com envios a conexão só desativa (a API responde
  // 409 ao remover), para não apagar o histórico de formulários.
  const hasSubmissions = connection.submissionCount > 0;

  return (
    <article className="meta-lead-form-card">
      <header>
        <strong>{connection.label}</strong>
        <span className={`status-chip${connection.active ? "" : " warn"}`}>
          {connection.active ? "Ativa" : "Desativada"}
        </span>
        <span
          className={`status-chip${connection.pageSubscribedAt ? "" : " warn"}`}
        >
          {connection.pageSubscribedAt ? "Página assinada" : "Página não assinada"}
        </span>
      </header>
      <dl className="lead-facts">
        <div>
          <dt>Página</dt>
          <dd>
            <PresentationMask placeholder="ID oculto">
              {connection.pageId}
            </PresentationMask>
          </dd>
        </div>
        <div>
          <dt>Formulários</dt>
          <dd>
            {connection.formIds.length
              ? connection.formIds.join(", ")
              : "Todos da Página"}
          </dd>
        </div>
        <div>
          <dt>Dataset do CRM / evento</dt>
          <dd>
            <PresentationMask placeholder="Dataset oculto">
              {connection.crmDatasetId ?? "Sem dataset (a etapa não é enviada à Meta)"}
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
              : " / o dataset usa o token Graph"}
          </dd>
        </div>
        <div>
          <dt>Leads recebidos</dt>
          <dd>
            {connection.submissionCount} (último{" "}
            {when(connection.lastSubmissionAt)})
          </dd>
        </div>
      </dl>
      {canManage ? (
        <div className="meta-lead-form-actions">
          <BackofficeActionForm action={subscribeMetaLeadFormPageAction}>
            <input type="hidden" name="connectionId" value={connection.id} />
            <PendingSubmitButton
              label={
                connection.pageSubscribedAt
                  ? "Assinar Página de novo"
                  : "Assinar Página"
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
              label={connection.active ? "Desativar" : "Reativar"}
              pendingLabel="Salvando..."
            />
          </BackofficeActionForm>
          {hasSubmissions ? null : (
            <BackofficeActionForm action={deleteMetaLeadFormConnectionAction}>
              <input type="hidden" name="connectionId" value={connection.id} />
              <button
                className="button"
                type="submit"
                onClick={(event) => {
                  if (
                    !window.confirm(
                      "Remover apaga a configuração desta Página (ela ainda não recebeu formulários). Para trocar token ou dataset, use Editar. Continuar?",
                    )
                  ) {
                    event.preventDefault();
                  }
                }}
              >
                Remover
              </button>
            </BackofficeActionForm>
          )}
        </div>
      ) : null}
      {canManage && hasSubmissions ? (
        <p className="muted">
          Esta Página já recebeu formulários: não dá para remover. Desative para
          parar de receber; o histórico fica guardado.
        </p>
      ) : null}
      {canManage ? (
        <details className="meta-lead-form-edit">
          <summary>Editar dataset, evento ou tokens</summary>
          <BackofficeActionForm
            action={updateMetaLeadFormConnectionAction}
            className="filter-bar"
            resetOnSuccess
          >
            <input type="hidden" name="connectionId" value={connection.id} />
            <label className="filter-field">
              <span>Dataset do CRM</span>
              <input name="crmDatasetId" inputMode="numeric" placeholder="manter" />
            </label>
            <label className="filter-field">
              <span>Evento ao qualificar</span>
              <input name="qualifiedEventName" maxLength={50} placeholder="manter" />
            </label>
            <label className="filter-field">
              <span>Novo token Graph</span>
              <input name="graphToken" type="password" autoComplete="off" placeholder="manter" />
            </label>
            <label className="filter-field">
              <span>Novo token do dataset do CRM</span>
              <input name="capiToken" type="password" autoComplete="off" placeholder="manter" />
            </label>
            <PendingSubmitButton label="Salvar alterações" pendingLabel="Salvando..." />
          </BackofficeActionForm>
        </details>
      ) : null}
    </article>
  );
}

/**
 * Fase 6.9 (PR #91 do nod): formulários instantâneos da Meta (Lead Ads). Cada
 * Página com o seu token de System User; ao registrar "Lead qualificado" no
 * lead (conversão manual ou Kanban), a etapa vai para o dataset do CRM. A
 * conexão nasce ativa: não há passo de liberação.
 */
export function MetaLeadFormsPanel({
  connections,
  canManage,
  licenseLocked,
  loadFailed,
}: {
  connections: MetaLeadFormConnectionDto[];
  canManage: boolean;
  licenseLocked: boolean;
  loadFailed: boolean;
}) {
  const webhookUrl = connections[0]?.webhookUrl;
  const canWrite = canManage && !licenseLocked;

  return (
    <div className="meta-config-section">
      <div>
        <span className="eyebrow">Formulários Meta</span>
        <h2>Leads de formulário instantâneo (Lead Ads)</h2>
        <p className="muted">
          Cada Página recebe os leads pelo webhook. Ao registrar Lead
          qualificado no lead (ou arrastar o card no CRM), a etapa vai para o
          dataset do CRM (Conversions API for CRM).
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
        <p className="muted">Não foi possível carregar as conexões agora.</p>
      ) : null}

      {connections.map((connection) => (
        <ConnectionCard
          key={connection.id}
          connection={connection}
          canManage={canWrite}
        />
      ))}

      {licenseLocked ? (
        <p className="muted">
          Licença bloqueada: criar, alterar e remover conexões de formulário está
          indisponível. Verifique /backoffice/license.
        </p>
      ) : canManage ? (
        <BackofficeActionForm
          action={createMetaLeadFormConnectionAction}
          className="filter-bar"
          resetOnSuccess
        >
          <label className="filter-field">
            <span>Nome</span>
            <input name="label" required maxLength={80} placeholder="Nome da Página" />
          </label>
          <label className="filter-field">
            <span>ID da Página</span>
            <input name="pageId" required inputMode="numeric" />
          </label>
          <label className="filter-field">
            <span>IDs dos formulários (opcional)</span>
            <input name="formIds" placeholder="vazio = todos" />
          </label>
          <label className="filter-field">
            <span>Dataset do CRM</span>
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
            <span>Token do dataset do CRM (opcional)</span>
            <input name="capiToken" type="password" autoComplete="off" />
          </label>
          <PendingSubmitButton
            label="Salvar conexão"
            pendingLabel="Salvando..."
            className="button primary"
          />
        </BackofficeActionForm>
      ) : (
        <p className="muted">Sem permissão para alterar formulários Meta.</p>
      )}
    </div>
  );
}
