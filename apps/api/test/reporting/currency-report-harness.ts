import { vi } from "vitest";
import { ExchangeRateService } from "../../src/currency/exchange-rate.service";
import type { PtaxFetch } from "../../src/currency/ptax.client";
import { MetaReportingService } from "../../src/reporting/meta-reporting.service";
import { ReportingMetricsEngine } from "../../src/reporting/reporting-metrics.engine";

// In-memory Prisma for the Meta reports (same where semantics as the
// lead-cohort suite) with ad accounts that carry a Meta currency and an
// optional manual override, plus a fixture of a workspace all in BRL.

export type Row = Record<string, unknown>;

export const WORKSPACE = "workspace_1";

function compare(value: unknown, bound: unknown): number {
  if (value === null || value === undefined) {
    return Number.NaN;
  }

  if (value instanceof Date || bound instanceof Date) {
    return (
      new Date(value as Date).getTime() - new Date(bound as Date).getTime()
    );
  }

  const left = String(value);
  const right = String(bound);

  return left < right ? -1 : left > right ? 1 : 0;
}

export function matchesWhere(row: Row, where: unknown): boolean {
  if (!where) {
    return true;
  }

  for (const [key, condition] of Object.entries(where as Row)) {
    if (key === "OR") {
      if (!(condition as unknown[]).some((item) => matchesWhere(row, item))) {
        return false;
      }
      continue;
    }

    if (key === "AND") {
      if (!(condition as unknown[]).every((item) => matchesWhere(row, item))) {
        return false;
      }
      continue;
    }

    const value = row[key] ?? null;

    if (
      condition !== null &&
      typeof condition === "object" &&
      !(condition instanceof Date)
    ) {
      const ops = condition as Row;

      if ("in" in ops && !(ops.in as unknown[]).includes(value)) return false;
      if ("notIn" in ops && (ops.notIn as unknown[]).includes(value)) {
        return false;
      }
      if ("not" in ops && value === ops.not) return false;
      if ("lt" in ops && !(compare(value, ops.lt) < 0)) return false;
      if ("gt" in ops && !(compare(value, ops.gt) > 0)) return false;
      if ("gte" in ops && !(compare(value, ops.gte) >= 0)) return false;
      if ("lte" in ops && !(compare(value, ops.lte) <= 0)) return false;
      continue;
    }

    if (value !== condition) {
      return false;
    }
  }

  return true;
}

export type HarnessDb = {
  workspace: { id: string; conversionCurrency: string };
  reportingAccounts: Row[];
  campaigns: Row[];
  adSets: Row[];
  ads: Row[];
  leads: Row[];
  conversionLogs: Row[];
  campaignDaily: Row[];
  adSetDaily: Row[];
  adDaily: Row[];
};

export function account(
  adAccountId: string,
  currency: string | null,
  currencyOverride: string | null = null,
): Row {
  return {
    workspaceId: WORKSPACE,
    businessId: "business_1",
    adAccountId,
    active: true,
    currency,
    currencyOverride,
  };
}

function entity(
  level: "campaign" | "adset" | "ad",
  input: {
    id: string;
    name: string;
    adAccountId: string;
    campaignId?: string;
    adSetId?: string;
    spendCents: number;
    metaConversationsStarted?: number;
  },
): Row {
  return {
    workspaceId: WORKSPACE,
    businessId: "business_1",
    adAccountId: input.adAccountId,
    ...(level === "campaign"
      ? { campaignId: input.id }
      : level === "adset"
        ? { campaignId: input.campaignId, adSetId: input.id }
        : {
            campaignId: input.campaignId,
            adSetId: input.adSetId,
            adId: input.id,
          }),
    name: input.name,
    status: "ACTIVE",
    effectiveStatus: "ACTIVE",
    whatsappClassification: "manual_include",
    spendCents: input.spendCents,
    metaConversationsStarted: input.metaConversationsStarted ?? 0,
    dailyBudgetCents: null,
    lifetimeBudgetCents: null,
  };
}

