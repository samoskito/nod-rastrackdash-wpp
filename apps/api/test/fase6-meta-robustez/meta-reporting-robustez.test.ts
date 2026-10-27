// Fase 6.4 (porte do SaaS 918a0837, 6a3f2c79, c0cec66c, 213047d3, bc72b208):
// testes do meta-reporting-service do SaaS para miniaturas guardadas, disjuntor
// só de relatórios, modo ad_level e janela incremental, com o harness do SaaS
// adaptado ao nod (listAdsWithPreviewStats e ordem do construtor).
import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { MetaReportingService } from "../../src/reporting/meta-reporting.service";
import { MetaAdDestinationRoutingService } from "../../src/integrations/meta/meta-ad-destination-routing.service";
import { ExchangeRateTable } from "../../src/currency/exchange-rate.service";
import { ReportingMetricsEngine } from "../../src/reporting/reporting-metrics.engine";
import { WhatsappCampaignClassifierService } from "../../src/reporting/whatsapp-campaign-classifier.service";
import {
  META_PERMISSION_MESSAGE,
  META_RATE_LIMIT_MESSAGE,
  META_RECONNECT_MESSAGE,
  MetaCredentialInvalidError,
  metaGraphErrorFromPayload,
} from "../../src/integrations/meta/meta-graph-error";

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
    // Undefined keeps the service on process.env, as before.
    options.env as never,
    // nod: creativeThumbnails is the last (optional) constructor argument.
    options.creativeThumbnails as never,
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

describe("meta reporting service: persisted creative thumbnails (Fase 6.4)", () => {
  it("delegates creative thumbnails to the persisted service after a sync", async () => {
    const creativeThumbnails = {
      refreshCreatives: vi.fn(async () => ({})),
    };
    const { metaAdapter, service } = createHarness({ creativeThumbnails });

    await service.syncWorkspaceMetaStructure({
      workspaceId: "workspace_1",
      since: "2026-07-01",
      until: "2026-07-02",
    });

    expect(creativeThumbnails.refreshCreatives).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      accessToken: "EAAB-secret-token",
      creativeIds: ["creative_1"],
    });
    // The adapter no longer has a preview enrichment path to call per sync.
    expect(metaAdapter).not.toHaveProperty("getCreativeThumbnails");
  });

  it("adds the persisted thumbnail version and drops expired Meta CDN URLs on ad rows", async () => {
    const { db, prisma, service } = createHarness();
    const findMany = vi.fn(async () => [
      { creativeId: "creative_1", version: "abcdef0123456789" },
    ]);
    Object.assign(prisma, { metaCreativeThumbnail: { findMany } });

    await service.syncWorkspaceMetaStructure({
      workspaceId: "workspace_1",
      since: "2026-07-01",
      until: "2026-07-02",
    });
    const expiredOe = Math.floor(Date.UTC(2020, 0, 1) / 1000).toString(16);
    Object.assign(db.ads[0]!, {
      thumbnailUrl: `https://scontent.xx.fbcdn.net/v/t45/ad.jpg?stp=p64x64&oe=${expiredOe}`,
      previewUrl: "https://example.com/ad-1-high.jpg",
    });

    const report = await service.getAdReportOverview({
      workspaceId: "workspace_1",
      rangeLabel: "Ultimos 2 dias",
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_1",
        creativeId: { in: ["creative_1"] },
        status: "ready",
      },
      select: { creativeId: true, version: true },
    });
    expect(report.ads[0]).toMatchObject({
      id: "ad_1",
      thumbnailUrl: null,
      previewUrl: "https://example.com/ad-1-high.jpg",
      thumbnailVersion: "abcdef0123456789",
    });
  });
});

