import type { MetaSyncCoverageDto } from "@wpptrack/shared";

/** Uma conta sem sincronizar há mais que isso é considerada atrasada. */
export const META_SYNC_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export type MetaCoverageAccount = {
  adAccountId: string;
  adAccountName: string;
  syncStatus: string;
  syncError: string | null;
  lastSyncedAt: Date | null;
  reportingSyncBlockedAt: Date | null;
  createdAt: Date;
};

type ProblemReason = MetaSyncCoverageDto["problemAccounts"][number]["reason"];

function problemFor(
  account: MetaCoverageAccount,
  now: Date,
): { reason: ProblemReason; since: Date } | null {
  const staleLimit = now.getTime() - META_SYNC_STALE_AFTER_MS;

  if (account.reportingSyncBlockedAt) {
    return {
      reason: "blocked",
      since: account.lastSyncedAt ?? account.reportingSyncBlockedAt,
    };
  }

  if (account.syncStatus === "error" || account.syncError) {
    return {
      reason: "error",
      since: account.lastSyncedAt ?? account.createdAt,
    };
  }

  if (account.lastSyncedAt) {
    return account.lastSyncedAt.getTime() < staleLimit
      ? { reason: "stale", since: account.lastSyncedAt }
      : null;
  }

  // Conta recém-conectada ainda dentro da janela de tolerância não alerta.
  return account.createdAt.getTime() < staleLimit
    ? { reason: "never", since: account.createdAt }
    : null;
}

/**
 * Regra pura dos avisos de cobertura da Meta:
 * (a) o período começa antes do primeiro dia diário sincronizado;
 * (b) alguma conta ativa está atrasada (> 24h), com erro ou bloqueada.
 */
export function buildMetaSyncCoverage(input: {
  accounts: MetaCoverageAccount[];
  minDates: Array<{ adAccountId: string; localDate: string | null }>;
  since?: string;
  now: Date;
}): MetaSyncCoverageDto {
  const names = new Map(
    input.accounts.map((account) => [
      account.adAccountId,
      account.adAccountName,
    ]),
  );
  let earliestDailyDate: string | null = null;
  let earliestDailyAccountName: string | null = null;

  // Só contas ativas: linhas de contas removidas não definem a cobertura.
  for (const row of input.minDates) {
    if (!row.localDate || !names.has(row.adAccountId)) {
      continue;
    }

    if (earliestDailyDate === null || row.localDate < earliestDailyDate) {
      earliestDailyDate = row.localDate;
      earliestDailyAccountName = names.get(row.adAccountId) ?? null;
    }
  }

  const problemAccounts = input.accounts
    .map((account) => {
      const problem = problemFor(account, input.now);

      return problem
        ? {
            adAccountId: account.adAccountId,
            name: account.adAccountName || account.adAccountId,
            reason: problem.reason,
            since: problem.since.toISOString(),
          }
        : null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => a.since.localeCompare(b.since))
    .slice(0, 50);

  return {
    earliestDailyDate,
    earliestDailyAccountName,
    periodStartsBeforeCoverage: Boolean(
      input.since && earliestDailyDate && input.since < earliestDailyDate,
    ),
    problemAccounts,
    staleSince: problemAccounts[0]?.since ?? null,
  };
}