/** Campaign + ad set + ad of one ad account (same spend at every level). */
export function adTree(
  db: HarnessDb,
  input: {
    suffix: string;
    adAccountId: string;
    spendCents: number;
    metaConversationsStarted: number;
  },
) {
  const campaignId = `cmp_${input.suffix}`;
  const adSetId = `adset_${input.suffix}`;
  const adId = `ad_${input.suffix}`;
  const base = {
    adAccountId: input.adAccountId,
    spendCents: input.spendCents,
    metaConversationsStarted: input.metaConversationsStarted,
  };

  db.campaigns.push(
    entity("campaign", {
      ...base,
      id: campaignId,
      name: `Campanha ${input.suffix}`,
    }),
  );
  db.adSets.push(
    entity("adset", {
      ...base,
      id: adSetId,
      campaignId,
      name: `Conjunto ${input.suffix}`,
    }),
  );
  db.ads.push(
    entity("ad", {
      ...base,
      id: adId,
      campaignId,
      adSetId,
      name: `Anuncio ${input.suffix}`,
    }),
  );

  return { campaignId, adSetId, adId };
}

export function conversionLog(input: {
  id: string;
  eventName: string;
  occurredAt: string;
  phoneHash: string;
  leadId?: string | null;
  attribution?: { campaignId: string; adSetId: string; adId: string } | null;
  valueCents?: number | null;
  currency?: string | null;
  purchaseKind?: string | null;
  businessSource?: string;
}): Row {
  return {
    id: input.id,
    workspaceId: WORKSPACE,
    leadId: input.leadId ?? null,
    phoneHash: input.phoneHash,
    customerIdentityKey: input.phoneHash,
    businessSource:
      input.businessSource ?? (input.attribution ? "paid" : "organic"),
    campaignId: input.attribution?.campaignId ?? null,
    adSetId: input.attribution?.adSetId ?? null,
    adId: input.attribution?.adId ?? null,
    ctwaClid: null,
    eventName: input.eventName,
    eventOccurredAt: new Date(input.occurredAt),
    status: "sent",
    valueCents: input.valueCents ?? null,
    valueSource: input.valueCents == null ? null : "actual",
    currency: input.currency ?? null,
    purchaseKind: input.purchaseKind ?? null,
  };
}

export function lead(input: {
  id: string;
  phoneHash: string;
  firstMessageAt: string;
  attribution: { campaignId: string; adSetId: string; adId: string } | null;
}): Row {
  return {
    id: input.id,
    workspaceId: WORKSPACE,
    phoneHash: input.phoneHash,
    campaignId: input.attribution?.campaignId ?? null,
    adSetId: input.attribution?.adSetId ?? null,
    adId: input.attribution?.adId ?? null,
    ctwaClid: null,
    firstMessageAt: new Date(input.firstMessageAt),
    createdAt: new Date(input.firstMessageAt),
  };
}

export function emptyDb(): HarnessDb {
  return {
    workspace: { id: WORKSPACE, conversionCurrency: "BRL" },
    reportingAccounts: [],
    campaigns: [],
    adSets: [],
    ads: [],
    leads: [],
    conversionLogs: [],
    campaignDaily: [],
    adSetDaily: [],
    adDaily: [],
  };
}

export function createReportingService(db: HarnessDb) {
  const tables = (): Record<string, Row[]> => ({
    metaReportingAccount: db.reportingAccounts,
    metaCampaign: db.campaigns,
    metaAdSet: db.adSets,
    metaAd: db.ads,
    conversionEventLog: db.conversionLogs,
    lead: db.leads,
    metaCampaignDailyInsight: db.campaignDaily,
    metaAdSetDailyInsight: db.adSetDaily,
    metaAdDailyInsight: db.adDaily,
  });
  const prisma = new Proxy(
    {},
    {
      get(_target, model: string) {
        if (model === "workspace") {
          return {
            findUnique: async () => ({ ...db.workspace }),
          };
        }

        const table = tables()[model];

        if (!table) {
          throw new Error(`Unexpected prisma model access: ${model}`);
        }

        return {
          findMany: async (args: { where?: unknown } = {}) =>
            table
              .filter((row) => matchesWhere(row, args.where))
              .map((row) => ({ ...row })),
        };
      },
    },
  );

  return new MetaReportingService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    new ReportingMetricsEngine(),
    { getConfiguration: async () => ({ stages: [] }) } as never,
  );
}

