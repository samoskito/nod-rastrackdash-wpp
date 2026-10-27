import { describe, expect, it, vi } from "vitest";
import {
  buildMetaSyncCoverage,
  type MetaCoverageAccount,
} from "../src/reporting/meta-sync-coverage";
import { MetaReportingService } from "../src/reporting/meta-reporting.service";

const now = new Date("2026-10-24T12:00:00.000Z");
const hoursAgo = (hours: number) =>
  new Date(now.getTime() - hours * 60 * 60 * 1000);

function account(
  overrides: Partial<MetaCoverageAccount> = {},
): MetaCoverageAccount {
  return {
    adAccountId: "act_1",
    adAccountName: "Conta Principal",
    syncStatus: "synced",
    syncError: null,
    lastSyncedAt: hoursAgo(2),
    reportingSyncBlockedAt: null,
    createdAt: hoursAgo(24 * 90),
    ...overrides,
  };
}

describe("buildMetaSyncCoverage", () => {
  it("não avisa quando o período está coberto e a sincronização está em dia", () => {
    const coverage = buildMetaSyncCoverage({
      accounts: [account()],
      minDates: [{ adAccountId: "act_1", localDate: "2026-08-01" }],
      since: "2026-09-01",
      now,
    });

    expect(coverage.periodStartsBeforeCoverage).toBe(false);
    expect(coverage.problemAccounts).toEqual([]);
    expect(coverage.staleSince).toBeNull();
  });

  it("avisa quando o período começa antes do primeiro dia sincronizado, apontando a conta", () => {
    const coverage = buildMetaSyncCoverage({
      accounts: [
        account(),
        account({ adAccountId: "act_2", adAccountName: "Conta Nova" }),
      ],
      minDates: [
        { adAccountId: "act_1", localDate: "2026-09-10" },
        { adAccountId: "act_2", localDate: "2026-09-20" },
      ],
      since: "2026-09-01",
      now,
    });

    expect(coverage.periodStartsBeforeCoverage).toBe(true);
    expect(coverage.earliestDailyDate).toBe("2026-09-10");
    expect(coverage.earliestDailyAccountName).toBe("Conta Principal");
  });

  it("começar exatamente no primeiro dia não avisa; sem linhas diárias também não", () => {
    expect(
      buildMetaSyncCoverage({
        accounts: [account()],
        minDates: [{ adAccountId: "act_1", localDate: "2026-09-10" }],
        since: "2026-09-10",
        now,
      }).periodStartsBeforeCoverage,
    ).toBe(false);
    expect(
      buildMetaSyncCoverage({
        accounts: [account()],
        minDates: [],
        since: "2026-09-10",
        now,
      }).periodStartsBeforeCoverage,
    ).toBe(false);
  });

  it("ignora linhas diárias de contas que não estão ativas", () => {
    const coverage = buildMetaSyncCoverage({
      accounts: [account()],
      minDates: [
        { adAccountId: "act_old", localDate: "2025-01-01" },
        { adAccountId: "act_1", localDate: "2026-09-10" },
      ],
      since: "2026-09-01",
      now,
    });

    expect(coverage.earliestDailyDate).toBe("2026-09-10");
  });

  it("marca conta atrasada (> 24h), com erro, bloqueada e nunca sincronizada", () => {
    const coverage = buildMetaSyncCoverage({
      accounts: [
        account({ adAccountId: "a", adAccountName: "Atrasada", lastSyncedAt: hoursAgo(30) }),
        account({
          adAccountId: "b",
          adAccountName: "Com erro",
          syncStatus: "error",
          syncError: "Reconecte a conta Meta",
          lastSyncedAt: hoursAgo(50),
        }),
        account({
          adAccountId: "c",
          adAccountName: "Bloqueada",
          reportingSyncBlockedAt: hoursAgo(10),
          lastSyncedAt: hoursAgo(80),
        }),
        account({
          adAccountId: "d",
          adAccountName: "Nunca",
          lastSyncedAt: null,
          createdAt: hoursAgo(72),
        }),
        account({ adAccountId: "e", adAccountName: "Em dia" }),
      ],
      minDates: [],
      now,
    });

    expect(
      Object.fromEntries(
        coverage.problemAccounts.map((item) => [item.name, item.reason]),
      ),
    ).toEqual({
      Atrasada: "stale",
      "Com erro": "error",
      Bloqueada: "blocked",
      Nunca: "never",
    });
    // O marco mais antigo (a conta bloqueada, última sync há 80h) vem primeiro.
    expect(coverage.staleSince).toBe(hoursAgo(80).toISOString());
  });

  it("conta recém-conectada sem sincronização ainda não alerta", () => {
    const coverage = buildMetaSyncCoverage({
      accounts: [account({ lastSyncedAt: null, createdAt: hoursAgo(1) })],
      minDates: [],
      now,
    });

    expect(coverage.problemAccounts).toEqual([]);
  });
});

describe("MetaReportingService.getMetaSyncCoverage", () => {
  function service(prisma: unknown) {
    return new MetaReportingService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  it("usa MIN indexado por conta e só contas ativas do workspace", async () => {
    const prisma = {
      metaReportingAccount: { findMany: vi.fn().mockResolvedValue([account()]) },
      metaCampaignDailyInsight: {
        groupBy: vi.fn().mockResolvedValue([
          { adAccountId: "act_1", _min: { localDate: "2026-09-10" } },
        ]),
      },
    };
    const coverage = await service(prisma).getMetaSyncCoverage(
      "ws_1",
      "2026-09-01",
      now,
    );

    expect(prisma.metaReportingAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws_1", active: true } }),
    );
    expect(prisma.metaCampaignDailyInsight.groupBy).toHaveBeenCalledWith({
      by: ["adAccountId"],
      where: { workspaceId: "ws_1" },
      _min: { localDate: true },
    });
    expect(coverage?.periodStartsBeforeCoverage).toBe(true);
  });

  it("nunca derruba o relatório: falha na leitura devolve undefined", async () => {
    const prisma = {
      metaReportingAccount: {
        findMany: vi.fn().mockRejectedValue(new Error("db fora")),
      },
      metaCampaignDailyInsight: { groupBy: vi.fn() },
    };

    await expect(
      service(prisma).getMetaSyncCoverage("ws_1", "2026-09-01", now),
    ).resolves.toBeUndefined();
  });
});
