import type { MetaSyncCoverageDto } from "@wpptrack/shared";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";

const SAO_PAULO = "America/Sao_Paulo";

/** yyyy-mm-dd -> dd/mm (sem fuso: é uma data de calendário). */
export function coverageDayLabel(date: string): string {
  const [, month, day] = date.split("-");

  return `${day}/${month}`;
}

/** ISO -> dd/mm no fuso de Brasília. */
export function coverageInstantLabel(iso: string): string {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: SAO_PAULO,
    day: "2-digit",
    month: "2-digit",
  }).formatToParts(new Date(iso));
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";

  return `${day}/${month}`;
}

export type MetaSyncCoverageMessages = {
  availability: string | null;
  delay: string | null;
};

export function metaSyncCoverageMessages(
  coverage: MetaSyncCoverageDto | undefined | null,
): MetaSyncCoverageMessages {
  if (!coverage) {
    return { availability: null, delay: null };
  }

  const availability =
    coverage.periodStartsBeforeCoverage && coverage.earliestDailyDate
      ? `Dados da Meta disponíveis a partir de ${coverageDayLabel(coverage.earliestDailyDate)}${
          coverage.earliestDailyAccountName
            ? ` (conta ${coverage.earliestDailyAccountName})`
            : ""
        }. Antes disso, investimento e conversas Meta aparecem como zero.`
      : null;
  const delay =
    coverage.problemAccounts.length > 0 && coverage.staleSince
      ? `Sincronização da Meta atrasada desde ${coverageInstantLabel(coverage.staleSince)} — reconecte a conta ou sincronize.${
          coverage.problemAccounts.length <= 3
            ? ` Contas: ${coverage.problemAccounts.map((account) => account.name).join(", ")}.`
            : ` ${coverage.problemAccounts.length} contas afetadas.`
        }`
      : null;

  return { availability, delay };
}

/**
 * Aviso compacto (callout do design system) sobre a cobertura dos dados da
 * Meta. Não renderiza nada quando está tudo certo.
 */
export function MetaSyncCoverageNotice({
  coverage,
  action,
}: {
  coverage: MetaSyncCoverageDto | undefined | null;
  /** Ação extra (ex.: o botão Sincronizar Meta já existente nos relatórios). */
  action?: string;
}) {
  const { availability, delay } = metaSyncCoverageMessages(coverage);

  if (!availability && !delay) {
    return null;
  }

  return (
    <div
      className="feedback-banner warn meta-sync-coverage-notice"
      role="status"
      data-testid="meta-sync-coverage-notice"
    >
      <strong>
        <AlertTriangle
          aria-hidden="true"
          size={14}
          style={{ marginRight: 6, verticalAlign: "-2px" }}
        />
        Atenção aos dados da Meta
      </strong>
      {availability ? <span>{availability}</span> : null}
      {delay ? (
        <span>
          {delay} {action ? `${action} ` : ""}
          <Link className="conversion-inline-link" href="/integrations">
            Abrir Integrações
          </Link>
        </span>
      ) : null}
    </div>
  );
}