export type StoredRate = {
  date: Date;
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
};

export const storedRate = (
  date: string,
  baseCurrency: string,
  rate: string,
): StoredRate => ({
  date: new Date(`${date}T00:00:00.000Z`),
  baseCurrency,
  quoteCurrency: "BRL",
  rate,
});

/** Olinda payload (BCB) with opening and closing bulletins. */
export function bcbPayload(
  rows: Array<{ date: string; rate: number; bulletin?: string }>,
) {
  return {
    value: rows.map((row) => ({
      cotacaoVenda: row.rate,
      dataHoraCotacao: `${row.date} 13:08:16.814`,
      tipoBoletim: row.bulletin ?? "Fechamento",
    })),
  };
}

/**
 * Real ExchangeRateService on an in-memory ExchangeRate table, a fake BCB
 * (never the network) and a fixed clock (15/10/2026 15:00 in Sao Paulo).
 */
export function ptaxHarness(options: {
  enabled: boolean;
  rows?: StoredRate[];
  fetchImpl?: PtaxFetch;
  now?: string;
}) {
  const rows: StoredRate[] = [...(options.rows ?? [])];
  const prisma = {
    exchangeRate: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            baseCurrency: { in: string[] };
            date: { gte: Date; lte: Date };
          };
        }) =>
          rows.filter(
            (row) =>
              where.baseCurrency.in.includes(row.baseCurrency) &&
              row.date.getTime() >= where.date.gte.getTime() &&
              row.date.getTime() <= where.date.lte.getTime(),
          ),
      ),
      createMany: vi.fn(async ({ data }: { data: StoredRate[] }) => {
        let count = 0;
        for (const item of data) {
          if (
            !rows.some(
              (row) =>
                row.date.getTime() === item.date.getTime() &&
                row.baseCurrency === item.baseCurrency,
            )
          ) {
            rows.push(item);
            count += 1;
          }
        }
        return { count };
      }),
    },
  };
  const fetchImpl =
    options.fetchImpl ??
    vi.fn<PtaxFetch>(async () => {
      throw new Error("unexpected BCB call");
    });
  const service = new ExchangeRateService(
    prisma as never,
    fetchImpl,
    undefined,
    options.enabled ? { PTAX_SYNC_ENABLED: "true" } : {},
    { now: () => new Date(options.now ?? "2026-10-15T18:00:00.000Z") },
  );

  return { service, prisma, fetchImpl, rows };
}

/**
 * Workspace all in BRL: two campaigns of one ad account (Meta currency BRL),
 * leads novos, a lead that came back, first purchases, a repurchase with no
 * currency (historical events) and an organic sale.
 */