describe("meta reporting sync circuit breaker (reporting-only)", () => {
  const graphError = (
    code: number,
    message = "Meta rejected",
    extra: Record<string, unknown> = {},
  ) =>
    metaGraphErrorFromPayload(
      { error: { message, code, type: "OAuthException", ...extra } },
      400,
      "Meta Graph HTTP 400",
    );
  const deadToken = () =>
    graphError(190, "Error validating access token: session invalidated", {
      error_subcode: 460,
    });
  const twoLegacyAccounts = () => [
    {
      id: "reporting_1",
      workspaceId: "workspace_1",
      businessId: "business_1",
      businessName: "BM 1",
      adAccountId: "act_1",
      adAccountName: "Conta 1",
      active: true,
    },
    {
      id: "reporting_2",
      workspaceId: "workspace_1",
      businessId: "business_1",
      businessName: "BM 1",
      adAccountId: "act_2",
      adAccountName: "Conta 2",
      active: true,
    },
  ];
  const normalizedAccount = {
    ...twoLegacyAccounts()[0],
    businessConnectionId: "connection_1",
    conversionDestinationId: null,
    businessConnection: null,
    allowedDestinations: [],
  };

  function withBreakerMocks(
    prisma: Record<string, unknown>,
    metaAdapter: Record<string, unknown>,
    probe: () => Promise<void>,
  ) {
    const mocks = {
      blockUpdateMany: vi.fn(async () => ({ count: 1 })),
      metaIntegrationUpdateMany: vi.fn(async () => ({ count: 1 })),
      metaCredentialUpdateMany: vi.fn(async () => ({ count: 1 })),
      probeAccessToken: vi.fn(probe),
    };
    Object.assign(prisma.metaReportingAccount as object, {
      updateMany: mocks.blockUpdateMany,
    });
    Object.assign(prisma, {
      metaIntegration: {
        ...(prisma.metaIntegration as Record<string, unknown>),
        updateMany: mocks.metaIntegrationUpdateMany,
      },
      metaCredential: { updateMany: mocks.metaCredentialUpdateMany },
    });
    metaAdapter.probeAccessToken = mocks.probeAccessToken;

    return mocks;
  }

  function expectRoutingStateUntouched(
    prisma: { metaBusinessConnection: { updateMany: { mock: unknown } } },
    mocks: ReturnType<typeof withBreakerMocks>,
  ) {
    // CAPI/CTWA read credential/connection/integration status,
    // validationError and lastValidatedAt: the breaker never writes them.
    expect(mocks.metaIntegrationUpdateMany).not.toHaveBeenCalled();
    expect(mocks.metaCredentialUpdateMany).not.toHaveBeenCalled();
    const connectionWrites = (
      prisma.metaBusinessConnection.updateMany.mock as {
        calls: Array<[{ data: Record<string, unknown> }]>;
      }
    ).calls.map(([args]) => args.data);
    for (const data of connectionWrites) {
      expect(data).not.toHaveProperty("status");
      expect(data).not.toHaveProperty("lastValidatedAt");
    }
  }

  it("blocks reporting for every account of a legacy token only after /me confirms 190", async () => {
    const { service, prisma, metaAdapter } = createHarness();
    const mocks = withBreakerMocks(prisma as never, metaAdapter as never, () =>
      Promise.reject(deadToken()),
    );
    prisma.metaReportingAccount.findMany.mockResolvedValue(twoLegacyAccounts());
    metaAdapter.listCampaigns.mockRejectedValue(deadToken());

    const failure = await service
      .syncWorkspaceMetaStructure({
        workspaceId: "workspace_1",
        since: "2026-07-01",
        until: "2026-07-07",
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MetaCredentialInvalidError);
    expect(mocks.probeAccessToken).toHaveBeenCalledTimes(1);
    // The dead token is not reused for the second account.
    expect(metaAdapter.listCampaigns).toHaveBeenCalledTimes(1);
    expect(mocks.blockUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "reporting_1",
        workspaceId: "workspace_1",
        reportingSyncBlockedAt: null,
      },
      data: {
        reportingSyncBlockedAt: expect.any(Date),
        reportingSyncBlockReason: "meta_graph code=190 subcode=460 http=400",
        syncStatus: "error",
        syncError: META_RECONNECT_MESSAGE,
      },
    });
    expect(mocks.blockUpdateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_1",
        active: true,
        reportingSyncBlockedAt: null,
      },
      data: expect.objectContaining({
        reportingSyncBlockedAt: expect.any(Date),
        syncError: META_RECONNECT_MESSAGE,
      }),
    });
    expectRoutingStateUntouched(prisma as never, mocks);
  });

  it("blocks only the failing account when /me shows the token is alive", async () => {
    const { service, prisma, metaAdapter } = createHarness();
    const mocks = withBreakerMocks(prisma as never, metaAdapter as never, () =>
      Promise.resolve(),
    );
    prisma.metaReportingAccount.findMany.mockResolvedValue(twoLegacyAccounts());
    metaAdapter.listCampaigns.mockImplementation(async (input) => {
      if (input?.adAccountId === "act_1") {
        throw deadToken();
      }

      return [];
    });

    const result = await service.syncWorkspaceMetaStructure({
      workspaceId: "workspace_1",
      since: "2026-07-01",
      until: "2026-07-07",
    });

    expect(result).toMatchObject({ accountsSynced: 1, accountsFailed: 1 });
    expect(mocks.blockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.blockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "reporting_1" }),
      }),
    );
    expectRoutingStateUntouched(prisma as never, mocks);
  });

  it("caches the /me verdict per token", async () => {
    const { service, prisma, metaAdapter } = createHarness();
    const mocks = withBreakerMocks(prisma as never, metaAdapter as never, () =>
      Promise.resolve(),
    );
    metaAdapter.listCampaigns.mockRejectedValue(deadToken());
    const run = () =>
      service
        .syncWorkspaceMetaStructure({
          workspaceId: "workspace_1",
          since: "2026-07-01",
          until: "2026-07-07",
        })
        .catch(() => undefined);

    await run();
    await run();

    expect(mocks.probeAccessToken).toHaveBeenCalledTimes(1);
  });

  it("limits a permission error (200) to that ad account's reporting", async () => {
    const { service, prisma, metaAdapter } = createHarness();
    const mocks = withBreakerMocks(prisma as never, metaAdapter as never, () =>
      Promise.resolve(),
    );
    prisma.metaReportingAccount.findMany.mockResolvedValue(twoLegacyAccounts());
    metaAdapter.listCampaigns.mockImplementation(async (input) => {
      if (input?.adAccountId === "act_2") {
        throw graphError(200, "Ad account owner has NOT grant ads_read");
      }

      return [];
    });

    const result = await service.syncWorkspaceMetaStructure({
      workspaceId: "workspace_1",
      since: "2026-07-01",
      until: "2026-07-07",
    });

    expect(result).toMatchObject({ accountsSynced: 1, accountsFailed: 1 });
    expect(mocks.probeAccessToken).not.toHaveBeenCalled();
    expect(mocks.blockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.blockUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "reporting_2",
        workspaceId: "workspace_1",
        reportingSyncBlockedAt: null,
      },
      data: expect.objectContaining({ syncError: META_PERMISSION_MESSAGE }),
    });
    expectRoutingStateUntouched(prisma as never, mocks);
  });

  it("blocks every account sharing a normalized credential after a confirmed 190, without touching its status", async () => {
    const { service, prisma, metaAdapter } = createHarness();
    const mocks = withBreakerMocks(prisma as never, metaAdapter as never, () =>
      Promise.reject(deadToken()),
    );
    prisma.metaReportingAccount.findFirst.mockResolvedValue(normalizedAccount);
    metaAdapter.listCampaigns.mockRejectedValue(deadToken());

    await expect(
      service.syncWorkspaceMetaStructure({
        workspaceId: "workspace_1",
        businessConnectionId: "connection_1",
        reportingAccountId: "reporting_1",
        since: "2026-07-01",
        until: "2026-07-07",
      }),
    ).rejects.toBeInstanceOf(MetaCredentialInvalidError);

    expect(mocks.blockUpdateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_1",
        businessConnection: { is: { credentialId: "credential_1" } },
        reportingSyncBlockedAt: null,
      },
      data: expect.objectContaining({ syncError: META_RECONNECT_MESSAGE }),
    });
    expectRoutingStateUntouched(prisma as never, mocks);
  });

  it("limits a normalized permission error (10) to that account", async () => {
    const { service, prisma, metaAdapter } = createHarness();
    const mocks = withBreakerMocks(prisma as never, metaAdapter as never, () =>
      Promise.resolve(),
    );
    prisma.metaReportingAccount.findFirst.mockResolvedValue(normalizedAccount);
    metaAdapter.listCampaigns.mockRejectedValue(graphError(10));

    await expect(
      service.syncWorkspaceMetaStructure({
        workspaceId: "workspace_1",
        businessConnectionId: "connection_1",
        reportingAccountId: "reporting_1",
        since: "2026-07-01",
        until: "2026-07-07",
      }),
    ).rejects.toBeInstanceOf(MetaCredentialInvalidError);

    expect(mocks.blockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.blockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "reporting_1" }),
      }),
    );
    expectRoutingStateUntouched(prisma as never, mocks);
  });

  it("does not call Meta for a blocked reporting account", async () => {
    const { service, prisma, metaAdapter } = createHarness();
    prisma.metaReportingAccount.findFirst.mockResolvedValue({
      ...normalizedAccount,
      reportingSyncBlockedAt: new Date(),
      syncError: META_RECONNECT_MESSAGE,
    } as never);

    await expect(
      service.syncWorkspaceMetaStructure({
        workspaceId: "workspace_1",
        businessConnectionId: "connection_1",
        reportingAccountId: "reporting_1",
        since: "2026-07-01",
        until: "2026-07-07",
      }),
    ).rejects.toBeInstanceOf(MetaCredentialInvalidError);
    expect(metaAdapter.listCampaigns).not.toHaveBeenCalled();
  });

  it("rethrows Meta throttling so the job is delayed instead of failed", async () => {
    const { service, prisma, metaAdapter } = createHarness();
    const mocks = withBreakerMocks(prisma as never, metaAdapter as never, () =>
      Promise.resolve(),
    );
    metaAdapter.listCampaigns.mockRejectedValue(
      graphError(17, "User request limit reached"),
    );

    await expect(
      service.syncWorkspaceMetaStructure({
        workspaceId: "workspace_1",
        since: "2026-07-01",
        until: "2026-07-07",
      }),
    ).rejects.toMatchObject({ details: expect.objectContaining({ code: 17 }) });
    expect(mocks.blockUpdateMany).not.toHaveBeenCalled();
    expect(prisma.metaReportingAccount.update).toHaveBeenCalledWith({
      where: { id: "reporting_1" },
      data: { syncStatus: "pending", syncError: META_RATE_LIMIT_MESSAGE },
    });
  });

  // nod (revisão da 6.4): um limite de taxa numa conta seguinte não pode
  // descartar o bloqueio já detectado numa conta anterior do mesmo job.
  it("keeps an account blocked when a later account hits a Meta rate limit", async () => {
    const { service, prisma, metaAdapter } = createHarness();
    const mocks = withBreakerMocks(prisma as never, metaAdapter as never, () =>
      Promise.resolve(),
    );
    prisma.metaReportingAccount.findMany.mockResolvedValue(twoLegacyAccounts());
    metaAdapter.listCampaigns.mockImplementation(async (input) => {
      if (input?.adAccountId === "act_2") {
        throw graphError(17, "User request limit reached");
      }

      throw graphError(200, "Ad account owner has NOT grant ads_read");
    });

    await expect(
      service.syncWorkspaceMetaStructure({
        workspaceId: "workspace_1",
        since: "2026-07-01",
        until: "2026-07-07",
      }),
    ).rejects.toMatchObject({ details: expect.objectContaining({ code: 17 }) });
    expect(mocks.blockUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "reporting_1",
        workspaceId: "workspace_1",
        reportingSyncBlockedAt: null,
      },
      data: expect.objectContaining({ syncError: META_PERMISSION_MESSAGE }),
    });
    expectRoutingStateUntouched(prisma as never, mocks);
  });
});

