import { describe, expect, it, vi } from "vitest";
import { MetaAdapter } from "../../src/integrations/meta/meta.adapter";
import {
  aggregateAdDailyInsightRows,
  aggregateAdInsightRows,
  compareInsightTotals,
  conversationsFromActionValues,
  metaInsightsLevelMode,
} from "../../src/reporting/meta-insights-aggregation";

const LEGACY = "onsite_conversion.messaging_conversation_started_7d";
const ONE_DAY = "onsite_conversion.messaging_conversation_started_1d";

type RawAd = {
  campaign_id: string;
  adset_id: string;
  ad_id: string;
  date_start?: string;
  spend: string;
  impressions: string;
  clicks: string;
  actions: Array<{ action_type: string; value: string }>;
};

/** Raw Graph ad rows; ad_b and ad_c are in the same ad set. */
const RAW_ADS: RawAd[] = [
  {
    campaign_id: "cmp_1",
    adset_id: "adset_1",
    ad_id: "ad_a",
    date_start: "2026-07-01",
    spend: "10.15",
    impressions: "1000",
    clicks: "31",
    actions: [
      { action_type: LEGACY, value: "5" },
      { action_type: ONE_DAY, value: "8" },
      { action_type: "link_click", value: "31" },
    ],
  },
  {
    campaign_id: "cmp_1",
    adset_id: "adset_2",
    ad_id: "ad_b",
    date_start: "2026-07-01",
    spend: "20.30",
    impressions: "2000",
    clicks: "12",
    actions: [
      { action_type: LEGACY, value: "9" },
      { action_type: ONE_DAY, value: "2" },
    ],
  },
  {
    campaign_id: "cmp_1",
    adset_id: "adset_2",
    ad_id: "ad_c",
    date_start: "2026-07-02",
    spend: "4.05",
    impressions: "300",
    clicks: "2",
    actions: [{ action_type: LEGACY, value: "1" }],
  },
  {
    campaign_id: "cmp_2",
    adset_id: "adset_3",
    ad_id: "ad_d",
    date_start: "2026-07-02",
    spend: "0",
    impressions: "10",
    clicks: "0",
    actions: [],
  },
];

/** What Meta returns at a coarser level: per-type sums of the ad rows. */
function rollUp(
  rows: RawAd[],
  keyOf: (row: RawAd) => string,
  pick: (row: RawAd) => Record<string, string>,
) {
  const groups = new Map<string, RawAd[]>();
  rows.forEach((row) =>
    groups.set(keyOf(row), [...(groups.get(keyOf(row)) ?? []), row]),
  );

  return [...groups.values()].map((group) => {
    const actions = new Map<string, number>();
    group.forEach((row) =>
      row.actions.forEach((action) =>
        actions.set(
          action.action_type,
          (actions.get(action.action_type) ?? 0) + Number(action.value),
        ),
      ),
    );

    return {
      ...pick(group[0]),
      spend: group
        .reduce((sum, row) => sum + Math.round(Number(row.spend) * 100), 0)
        .toString()
        .replace(/(\d\d)$/, ".$1"),
      impressions: String(
        group.reduce((sum, row) => sum + Number(row.impressions), 0),
      ),
      clicks: String(group.reduce((sum, row) => sum + Number(row.clicks), 0)),
      actions: [...actions].map(([action_type, value]) => ({
        action_type,
        value: String(value),
      })),
    };
  });
}

