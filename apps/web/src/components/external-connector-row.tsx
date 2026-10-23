"use client";

import type { ExternalConnectorHealthDto } from "@wpptrack/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDateTime } from "../lib/date-time";
import {
  BackofficeActionForm,
  type BackofficeActionState,
  type BackofficeFormAction
} from "./backoffice-action-form";
import { PendingSubmitButton } from "./pending-submit-button";

type ExternalConnectorRowProps = {
  initialHealth: ExternalConnectorHealthDto;
  workspaceName: string;
  testAction: BackofficeFormAction;
  activateAction: BackofficeFormAction;
  syncAction: BackofficeFormAction;
  activateCutoverAction: BackofficeFormAction;
  rollbackCutoverAction: BackofficeFormAction;
  loadHealthAction: (connectorId: string) => Promise<ExternalConnectorHealthDto | null>;
};

function formatDate(value: string | null): string {
  return value ? formatDateTime(value) : "Ainda não executado";
}

function connectionStatusLabel(health: ExternalConnectorHealthDto): string {
  const connector = health.connector;

  if (connector.lastConnectionStatus === "connected") {
    return connector.status === "active" ? "Ativo" : "Conexão validada";
  }

  if (connector.lastConnectionStatus === "failed") {
    return "Falha na conexão";
  }

  return "Aguardando teste";
}

function reconciliationStateLabel(
  state: NonNullable<ExternalConnectorHealthDto["reconciliation"]>["state"]
): string {
  const labels = {
    collecting: "Coletando eventos",
    blocked: "Bloqueado",
    ready: "Pronto para corte",
    partial: "CAPI parcial",
    live: "CAPI ativo"
  };

  return labels[state];
}

function n8nDeliveryNodeLabel(eventType: string): string {
  const labels: Record<string, string> = {
    conversation_started: "node HTTP de envio LeadSubmitted",
    qualified_lead: 'node "Envia conversão de Lead Qualificado"',
    purchase: "node HTTP de envio Purchase"
  };

  return labels[eventType] ?? "node de envio Meta correspondente";
}

function reconciliationEventLabel(eventType: string): string {
  const labels: Record<string, string> = {
    conversation_started: "Conversas",
    qualified_lead: "Qualificados",
    purchase: "Compras"
  };

  return labels[eventType] ?? eventType;
}

function terminalSyncReached(health: ExternalConnectorHealthDto, requestedAt: number): boolean {
  const connector = health.connector;
  const startedAt = connector.lastSyncStartedAt
    ? new Date(connector.lastSyncStartedAt).getTime()
    : 0;
  const completedAt = connector.lastSyncCompletedAt
    ? new Date(connector.lastSyncCompletedAt).getTime()
    : 0;

  return (
    completedAt >= requestedAt ||
    (connector.lastSyncStatus === "failed" && startedAt >= requestedAt)
  );
}