describe("meta reporting insights call reduction", () => {
  const legacyConversation =
    "onsite_conversion.messaging_conversation_started_7d";
  const adRow = (
    adId: string,
    date: string | null,
    spendCents: number,
    conversations: number,
  ) => ({
    adId,
    adSetId: "adset_1",
    campaignId: "cmp_1",
    date,
    spendCents,
    impressions: spendCents / 10,
    clicks: spendCents / 100,
    actionValues: { [legacyConversation]: conversations },
  });

  it("ad_level mode reads only ad rows and aggregates campaign and ad set totals locally, including deleted ads", async () => {
    vi.stubEnv("META_INSIGHTS_LEVEL_MODE", "ad_level");
    try {
      const { db, metaAdapter, service } = createHarness();
      // ad_deleted is no longer listed by /ads but still spent in the window.
      metaAdapter.listAdInsightRows.mockImplementation(async (input) =>
        input.daily
          ? [
              adRow("ad_1", "2026-07-01", 17500, 22),
              adRow("ad_deleted", "2026-07-01", 52500, 78),
              adRow("ad_1", "2026-07-02", 12500, 18),
              adRow("ad_deleted", "2026-07-02", 37500, 58),
            ]
          : [
              adRow("ad_1", null, 30000, 40),
              adRow("ad_deleted", null, 90000, 136),
            ],
      );

      await service.syncWorkspaceMetaStructure({
        workspaceId: "workspace_1",
        since: "2026-07-01",
        until: "2026-07-02",
      });

      expect(metaAdapter.listCampaignInsights).not.toHaveBeenCalled();
      expect(metaAdapter.listCampaignDailyInsights).not.toHaveBeenCalled();
      expect(metaAdapter.listAdSetInsights).not.toHaveBeenCalled();
      expect(metaAdapter.listAdSetDailyInsights).not.toHaveBeenCalled();
      expect(metaAdapter.listAdInsights).not.toHaveBeenCalled();
      expect(metaAdapter.listAdDailyInsights).not.toHaveBeenCalled();
      expect(metaAdapter.listAdInsightRows).toHaveBeenCalledTimes(2);
      expect(db.campaigns.at(-1)).toMatchObject({
        campaignId: "cmp_1",
        spendCents: 120000,
        impressions: 12000,
        clicks: 1200,
        metaConversationsStarted: 176,
      });
      expect(db.adSets.at(-1)).toMatchObject({
        adSetId: "adset_1",
        spendCents: 120000,
        metaConversationsStarted: 176,
      });
      expect(db.ads.at(-1)).toMatchObject({
        adId: "ad_1",
        spendCents: 30000,
        metaConversationsStarted: 40,
      });
      expect(
        db.dailyInsights.map((row) => [
          row.localDate,
          row.spendCents,
          row.metaConversationsStarted,
        ]),
      ).toEqual([
        ["2026-07-01", 70000, 100],
        ["2026-07-02", 50000, 76],
      ]);
      // Only listed ads get ad daily rows; deleted ones only count in totals.
      expect(db.adDailyInsights.map((row) => row.adId)).toEqual([
        "ad_1",
        "ad_1",
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("ad_level manual recovery re-reads only the ad level one day at a time", async () => {
    vi.stubEnv("META_INSIGHTS_LEVEL_MODE", "ad_level");
    try {
      const { db, metaAdapter, prisma, service } = createHarness();
      prisma.metaReportingAccount.findFirst.mockResolvedValue({
        id: "reporting_1",
        workspaceId: "workspace_1",
        businessId: "business_1",
        businessName: "BM 1",
        adAccountId: "act_123",
        adAccountName: "Conta 1",
        businessConnectionId: "connection_1",
        conversionDestinationId: null,
        businessConnection: null,
        allowedDestinations: [],
        active: true,
      });
      metaAdapter.listAdInsightRows.mockImplementation(async (input) => {
        if (input.daily) {
          return []; // Meta dropped the daily rows: diverges from the total.
        }

        if (input.since === "2026-07-01" && input.until === "2026-07-01") {
          return [adRow("ad_1", null, 17500, 22)];
        }

        if (input.since === "2026-07-02" && input.until === "2026-07-02") {
          return [adRow("ad_1", null, 12500, 18)];
        }

        return [adRow("ad_1", null, 30000, 40)];
      });

      await service.syncWorkspaceMetaStructure({
        workspaceId: "workspace_1",
        businessConnectionId: "connection_1",
        reportingAccountId: "reporting_1",
        since: "2026-07-01",
        until: "2026-07-02",
      });

      // 1 aggregate + 1 daily + 2 per-day recoveries (was 3 levels x 2 days).
      expect(metaAdapter.listAdInsightRows).toHaveBeenCalledTimes(4);
      expect(
        db.dailyInsights.map((row) => [row.localDate, row.spendCents]),
      ).toEqual([
        ["2026-07-01", 17500],
        ["2026-07-02", 12500],
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  function incrementalHarness() {
    const harness = createHarness();
    const { metaAdapter } = harness;
    const since = (input: unknown) =>
      String((input as { since?: string }).since ?? "");
    const campaignDaily = [
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
    ];
    // Matches the harness window totals: ad set 60000/80, ad 30000/40.
    const adSetDaily = campaignDaily.map((row, index) => ({
      ...row,
      adSetId: "adset_1",
      spendCents: row.spendCents / 2,
      metaConversationsStarted: [45, 35][index],
    }));
    const adDaily = campaignDaily.map((row, index) => ({
      ...row,
      adSetId: "adset_1",
      adId: "ad_1",
      spendCents: row.spendCents / 4,
      metaConversationsStarted: [22, 18][index],
    }));
    metaAdapter.listCampaignDailyInsights.mockImplementation((async (
      input: unknown,
    ) =>
      campaignDaily.filter((row) => row.date >= since(input))) as never);
    metaAdapter.listAdSetDailyInsights.mockImplementation((async (
      input: unknown,
    ) => adSetDaily.filter((row) => row.date >= since(input))) as never);
    metaAdapter.listAdDailyInsights.mockImplementation((async (
      input: unknown,
    ) => adDaily.filter((row) => row.date >= since(input))) as never);

    return harness;
  }

  const storedRow = (extra: Record<string, unknown>) => ({
    workspaceId: "workspace_1",
    adAccountId: "act_123",
    localDate: "2026-07-01",
    syncedAt: "stored",
    ...extra,
  });

  it("incremental sync refreshes only the recent days when stored days add up to the Meta totals", async () => {
    const { db, metaAdapter, service } = incrementalHarness();
    db.dailyInsights.push(
      storedRow({
        campaignId: "cmp_1",
        spendCents: 70000,
        metaConversationsStarted: 100,
      }),
    );
    db.adSetDailyInsights.push(
      storedRow({
        adSetId: "adset_1",
        campaignId: "cmp_1",
        spendCents: 35000,
        metaConversationsStarted: 45,
      }),
    );
    db.adDailyInsights.push(
      storedRow({
        adId: "ad_1",
        adSetId: "adset_1",
        campaignId: "cmp_1",
        spendCents: 17500,
        metaConversationsStarted: 22,
      }),
    );

    await service.syncWorkspaceMetaStructure({
      workspaceId: "workspace_1",
      since: "2026-07-02",
      until: "2026-07-02",
      totalsSince: "2026-07-01",
    });

    expect(metaAdapter.listCampaignInsights).toHaveBeenCalledWith(
      expect.objectContaining({ since: "2026-07-01", until: "2026-07-02" }),
    );
    expect(metaAdapter.listCampaignDailyInsights).toHaveBeenCalledTimes(1);
    expect(metaAdapter.listCampaignDailyInsights).toHaveBeenCalledWith(
      expect.objectContaining({ since: "2026-07-02", until: "2026-07-02" }),
    );
    // Entity totals still cover the full lookback window.
    expect(db.campaigns.at(-1)).toMatchObject({ spendCents: 120000 });
    // The older stored day is untouched; only 07-02 was replaced.
    expect(
      db.dailyInsights.map((row) => [
        row.localDate,
        row.spendCents,
        row.syncedAt === "stored" ? "stored" : "fresh",
      ]),
    ).toEqual([
      ["2026-07-01", 70000, "stored"],
      ["2026-07-02", 50000, "fresh"],
    ]);
  });

  it("incremental sync reads the full window when conversations were attributed late to D-5", async () => {
    const { db, metaAdapter, service } = incrementalHarness();
    // Window D-5..D = 2026-06-27..2026-07-02; only 07-01..07-02 are fresh.
    // Spend still adds up, but Meta now credits 3 more conversations to
    // 06-27 than the stored row (0) holds.
    db.dailyInsights.push(
      storedRow({
        campaignId: "cmp_1",
        localDate: "2026-06-27",
        spendCents: 0,
        metaConversationsStarted: 0,
      }),
    );
    metaAdapter.listCampaignInsights.mockResolvedValue([
      {
        campaignId: "cmp_1",
        spendCents: 120000,
        impressions: 10000,
        clicks: 420,
        metaConversationsStarted: 179,
      },
    ]);

    await service.syncWorkspaceMetaStructure({
      workspaceId: "workspace_1",
      since: "2026-07-01",
      until: "2026-07-02",
      totalsSince: "2026-06-27",
    });

    expect(metaAdapter.listCampaignDailyInsights).toHaveBeenCalledTimes(2);
    expect(metaAdapter.listCampaignDailyInsights).toHaveBeenLastCalledWith(
      expect.objectContaining({ since: "2026-06-27", until: "2026-07-02" }),
    );
    expect(db.campaigns.at(-1)).toMatchObject({
      metaConversationsStarted: 179,
    });
  });

  it("incremental sync falls back to the full daily window when stored days do not add up", async () => {
    const { db, metaAdapter, service } = incrementalHarness();

    await service.syncWorkspaceMetaStructure({
      workspaceId: "workspace_1",
      since: "2026-07-02",
      until: "2026-07-02",
      totalsSince: "2026-07-01",
    });

    expect(metaAdapter.listCampaignDailyInsights).toHaveBeenCalledTimes(2);
    expect(metaAdapter.listCampaignDailyInsights).toHaveBeenLastCalledWith(
      expect.objectContaining({ since: "2026-07-01", until: "2026-07-02" }),
    );
    expect(
      db.dailyInsights.map((row) => [row.localDate, row.spendCents]),
    ).toEqual([
      ["2026-07-01", 70000],
      ["2026-07-02", 50000],
    ]);
  });
});
