import { describe, expect, it } from "vitest";
import type { PrismaService } from "../../src/common/prisma/prisma.service";
import {
  computeOrphanRoutes,
  diagnoseNormalizedRoute,
  simulateRouteChange,
} from "../../src/integrations/meta/meta-orphan-routes";
import { MetaManualConnectionsService } from "../../src/integrations/meta/meta-manual-connections.service";

type Scenario = {
  routingEnabled: boolean;
  /** Leads of the last 7 days, one entry per group. */
  leads?: Array<{ adId: string | null; campaignId: string | null; n: number }>;
  blockedEvents?: Array<{ adId: string; n: number }>;
  accounts?: Array<{
    id: string;
    adAccountId: string;
    adAccountName: string;
    active: boolean;
    businessConnectionId: string | null;
    conversionDestinationId: string | null;
  }>;
  connectionStatus?: string;
  destinationStatus?: string;
  connectionDefaultDestination?: string | null;
  legacyPixel?: string | null;
};

function fakePrisma(scenario: Scenario) {
  const leads = scenario.leads ?? [
    { adId: "ad_old", campaignId: "camp_old", n: 5 },
  ];

  return {
    lead: {
      groupBy: async () =>
        leads.map((group) => ({
          adId: group.adId,
          campaignId: group.campaignId,
          _count: { _all: group.n },
        })),
    },
    conversionEventLog: {
      groupBy: async () =>
        (scenario.blockedEvents ?? []).map((event) => ({
          metaAccountId: null,
          adId: event.adId,
          campaignId: null,
          _count: { _all: event.n },
        })),
    },
    metaAd: {
      findMany: async () => [
        { adId: "ad_old", adAccountId: "act_old", campaignId: "camp_old" },
        { adId: "ad_new", adAccountId: "act_new", campaignId: "camp_new" },
      ],
    },
    metaCampaign: {
      findMany: async () => [
        { campaignId: "camp_old", adAccountId: "act_old", name: "Campanha Antiga" },
        { campaignId: "camp_new", adAccountId: "act_new", name: "Campanha Nova" },
      ],
    },
    metaIntegration: {
      findUnique: async () => ({
        advancedRoutingEnabled: scenario.routingEnabled,
        selectedPixelId:
          scenario.legacyPixel === undefined ? "pixel_legacy" : scenario.legacyPixel,
        primaryConversionDestinationId: null,
      }),
    },
    metaBusinessConnection: {
      count: async () => 1,
      findMany: async () => [
        {
          id: "conn_1",
          status: scenario.connectionStatus ?? "active",
          defaultConversionDestinationId:
            scenario.connectionDefaultDestination === undefined
              ? "dest_1"
              : scenario.connectionDefaultDestination,
          credential: { status: "active" },
        },
      ],
    },
    metaConversionDestination: {
      findMany: async () => [
        { id: "dest_1", status: scenario.destinationStatus ?? "configured" },
      ],
    },
    metaReportingAccount: {
      findMany: async () =>
        scenario.accounts ?? [
          {
            id: "ra_old",
            adAccountId: "act_old",
            adAccountName: "Conta Antiga",
            active: false,
            businessConnectionId: "conn_1",
            conversionDestinationId: null,
          },
          {
            id: "ra_new",
            adAccountId: "act_new",
            adAccountName: "Conta Nova",
            active: true,
            businessConnectionId: "conn_1",
            conversionDestinationId: null,
          },
        ],
    },
  } as unknown as PrismaService;
}

const NOW = new Date("2026-11-24T12:00:00Z");

