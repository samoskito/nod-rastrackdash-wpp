import type {
  MetaOrphanRouteAccountDto,
  MetaOrphanRouteReasonDto,
  MetaOrphanRoutesDto,
} from "@wpptrack/shared";
import type { PrismaService } from "../../common/prisma/prisma.service";

/**
 * Dry run of the Meta CAPI route (no token is read or decrypted). It mirrors
 * the account/connection/destination checks of
 * MetaConnectionResolverService.resolveCapiRoute so the owner can be warned
 * before a lead is blocked. Keep both in sync when the routing rules change.
 */

export const ORPHAN_ROUTE_WINDOW_DAYS = 7;

export type RouteDryRunAccount = {
  active: boolean;
  businessConnectionId: string | null;
  conversionDestinationId: string | null;
};

export type RouteDryRunConnection = {
  status: string;
  credentialStatus: string;
  defaultConversionDestinationId: string | null;
};

/** Reporting sync switch of the resolver: needs a BM and, by default, is on. */
export async function isNormalizedRoutingEnabledFor(
  prisma: Pick<PrismaService, "metaBusinessConnection" | "metaIntegration">,
  workspaceId: string,
): Promise<boolean> {
  const [normalizedConnections, legacy] = await Promise.all([
    prisma.metaBusinessConnection.count({ where: { workspaceId } }),
    prisma.metaIntegration.findUnique({
      where: { workspaceId },
      select: { advancedRoutingEnabled: true },
    }),
  ]);

  if (normalizedConnections === 0) {
    return false;
  }

  return legacy ? legacy.advancedRoutingEnabled : true;
}

export function diagnoseNormalizedRoute(input: {
  account: RouteDryRunAccount | null;
  connection: RouteDryRunConnection | null;
  configuredDestinationIds: ReadonlySet<string>;
  /** Destination assigned to the ad (only valid for this very account). */
  adDestinationId?: string | null;
}): MetaOrphanRouteReasonDto | null {
  const { account, connection } = input;

  if (!account) return "account_unknown";
  if (!account.active) return "account_inactive";
  if (!account.businessConnectionId || !connection) return "no_connection";
  if (
    connection.status !== "active" ||
    connection.credentialStatus !== "active"
  ) {
    return "connection_paused";
  }

  // Same order as resolveCapiRoute: ad assignment, account, connection default.
  const destinationId =
    input.adDestinationId ??
    account.conversionDestinationId ??
    connection.defaultConversionDestinationId;

  if (!destinationId) return "no_destination";
  if (!input.configuredDestinationIds.has(destinationId)) {
    return "destination_not_configured";
  }

  return null;
}

export type RouteDryRunOverrides = {
  deactivateReportingAccountId?: string;
};

const normalizeAct = (id: string) => id.replace(/^act_/i, "");

export const UNATTRIBUTED_AD_ACCOUNT_ID = "unattributed";

type Bucket = {
  /** Normalized ad account id, or UNATTRIBUTED_AD_ACCOUNT_ID. */
  accountKey: string;
  adDestinationId: string | null;
  leads: number;
  events: number;
  campaigns: Map<string, { name: string; leads: number }>;
};