export function brlWorkspaceDb(): HarnessDb {
  const db = emptyDb();
  db.reportingAccounts.push(account("act_123", "BRL"));
  const one = adTree(db, {
    suffix: "1",
    adAccountId: "act_123",
    spendCents: 30_000,
    metaConversationsStarted: 40,
  });
  const two = adTree(db, {
    suffix: "2",
    adAccountId: "act_123",
    spendCents: 12_000,
    metaConversationsStarted: 10,
  });

  for (const [campaignId, adSetId, adId, spend, conversations] of [
    [one.campaignId, one.adSetId, one.adId, 30_000, 40],
    [two.campaignId, two.adSetId, two.adId, 12_000, 10],
  ] as const) {
    for (const [localDate, share] of [
      ["2026-07-01", 0.5],
      ["2026-07-02", 0.5],
    ] as const) {
      const metrics = {
        workspaceId: WORKSPACE,
        localDate,
        spendCents: spend * share,
        metaConversationsStarted: conversations * share,
        impressions: 100,
      };
      db.campaignDaily.push({ ...metrics, campaignId });
      db.adSetDaily.push({ ...metrics, adSetId });
      db.adDaily.push({ ...metrics, adId });
    }
  }

  db.leads.push(
    lead({
      id: "lead_1",
      phoneHash: "phone_1",
      firstMessageAt: "2026-07-01T13:00:00.000Z",
      attribution: one,
    }),
    lead({
      id: "lead_2",
      phoneHash: "phone_2",
      firstMessageAt: "2026-07-02T13:00:00.000Z",
      attribution: two,
    }),
    lead({
      id: "lead_back",
      phoneHash: "phone_back",
      firstMessageAt: "2026-06-20T13:00:00.000Z",
      attribution: one,
    }),
    lead({
      id: "lead_organic",
      phoneHash: "phone_organic",
      firstMessageAt: "2026-07-01T20:00:00.000Z",
      attribution: null,
    }),
  );
  db.conversionLogs.push(
    conversionLog({
      id: "ls_1",
      eventName: "LeadSubmitted",
      occurredAt: "2026-07-01T13:00:00.000Z",
      phoneHash: "phone_1",
      leadId: "lead_1",
      attribution: one,
    }),
    conversionLog({
      id: "ls_2",
      eventName: "LeadSubmitted",
      occurredAt: "2026-07-02T13:00:00.000Z",
      phoneHash: "phone_2",
      leadId: "lead_2",
      attribution: two,
    }),
    conversionLog({
      id: "ls_back",
      eventName: "LeadSubmitted",
      occurredAt: "2026-07-02T15:00:00.000Z",
      phoneHash: "phone_back",
      leadId: "lead_back",
      attribution: one,
    }),
    conversionLog({
      id: "ql_1",
      eventName: "QualifiedLead",
      occurredAt: "2026-07-01T14:00:00.000Z",
      phoneHash: "phone_1",
      leadId: "lead_1",
      attribution: one,
    }),
    conversionLog({
      id: "purchase_1",
      eventName: "Purchase",
      occurredAt: "2026-07-01T18:00:00.000Z",
      phoneHash: "phone_1",
      leadId: "lead_1",
      attribution: one,
      valueCents: 15_000,
      currency: "BRL",
      purchaseKind: "first_purchase",
    }),
    conversionLog({
      id: "purchase_1_again",
      eventName: "Purchase",
      occurredAt: "2026-07-02T18:00:00.000Z",
      phoneHash: "phone_1",
      leadId: "lead_1",
      attribution: one,
      valueCents: 5_000,
      // Historical event without currency = BRL.
      currency: null,
      purchaseKind: "repurchase",
    }),
    conversionLog({
      id: "purchase_2",
      eventName: "Purchase",
      occurredAt: "2026-07-02T19:00:00.000Z",
      phoneHash: "phone_2",
      leadId: "lead_2",
      attribution: two,
      valueCents: 9_000,
      currency: "BRL",
      purchaseKind: "first_purchase",
    }),
    conversionLog({
      id: "purchase_organic",
      eventName: "Purchase",
      occurredAt: "2026-07-01T21:00:00.000Z",
      phoneHash: "phone_organic",
      leadId: "lead_organic",
      attribution: null,
      valueCents: 7_000,
      currency: "BRL",
      purchaseKind: "first_purchase",
    }),
  );

  return db;
}

export const BRL_PERIOD = {
  workspaceId: WORKSPACE,
  rangeLabel: "2026-07-01 a 2026-07-02",
  since: "2026-07-01",
  until: "2026-07-02",
};

/** Every report of the BRL fixture, as the API returns them. */
export async function brlReports(service: MetaReportingService) {
  return {
    overview: await service.getCampaignReportOverview({
      ...BRL_PERIOD,
      includeSummary: true,
      includeDaily: true,
    }),
    overviewByAccount: await service.getCampaignReportOverview({
      ...BRL_PERIOD,
      adAccountId: "act_123",
      includeSummary: true,
    }),
    adSets: await service.getAdSetReportOverview(BRL_PERIOD),
    ads: await service.getAdReportOverview(BRL_PERIOD),
    csv: (await service.getCampaignReportCsv(BRL_PERIOD)).content,
  };
}
