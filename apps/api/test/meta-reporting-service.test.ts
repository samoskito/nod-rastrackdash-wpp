import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { MetaReportingService } from "../src/reporting/meta-reporting.service";
import { MetaAdDestinationRoutingService } from "../src/integrations/meta/meta-ad-destination-routing.service";
import { ExchangeRateTable } from "../src/currency/exchange-rate.service";
import { ReportingMetricsEngine } from "../src/reporting/reporting-metrics.engine";
import { WhatsappCampaignClassifierService } from "../src/reporting/whatsapp-campaign-classifier.service";

function matchesWhere(
  record: Record<string, unknown>,
  where?: Record<string, unknown>,
): boolean {
  if (!where) {
    return true;
  }

  return Object.entries(where).every(([key, value]) => {
    if (key === "AND" && Array.isArray(value)) {
      return value.every(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          matchesWhere(record, item as Record<string, unknown>),
      );
    }

    if (key === "OR" && Array.isArray(value)) {
      return value.some(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          matchesWhere(record, item as Record<string, unknown>),
      );
    }

    if (key === "NOT" && Array.isArray(value)) {
      return !value.some((item) =>
        matchesWhere(record, item as Record<string, unknown>),
      );
    }

    if (key === "NOT" && value && typeof value === "object") {
      return !matchesWhere(record, value as Record<string, unknown>);
    }

    if (value && typeof value === "object" && "endsWith" in value) {
      return String(record[key] ?? "").endsWith(String(value.endsWith));
    }

    // Prisma JSON path filter: { path: ["error", "code"], equals: 190 }.
    if (
      value &&
      typeof value === "object" &&
      "path" in value &&
      Array.isArray(value.path)
    ) {
      const found = (value.path as string[]).reduce<unknown>(
        (current, segment) =>
          current && typeof current === "object"
            ? (current as Record<string, unknown>)[segment]
            : undefined,
        record[key],
      );
      return found === (value as { equals?: unknown }).equals;
    }

    if (value && typeof value === "object" && "equals" in value) {
      return record[key] === value.equals;
    }

    if (value && typeof value === "object" && "notIn" in value) {
      return !(value.notIn as unknown[]).includes(record[key]);
    }

    if (value && typeof value === "object" && "in" in value) {
      return (value.in as unknown[]).includes(record[key]);
    }

    if (value && typeof value === "object" && "startsWith" in value) {
      return String(record[key] ?? "").startsWith(String(value.startsWith));
    }

    if (value && typeof value === "object" && "not" in value) {
      return record[key] !== value.not;
    }

    if (value && typeof value === "object" && "gt" in value) {
      return Number(record[key]) > Number(value.gt);
    }

    if (value && typeof value === "object" && "lt" in value) {
      const current = record[key];

      return (
        (current instanceof Date || typeof current === "string") &&
        new Date(current).getTime() < new Date(value.lt as Date).getTime()
      );
    }

    if (
      value &&
      typeof value === "object" &&
      ("gte" in value || "lte" in value)
    ) {
      const current = record[key];

      if (!(current instanceof Date) && typeof current !== "string") {
        return false;
      }

      const currentTime = new Date(current).getTime();

      if ("gte" in value) {
        const minimum = value.gte;

        if (
          (!(minimum instanceof Date) && typeof minimum !== "string") ||
          currentTime < new Date(minimum).getTime()
        ) {
          return false;
        }
      }

      if ("lte" in value) {
        const maximum = value.lte;

        if (
          (!(maximum instanceof Date) && typeof maximum !== "string") ||
          currentTime > new Date(maximum).getTime()
        ) {
          return false;
        }
      }

      return true;
    }

    return record[key] === value;
  });
}