export async function computeOrphanRoutes(
  prisma: PrismaService,
  workspaceId: string,
  overrides: RouteDryRunOverrides = {},
  now = new Date(),
): Promise<MetaOrphanRoutesDto> {
  const since = new Date(
    now.getTime() - ORPHAN_ROUTE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const [leadGroups, eventGroups] = await Promise.all([
    prisma.lead.groupBy({
      by: ["adId", "campaignId"],
      where: {
        workspaceId,
        createdAt: { gte: since },
        OR: [{ adId: { not: null } }, { campaignId: { not: null } }],
      },
      _count: { _all: true },
    }),
    prisma.conversionEventLog.groupBy({
      by: ["metaAccountId", "adId", "campaignId"],
      where: {
        workspaceId,
        status: "not_configured",
        errorCode: "MissingMetaDestination",
        createdAt: { gte: since },
      },
      _count: { _all: true },
    }),
  ]);

  if (leadGroups.length === 0 && eventGroups.length === 0) {
    return { accounts: [], blockedEventCount: 0 };
  }

  const adIds = new Set<string>();
  const campaignIds = new Set<string>();
  for (const group of [...leadGroups, ...eventGroups]) {
    if (group.adId) adIds.add(group.adId);
    if (group.campaignId) campaignIds.add(group.campaignId);
  }
  const ads = adIds.size
    ? await prisma.metaAd.findMany({
        where: { workspaceId, adId: { in: [...adIds] } },
        select: {
          adId: true,
          adAccountId: true,
          campaignId: true,
          destinationAssignment: {
            select: { reportingAccountId: true, conversionDestinationId: true },
          },
        },
      })
    : [];
  const adById = new Map(ads.map((ad) => [ad.adId, ad]));
  for (const ad of ads) campaignIds.add(ad.campaignId);
  const campaigns = campaignIds.size
    ? await prisma.metaCampaign.findMany({
        where: { workspaceId, campaignId: { in: [...campaignIds] } },
        select: { campaignId: true, adAccountId: true, name: true },
      })
    : [];
  const campaignById = new Map(
    campaigns.map((campaign) => [campaign.campaignId, campaign]),
  );

  const [legacy, reportingAccounts, connections, destinations] =
    await Promise.all([
      prisma.metaIntegration.findUnique({
        where: { workspaceId },
        select: {
          advancedRoutingEnabled: true,
          selectedPixelId: true,
          primaryConversionDestinationId: true,
        },
      }),
      prisma.metaReportingAccount.findMany({
        where: { workspaceId },
        select: {
          id: true,
          adAccountId: true,
          adAccountName: true,
          active: true,
          businessConnectionId: true,
          conversionDestinationId: true,
        },
      }),
      prisma.metaBusinessConnection.findMany({
        where: { workspaceId },
        select: {
          id: true,
          status: true,
          defaultConversionDestinationId: true,
          credential: { select: { status: true } },
        },
      }),
      prisma.metaConversionDestination.findMany({
        where: { workspaceId },
        select: { id: true, status: true },
      }),
    ]);
  // Same flag as resolveCapiRoute (nod): the saved switch, or no integration.
  const routingEnabled = !legacy || legacy.advancedRoutingEnabled;
  const accountByAdAccount = new Map(
    reportingAccounts.map((account) => [
      normalizeAct(account.adAccountId),
      account,
    ]),
  );

  // Same attribution order as the resolver: the ad's account, then the
  // campaign's. Traffic with no account falls to the "only account" rule.
  const buckets = new Map<string, Bucket>();
  const attribute = (
    group: {
      adId: string | null;
      campaignId: string | null;
      metaAccountId?: string | null;
    },
    count: number,
    kind: "leads" | "events",
  ) => {
    const ad = group.adId ? adById.get(group.adId) : undefined;
    const campaignId = group.campaignId ?? ad?.campaignId ?? null;
    const campaign = campaignId ? campaignById.get(campaignId) : undefined;
    const rawAccountId =
      group.metaAccountId?.trim() || ad?.adAccountId || campaign?.adAccountId;
    const accountKey = rawAccountId
      ? normalizeAct(rawAccountId)
      : UNATTRIBUTED_AD_ACCOUNT_ID;
    const assignment = ad?.destinationAssignment;
    const accountRow = accountByAdAccount.get(accountKey);
    const adDestinationId =
      assignment && accountRow && assignment.reportingAccountId === accountRow.id
        ? assignment.conversionDestinationId
        : null;
    const key = `${accountKey}|${adDestinationId ?? ""}`;
    const bucket = buckets.get(key) ?? {
      accountKey,
      adDestinationId,
      leads: 0,
      events: 0,
      campaigns: new Map(),
    };
    bucket[kind] += count;

    if (kind === "leads" && campaignId && campaign) {
      const current = bucket.campaigns.get(campaignId);
      bucket.campaigns.set(campaignId, {
        name: campaign.name,
        leads: (current?.leads ?? 0) + count,
      });
    }

    buckets.set(key, bucket);
  };

  for (const group of leadGroups) attribute(group, group._count._all, "leads");
  for (const group of eventGroups) {
    attribute(group, group._count._all, "events");
  }

  const configuredDestinationIds = new Set(
    destinations
      .filter((destination) => destination.status === "configured")
      .map((destination) => destination.id),
  );
  const connectionById = new Map(
    connections.map((connection) => [
      connection.id,
      {
        status: connection.status as string,
        credentialStatus: connection.credential.status as string,
        defaultConversionDestinationId:
          connection.defaultConversionDestinationId,
      } satisfies RouteDryRunConnection,
    ]),
  );
  const toDryRunAccount = (
    account: (typeof reportingAccounts)[number],
  ): RouteDryRunAccount => ({
    active:
      account.active && account.id !== overrides.deactivateReportingAccountId,
    businessConnectionId: account.businessConnectionId,
    conversionDestinationId: account.conversionDestinationId,
  });
  // resolveCapiRoute fallback: exactly one account with a BM, active or not
  // (an inactive one blocks).
  const bmAccounts = reportingAccounts.filter(
    (account) => account.businessConnectionId,
  );
  const onlyAccount = bmAccounts.length === 1 ? bmAccounts[0] : null;
  const legacyConfigured = Boolean(
    legacy &&
      (legacy.selectedPixelId ||
        (legacy.primaryConversionDestinationId &&
          destinations.some(
            (destination) =>
              destination.id === legacy.primaryConversionDestinationId,
          ))),
  );
  const perAccount = new Map<string, MetaOrphanRouteAccountDto>();
  const campaignsByAccount = new Map<
    string,
    Map<string, { name: string; leads: number }>
  >();

  for (const bucket of buckets.values()) {
    const unattributed = bucket.accountKey === UNATTRIBUTED_AD_ACCOUNT_ID;
    const account = unattributed
      ? routingEnabled
        ? onlyAccount
        : null
      : (accountByAdAccount.get(bucket.accountKey) ?? null);
    const dryRunAccount = account ? toDryRunAccount(account) : null;
    let reason: MetaOrphanRouteReasonDto | null;

    // nod: an inactive account blocks even with BM routing off, and an
    // account linked to a BM uses the BM route even with routing off.
    if (dryRunAccount && !dryRunAccount.active) {
      reason = "account_inactive";
    } else if (!routingEnabled && !account?.businessConnectionId) {
      // The legacy route; a missing legacy setup (or no integration at all,
      // which the resolver rejects) breaks it.
      reason = !legacy || !legacyConfigured ? "legacy_unconfigured" : null;
    } else {
      reason = diagnoseNormalizedRoute({
        account: dryRunAccount,
        connection: account?.businessConnectionId
          ? (connectionById.get(account.businessConnectionId) ?? null)
          : null,
        configuredDestinationIds,
        adDestinationId: bucket.adDestinationId,
      });
    }

    if (!reason || bucket.leads + bucket.events === 0) continue;

    const outKey = bucket.accountKey;
    const known = unattributed ? null : accountByAdAccount.get(outKey);
    const entry = perAccount.get(outKey) ?? {
      adAccountId: unattributed
        ? UNATTRIBUTED_AD_ACCOUNT_ID
        : (known?.adAccountId ?? outKey),
      adAccountName: unattributed
        ? "Conta não identificada"
        : (known?.adAccountName ?? null),
      reason,
      leadCount: 0,
      blockedEventCount: 0,
      campaignNames: [],
      campaignCount: 0,
    };
    entry.leadCount += bucket.leads;
    entry.blockedEventCount += bucket.events;
    const merged = campaignsByAccount.get(outKey) ?? new Map();
    for (const [id, value] of bucket.campaigns) {
      const current = merged.get(id);
      merged.set(id, {
        name: value.name,
        leads: (current?.leads ?? 0) + value.leads,
      });
    }
    campaignsByAccount.set(outKey, merged);
    perAccount.set(outKey, entry);
  }

  const accounts: MetaOrphanRouteAccountDto[] = [];
  let blockedEventCount = 0;

  for (const [key, entry] of perAccount) {
    const list = [...(campaignsByAccount.get(key)?.values() ?? [])].sort(
      (a, b) => b.leads - a.leads,
    );
    blockedEventCount += entry.blockedEventCount;
    accounts.push({
      ...entry,
      campaignNames: list.slice(0, 3).map((campaign) => campaign.name),
      campaignCount: list.length,
    });
  }

  accounts.sort((a, b) => b.leadCount - a.leadCount);

  return { accounts, blockedEventCount };
}

/** Accounts that the change would newly block (already-blocked ones are excluded). */
export async function simulateRouteChange(
  prisma: PrismaService,
  workspaceId: string,
  overrides: RouteDryRunOverrides,
  now = new Date(),
): Promise<MetaOrphanRouteAccountDto[]> {
  const [before, after] = await Promise.all([
    computeOrphanRoutes(prisma, workspaceId, {}, now),
    computeOrphanRoutes(prisma, workspaceId, overrides, now),
  ]);
  const alreadyBlocked = new Set(
    before.accounts.map((account) => normalizeAct(account.adAccountId)),
  );

  return after.accounts.filter(
    (account) => !alreadyBlocked.has(normalizeAct(account.adAccountId)),
  );
}
