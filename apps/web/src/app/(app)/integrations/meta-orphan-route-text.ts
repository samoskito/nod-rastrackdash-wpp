import type {
  MetaOrphanRouteAccountDto,
  MetaOrphanRouteReasonDto,
} from "@wpptrack/shared";

function campaignLabel(account: MetaOrphanRouteAccountDto): string | null {
  const [first] = account.campaignNames;

  if (!first) {
    return null;
  }

  const more = account.campaignCount - 1;

  return more > 0 ? `${first} (e mais ${more})` : first;
}

function leadsLabel(count: number): string {
  return count === 1 ? "1 lead" : `${count} leads`;
}

function accountLabel(account: MetaOrphanRouteAccountDto): string {
  return account.adAccountName?.trim() || account.adAccountId;
}

/** What the confirm shows before a change that would block leads; null when none. */
export function routeSimulationMessage(
  blockedAccounts: MetaOrphanRouteAccountDto[],
): string | null {
  const lines = blockedAccounts
    .filter((account) => account.leadCount > 0)
    .map((account) => {
      const campaign = campaignLabel(account);
      const subject = campaign ? `A campanha ${campaign}` : "Esta conta";
      const received = campaign
        ? `recebeu ${leadsLabel(account.leadCount)} nos últimos 7 dias nesta conta`
        : `recebeu ${leadsLabel(account.leadCount)} nos últimos 7 dias (${accountLabel(account)})`;

      return `${subject} ${received}. Com esta mudança, os leads dela ficam bloqueados e não vão para a Meta.`;
    });

  return lines.length > 0 ? lines.join("\n") : null;
}

function reasonLabel(reason: MetaOrphanRouteReasonDto): string {
  if (reason === "account_inactive") return "desativada";
  if (reason === "connection_paused") return "com a BM pausada";

  return "sem destino";
}

export type OrphanRouteWarning = {
  key: string;
  message: string;
  advice: string;
};

/** Persistent warning lines for accounts that already block leads. */
export function orphanRouteWarnings(
  accounts: MetaOrphanRouteAccountDto[],
): OrphanRouteWarning[] {
  return accounts
    .filter((account) => account.leadCount > 0)
    .map((account) => {
      const campaign = campaignLabel(account);
      const origin = campaign ? `da campanha ${campaign}, na conta` : "da conta";
      const verb = account.leadCount === 1 ? "veio" : "vieram";

      return {
        key: account.adAccountId,
        message: `${leadsLabel(account.leadCount)} dos últimos 7 dias ${verb} ${origin} ${accountLabel(account)}, que está ${reasonLabel(account.reason)}. Esses leads ficam bloqueados.`,
        advice:
          account.reason === "legacy_unconfigured"
            ? "Configure o destino principal da conta."
            : "Ative a conta e vincule um destino a ela.",
      };
    });
}