function createHarness(
  options: {
    creativeThumbnails?: unknown;
    env?: Record<string, string | undefined>;
  } = {},
) {
  const db = {
    metaIntegration: {
      workspaceId: "workspace_1",
      status: "connected",
      encryptedAccessToken: "encrypted",
      tokenIv: "iv",
      tokenTag: "tag",
      selectedAdAccountId: "act_123",
    },
    reportingAccounts: [
      {
        id: "reporting_1",
        workspaceId: "workspace_1",
        businessId: "business_1",
        businessName: "BM 1",
        adAccountId: "act_123",
        adAccountName: "Conta 1",
        businessConnectionId: null,
        active: true,
      },
    ] as Array<{
      id: string;
      workspaceId: string;
      businessId: string;
      businessName: string;
      adAccountId: string;
      adAccountName: string;
      businessConnectionId?: string | null;
      active: boolean;
    }>,
    campaigns: [] as Array<Record<string, unknown>>,
    dailyInsights: [] as Array<Record<string, unknown>>,
    adSetDailyInsights: [] as Array<Record<string, unknown>>,
    adDailyInsights: [] as Array<Record<string, unknown>>,
    adSets: [] as Array<Record<string, unknown>>,
    ads: [] as Array<Record<string, unknown>>,
    conversionDestinations: [] as Array<Record<string, unknown>>,
    accountDestinations: [] as Array<Record<string, unknown>>,
    adDestinationAssignments: [] as Array<Record<string, unknown>>,
    auditLogs: [] as Array<Record<string, unknown>>,
    integrationLogs: [] as Array<Record<string, unknown>>,
    diagnosticEvents: [] as Array<Record<string, unknown>>,
    externalIngestionRecords: [] as Array<Record<string, unknown>>,
    whatsappInstances: [
      {
        id: "instance_a",
        workspaceId: "workspace_1",
        name: "Chip comercial",
        status: "active",
      },
      {
        id: "instance_b",
        workspaceId: "workspace_1",
        name: "Chip pos-venda",
        status: "active",
      },
      {
        id: "instance_other_workspace",
        workspaceId: "workspace_other",
        name: "Chip externo",
        status: "active",
      },
    ] as Array<Record<string, unknown>>,
    conversionRules: [
      {
        workspaceId: "workspace_1",
        eventName: "QualifiedLead",
        active: true,
      },
      {
        workspaceId: "workspace_1",
        eventName: "Purchase",
        active: true,
      },
    ],
    leads: [
      {
        id: "lead_1",
        workspaceId: "workspace_1",
        name: "Mariana Alves",
        phoneDisplay: "+55 11 99999-1020",
        phoneHash: "phone_a",
        campaignId: "cmp_1",
        adSetId: "adset_1",
        adId: "ad_1",
        firstMessageAt: new Date("2026-07-01T12:00:00.000Z"),
        createdAt: new Date("2026-07-01T12:00:00.000Z"),
      },
      {
        id: "lead_2",
        workspaceId: "workspace_1",
        name: "Rafael Costa",
        phoneDisplay: "+55 11 99999-2030",
        phoneHash: "phone_b",
        campaignId: "cmp_1",
        adSetId: "adset_1",
        adId: "ad_1",
        firstMessageAt: null,
        createdAt: new Date("2026-07-02T12:00:00.000Z"),
      },
      {
        id: "lead_other",
        workspaceId: "workspace_1",
        name: "Outro Lead",
        phoneDisplay: "+55 11 99999-3040",
        phoneHash: "phone_other",
        campaignId: "cmp_other",
        adSetId: "adset_other",
        adId: "ad_other",
        firstMessageAt: new Date("2026-07-02T12:00:00.000Z"),
        createdAt: new Date("2026-07-02T12:00:00.000Z"),
      },
    ] as Array<{
      id: string;
      workspaceId: string;
      name: string | null;
      phoneDisplay: string | null;
      phoneHash: string;
      campaignId: string | null;
      adSetId: string | null;
      adId: string | null;
      whatsappInstanceId?: string | null;
      firstMessageAt: Date | null;
      createdAt: Date;
    }>,
    conversionLogs: [
      {
        id: "event_lead_submitted",
        workspaceId: "workspace_1",
        phoneHash: "phone_a",
        customerIdentityKey: "phone_a",
        businessSource: "paid",
        campaignId: "cmp_1",
        adSetId: "adset_1",
        adId: "ad_1",
        eventName: "LeadSubmitted",
        eventOccurredAt: new Date("2026-07-01T12:05:00.000Z"),
        status: "sent",
        valueCents: null,
        currency: null,
        purchaseKind: null,
      },
      {
        id: "event_qualified",
        workspaceId: "workspace_1",
        phoneHash: "phone_a",
        customerIdentityKey: "phone_a",
        businessSource: "paid",
        campaignId: "cmp_1",
        adSetId: "adset_1",
        adId: "ad_1",
        eventName: "QualifiedLead",
        eventOccurredAt: new Date("2026-07-01T12:10:00.000Z"),
        status: "error",
        valueCents: null,
        currency: null,
        purchaseKind: null,
      },
      {
        id: "event_purchase",
        workspaceId: "workspace_1",
        phoneHash: "phone_a",
        customerIdentityKey: "phone_a",
        businessSource: "paid",
        campaignId: "cmp_1",
        adSetId: "adset_1",
        adId: "ad_1",
        eventName: "Purchase",
        eventOccurredAt: new Date("2026-07-01T12:30:00.000Z"),
        status: "sent",
        valueCents: 100000,
        currency: "BRL",
        purchaseKind: "first_purchase",
      },
    ] as Array<Record<string, unknown>>,
  };
  const prisma = {
    whatsappInstance: {
      findFirst: vi.fn(
        async (args?: { where?: Record<string, unknown> }) =>
          db.whatsappInstances.find((instance) =>
            matchesWhere(instance, args?.where),
          ) ?? null,
      ),
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
        db.whatsappInstances.filter((instance) =>
          matchesWhere(instance, args?.where),
        ),
      ),
    },
    metaIntegration: {
      findUnique: vi.fn(async () => db.metaIntegration),
    },
    metaReportingAccount: {
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
        db.reportingAccounts.filter((account) =>
          matchesWhere(account, args?.where),
        ),
      ),
      findFirst: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        const account = db.reportingAccounts.find((candidate) =>
          matchesWhere(candidate, args?.where),
        );

        if (!account) {
          return null;
        }

        return {
          ...account,
          conversionDestinationId:
            (account as Record<string, unknown>).conversionDestinationId ??
            null,
          businessConnection: null,
          allowedDestinations: db.accountDestinations
            .filter(
              (record) =>
                record.workspaceId === account.workspaceId &&
                record.reportingAccountId === account.id &&
                record.active === true,
            )
            .map((record) => ({
              destination: db.conversionDestinations.find(
                (destination) =>
                  destination.id === record.conversionDestinationId,
              ),
            }))
            .filter((record) => Boolean(record.destination)),
        };
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const account = db.reportingAccounts.find(
            (item) => item.id === where.id,
          );
          return { ...account, ...data };
        },
      ),
    },
    metaBusinessConnection: {
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    metaConversionDestination: {
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
        db.conversionDestinations.filter((destination) =>
          matchesWhere(destination, args?.where),
        ),
      ),
    },
    metaAdDestinationAssignment: {
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
        db.adDestinationAssignments.filter((assignment) =>
          matchesWhere(assignment, args?.where),
        ),
      ),
      deleteMany: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        const retained = db.adDestinationAssignments.filter(
          (assignment) => !matchesWhere(assignment, args?.where),
        );
        const count = db.adDestinationAssignments.length - retained.length;
        db.adDestinationAssignments.splice(
          0,
          db.adDestinationAssignments.length,
          ...retained,
        );
        return { count };
      }),
      createMany: vi.fn(
        async ({ data }: { data: Array<Record<string, unknown>> }) => {
          let count = 0;

          for (const candidate of data) {
            const exists = db.adDestinationAssignments.some(
              (assignment) =>
                assignment.workspaceId === candidate.workspaceId &&
                assignment.adId === candidate.adId,
            );

            if (!exists) {
              db.adDestinationAssignments.push({
                id: `assignment_${db.adDestinationAssignments.length + 1}`,
                ...candidate,
              });
              count += 1;
            }
          }

          return { count };
        },
      ),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const key = where.workspaceId_adId;
        const existing = db.adDestinationAssignments.find(
          (assignment) =>
            assignment.workspaceId === key.workspaceId &&
            assignment.adId === key.adId,
        );

        if (existing) {
          Object.assign(existing, update);
          return existing;
        }

        const record = {
          id: `assignment_${db.adDestinationAssignments.length + 1}`,
          ...create,
        };
        db.adDestinationAssignments.push(record);
        return record;
      }),
    },
    metaCampaign: {
      upsert: vi.fn(
        async ({
          create,
          update,
        }: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const record = { ...create, ...update };
          db.campaigns.push(record);
          return record;
        },
      ),
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
        db.campaigns.filter((campaign) => matchesWhere(campaign, args?.where)),
      ),
      findFirst: vi.fn(
        async (args?: { where?: Record<string, unknown> }) =>
          db.campaigns.find((campaign) =>
            matchesWhere(campaign, args?.where),
          ) ?? null,
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const records = db.campaigns.filter((campaign) =>
            matchesWhere(campaign, where),
          );
          records.forEach((record) => Object.assign(record, data));
          return { count: records.length };
        },
      ),
    },
    metaCampaignDailyInsight: {
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
        db.dailyInsights.filter((insight) =>
          matchesWhere(insight, args?.where),
        ),
      ),
      // Meta coverage (#174): MIN(localDate) per ad account.
      groupBy: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        const mins = new Map<string, string>();
        for (const insight of db.dailyInsights.filter((row) =>
          matchesWhere(row, args?.where),
        )) {
          const account = String(insight.adAccountId);
          const date = String(insight.localDate);
          const current = mins.get(account);
          if (!current || date < current) mins.set(account, date);
        }
        return [...mins].map(([adAccountId, localDate]) => ({
          adAccountId,
          _min: { localDate },
        }));
      }),
      deleteMany: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        const retained = db.dailyInsights.filter(
          (insight) => !matchesWhere(insight, args?.where),
        );
        const count = db.dailyInsights.length - retained.length;
        db.dailyInsights.splice(0, db.dailyInsights.length, ...retained);
        return { count };
      }),
      createMany: vi.fn(
        async ({ data }: { data: Array<Record<string, unknown>> }) => {
          db.dailyInsights.push(...data);
          return { count: data.length };
        },
      ),
    },
    metaAdSetDailyInsight: {
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
        db.adSetDailyInsights.filter((insight) =>
          matchesWhere(insight, args?.where),
        ),
      ),
      deleteMany: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        const retained = db.adSetDailyInsights.filter(
          (insight) => !matchesWhere(insight, args?.where),
        );
        const count = db.adSetDailyInsights.length - retained.length;
        db.adSetDailyInsights.splice(
          0,
          db.adSetDailyInsights.length,
          ...retained,
        );
        return { count };
      }),
      createMany: vi.fn(
        async ({ data }: { data: Array<Record<string, unknown>> }) => {
          db.adSetDailyInsights.push(...data);
          return { count: data.length };
        },
      ),
    },
    metaAdDailyInsight: {
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
        db.adDailyInsights.filter((insight) =>
          matchesWhere(insight, args?.where),
        ),
      ),
      deleteMany: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        const retained = db.adDailyInsights.filter(
          (insight) => !matchesWhere(insight, args?.where),
        );
        const count = db.adDailyInsights.length - retained.length;
        db.adDailyInsights.splice(0, db.adDailyInsights.length, ...retained);
        return { count };
      }),
      createMany: vi.fn(
        async ({ data }: { data: Array<Record<string, unknown>> }) => {
          db.adDailyInsights.push(...data);
          return { count: data.length };
        },
      ),
    },
    metaAdSet: {
      upsert: vi.fn(
        async ({
          create,
          update,
        }: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const record = { ...create, ...update };
          db.adSets.push(record);
          return record;
        },
      ),
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
        db.adSets.filter((adSet) => matchesWhere(adSet, args?.where)),
      ),
      findFirst: vi.fn(
        async (args?: { where?: Record<string, unknown> }) =>
          db.adSets.find((adSet) => matchesWhere(adSet, args?.where)) ?? null,
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const records = db.adSets.filter((adSet) =>
            matchesWhere(adSet, where),
          );
          records.forEach((record) => Object.assign(record, data));
          return { count: records.length };
        },
      ),
    },
    metaAd: {
      upsert: vi.fn(
        async ({
          create,
          update,
        }: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const record = { ...create, ...update };
          db.ads.push(record);
          return record;
        },
      ),
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
        db.ads.filter((ad) => matchesWhere(ad, args?.where)),
      ),
      findFirst: vi.fn(
        async (args?: { where?: Record<string, unknown> }) =>
          db.ads.find((ad) => matchesWhere(ad, args?.where)) ?? null,
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const records = db.ads.filter((ad) => matchesWhere(ad, where));
          records.forEach((record) => Object.assign(record, data));
          return { count: records.length };
        },
      ),
    },
    conversionRule: {
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
        db.conversionRules.filter((rule) => matchesWhere(rule, args?.where)),
      ),
    },
    conversionEventLog: {
      findFirst: vi.fn(
        async (args?: { where?: Record<string, unknown> }) =>
          db.conversionLogs.find((log) => matchesWhere(log, args?.where)) ??
          null,
      ),
      findMany: vi.fn(
        async (args?: {
          where?: Record<string, unknown>;
          skip?: number;
          take?: number;
        }) => {
          const records = db.conversionLogs.filter((log) =>
            matchesWhere(log, args?.where),
          );
          const start = args?.skip ?? 0;
          return records.slice(
            start,
            args?.take ? start + args.take : undefined,
          );
        },
      ),
      groupBy: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        const counts = new Map<string, number>();
        db.conversionLogs
          .filter((log) => matchesWhere(log, args?.where))
          .forEach((log) => {
            const status = String(log.status);
            counts.set(status, (counts.get(status) ?? 0) + 1);
          });
        return [...counts].map(([status, count]) => ({
          status,
          _count: { _all: count },
        }));
      }),
      count: vi.fn(
        async (args?: { where?: Record<string, unknown> }) =>
          db.conversionLogs.filter((log) => matchesWhere(log, args?.where))
            .length,
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const records = db.conversionLogs.filter((log) =>
            matchesWhere(log, where),
          );
          records.forEach((record) => Object.assign(record, data));
          return { count: records.length };
        },
      ),
    },
    externalIngestionRecord: {
      findFirst: vi.fn(
        async (args?: { where?: Record<string, unknown> }) =>
          db.externalIngestionRecords.find((record) =>
            matchesWhere(record, args?.where),
          ) ?? null,
      ),
    },
    lead: {
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
        db.leads.filter((lead) => matchesWhere(lead, args?.where)),
      ),
      groupBy: vi.fn(
        async (args?: { by?: string[]; where?: Record<string, unknown> }) => {
          const groups = new Map<string, Record<string, unknown>>();
          const keys = args?.by ?? [];

          db.leads
            .filter((lead) => matchesWhere(lead, args?.where))
            .forEach((lead) => {
              const group = Object.fromEntries(
                keys.map((key) => [
                  key,
                  lead[key as keyof typeof lead] ?? null,
                ]),
              );
              const groupKey = JSON.stringify(group);
              const current = groups.get(groupKey) ?? {
                ...group,
                _count: { _all: 0 },
              };
              (current._count as { _all: number })._all += 1;
              groups.set(groupKey, current);
            });

          return [...groups.values()];
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const records = db.leads.filter((lead) => matchesWhere(lead, where));
          records.forEach((record) => Object.assign(record, data));
          return { count: records.length };
        },
      ),
    },
    integrationLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const log = {
          id: `integration_${db.integrationLogs.length + 1}`,
          ...data,
        };
        db.integrationLogs.push(log);
        return log;
      }),
    },
    diagnosticEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const event = {
          id: `diagnostic_${db.diagnosticEvents.length + 1}`,
          ...data,
        };
        db.diagnosticEvents.push(event);
        return event;
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const log = {
          id: `audit_${db.auditLogs.length + 1}`,
          ...data,
        };
        db.auditLogs.push(log);
        return log;
      }),
    },
  };
  Object.assign(prisma, {
    $transaction: vi.fn(async (operation: (client: unknown) => unknown) =>
      operation(prisma),
    ),
  });
  const encryption = {
    decrypt: vi.fn(() => "EAAB-secret-token"),
    fingerprint: vi.fn((accessToken: string) => `fingerprint:${accessToken}`),
  };
  const metaAdapter = {
    listCampaigns: vi.fn(async (_input?: { adAccountId?: string }) => [
      {
        id: "cmp_1",
        name: "Black Friday WhatsApp",
        status: "ACTIVE",
        effectiveStatus: "ACTIVE",
        objective: "OUTCOME_SALES",
        dailyBudgetCents: 49500,
        lifetimeBudgetCents: null,
      },
    ]),
    listAdSets: vi.fn(async () => [
      {
        id: "adset_1",
        name: "Publico quente",
        campaignId: "cmp_1",
        status: "ACTIVE",
        effectiveStatus: "ACTIVE",
        destinationType: "WHATSAPP" as string | null,
        dailyBudgetCents: null,
        lifetimeBudgetCents: null,
      },
    ]),
    listAds: vi.fn(async () => [
      {
        id: "ad_1",
        name: "Criativo WhatsApp",
        campaignId: "cmp_1",
        adSetId: "adset_1",
        status: "ACTIVE",
        effectiveStatus: "ACTIVE",
        creativeId: "creative_1",
        thumbnailUrl: "https://example.com/ad-1.jpg" as string | null,
        callToActionType: "WHATSAPP_MESSAGE" as string | null,
        detectedPixelIds: [] as string[],
        detectedPageIds: [] as string[],
      },
    ]),
    listCampaignInsights: vi.fn(
      async (_input: {
        accessToken?: string;
        adAccountId?: string;
        since?: string;
        until?: string;
        readMode?: "legacy" | "manual";
      }) => [
        {
          campaignId: "cmp_1",
          spendCents: 120000,
          impressions: 10000,
          clicks: 420,
          metaConversationsStarted: 176,
        },
      ],
    ),
    listCampaignDailyInsights: vi.fn(async () => [
      {
        campaignId: "cmp_1",
        date: "2026-07-01",
        spendCents: 70000,
        impressions: 6000,
        clicks: 250,
        metaConversationsStarted: 100,
      },
      {
        campaignId: "cmp_1",
        date: "2026-07-02",
        spendCents: 50000,
        impressions: 4000,
        clicks: 170,
        metaConversationsStarted: 76,
      },
    ]),
    listAdSetInsights: vi.fn(
      async (_input: {
        accessToken?: string;
        adAccountId?: string;
        since?: string;
        until?: string;
        readMode?: "legacy" | "manual";
      }) => [
        {
          adSetId: "adset_1",
          campaignId: "cmp_1",
          spendCents: 60000,
          impressions: 5000,
          clicks: 210,
          metaConversationsStarted: 80,
        },
      ],
    ),
    listAdSetDailyInsights: vi.fn(async () => [
      {
        adSetId: "adset_1",
        campaignId: "cmp_1",
        date: "2026-07-01",
        spendCents: 35000,
        impressions: 3000,
        clicks: 125,
        metaConversationsStarted: 45,
      },
      {
        adSetId: "adset_1",
        campaignId: "cmp_1",
        date: "2026-07-02",
        spendCents: 25000,
        impressions: 2000,
        clicks: 85,
        metaConversationsStarted: 35,
      },
    ]),
    listAdInsights: vi.fn(
      async (_input: {
        accessToken?: string;
        adAccountId?: string;
        since?: string;
        until?: string;
        readMode?: "legacy" | "manual";
      }) => [
        {
          adId: "ad_1",
          adSetId: "adset_1",
          campaignId: "cmp_1",
          spendCents: 30000,
          impressions: 2500,
          clicks: 105,
          metaConversationsStarted: 40,
        },
      ],
    ),
    listAdDailyInsights: vi.fn(async () => [
      {
        adId: "ad_1",
        adSetId: "adset_1",
        campaignId: "cmp_1",
        date: "2026-07-01",
        spendCents: 17500,
        impressions: 1500,
        clicks: 65,
        metaConversationsStarted: 22,
      },
      {
        adId: "ad_1",
        adSetId: "adset_1",
        campaignId: "cmp_1",
        date: "2026-07-02",
        spendCents: 12500,
        impressions: 1000,
        clicks: 40,
        metaConversationsStarted: 18,
      },
    ]),
    listAdInsightRows: vi.fn(
      async (_input: {
        accessToken?: string;
        adAccountId?: string;
        since?: string;
        until?: string;
        daily?: boolean;
        readMode?: "legacy" | "manual";
      }) =>
        [] as Array<{
          adId: string;
          adSetId: string;
          campaignId: string;
          date: string | null;
          spendCents: number;
          impressions: number;
          clicks: number;
          actionValues: Record<string, number>;
        }>,
    ),
    updateEntityStatus: vi.fn(async () => undefined),
    updateEntityBudget: vi.fn(async () => undefined),
    // nod: the sync reads ads through listAdsWithPreviewStats (saved media
    // reuse); in these tests it returns listAds with empty preview stats.
    listAdsWithPreviewStats: vi.fn(async (input: unknown) => ({
      ads: await (metaAdapter.listAds as (value: unknown) => Promise<unknown[]>)(
        input,
      ),
      previewStats: {
        distinctCreatives: 0,
        creativesReused: 0,
        creativesSkipped: 0,
        creativesRequested: 0,
        creativesSucceeded: 0,
        creativesFailed: 0,
        creativesWithoutPreview: 0,
        creativeBatchRequests: 0,
        videosRequested: 0,
        videosSucceeded: 0,
        videosFailed: 0,
        videoBatchRequests: 0,
        failureReasons: {},
      },
    })),
  };
  const connectionResolver = {
    resolveReportingRoute: vi.fn(async () => ({
      source: "manual" as const,
      workspaceId: "workspace_1",
      accessToken: "EAAB-manual-exact-token",
      reportingAccountId: "reporting_1",
      adAccountId: "act_123",
      businessConnectionId: "connection_1",
      credentialId: "credential_1",
    })),
    getLegacyCompatibilityProjection: vi.fn(async () => ({
      source: "legacy_oauth" as const,
      workspaceId: "workspace_1",
      businessId: "business_1",
      adAccountId: "act_123",
      pixelId: "pixel_1",
      destinationPixelId: "pixel_1",
      destinationPageId: "page_1",
      credentialFingerprint: "fingerprint:EAAB-secret-token",
    })),
  };
  const service = new MetaReportingService(
    prisma as never,
    encryption as never,
    metaAdapter as never,
    new MetaAdDestinationRoutingService(prisma as never),
    new WhatsappCampaignClassifierService(),
    new ReportingMetricsEngine(),
    {
      getConfiguration: vi.fn(async (workspaceId: string) => {
        const stages = [
          {
            eventName: "LeadSubmitted",
            label: "Conversas reais iniciadas",
          },
          ...db.conversionRules
            .filter(
              (rule) =>
                rule.workspaceId === workspaceId && rule.active === true,
            )
            .sort(
              (left, right) =>
                ["QualifiedLead", "InitiateCheckout", "Purchase"].indexOf(
                  left.eventName,
                ) -
                ["QualifiedLead", "InitiateCheckout", "Purchase"].indexOf(
                  right.eventName,
                ),
            )
            .map((rule) => ({
              eventName: rule.eventName,
              label:
                {
                  QualifiedLead: "Lead qualificado",
                  InitiateCheckout: "Checkout iniciado",
                  Purchase: "Compras",
                }[rule.eventName] ?? rule.eventName,
            })),
        ];

        return {
          stages: stages.map((stage, index) => ({
            ...stage,
            position: index + 1,
            visible: true,
          })),
        };
      }),
    } as never,
    connectionResolver as never,
    undefined,
    undefined,
    // nod: LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED is on by default (unset = on).
    // These SaaS tests assume it off unless they pass `env` explicitly.
    (options.env ?? { LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED: "false" }) as never,
  );

  return {
    db,
    encryption,
    metaAdapter,
    prisma,
    service,
    connectionResolver,
  };
}