function graphFake() {
  const urls: URL[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    const level = url.searchParams.get("level");
    const daily = url.searchParams.get("time_increment") === "1";
    const day = (row: RawAd) => (daily ? `:${row.date_start}` : "");
    const withDate = (row: RawAd): Record<string, string> =>
      daily ? { date_start: row.date_start ?? "" } : {};
    const data =
      level === "campaign"
        ? rollUp(
            RAW_ADS,
            (row) => `${row.campaign_id}${day(row)}`,
            (row) => ({ campaign_id: row.campaign_id, ...withDate(row) }),
          )
        : level === "adset"
          ? rollUp(
              RAW_ADS,
              (row) => `${row.adset_id}${day(row)}`,
              (row) => ({
                campaign_id: row.campaign_id,
                adset_id: row.adset_id,
                ...withDate(row),
              }),
            )
          : rollUp(
              RAW_ADS,
              (row) => `${row.ad_id}${day(row)}`,
              (row) => ({
                campaign_id: row.campaign_id,
                adset_id: row.adset_id,
                ad_id: row.ad_id,
                ...withDate(row),
              }),
            );

    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as unknown as typeof fetch;

  return {
    urls,
    adapter: new MetaAdapter({ META_GRAPH_API_VERSION: "v25.0" }, fetchMock),
  };
}

const RANGE = {
  accessToken: "EAAB-token",
  adAccountId: "act_123",
  since: "2026-07-01",
  until: "2026-07-02",
};
const byId = <T>(rows: T[], id: (row: T) => string) =>
  [...rows].sort((left, right) => id(left).localeCompare(id(right)));

describe("meta insights local aggregation parity", () => {
  for (const readMode of ["legacy", "manual"] as const) {
    it(`matches campaign and ad set level reads (${readMode})`, async () => {
      const { adapter } = graphFake();
      const [campaigns, adSets, ads, rows] = await Promise.all([
        adapter.listCampaignInsights({ ...RANGE, readMode }),
        adapter.listAdSetInsights({ ...RANGE, readMode }),
        adapter.listAdInsights({ ...RANGE, readMode }),
        adapter.listAdInsightRows({ ...RANGE, readMode, daily: false }),
      ]);
      const local = aggregateAdInsightRows(rows, readMode);

      expect(byId(local.campaigns, (row) => row.campaignId)).toEqual(
        byId(campaigns, (row) => row.campaignId),
      );
      expect(byId(local.adSets, (row) => row.adSetId)).toEqual(
        byId(adSets, (row) => row.adSetId),
      );
      expect(byId(local.ads, (row) => row.adId)).toEqual(
        byId(ads, (row) => row.adId),
      );
    });

    it(`matches daily campaign and ad set level reads (${readMode})`, async () => {
      const { adapter } = graphFake();
      const [campaigns, adSets, ads, rows] = await Promise.all([
        adapter.listCampaignDailyInsights({ ...RANGE, readMode }),
        adapter.listAdSetDailyInsights({ ...RANGE, readMode }),
        adapter.listAdDailyInsights({ ...RANGE, readMode }),
        adapter.listAdInsightRows({ ...RANGE, readMode, daily: true }),
      ]);
      const local = aggregateAdDailyInsightRows(rows, readMode);
      const key = (row: { date: string; campaignId: string }) =>
        `${row.campaignId}:${row.date}`;

      expect(byId(local.campaigns, key)).toEqual(byId(campaigns, key));
      expect(byId(local.adSets, (row) => `${row.adSetId}:${row.date}`)).toEqual(
        byId(adSets, (row) => `${row.adSetId}:${row.date}`),
      );
      expect(byId(local.ads, (row) => `${row.adId}:${row.date}`)).toEqual(
        byId(ads, (row) => `${row.adId}:${row.date}`),
      );
    });
  }

  it("derives conversations after summing per type (max of sums, not sum of maxes)", () => {
    const rows = [
      {
        adId: "ad_a",
        adSetId: "adset_1",
        campaignId: "cmp_1",
        date: null,
        spendCents: 0,
        impressions: 0,
        clicks: 0,
        actionValues: { [LEGACY]: 5, [ONE_DAY]: 8 },
      },
      {
        adId: "ad_b",
        adSetId: "adset_1",
        campaignId: "cmp_1",
        date: null,
        spendCents: 0,
        impressions: 0,
        clicks: 0,
        actionValues: { [LEGACY]: 9, [ONE_DAY]: 2 },
      },
    ];

    // Per ad the manual metric is 8 and 9 (17), but the campaign read is
    // max(5+9, 8+2) = 14.
    expect(
      aggregateAdInsightRows(rows, "manual").campaigns[0]
        .metaConversationsStarted,
    ).toBe(14);
    expect(
      aggregateAdInsightRows(rows, "legacy").campaigns[0]
        .metaConversationsStarted,
    ).toBe(14);
    expect(conversationsFromActionValues({ [ONE_DAY]: 3 }, "legacy")).toBe(0);
    expect(conversationsFromActionValues({ [ONE_DAY]: 3 }, "manual")).toBe(3);
  });

  it("reports parity mismatches beyond the rounding tolerance", () => {
    const row = (campaignId: string, spendCents: number, clicks = 1) => ({
      campaignId,
      spendCents,
      impressions: 10,
      clicks,
      metaConversationsStarted: 1,
    });
    const report = compareInsightTotals({
      level: "campaign",
      expected: [row("a", 1000), row("b", 500), row("c", 100)],
      actual: [row("a", 1001), row("b", 497), row("c", 100, 2)],
      idOf: (item) => item.campaignId,
    });

    expect(report).toMatchObject({
      compared: 3,
      mismatched: 2,
      maxSpendDeltaCents: 3,
    });
    expect(report.sample.map((item) => [item.id, item.field])).toEqual([
      ["b", "spendCents"],
      ["c", "clicks"],
    ]);
  });

  it("defaults the level mode to legacy", () => {
    expect(metaInsightsLevelMode({})).toBe("legacy");
    expect(
      metaInsightsLevelMode({ META_INSIGHTS_LEVEL_MODE: "AD_LEVEL" }),
    ).toBe("ad_level");
    expect(metaInsightsLevelMode({ META_INSIGHTS_LEVEL_MODE: "shadow" })).toBe(
      "shadow",
    );
    expect(metaInsightsLevelMode({ META_INSIGHTS_LEVEL_MODE: "x" })).toBe(
      "legacy",
    );
  });
});

describe("meta adapter ad-level insight rows", () => {
  it("includes archived and deleted ads, uses bigger pages and only time_increment when daily", async () => {
    const { adapter, urls } = graphFake();

    await adapter.listAdInsightRows({ ...RANGE, daily: false });
    await adapter.listAdInsightRows({ ...RANGE, daily: true });

    for (const url of urls) {
      expect(url.searchParams.get("level")).toBe("ad");
      expect(url.searchParams.get("limit")).toBe("500");
      const filtering = JSON.parse(url.searchParams.get("filtering") ?? "[]");
      expect(filtering).toEqual([
        expect.objectContaining({
          field: "ad.effective_status",
          operator: "IN",
          value: expect.arrayContaining(["ACTIVE", "ARCHIVED", "DELETED"]),
        }),
      ]);
    }
    expect(urls[0].searchParams.get("time_increment")).toBeNull();
    expect(urls[1].searchParams.get("time_increment")).toBe("1");
  });

  it("retries once with 100-row pages when Meta asks to reduce the data", async () => {
    const limits: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      limits.push(url.searchParams.get("limit") ?? "");

      if (url.searchParams.get("limit") === "500") {
        return new Response(
          JSON.stringify({
            error: {
              code: 1,
              message:
                "Please reduce the amount of data you're asking for, then retry your request",
            },
          }),
          { status: 500 },
        );
      }

      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new MetaAdapter(
      { META_GRAPH_API_VERSION: "v25.0" },
      fetchMock,
    );

    await expect(
      adapter.listAdInsightRows({ ...RANGE, daily: true }),
    ).resolves.toEqual([]);
    expect(limits).toEqual(["500", "100"]);
  });

  for (const failure of [
    { label: "bodiless HTTP 503", status: 503, body: "" },
    {
      label: "code 2",
      status: 500,
      body: JSON.stringify({
        error: { code: 2, message: "Service temporarily unavailable" },
      }),
    },
  ]) {
    it(`retries once with 100-row pages on ${failure.label}`, async () => {
      const limits: string[] = [];
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        limits.push(url.searchParams.get("limit") ?? "");

        return url.searchParams.get("limit") === "500"
          ? new Response(failure.body, { status: failure.status })
          : new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as unknown as typeof fetch;
      const adapter = new MetaAdapter(
        { META_GRAPH_API_VERSION: "v25.0" },
        fetchMock,
      );

      await expect(
        adapter.listAdInsightRows({ ...RANGE, daily: true }),
      ).resolves.toEqual([]);
      expect(limits).toEqual(["500", "100"]);
    });
  }

  it("does not shrink pages on rate limits", async () => {
    const limits: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      limits.push(new URL(String(input)).searchParams.get("limit") ?? "");

      return new Response(
        JSON.stringify({ error: { code: 17, message: "User request limit" } }),
        { status: 400 },
      );
    }) as unknown as typeof fetch;
    const adapter = new MetaAdapter(
      { META_GRAPH_API_VERSION: "v25.0" },
      fetchMock,
    );

    await expect(
      adapter.listAdInsightRows({ ...RANGE, daily: true }),
    ).rejects.toThrow();
    expect(limits).toEqual(["500"]);
  });

  function asyncFake(statuses: string[]) {
    const calls: Array<{ method: string; url: URL; body?: URLSearchParams }> =
      [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        calls.push({
          method,
          url,
          ...(init?.body
            ? { body: new URLSearchParams(String(init.body)) }
            : {}),
        });

        if (method === "POST") {
          return new Response(JSON.stringify({ report_run_id: "987654" }), {
            status: 200,
          });
        }

        if (url.pathname.endsWith("/987654")) {
          return new Response(
            JSON.stringify({
              async_status: statuses.shift() ?? "Job Completed",
              async_percent_completion: 50,
            }),
            { status: 200 },
          );
        }

        return new Response(
          JSON.stringify({
            data: [
              {
                campaign_id: "cmp_1",
                adset_id: "adset_1",
                ad_id: "ad_1",
                date_start: "2026-05-01",
                spend: "1.50",
                impressions: "10",
                clicks: "1",
                actions: [{ action_type: LEGACY, value: "2" }],
              },
            ],
          }),
          { status: 200 },
        );
      },
    ) as unknown as typeof fetch;

    return {
      calls,
      adapter: new MetaAdapter(
        {
          META_GRAPH_API_VERSION: "v25.0",
          META_INSIGHTS_ASYNC_ENABLED: "true",
          META_INSIGHTS_ASYNC_MIN_DAYS: "31",
          META_INSIGHTS_ASYNC_POLL_MS: "0",
        },
        fetchMock,
      ),
    };
  }
  const LONG_RANGE = {
    ...RANGE,
    since: "2026-04-03",
    until: "2026-07-01",
  };

  it("reads long daily ranges through an async report run", async () => {
    const { adapter, calls } = asyncFake(["Job Running", "Job Completed"]);

    const rows = await adapter.listAdInsightRows({
      ...LONG_RANGE,
      daily: true,
    });

    expect(rows).toEqual([
      {
        adId: "ad_1",
        adSetId: "adset_1",
        campaignId: "cmp_1",
        date: "2026-05-01",
        spendCents: 150,
        impressions: 10,
        clicks: 1,
        actionValues: { [LEGACY]: 2 },
      },
    ]);
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "POST /v25.0/act_123/insights",
      "GET /v25.0/987654",
      "GET /v25.0/987654",
      "GET /v25.0/987654/insights",
    ]);
    expect(calls[0].body?.get("time_increment")).toBe("1");
    expect(calls[0].body?.get("level")).toBe("ad");
    expect(calls[0].body?.get("filtering")).toContain("DELETED");
  });

  it("falls back to the synchronous read when the async report fails", async () => {
    const { adapter, calls } = asyncFake(["Job Failed"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const rows = await adapter.listAdInsightRows({
      ...LONG_RANGE,
      daily: true,
    });

    expect(rows).toHaveLength(1);
    expect(calls.at(-1)?.url.pathname).toBe("/v25.0/act_123/insights");
    expect(calls.at(-1)?.method).toBe("GET");
    warn.mockRestore();
  });

  it("keeps short ranges synchronous even when async reports are enabled", async () => {
    const { adapter, calls } = asyncFake([]);

    await adapter.listAdInsightRows({ ...RANGE, daily: true });

    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });
});