export function ExternalConnectorRow({
  initialHealth,
  workspaceName,
  testAction,
  activateAction,
  syncAction,
  activateCutoverAction,
  rollbackCutoverAction,
  loadHealthAction
}: ExternalConnectorRowProps) {
  const [health, setHealth] = useState(initialHealth);
  const [syncRequestedAt, setSyncRequestedAt] = useState<number | null>(null);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const connector = health.connector;

  useEffect(() => {
    setHealth(initialHealth);
  }, [initialHealth]);

  const refreshHealth = useCallback(async () => {
    const nextHealth = await loadHealthAction(connector.id);
    if (nextHealth) {
      setHealth(nextHealth);
    }
    return nextHealth;
  }, [connector.id, loadHealthAction]);

  useEffect(() => {
    if (!syncRequestedAt) {
      return;
    }

    let cancelled = false;
    let timeout: number | undefined;

    const poll = async () => {
      const nextHealth = await refreshHealth();
      if (cancelled) {
        return;
      }

      if (nextHealth && terminalSyncReached(nextHealth, syncRequestedAt)) {
        setSyncRequestedAt(null);
        setPollTimedOut(false);
        return;
      }

      if (Date.now() - syncRequestedAt >= 60_000) {
        setSyncRequestedAt(null);
        setPollTimedOut(true);
        return;
      }

      timeout = window.setTimeout(poll, 2_500);
    };

    void poll();

    return () => {
      cancelled = true;
      if (timeout) {
        window.clearTimeout(timeout);
      }
    };
  }, [refreshHealth, syncRequestedAt]);

  const syncLabel = useMemo(() => {
    const startedAt = connector.lastSyncStartedAt
      ? new Date(connector.lastSyncStartedAt).getTime()
      : 0;

    if (syncRequestedAt && startedAt < syncRequestedAt) {
      return "Na fila";
    }
    if (connector.lastSyncStatus === "running") {
      return "Sincronizando";
    }
    if (connector.lastSyncStatus === "completed") {
      return "Sincronização concluída";
    }
    if (connector.lastSyncStatus === "failed") {
      return "Falha na sincronização";
    }
    return "Ainda não sincronizado";
  }, [connector.lastSyncStartedAt, connector.lastSyncStatus, syncRequestedAt]);

  const handleSyncQueued = useCallback((state: BackofficeActionState) => {
    if (!state.syncRequest) {
      return;
    }
    setPollTimedOut(false);
    setSyncRequestedAt(state.syncRequest.requestedAt);
  }, []);

  const handleRefresh = useCallback(() => {
    void refreshHealth();
  }, [refreshHealth]);

  return (
    <article className="connector-row">
      <div className="connector-identity">
        <span className="micro-label">{workspaceName}</span>
        <strong>{connector.name}</strong>
        <small>
          {connector.provider} - SSL {connector.sslMode}
        </small>
      </div>

      <div className="connector-health-copy">
        <div className="connector-status-line">
          <span
            className={`event-chip${connector.lastConnectionStatus === "failed" ? " warn" : ""}`}
          >
            {connectionStatusLabel(health)}
          </span>
          <strong className={connector.lastSyncStatus === "failed" ? "sync-failed" : ""}>
            {syncLabel}
          </strong>
        </div>
        <small>Teste: {formatDate(connector.lastConnectionTestAt)}</small>
        <small>Última sync: {formatDate(connector.lastSyncCompletedAt)}</small>
        {connector.lastSyncErrorCode ? (
          <small className="sync-error-code">Código: {connector.lastSyncErrorCode}</small>
        ) : null}
        {pollTimedOut ? (
          <small className="sync-error-code">
            A fila ainda está processando. Atualize o status em alguns instantes.
          </small>
        ) : null}
        <div className="connector-sync-totals" aria-label="Totais importados">
          <span>
            <small>Importados</small>
            <strong>{health.totals.imported}</strong>
          </span>
          <span>
            <small>Duplicados</small>
            <strong>{health.totals.duplicates}</strong>
          </span>
          <span>
            <small>Descartados</small>
            <strong>{health.totals.quarantined}</strong>
          </span>
          <span>
            <small>Falhas</small>
            <strong>{health.totals.failed}</strong>
          </span>
          <span>
            <small>Pendentes</small>
            <strong>{health.totals.pending}</strong>
          </span>
        </div>
        {health.reconciliation ? (
          <div className="connector-reconciliation" aria-label="Gate de reconciliação CAPI">
            <div className="connector-reconciliation-heading">
              <span className="micro-label">Gate de corte CAPI</span>
              <span
                className={`event-chip${
                  ["blocked", "collecting"].includes(health.reconciliation.state)
                    ? " warn"
                    : ""
                }`}
              >
                {reconciliationStateLabel(health.reconciliation.state)}
              </span>
            </div>
            <div className="connector-reconciliation-events">
              {health.reconciliation.events.map((event) => (
                <div className="connector-reconciliation-event" key={event.eventType}>
                  <strong>{reconciliationEventLabel(event.eventType)}</strong>
                  <span>
                    {event.operationalRows} reais válidos / {event.historicalRows} históricos
                  </span>
                  <small>
                    {event.matchedRows}/{event.expectedMatchedRows} conversões vinculadas
                  </small>
                  <small>
                    {event.duplicateDeliveries} repetições / {event.quarantinedRows} descartados
                  </small>
                  {event.notEligibleRows > 0 ? (
                    <small>
                      {event.notEligibleRows} sem identificador de clique (não elegíveis ao CAPI)
                    </small>
                  ) : null}
                  {event.blockingRejectedRows > 0 || event.pendingRows > 0 ? (
                    <small className="reconciliation-event-warning">
                      {event.blockingRejectedRows} falhas / {event.pendingRows} pendentes
                    </small>
                  ) : null}
                  {event.shadowObservedRows > 0 ? (
                    <small>{event.shadowObservedRows} observados em sombra</small>
                  ) : null}
                  {event.capiActive ? (
                    <div className="connector-cutover-state">
                      <span className="event-chip">WppTrack envia</span>
                      <small>Desde {formatDate(event.cutoverAt)}</small>
                      <details className="connector-cutover-control rollback">
                        <summary>Reverter para o n8n</summary>
                        <p>
                          Reative primeiro o {n8nDeliveryNodeLabel(event.eventType)} no n8n.
                          Depois confirme o rollback aqui.
                        </p>
                        <BackofficeActionForm
                          action={rollbackCutoverAction}
                          onSuccess={handleRefresh}
                          resetOnSuccess
                        >
                          <input type="hidden" name="connectorId" value={connector.id} />
                          <input type="hidden" name="eventType" value={event.eventType} />
                          <label>
                            Digite REVERTER CAPI
                            <input
                              name="confirmation"
                              required
                              pattern="REVERTER CAPI"
                              autoComplete="off"
                            />
                          </label>
                          <PendingSubmitButton
                            label="Reverter envio"
                            pendingLabel="Revertendo..."
                            className="button ghost compact-button"
                          />
                        </BackofficeActionForm>
                      </details>
                    </div>
                  ) : event.readyForCutover ? (
                    <details className="connector-cutover-control">
                      <summary>Assumir envio</summary>
                      <p>
                        Ao concluir, desative imediatamente o {n8nDeliveryNodeLabel(event.eventType)}.
                        Mantenha o registro no ledger MySQL ativo.
                      </p>
                      <BackofficeActionForm
                        action={activateCutoverAction}
                        onSuccess={handleRefresh}
                        resetOnSuccess
                      >
                        <input type="hidden" name="connectorId" value={connector.id} />
                        <input type="hidden" name="eventType" value={event.eventType} />
                        <input
                          type="hidden"
                          name="expectedOperationalRows"
                          value={event.operationalRows}
                        />
                        <label>
                          Digite ASSUMIR ENVIO
                          <input
                            name="confirmation"
                            required
                            pattern="ASSUMIR ENVIO"
                            autoComplete="off"
                          />
                        </label>
                        <PendingSubmitButton
                          label="Ativar este evento"
                          pendingLabel="Ativando..."
                          className="button compact-button"
                        />
                      </BackofficeActionForm>
                    </details>
                  ) : null}
                </div>
              ))}
            </div>
            <small>
              Meta {health.reconciliation.meta.connectionConfigured ? "conectado" : "pendente"}
              {" / "}
              Destino {health.reconciliation.meta.destinationConfigured ? "configurado" : "pendente"}
            </small>
            {health.reconciliation.blockers.length ? (
              <ul className="connector-reconciliation-blockers">
                {health.reconciliation.blockers.slice(0, 3).map((blocker) => (
                  <li key={blocker.code}>{blocker.message}</li>
                ))}
                {health.reconciliation.blockers.length > 3 ? (
                  <li>Mais {health.reconciliation.blockers.length - 3} verificação(oes).</li>
                ) : null}
              </ul>
            ) : (
              <small className="reconciliation-ready-copy">
                {health.reconciliation.events.some((event) => event.capiActive)
                  ? "Corte parcial ativo. Valide cada evento antes de assumir o próximo."
                  : "Eventos reais reconciliados. O envio WppTrack continua desligado."}
              </small>
            )}
          </div>
        ) : null}
      </div>

      <div className="connector-actions">
        <BackofficeActionForm action={testAction} onSuccess={handleRefresh}>
          <input type="hidden" name="connectorId" value={connector.id} />
          <PendingSubmitButton
            label="Testar"
            pendingLabel="Testando..."
            className="button ghost compact-button"
          />
        </BackofficeActionForm>
        {connector.lastConnectionStatus === "connected" && connector.status !== "active" ? (
          <BackofficeActionForm action={activateAction} onSuccess={handleRefresh}>
            <input type="hidden" name="connectorId" value={connector.id} />
            <PendingSubmitButton
              label="Ativar sombra"
              pendingLabel="Ativando..."
              className="button ghost compact-button"
            />
          </BackofficeActionForm>
        ) : null}
        {connector.status === "active" ? (
          <>
            <BackofficeActionForm action={syncAction} onSuccess={handleSyncQueued}>
              <input type="hidden" name="connectorId" value={connector.id} />
              <input type="hidden" name="reimportLeads" value="true" />
              <PendingSubmitButton
                label="Reimportar leads"
                pendingLabel="Enfileirando..."
                className="button ghost compact-button"
              />
            </BackofficeActionForm>
            <BackofficeActionForm action={syncAction} onSuccess={handleSyncQueued}>
              <input type="hidden" name="connectorId" value={connector.id} />
              <PendingSubmitButton
                label="Sincronizar"
                pendingLabel="Enfileirando..."
                className="button compact-button"
              />
            </BackofficeActionForm>
          </>
        ) : null}
      </div>
    </article>
  );
}