// Fase 6.3a (nod): the tests below are ported from the SaaS meta-reporting-service
// suite (#61, #157, #167 and e4139c4c), on the same in-memory harness.
describe("meta reporting service", () => {
  it("shows the corrected value of a Payt sale only when it really changed (e4139c4c)", async () => {
    const { db, service } = createHarness();
    const ctwaDestination = {
      kind: "authorized_ctwa_destination",
      deliveryKind: "page_pixel",
      workspaceId: "workspace_1",
      channelId: "channel_1",
      connectionId: "connection_1",
      organizationId: "org_1",
      providerChannelId: "provider_channel_1",
      destinationId: "destination_1",
      businessConnectionId: "business_connection_1",
      credentialId: "credential_1",
      credentialFingerprint: "fingerprint_1",
      pixelId: "pixel_1",
      pageId: "page_1",
    };
    const stuck = {
      id: "payt_purchase_no_ad",
      workspaceId: "workspace_1",
      eventName: "Purchase",
      eventOccurredAt: new Date("2026-07-02T12:00:00.000Z"),
      createdAt: new Date("2026-07-02T12:00:00.000Z"),
      sentAt: null,
      status: "ready_to_send",
      sourceTrigger: "inbound_webhook:payt:provider_automation",
      sourceEventId: "payt_1",
      eventId: "conversion_purchase_1",
      dedupeKey: "purchase:1",
      leadId: null,
      phoneHash: "phone_a",
      campaignId: null,
      adSetId: null,
      adId: null,
      ctwaClid: "ctwa_1",
      pixelId: null,
      pageId: null,
      attributionStatus: "ctwa_ad_unknown",
      valueCents: 83856,
      valueSource: "actual",
      currency: "BRL",
      contentName: null,
      customData: null,
      sourcePayload: {
        provider: "payt",
        processingMode: "frozen_provider_conversion",
        ctwaDestination,
      },
      providerRequestPayload: null,
      providerResponseSummary: null,
      errorCode: null,
      errorMessage: null,
    };
    // nod: the CTWA page/pixel half of this SaaS test belongs to another
    // item; only the value correction (e4139c4c) is ported here.
    // Without a CTWA destination the missing ad is still reported.
    db.conversionLogs = [
      {
        ...stuck,
        attributionStatus: "organic_or_unattributed",
        sourcePayload: { provider: "payt" },
      },
    ];
    const plain = await service.getConversionEventAuditDetail({
      workspaceId: "workspace_1",
      eventId: "payt_purchase_no_ad",
    });
    expect(plain.missingFields).toContain("ad_id");
    expect(plain.valueCorrection).toBeNull();

    // A Payt sale corrected to the value without installment interest.
    db.conversionLogs = [
      {
        ...stuck,
        valueCents: 24700,
        sourcePayload: {
          provider: "payt",
          valueCorrection: {
            previousValueCents: 29760,
            valueCents: 24700,
            reason: "payt_price_without_installments",
          },
        },
      },
    ];
    const corrected = await service.getConversionEventAuditDetail({
      workspaceId: "workspace_1",
      eventId: "payt_purchase_no_ad",
    });
    expect(corrected.valueCorrection).toEqual({
      previousValueCents: 29760,
      valueCents: 24700,
      currency: "BRL",
    });
  });

  it("exposes every workspace-configured event as an audit filter option", async () => {
    const { db, service } = createHarness();
    db.conversionRules = [
      ...db.conversionRules,
      {
        workspaceId: "workspace_1",
        eventName: "InitiateCheckout",
        active: true,
      },
      {
        workspaceId: "workspace_2",
        eventName: "OrderShipped",
        active: true,
      },
    ];

    const result = await service.getConversionEventAudit({
      workspaceId: "workspace_1",
      rangeLabel: "2026-07-01 a 2026-07-02",
      since: "2026-07-01",
      until: "2026-07-02",
      page: 1,
      pageSize: 25,
    });

    expect(result.availableEvents).toEqual([
      { eventName: "LeadSubmitted", label: "Conversas reais iniciadas" },
      { eventName: "QualifiedLead", label: "Lead qualificado" },
      { eventName: "InitiateCheckout", label: "Checkout iniciado" },
      { eventName: "Purchase", label: "Compras" },
    ]);
  });

  it("returns a daily Meta versus real conversation series scoped by business", async () => {
    const { service } = createHarness();

    await service.syncWorkspaceMetaStructure({
      workspaceId: "workspace_1",
      since: "2026-07-01",
      until: "2026-07-02",
    });

    const report = await service.getCampaignReportOverview({
      workspaceId: "workspace_1",
      rangeLabel: "2026-07-01 a 2026-07-02",
      since: "2026-07-01",
      until: "2026-07-02",
      businessId: "business_1",
      includeSummary: true,
      includeDaily: true,
    });

    expect(report.dailyComparisonAvailable).toBe(true);
    expect(report.dailyComparison).toEqual([
      {
        date: "2026-07-01",
        metaConversationsStarted: 100,
        // Conversas iniciadas reais: the entry LeadSubmitted of 01/07.
        adConversationsStarted: 1,
        realConversations: 1,
        returningLeads: 0,
      },
      {
        date: "2026-07-02",
        metaConversationsStarted: 76,
        // lead_2 has no LeadSubmitted (no conversation started by ad).
        adConversationsStarted: 0,
        realConversations: 1,
        returningLeads: 0,
      },
    ]);
    // Lead sent at the entry (no rule override): no separate Lead series.
    expect(report.dailyComparisonLeadEventDeferred).toBe(false);
    // The days add up to "Conversas por anuncio" of the block.
    expect(
      report.dailyComparison?.reduce(
        (total, point) => total + (point.adConversationsStarted ?? 0),
        0,
      ),
    ).toBe(report.summary?.adConversationEvents);
    expect(report.summary?.realConversations).toBe(2);
    expect(report.summary?.metaConversationsStarted).toBe(176);
  });

  describe("leads novos x leads que voltaram", () => {
    const periodInput = {
      workspaceId: "workspace_1",
      rangeLabel: "2026-07-01 a 2026-07-02",
      since: "2026-07-01",
      until: "2026-07-02",
      includeSummary: true,
      includeDaily: true,
    };

    function returningLead(
      db: ReturnType<typeof createHarness>["db"],
      input: { id: string; phoneHash: string; firstMessageAt: Date },
    ) {
      db.leads.push({
        id: input.id,
        workspaceId: "workspace_1",
        name: "Cliente antigo",
        phoneDisplay: "+55 11 99999-7070",
        phoneHash: input.phoneHash,
        // The row now points at the ad of the NEW conversation.
        campaignId: "cmp_1",
        adSetId: "adset_1",
        adId: "ad_1",
        firstMessageAt: input.firstMessageAt,
        createdAt: input.firstMessageAt,
      });
    }

    function leadSubmitted(
      db: ReturnType<typeof createHarness>["db"],
      input: {
        id: string;
        leadId: string;
        phoneHash: string;
        occurredAt: Date;
        campaignId?: string;
        adSetId?: string;
        adId?: string;
      },
    ) {
      db.conversionLogs.push({
        id: input.id,
        workspaceId: "workspace_1",
        leadId: input.leadId,
        phoneHash: input.phoneHash,
        customerIdentityKey: input.phoneHash,
        businessSource: "paid",
        campaignId: input.campaignId ?? "cmp_1",
        adSetId: input.adSetId ?? "adset_1",
        adId: input.adId ?? "ad_1",
        eventName: "LeadSubmitted",
        eventOccurredAt: input.occurredAt,
        status: "sent",
        valueCents: null,
        currency: null,
        purchaseKind: null,
      });
    }

    async function sync(service: ReturnType<typeof createHarness>["service"]) {
      await service.syncWorkspaceMetaStructure({
        workspaceId: "workspace_1",
        since: "2026-07-01",
        until: "2026-07-02",
      });
    }

    describe("daily chart: Meta x conversas reais (+ Lead event when deferred)", () => {
      const flagOn = { LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED: "true" };

      /**
       * Override fixture: besides the base lead_1 (entry Lead sent on 01/07)
       * and lead_2 (02/07, no conversation event), lead_d1 enters on 01/07
       * with the Lead deferred to a rule that sends it on 02/07, and lead_d2
       * enters on 02/07 deferred and the rule never fires.
       */
      function deferredFixture(db: ReturnType<typeof createHarness>["db"]) {
        const deferredLead = (id: string, phoneHash: string, at: string) => {
          db.leads.push({
            id,
            workspaceId: "workspace_1",
            name: id,
            phoneDisplay: null,
            phoneHash,
            campaignId: "cmp_1",
            adSetId: "adset_1",
            adId: "ad_1",
            firstMessageAt: new Date(at),
            createdAt: new Date(at),
          });
        };
        const log = (input: {
          id: string;
          leadId: string;
          phoneHash: string;
          at: string;
          sourceTrigger: string;
          deferred?: boolean;
        }) =>
          db.conversionLogs.push({
            id: input.id,
            workspaceId: "workspace_1",
            leadId: input.leadId,
            phoneHash: input.phoneHash,
            customerIdentityKey: input.phoneHash,
            businessSource: "paid",
            campaignId: "cmp_1",
            adSetId: "adset_1",
            adId: "ad_1",
            eventName: "LeadSubmitted",
            eventOccurredAt: new Date(input.at),
            sourceTrigger: input.sourceTrigger,
            status: input.deferred ? "not_eligible" : "sent",
            errorCode: input.deferred
              ? "lead_submitted_deferred_to_rule"
              : null,
            valueCents: null,
            currency: null,
            purchaseKind: null,
          });

        deferredLead("lead_d1", "phone_d1", "2026-07-01T15:00:00.000Z");
        log({
          id: "entry_d1",
          leadId: "lead_d1",
          phoneHash: "phone_d1",
          at: "2026-07-01T15:00:00.000Z",
          sourceTrigger: "inbound_webhook:unnichat",
          deferred: true,
        });
        log({
          id: "rule_d1",
          leadId: "lead_d1",
          phoneHash: "phone_d1",
          at: "2026-07-02T13:00:00.000Z",
          sourceTrigger: "inbound_webhook:unnichat:provider_automation",
        });
        deferredLead("lead_d2", "phone_d2", "2026-07-02T14:00:00.000Z");
        log({
          id: "entry_d2",
          leadId: "lead_d2",
          phoneHash: "phone_d2",
          at: "2026-07-02T14:00:00.000Z",
          sourceTrigger: "inbound_webhook:unnichat",
          deferred: true,
        });
      }

      it("override mode: conversations count every entry (deferred too); the Lead series follows the rule send", async () => {
        const { db, service } = createHarness({ env: flagOn });
        deferredFixture(db);
        await sync(service);

        const report = await service.getCampaignReportOverview({
          ...periodInput,
          businessId: "business_1",
        });

        expect(report.dailyComparisonLeadEventDeferred).toBe(true);
        expect(
          report.dailyComparison?.map((point) => ({
            date: point.date,
            conversas: point.adConversationsStarted,
            leads: point.realConversations,
          })),
        ).toEqual([
          // event_lead_submitted + entry_d1 (deferred, still a conversation).
          { date: "2026-07-01", conversas: 2, leads: 1 },
          // entry_d2 only (rule_d1 is not a new conversation); leads: lead_2
          // and lead_d1 (Lead sent by the rule today). lead_d2 never.
          { date: "2026-07-02", conversas: 1, leads: 2 },
        ]);
        const conversations = report.dailyComparison?.reduce(
          (total, point) => total + (point.adConversationsStarted ?? 0),
          0,
        );
        expect(conversations).toBe(3);
        expect(conversations).toBe(report.summary?.adConversationEvents);
        expect(report.summary?.realConversations).toBe(3);
      });

      it("nod: the variable unset is the override mode (on by default, produção direta)", async () => {
        const { db, service } = createHarness({ env: {} });
        deferredFixture(db);
        await sync(service);

        const report = await service.getCampaignReportOverview({
          ...periodInput,
          businessId: "business_1",
        });

        expect(report.dailyComparisonLeadEventDeferred).toBe(true);
        expect(
          report.dailyComparison?.map((point) => point.adConversationsStarted),
        ).toEqual([2, 1]);
      });

      it("normal mode (flag off): no Lead series and the same conversation rule", async () => {
        const { db, service } = createHarness({
          env: { LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED: "false" },
        });
        leadSubmitted(db, {
          id: "event_second_lead",
          leadId: "lead_2",
          phoneHash: "phone_b",
          occurredAt: new Date("2026-07-02T12:00:00.000Z"),
        });
        await sync(service);

        const report = await service.getCampaignReportOverview({
          ...periodInput,
          businessId: "business_1",
        });

        expect(report.dailyComparisonLeadEventDeferred).toBe(false);
        expect(
          report.dailyComparison?.map((point) => [
            point.adConversationsStarted,
            point.realConversations,
          ]),
        ).toEqual([
          [1, 1],
          [1, 1],
        ]);
        expect(report.summary?.adConversationEvents).toBe(2);
      });
    });
  });
});

