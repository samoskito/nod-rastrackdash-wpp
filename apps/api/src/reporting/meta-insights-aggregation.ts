import type {
  MetaAdDailyInsight,
  MetaAdInsight,
  MetaAdInsightRow,
  MetaAdSetDailyInsight,
  MetaAdSetInsight,
  MetaCampaignDailyInsight,
  MetaCampaignInsight,
  MetaInsightReadMode,
} from "../integrations/meta/meta.adapter";

/**
 * Local aggregation of ad-level Meta insights into campaign / ad set totals.
 *
 * Every metric WppTrack reads (spend, impressions, clicks, messaging
 * conversation action counts) is additive across ads, so the campaign and ad
 * set rows Meta would return are the per-type sums of their ad rows. The
 * conversation metric is derived only AFTER summing raw per-type counts, so
 * the "manual" read mode (max over compatible action types) keeps the exact
 * semantics of a campaign-level read. Non-additive metrics (reach, frequency,
 * unique_*) are not read by WppTrack; if one is ever added it must keep being
 * fetched at its own level.
 */

export const LEGACY_CONVERSATION_ACTION_TYPE =
  "onsite_conversion.messaging_conversation_started_7d";

export type MetaInsightsLevelMode = "legacy" | "shadow" | "ad_level";

/**
 * META_INSIGHTS_LEVEL_MODE:
 * - legacy (default): campaign + ad set + ad insights read separately.
 * - shadow: legacy reads drive the data; ad-level rows are also read and the
 *   locally aggregated totals are compared and logged (parity evidence).
 * - ad_level: only ad-level rows are read; campaign/ad set totals are local.
 */
export function metaInsightsLevelMode(
  env: Record<string, string | undefined> = process.env,
): MetaInsightsLevelMode {
  const value = env.META_INSIGHTS_LEVEL_MODE?.trim().toLowerCase();

  return value === "shadow" || value === "ad_level" ? value : "legacy";
}

export function conversationsFromActionValues(
  actionValues: Record<string, number>,
  readMode: MetaInsightReadMode = "legacy",
): number {
  const legacyValue = actionValues[LEGACY_CONVERSATION_ACTION_TYPE] ?? 0;

  if (readMode === "legacy") {
    return legacyValue;
  }

  const compatibleValues = Object.entries(actionValues)
    .filter(([type]) =>
      type.toLowerCase().includes("messaging_conversation_started"),
    )
    .map(([, value]) => value);

  return Math.max(legacyValue, ...compatibleValues, 0);
}

type Bucket = {
  spendCents: number;
  impressions: number;
  clicks: number;
  actionValues: Record<string, number>;
};

function addRow(bucket: Bucket, row: MetaAdInsightRow): void {
  bucket.spendCents += row.spendCents;
  bucket.impressions += row.impressions;
  bucket.clicks += row.clicks;

  for (const [type, value] of Object.entries(row.actionValues)) {
    bucket.actionValues[type] = (bucket.actionValues[type] ?? 0) + value;
  }
}

function emptyBucket(): Bucket {
  return { spendCents: 0, impressions: 0, clicks: 0, actionValues: {} };
}

function groupRows<TKey>(
  rows: MetaAdInsightRow[],
  keyOf: (row: MetaAdInsightRow) => string,
  identityOf: (row: MetaAdInsightRow) => TKey,
): Array<{ identity: TKey; bucket: Bucket }> {
  const groups = new Map<string, { identity: TKey; bucket: Bucket }>();

  for (const row of rows) {
    const key = keyOf(row);
    let group = groups.get(key);

    if (!group) {
      group = { identity: identityOf(row), bucket: emptyBucket() };
      groups.set(key, group);
    }

    addRow(group.bucket, row);
  }

  return [...groups.values()];
}

function metrics(bucket: Bucket, readMode: MetaInsightReadMode) {
  return {
    spendCents: bucket.spendCents,
    impressions: bucket.impressions,
    clicks: bucket.clicks,
    metaConversationsStarted: conversationsFromActionValues(
      bucket.actionValues,
      readMode,
    ),
  };
}