describe("meta orphan routes", () => {
  it("warns when routing is on and the account with leads is inactive", async () => {
    const result = await computeOrphanRoutes(
      fakePrisma({ routingEnabled: true }),
      "ws",
      {},
      NOW,
    );

    expect(result.accounts).toEqual([
      {
        adAccountId: "act_old",
        adAccountName: "Conta Antiga",
        reason: "account_inactive",
        leadCount: 5,
        blockedEventCount: 0,
        campaignNames: ["Campanha Antiga"],
        campaignCount: 1,
      },
    ]);
  });

  const legacyAccount = {
    id: "ra_old",
    adAccountId: "act_old",
    adAccountName: "Conta Antiga",
    active: true,
    businessConnectionId: null,
    conversionDestinationId: null,
  };

  it("does not warn when routing is off and the legacy route works", async () => {
    const result = await computeOrphanRoutes(
      fakePrisma({ routingEnabled: false, accounts: [legacyAccount] }),
      "ws",
      {},
      NOW,
    );

    expect(result.accounts).toEqual([]);
  });

  it("warns on routing off only when the legacy route itself is unconfigured", async () => {
    const result = await computeOrphanRoutes(
      fakePrisma({
        routingEnabled: false,
        accounts: [legacyAccount],
        legacyPixel: null,
      }),
      "ws",
      {},
      NOW,
    );

    expect(result.accounts[0]?.reason).toBe("legacy_unconfigured");
  });

  it("nod: an inactive account blocks even with routing off", async () => {
    const result = await computeOrphanRoutes(
      fakePrisma({
        routingEnabled: false,
        accounts: [{ ...legacyAccount, active: false }],
      }),
      "ws",
      {},
      NOW,
    );

    expect(result.accounts[0]?.reason).toBe("account_inactive");
  });

  it("nod: an account linked to a BM uses the BM route with routing off", async () => {
    const result = await computeOrphanRoutes(
      fakePrisma({
        routingEnabled: false,
        accounts: [{ ...legacyAccount, businessConnectionId: "conn_1" }],
        connectionDefaultDestination: null,
      }),
      "ws",
      {},
      NOW,
    );

    expect(result.accounts[0]?.reason).toBe("no_destination");
  });

  it("does not warn for an active account with a configured destination", async () => {
    const result = await computeOrphanRoutes(
      fakePrisma({
        routingEnabled: true,
        leads: [{ adId: "ad_new", campaignId: "camp_new", n: 3 }],
      }),
      "ws",
      {},
      NOW,
    );

    expect(result.accounts).toEqual([]);
  });

  it("does not warn without recent leads or blocked events", async () => {
    const result = await computeOrphanRoutes(
      fakePrisma({ routingEnabled: true, leads: [] }),
      "ws",
      {},
      NOW,
    );

    expect(result).toEqual({ accounts: [], blockedEventCount: 0 });
  });

  it("flags an active account without destination and counts blocked events", async () => {
    const result = await computeOrphanRoutes(
      fakePrisma({
        routingEnabled: true,
        leads: [{ adId: "ad_new", campaignId: "camp_new", n: 2 }],
        blockedEvents: [{ adId: "ad_new", n: 4 }],
        connectionDefaultDestination: null,
      }),
      "ws",
      {},
      NOW,
    );

    expect(result.accounts[0]).toMatchObject({
      adAccountId: "act_new",
      reason: "no_destination",
      leadCount: 2,
      blockedEventCount: 4,
    });
    expect(result.blockedEventCount).toBe(4);
  });

  it("limits to 3 campaign names, busiest first, and counts them all", async () => {
    const prisma = fakePrisma({
      routingEnabled: true,
      leads: [{ adId: "ad_old", campaignId: "camp_old", n: 1 }],
    });
    (prisma as unknown as { metaCampaign: { findMany: unknown } }).metaCampaign.findMany =
      async () =>
        ["a", "b", "c", "d"].map((id, index) => ({
          campaignId: `camp_${id}`,
          adAccountId: "act_old",
          name: `Campanha ${id}`,
          index,
        }));
    (prisma as unknown as { lead: { groupBy: unknown } }).lead.groupBy =
      async () =>
        ["a", "b", "c", "d"].map((id, index) => ({
          adId: null,
          campaignId: `camp_${id}`,
          _count: { _all: index + 1 },
        }));

    const result = await computeOrphanRoutes(prisma, "ws", {}, NOW);

    expect(result.accounts[0]?.campaignNames).toEqual([
      "Campanha d",
      "Campanha c",
      "Campanha b",
    ]);
    expect(result.accounts[0]?.campaignCount).toBe(4);
    expect(result.accounts[0]?.leadCount).toBe(10);
  });

  it("diagnoses each failing step like the CAPI resolver", () => {
    const destinations = new Set(["dest_1"]);
    const connection = {
      status: "active",
      credentialStatus: "active",
      defaultConversionDestinationId: "dest_1",
    };
    const account = {
      active: true,
      businessConnectionId: "conn_1",
      conversionDestinationId: null,
    };

    expect(
      diagnoseNormalizedRoute({
        account: null,
        connection,
        configuredDestinationIds: destinations,
      }),
    ).toBe("account_unknown");
    expect(
      diagnoseNormalizedRoute({
        account: { ...account, businessConnectionId: null },
        connection: null,
        configuredDestinationIds: destinations,
      }),
    ).toBe("no_connection");
    expect(
      diagnoseNormalizedRoute({
        account,
        connection: { ...connection, status: "paused" },
        configuredDestinationIds: destinations,
      }),
    ).toBe("connection_paused");
    expect(
      diagnoseNormalizedRoute({
        account,
        connection: { ...connection, defaultConversionDestinationId: "dest_x" },
        configuredDestinationIds: destinations,
      }),
    ).toBe("destination_not_configured");
    expect(
      diagnoseNormalizedRoute({
        account,
        connection,
        configuredDestinationIds: destinations,
      }),
    ).toBeNull();
  });
});

type Override = Record<string, unknown>;
function patchPrisma(prisma: PrismaService, patch: Override) {
  Object.assign(prisma as unknown as Override, patch);
}

