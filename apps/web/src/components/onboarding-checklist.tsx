import type { OnboardingChecks, OnboardingStatusResponse } from "../lib/onboarding-status";

type ChecklistRow = {
  key: keyof OnboardingChecks;
  label: string;
  description: string;
  href?: string;
};

const rows: ChecklistRow[] = [
  {
    key: "database",
    label: "Banco de dados conectado",
    description: "A API consegue falar com o Postgres configurado em DATABASE_URL.",
  },
  {
    key: "licenseActive",
    label: "Licença ativa",
    description: "Chave de licença ativada ou dentro da janela de tolerância.",
    href: "/backoffice/license",
  },
  {
    key: "metaConnected",
    label: "Meta Ads conectado",
    description: "Uma conta Meta está conectada neste workspace.",
    href: "/integrations",
  },
  {
    key: "hasWorkspace",
    label: "Workspace criado",
    description: "Você já tem pelo menos um workspace disponível.",
    href: "/backoffice/clients",
  },
];

/**
 * Soft onboarding checklist (F6.3) — server-fetched real signals, never
 * blocks the app. Rendered on the backoffice home; see
 * .claude-task-f6-3-setup-docs.md #2.
 */
export function OnboardingChecklist({ status }: { status: OnboardingStatusResponse | null }) {
  if (!status) {
    return (
      <section className="surface-panel onboarding-checklist-panel">
        <p>Não foi possível carregar o checklist de configuração agora.</p>
      </section>
    );
  }

  return (
    <section className="surface-panel onboarding-checklist-panel">
      <header className="onboarding-checklist-header">
        <div>
          <span className="eyebrow">Primeiros passos</span>
          <h2>Checklist de configuração</h2>
        </div>
        <span className="status-chip">
          {status.completedCount}/{status.totalCount} concluídos
        </span>
      </header>

      <ul className="onboarding-checklist-list">
        {rows.map((row) => {
          const done = status.checks[row.key];
          const copy = (
            <>
              <span className={`status-chip${done ? "" : " warn"}`}>
                {done ? "Concluído" : "Pendente"}
              </span>
              <span className="onboarding-checklist-copy">
                <strong>{row.label}</strong>
                <span>{row.description}</span>
              </span>
            </>
          );

          return (
            <li className="onboarding-checklist-row" key={row.key}>
              {row.href ? (
                <a className="onboarding-checklist-link" href={row.href}>
                  {copy}
                </a>
              ) : (
                <div className="onboarding-checklist-static">{copy}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