/** Window totals (date ignored) at campaign, ad set and ad level. */
export function aggregateAdInsightRows(
  rows: MetaAdInsightRow[],
  readMode: MetaInsightReadMode = "legacy",
): {
  campaigns: MetaCampaignInsight[];
  adSets: MetaAdSetInsight[];
  ads: MetaAdInsight[];
} {
  return {
    campaigns: groupRows(
      rows,
      (row) => row.campaignId,
      (row) => ({ campaignId: row.campaignId }),
    ).map(({ identity, bucket }) => ({
      ...identity,
      ...metrics(bucket, readMode),
    })),
    adSets: groupRows(
      rows,
      (row) => row.adSetId,
      (row) => ({ adSetId: row.adSetId, campaignId: row.campaignId }),
    ).map(({ identity, bucket }) => ({
      ...identity,
      ...metrics(bucket, readMode),
    })),
    ads: groupRows(
      rows,
      (row) => row.adId,
      (row) => ({
        adId: row.adId,
        adSetId: row.adSetId,
        campaignId: row.campaignId,
      }),
    ).map(({ identity, bucket }) => ({
      ...identity,
      ...metrics(bucket, readMode),
    })),
  };
}

/** Per-day totals at campaign, ad set and ad level (rows without date are skipped). */
export function aggregateAdDailyInsightRows(
  rows: MetaAdInsightRow[],
  readMode: MetaInsightReadMode = "legacy",
): {
  campaigns: MetaCampaignDailyInsight[];
  adSets: MetaAdSetDailyInsight[];
  ads: MetaAdDailyInsight[];
} {
  const dated = rows.filter((row): row is MetaAdInsightRow & { date: string } =>
    Boolean(row.date),
  );

  return {
    campaigns: groupRows(
      dated,
      (row) => `${row.campaignId}:${row.date}`,
      (row) => ({ campaignId: row.campaignId, date: row.date as string }),
    ).map(({ identity, bucket }) => ({
      ...identity,
      ...metrics(bucket, readMode),
    })),
    adSets: groupRows(
      dated,
      (row) => `${row.adSetId}:${row.date}`,
      (row) => ({
        adSetId: row.adSetId,
        campaignId: row.campaignId,
        date: row.date as string,
      }),
    ).map(({ identity, bucket }) => ({
      ...identity,
      ...metrics(bucket, readMode),
    })),
    ads: groupRows(
      dated,
      (row) => `${row.adId}:${row.date}`,
      (row) => ({
        adId: row.adId,
        adSetId: row.adSetId,
        campaignId: row.campaignId,
        date: row.date as string,
      }),
    ).map(({ identity, bucket }) => ({
      ...identity,
      ...metrics(bucket, readMode),
    })),
  };
}

export type InsightParityReport = {
  level: "campaign" | "adset";
  compared: number;
  mismatched: number;
  maxSpendDeltaCents: number;
  sample: Array<{
    id: string;
    field: string;
    expected: number;
    actual: number;
  }>;
};

/**
 * Compares Meta's own level totals with locally aggregated ones. Spend gets a
 * 1-cent-per-ad rounding tolerance; counts must match exactly.
 */
export function compareInsightTotals<
  T extends {
    spendCents: number;
    impressions: number;
    clicks: number;
    metaConversationsStarted: number;
  },
>(input: {
  level: "campaign" | "adset";
  expected: T[];
  actual: T[];
  idOf: (row: T) => string;
  spendToleranceCentsFor?: (id: string) => number;
}): InsightParityReport {
  const expectedById = new Map(
    input.expected.map((row) => [input.idOf(row), row]),
  );
  const actualById = new Map(input.actual.map((row) => [input.idOf(row), row]));
  const ids = new Set([...expectedById.keys(), ...actualById.keys()]);
  const report: InsightParityReport = {
    level: input.level,
    compared: ids.size,
    mismatched: 0,
    maxSpendDeltaCents: 0,
    sample: [],
  };
  const zero = {
    spendCents: 0,
    impressions: 0,
    clicks: 0,
    metaConversationsStarted: 0,
  };

  for (const id of ids) {
    const expected = expectedById.get(id) ?? zero;
    const actual = actualById.get(id) ?? zero;
    const spendDelta = Math.abs(expected.spendCents - actual.spendCents);
    const tolerance = input.spendToleranceCentsFor?.(id) ?? 1;
    report.maxSpendDeltaCents = Math.max(report.maxSpendDeltaCents, spendDelta);
    const differences: Array<keyof typeof zero> = [
      ...(spendDelta > tolerance ? (["spendCents"] as const) : []),
      ...(
        ["impressions", "clicks", "metaConversationsStarted"] as const
      ).filter((field) => expected[field] !== actual[field]),
    ];

    if (differences.length > 0) {
      report.mismatched += 1;

      if (report.sample.length < 5) {
        const field = differences[0];
        report.sample.push({
          id,
          field,
          expected: expected[field],
          actual: actual[field],
        });
      }
    }
  }

  return report;
}
