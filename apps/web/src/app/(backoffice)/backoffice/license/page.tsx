import { BackofficeNavigation } from "../../../../components/backoffice-navigation";
import { formatDateTime } from "../../../../lib/date-time";
import {
  fetchLicenseStatus,
  licenseIntervalLabel,
  licenseLockCopy,
  licenseLockReason,
  type LicenseStatus,
  type LicenseStatusResponse,
} from "../../../../lib/license-status";

const statusChipClass: Record<LicenseStatus, string> = {
  active: "status-chip",
  grace: "status-chip warn",
  blocked: "status-chip bad",
  unlicensed: "status-chip neutral",
};

const statusLabel: Record<LicenseStatus, string> = {
  active: "Ativa",
  grace: "Em tolerância",
  blocked: "Bloqueada",
  unlicensed: "Sem licença",
};

/**
 * Read-only license status for the student/self-hosted edition — no key
 * material, account identity or write actions. When the API is locking writes
 * it also spells out how to get back to an activated license. See
 * .claude-task-f6-1-backoffice.md #2 and .claude-task-license-hard-lock.md #6.
 */
export default async function BackofficeLicensePage() {
  const status = await fetchLicenseStatus();

  return (
    <section className="page-stack standalone-page backoffice-license-page">
      <BackofficeNavigation active="license" />

      <header className="page-header">
        <div>
          <span className="eyebrow">Operação da instância</span>
          <h1>Licença</h1>
          <p>Consulta somente leitura do status da licença local.</p>
        </div>
        {status ? (
          <span className={statusChipClass[status.status]}>
            {statusLabel[status.status]}
          </span>
        ) : (
          <span className="status-chip bad">Indisponível</span>
        )}
      </header>

      {status && licenseLockReason(status) ? (
        <LicenseLockPanel status={status} />
      ) : null}

      {status ? (
        <LicenseStatusPanel status={status} />
      ) : (
        <section className="surface-panel license-status-panel">
          <p>
            Não foi possível carregar o status da licença. Verifique se a API
            está no ar e tente novamente.
          </p>
        </section>
      )}

      {status?.status === "unlicensed" && !licenseLockReason(status) ? (
        <LicenseEmptyStateNote />
      ) : null}
    </section>
  );
}

function LicenseStatusPanel({ status }: { status: LicenseStatusResponse }) {
  return (
    <section className="surface-panel license-status-panel">
      <dl className="account-facts license-status-fields">
        <div>
          <dt>Status</dt>
          <dd>{statusLabel[status.status]}</dd>
        </div>
        <div>
          <dt>Utilizável</dt>
          <dd>{status.usable ? "Sim" : "Não"}</dd>
        </div>
        <div>
          <dt>Bloqueio parcial (soft lock)</dt>
          <dd>{status.softLock ? "Sim" : "Não"}</dd>
        </div>
        <div>
          <dt>Bloqueio total (hard lock)</dt>
          <dd>{status.hardLock ? "Sim" : "Não"}</dd>
        </div>
        <div>
          <dt>Tipo de licença</dt>
          <dd>{licenseIntervalLabel(status)}</dd>
        </div>
        <div>
          <dt>Expira em</dt>
          <dd>{status.expiresAt ? formatDateTime(status.expiresAt) : "—"}</dd>
        </div>
        <div>
          <dt>Tolerância até</dt>
          <dd>{status.validUntil ? formatDateTime(status.validUntil) : "—"}</dd>
        </div>
        <div>
          <dt>Origem da checagem</dt>
          <dd>
            {status.source === "server"
              ? "Servidor de licenciamento"
              : "Cache local"}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function LicenseLockPanel({ status }: { status: LicenseStatusResponse }) {
  const reason = licenseLockReason(status);

  if (!reason) {
    return null;
  }

  const copy = licenseLockCopy[reason];
  const needsActivation =
    reason === "license_required" || reason === "activation_failed";

  return (
    <section className="surface-panel license-lock-panel" role="alert">
      <strong>{copy.title}</strong>
      <p>{copy.detail}</p>
      {needsActivation ? (
        <>
          <p>O que fazer:</p>
          <ol>
            <li>
              Preencha <code>LICENSE_KEY</code> e{" "}
              <code>LICENSE_ACCOUNT_IDENTITY</code> (e{" "}
              <code>LICENSE_SERVER_URL</code>, se ainda estiver vazio) no{" "}
              <code>.env</code> da API — nunca commite esses valores.
            </li>
            <li>Reinicie a API para carregar as variáveis.</li>
            <li>
              Ative a licença chamando <code>POST /license-client/activate</code>{" "}
              na API (a rota continua liberada durante o bloqueio) e recarregue
              esta página.
            </li>
          </ol>
          <p>
            Enquanto a licença não estiver ativa, a leitura continua liberada e
            toda operação de escrita responde <code>423</code>.
          </p>
        </>
      ) : (
        <p>
          A leitura dos dados já coletados continua liberada; renove ou fale com
          o suporte da PalmUP para reativar a escrita.
        </p>
      )}
    </section>
  );
}

function LicenseEmptyStateNote() {
  return (
    <section className="surface-panel license-empty-state">
      <strong>Licença não configurada</strong>
      <p>
        Configure LICENSE_KEY e LICENSE_ACCOUNT_IDENTITY no .env e reinicie a
        API para ativar a licença local.
      </p>
    </section>
  );
}