describe("meta reporting service: Meta metrics follow the requested period", () => {
  // Ads stopped spending on 2026-10-16. The entity columns hold the totals of
  // the last sync window (2026-10-10..16); a later period must not reuse them.
  async function syncUntilAdsStopped() {
    const harness = createHarness();
    const day = (date: string, spendCents: number, conversations: number) => ({
      date,
      spendCents,
      impressions: spendCents / 10,
      clicks: spendCents / 100,
      metaConversationsStarted: conversations,
    });
    harness.metaAdapter.listCampaignDailyInsights.mockResolvedValue([
      { campaignId: "cmp_1", ...day("2026-10-15", 70000, 100) },
      { campaignId: "cmp_1", ...day("2026-10-16", 50000, 76) },
    ]);
    harness.metaAdapter.listAdSetDailyInsights.mockResolvedValue([
      {
        adSetId: "adset_1",
        campaignId: "cmp_1",
        ...day("2026-10-15", 35000, 45),
      },
      {
        adSetId: "adset_1",
        campaignId: "cmp_1",
        ...day("2026-10-16", 25000, 35),
      },
    ]);
    harness.metaAdapter.listAdDailyInsights.mockResolvedValue([
      {
        adId: "ad_1",
        adSetId: "adset_1",
        campaignId: "cmp_1",
        ...day("2026-10-15", 17500, 22),
      },
      {
        adId: "ad_1",
        adSetId: "adset_1",
        campaignId: "cmp_1",
        ...day("2026-10-16", 12500, 18),
      },
    ]);

    await harness.service.syncWorkspaceMetaStructure({
      workspaceId: "workspace_1",
      since: "2026-10-10",
      until: "2026-10-16",
    });

    return harness;
  }

  const periods = [
    ["2026-10-17", "2026-10-21"],
    ["2026-10-18", "2026-10-21"],
    ["2026-10-20", "2026-10-21"],
    ["2026-10-21", "2026-10-21"],
  ] as const;

  it.each(periods)(
    "overview %s..%s shows zero spend and Meta conversations",
    async (since, until) => {
      const { service } = await syncUntilAdsStopped();

      const report = await service.getCampaignReportOverview({
        workspaceId: "workspace_1",
        rangeLabel: `${since} a ${until}`,
        since,
        until,
        includeSummary: true,
        includeDaily: true,
      });

      expect(report.summary).toMatchObject({
        spendCents: 0,
        metaConversationsStarted: 0,
        costPerMetaConversationCents: null,
      });
      expect(report.totals).toMatchObject({
        spendCents: 0,
        metaConversationsStarted: 0,
      });
      expect(report.campaigns[0]).toMatchObject({
        id: "cmp_1",
        spendCents: 0,
        metaConversationsStarted: 0,
      });
      expect(report.dailyComparisonAvailable).toBe(false);
    },
  );

  it("Relatorios campaign rows (no daily comparison) also follow the period", async () => {
    const { service } = await syncUntilAdsStopped();

    const report = await service.getCampaignReportOverview({
      workspaceId: "workspace_1",
      rangeLabel: "2026-10-17 a 2026-10-21",
      since: "2026-10-17",
      until: "2026-10-21",
    });

    expect(report.campaigns[0]).toMatchObject({
      spendCents: 0,
      metaConversationsStarted: 0,
    });
  });

  it("a selected campaign after the stop day reports zero, not the sync window", async () => {
    const { service } = await syncUntilAdsStopped();

    const report = await service.getCampaignReportOverview({
      workspaceId: "workspace_1",
      rangeLabel: "2026-10-17 a 2026-10-21",
      since: "2026-10-17",
      until: "2026-10-21",
      includeSummary: true,
      campaignId: "cmp_1",
    });

    expect(report.summary).toMatchObject({
      spendCents: 0,
      metaConversationsStarted: 0,
    });
  });

  it("ad set and ad reports after the stop day report zero", async () => {
    const { service } = await syncUntilAdsStopped();
    const period = {
      workspaceId: "workspace_1",
      rangeLabel: "2026-10-17 a 2026-10-21",
      since: "2026-10-17",
      until: "2026-10-21",
    };

    const adSets = await service.getAdSetReportOverview(period);
    const ads = await service.getAdReportOverview(period);

    expect(adSets.adSets[0]).toMatchObject({
      spendCents: 0,
      metaConversationsStarted: 0,
    });
    expect(adSets.totals).toMatchObject({ spendCents: 0 });
    expect(ads.ads[0]).toMatchObject({
      spendCents: 0,
      metaConversationsStarted: 0,
    });
    expect(ads.totals).toMatchObject({ spendCents: 0 });
  });

  it("a period overlapping the stop day sums only its own days", async () => {
    const { service } = await syncUntilAdsStopped();

    const overview = await service.getCampaignReportOverview({
      workspaceId: "workspace_1",
      rangeLabel: "2026-10-16 a 2026-10-21",
      since: "2026-10-16",
      until: "2026-10-21",
      includeSummary: true,
      includeDaily: true,
    });
    const adSets = await service.getAdSetReportOverview({
      workspaceId: "workspace_1",
      rangeLabel: "2026-10-16 a 2026-10-21",
      since: "2026-10-16",
      until: "2026-10-21",
    });

    // Only 2026-10-16 (WhatsApp ad set scope, as before for partial periods).
    expect(overview.summary).toMatchObject({
      spendCents: 25000,
      metaConversationsStarted: 35,
    });
    expect(adSets.adSets[0]).toMatchObject({
      spendCents: 25000,
      metaConversationsStarted: 35,
    });
  });

  it("campaign, ad set and ad reports carry the Meta coverage of the period (#174)", async () => {
    const { db, service } = await syncUntilAdsStopped();
    // Synced just now: no delay warning, only the coverage start.
    for (const account of db.reportingAccounts) {
      Object.assign(account, {
        createdAt: new Date("2026-10-01T00:00:00.000Z"),
        lastSyncedAt: new Date(),
      });
    }
    const period = {
      workspaceId: "workspace_1",
      rangeLabel: "2026-10-01 a 2026-10-21",
      since: "2026-10-01",
      until: "2026-10-21",
    };

    const campaigns = await service.getCampaignReportOverview(period);
    const adSets = await service.getAdSetReportOverview(period);
    const ads = await service.getAdReportOverview(period);

    for (const report of [campaigns, adSets, ads]) {
      expect(report.metaSyncCoverage).toMatchObject({
        // The sync stores every day of its window (10..16), zeros included.
        earliestDailyDate: "2026-10-10",
        periodStartsBeforeCoverage: true,
        problemAccounts: [],
      });
    }
  });

  it("keeps the synced period itself unchanged", async () => {
    const { service } = await syncUntilAdsStopped();

    const report = await service.getCampaignReportOverview({
      workspaceId: "workspace_1",
      rangeLabel: "2026-10-10 a 2026-10-16",
      since: "2026-10-10",
      until: "2026-10-16",
      includeSummary: true,
      includeDaily: true,
    });

    expect(report.dailyComparisonAvailable).toBe(true);
    expect(report.summary).toMatchObject({
      spendCents: 120000,
      metaConversationsStarted: 176,
    });
  });
});