describe("meta orphan routes: unattributed traffic and ad destinations", () => {
  const singleActive = [
    {
      id: "ra_only",
      adAccountId: "act_only",
      adAccountName: "Conta Unica",
      active: true,
      businessConnectionId: "conn_1",
      conversionDestinationId: null,
    },
  ];
  const unattributedLeads = [{ adId: null, campaignId: "camp_ghost", n: 9 }];

  it("deactivating the only active account blocks leads with no resolvable account", async () => {
    const prisma = fakePrisma({
      routingEnabled: true,
      accounts: singleActive,
      leads: unattributedLeads,
    });
    const before = await computeOrphanRoutes(prisma, "ws", {}, NOW);
    const blocked = await simulateRouteChange(
      prisma,
      "ws",
      { deactivateReportingAccountId: "ra_only" },
      NOW,
    );

    expect(before.accounts).toEqual([]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      adAccountId: "unattributed",
      leadCount: 9,
      reason: "account_inactive",
    });
  });

  it("flags unattributed leads when more than one account is active", async () => {
    const two = [
      ...singleActive,
      { ...singleActive[0]!, id: "ra_two", adAccountId: "act_two" },
    ];
    const result = await computeOrphanRoutes(
      fakePrisma({
        routingEnabled: true,
        accounts: two,
        leads: unattributedLeads,
      }),
      "ws",
      {},
      NOW,
    );

    expect(result.accounts[0]).toMatchObject({
      adAccountId: "unattributed",
      leadCount: 9,
    });
  });

  it("does not flag an account without default when every ad has a configured destination", async () => {
    const prisma = fakePrisma({
      routingEnabled: true,
      connectionDefaultDestination: null,
      leads: [{ adId: "ad_new", campaignId: "camp_new", n: 4 }],
    });
    patchPrisma(prisma, {
      metaAd: {
        findMany: async () => [
          {
            adId: "ad_new",
            adAccountId: "act_new",
            campaignId: "camp_new",
            destinationAssignment: {
              reportingAccountId: "ra_new",
              conversionDestinationId: "dest_1",
            },
          },
        ],
      },
    });

    const result = await computeOrphanRoutes(prisma, "ws", {}, NOW);

    expect(result.accounts).toEqual([]);
  });

  it("flags an ad assigned to a destination that is not configured", async () => {
    const prisma = fakePrisma({
      routingEnabled: true,
      leads: [{ adId: "ad_new", campaignId: "camp_new", n: 4 }],
    });
    patchPrisma(prisma, {
      metaAd: {
        findMany: async () => [
          {
            adId: "ad_new",
            adAccountId: "act_new",
            campaignId: "camp_new",
            destinationAssignment: {
              reportingAccountId: "ra_new",
              conversionDestinationId: "dest_broken",
            },
          },
        ],
      },
    });

    const result = await computeOrphanRoutes(prisma, "ws", {}, NOW);

    expect(result.accounts[0]).toMatchObject({
      adAccountId: "act_new",
      reason: "destination_not_configured",
      leadCount: 4,
    });
  });

  it("ignores an assignment that belongs to another reporting account", async () => {
    const prisma = fakePrisma({
      routingEnabled: true,
      connectionDefaultDestination: null,
      leads: [{ adId: "ad_new", campaignId: "camp_new", n: 4 }],
    });
    patchPrisma(prisma, {
      metaAd: {
        findMany: async () => [
          {
            adId: "ad_new",
            adAccountId: "act_new",
            campaignId: "camp_new",
            destinationAssignment: {
              reportingAccountId: "ra_other",
              conversionDestinationId: "dest_1",
            },
          },
        ],
      },
    });

    const result = await computeOrphanRoutes(prisma, "ws", {}, NOW);

    expect(result.accounts[0]?.reason).toBe("no_destination");
  });
});

describe("meta route simulation", () => {
  const leads = [{ adId: "ad_new", campaignId: "camp_new", n: 7 }];

  it("deactivation with routing on blocks the account", async () => {
    const blocked = await simulateRouteChange(
      fakePrisma({ routingEnabled: true, leads }),
      "ws",
      { deactivateReportingAccountId: "ra_new" },
      NOW,
    );

    expect(blocked[0]).toMatchObject({
      adAccountId: "act_new",
      reason: "account_inactive",
      leadCount: 7,
    });
  });

  it("nod: deactivation with routing off blocks too", async () => {
    const blocked = await simulateRouteChange(
      fakePrisma({ routingEnabled: false, leads }),
      "ws",
      { deactivateReportingAccountId: "ra_new" },
      NOW,
    );

    expect(blocked.map((account) => account.adAccountId)).toEqual(["act_new"]);
  });

  it("does not repeat accounts that are already blocked", async () => {
    const blocked = await simulateRouteChange(
      fakePrisma({ routingEnabled: true }),
      "ws",
      { deactivateReportingAccountId: "ra_old" },
      NOW,
    );

    expect(blocked).toEqual([]);
  });

  it("service wraps the simulation and 404s unknown accounts", async () => {
    const prisma = fakePrisma({ routingEnabled: false });
    (prisma as unknown as { metaReportingAccount: { findFirst: unknown } }).metaReportingAccount.findFirst =
      async ({ where }: { where: { id: string } }) =>
        where.id === "ra_old" ? { id: "ra_old" } : null;
    const service = new MetaManualConnectionsService(
      prisma,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.simulateReportingAccountDeactivation("ws", "nope"),
    ).rejects.toThrow("Conta Meta não encontrada");
    const off = await service.simulateReportingAccountDeactivation("ws", "ra_old");
    expect(off.blockedAccounts).toEqual([]);
  });
});
