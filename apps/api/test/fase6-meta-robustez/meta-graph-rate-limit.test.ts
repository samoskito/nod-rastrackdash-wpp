import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaAdapter } from "../../src/integrations/meta/meta.adapter";
import { isMetaRateLimitError as isThumbnailRateLimitError } from "../../src/integrations/meta/meta-creative-thumbnail.service";
import {
  MetaGraphError,
  classifyMetaGraphError,
  metaCredentialFatalScope,
  metaGraphErrorFromPayload,
  sanitizedMetaGraphReason,
} from "../../src/integrations/meta/meta-graph-error";
import {
  MetaGraphUsageMonitor,
  metaAdAccountFromGraphUrl,
  parseMetaGraphUsageHeaders,
} from "../../src/integrations/meta/meta-graph-usage";
import {
  META_AUTO_SYNC_LOCK_KEY,
  MetaReportSyncThrottleService,
} from "../../src/reporting/meta-report-sync-throttle.service";

function graphError(
  error: Record<string, unknown>,
  httpStatus = 400,
): MetaGraphError {
  return metaGraphErrorFromPayload({ error }, httpStatus, "Meta Graph HTTP");
}

function fakeRedis() {
  const store = new Map<string, string>();
  const redis = {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    mget: vi.fn(async (...keys: string[]) =>
      keys.map((key) => store.get(key) ?? null),
    ),
    set: vi.fn(
      async (key: string, value: string, ...args: Array<string | number>) => {
        if (args.includes("NX") && store.has(key)) {
          return null;
        }

        store.set(key, value);
        return "OK";
      },
    ),
  };

  return redis;
}

describe("meta graph error classification", () => {
  it.each([
    [{ code: 190, error_subcode: 460, type: "OAuthException" }, "credential"],
    [{ code: 190, error_subcode: 463, type: "OAuthException" }, "credential"],
    [{ code: 190 }, "credential"],
    [{ code: 10, type: "OAuthException" }, "account"],
    [{ code: 200, type: "OAuthException" }, "account"],
    [{ code: 294 }, "account"],
    [
      {
        code: 100,
        message:
          "The application does not belong to the system user's business",
      },
      "account",
    ],
  ])("treats %j as credential-fatal (%s)", (error, scope) => {
    const parsed = graphError({ message: "rejected", ...error });

    expect(classifyMetaGraphError(parsed)).toBe("credential_fatal");
    expect(metaCredentialFatalScope(parsed)).toBe(scope);
  });

  it.each([4, 17, 32, 341, 613, 80000, 80004, 80014])(
    "treats code %i as rate limited even when typed OAuthException",
    (code) => {
      expect(
        classifyMetaGraphError(
          graphError({ message: "limit", code, type: "OAuthException" }),
        ),
      ).toBe("rate_limited");
    },
  );

  it("keeps parameter errors and transient failures out of the breaker", () => {
    expect(
      classifyMetaGraphError(
        graphError({
          message:
            "(#100) Tried accessing nonexisting field (object_story_spec)",
          code: 100,
          type: "OAuthException",
        }),
      ),
    ).toBe("other");
    expect(classifyMetaGraphError(graphError({ code: 2 }, 500))).toBe(
      "transient",
    );
    expect(classifyMetaGraphError(graphError({}, 503))).toBe("transient");
    expect(classifyMetaGraphError(new Error("network"))).toBe("other");
  });

  it("keeps the historical error message and exposes a token-free reason", () => {
    const error = graphError({
      message: "Error validating access token",
      code: 190,
      error_subcode: 460,
    });

    expect(error.message).toBe("Error validating access token");
    expect(sanitizedMetaGraphReason(error)).toBe(
      "meta_graph code=190 subcode=460 http=400",
    );
    expect(
      metaGraphErrorFromPayload({}, 502, "Meta Graph HTTP 502").message,
    ).toBe("Meta Graph HTTP 502");
  });
});

describe("meta graph usage headers", () => {
  it("parses app, business use case, insights and ad account usage", () => {
    const headers = new Headers({
      "x-app-usage": JSON.stringify({
        call_count: 41,
        total_time: 12,
        total_cputime: 8,
      }),
      "x-business-use-case-usage": JSON.stringify({
        "123": [
          {
            type: "ads_insights",
            call_count: 88,
            total_cputime: 10,
            total_time: 20,
            estimated_time_to_regain_access: 7,
          },
        ],
      }),
      "x-fb-ads-insights-throttle": JSON.stringify({
        app_id_util_pct: 76.5,
        acc_id_util_pct: 12,
      }),
    });

    expect(parseMetaGraphUsageHeaders(headers)).toEqual({
      appPercent: 76.5,
      accountPercent: 88,
      regainAfterMs: 7 * 60_000,
    });
    expect(parseMetaGraphUsageHeaders(new Headers())).toBeNull();
    expect(
      parseMetaGraphUsageHeaders(new Headers({ "x-app-usage": "not-json" })),
    ).toBeNull();
  });

  it("attributes account usage to the ad account in the URL, never the token", () => {
    expect(
      metaAdAccountFromGraphUrl(
        "https://graph.facebook.com/v25.0/act_998/insights?access_token=SECRET",
      ),
    ).toBe("act_998");

    const monitor = new MetaGraphUsageMonitor();
    monitor.record(
      new Headers({
        "x-ad-account-usage": JSON.stringify({
          acc_id_util_pct: 64,
          reset_time_duration: 120,
        }),
      }),
      "https://graph.facebook.com/v25.0/act_998/ads?access_token=SECRET",
      1_000,
    );

    expect(monitor.snapshot(1_000)).toEqual({
      app: null,
      accounts: {
        act_998: { percent: 64, regainAtMs: 121_000, observedAtMs: 1_000 },
      },
    });
    expect(JSON.stringify(monitor.snapshot(1_000))).not.toContain("SECRET");
    // Stale observations expire so paused syncs eventually probe again.
    expect(monitor.snapshot(1_000 + 11 * 60_000).accounts).toEqual({});
  });
});

describe("meta report sync throttle", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defers background sync when app usage crosses the pause threshold", async () => {
    const monitor = new MetaGraphUsageMonitor();
    const redis = fakeRedis();
    const throttle = new MetaReportSyncThrottleService(
      { client: Promise.resolve(redis) } as never,
      monitor,
    );
    const now = 1_800_000_000_000;

    monitor.record(
      new Headers({ "x-app-usage": JSON.stringify({ call_count: 60 }) }),
      null,
      now,
    );
    await expect(throttle.deferralFor([], 0, now)).resolves.toBeNull();

    monitor.record(
      new Headers({ "x-app-usage": JSON.stringify({ call_count: 80 }) }),
      null,
      now + 1,
    );
    const deferral = await throttle.deferralFor([], 0, now + 1);

    expect(deferral).toMatchObject({ reason: "app_usage", percent: 80 });
    expect(deferral!.untilMs).toBeGreaterThanOrEqual(now + 1 + 5 * 60_000);
    // Published for the other replicas.
    expect(
      JSON.parse(redis.store.get("wpptrack:meta-graph-usage:app") ?? "{}"),
    ).toMatchObject({ percent: 80 });
  });

  it("honours Meta's estimated time to regain access and shared replica state", async () => {
    const redis = fakeRedis();
    const now = 1_800_000_000_000;
    redis.store.set(
      "wpptrack:meta-graph-usage:account:act_1",
      JSON.stringify({
        percent: 100,
        regainAtMs: now + 45 * 60_000,
        observedAtMs: now - 1_000,
      }),
    );
    const throttle = new MetaReportSyncThrottleService(
      { client: Promise.resolve(redis) } as never,
      new MetaGraphUsageMonitor(),
    );

    await expect(throttle.deferralFor(["act_1"], 0, now)).resolves.toEqual({
      untilMs: now + 45 * 60_000,
      reason: "account_usage",
      percent: 100,
    });
    await expect(throttle.deferralFor(["act_2"], 0, now)).resolves.toBeNull();
  });

  it("records throttle errors as an app-wide cooldown for code 4", async () => {
    const redis = fakeRedis();
    const monitor = new MetaGraphUsageMonitor();
    const throttle = new MetaReportSyncThrottleService(
      { client: Promise.resolve(redis) } as never,
      monitor,
    );
    const now = 1_800_000_000_000;

    await throttle.recordRateLimitError(
      graphError({ message: "Application request limit reached", code: 4 }),
      ["act_1"],
      0,
      now,
    );

    expect(monitor.snapshot(now).app).toMatchObject({ percent: 100 });
    expect(redis.store.has("wpptrack:meta-graph-usage:app")).toBe(true);
    await expect(
      throttle.deferralFor(["act_9"], 1, now + 1),
    ).resolves.toMatchObject({ reason: "app_usage" });
  });

  it("keeps working in-process when Redis is unavailable", async () => {
    const monitor = new MetaGraphUsageMonitor();
    const throttle = new MetaReportSyncThrottleService(
      { client: Promise.reject(new Error("redis down")) } as never,
      monitor,
    );
    const now = 1_800_000_000_000;

    monitor.recordThrottle("account", "act_1", 60_000, now);

    await expect(
      throttle.deferralFor(["act_1"], 0, now),
    ).resolves.toMatchObject({ reason: "account_usage" });
    await expect(throttle.acquireAutoSyncLock(60_000)).resolves.toBeNull();
  });

  it("lets only one replica take the auto-sync lock per interval", async () => {
    const redis = fakeRedis();
    const throttle = new MetaReportSyncThrottleService({
      client: Promise.resolve(redis),
    } as never);

    await expect(throttle.acquireAutoSyncLock(60_000)).resolves.toBe(true);
    await expect(throttle.acquireAutoSyncLock(60_000)).resolves.toBe(false);
    expect(redis.set).toHaveBeenCalledWith(
      META_AUTO_SYNC_LOCK_KEY,
      expect.any(String),
      "PX",
      60_000,
      "NX",
    );
  });

  it("respects a custom pause threshold", async () => {
    vi.stubEnv("WPPTRACK_META_USAGE_PAUSE_PERCENT", "90");
    const monitor = new MetaGraphUsageMonitor();
    const throttle = new MetaReportSyncThrottleService({} as never, monitor);
    const now = 1_800_000_000_000;

    monitor.record(
      new Headers({ "x-app-usage": JSON.stringify({ call_count: 85 }) }),
      null,
      now,
    );

    await expect(throttle.deferralFor([], 0, now)).resolves.toBeNull();
  });
});

describe("meta adapter rate-limit awareness", () => {
  const deadToken = {
    error: {
      message:
        "Error validating access token: The session has been invalidated",
      type: "OAuthException",
      code: 190,
      error_subcode: 460,
    },
  };

  it("does not repeat listAds field fallbacks with a dead token", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(deadToken), { status: 400 }),
    ) as unknown as typeof fetch;
    const adapter = new MetaAdapter({}, fetcher);

    const failure = await adapter
      .listAds({ accessToken: "meta-token", adAccountId: "act_123" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MetaGraphError);
    expect((failure as MetaGraphError).details).toMatchObject({
      code: 190,
      subcode: 460,
      httpStatus: 400,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not repeat listAds field fallbacks while throttled", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { message: "User request limit reached", code: 17 },
          }),
          { status: 400 },
        ),
    ) as unknown as typeof fetch;
    const adapter = new MetaAdapter({}, fetcher);

    await expect(
      adapter.listAds({ accessToken: "meta-token", adAccountId: "act_123" }),
    ).rejects.toBeInstanceOf(MetaGraphError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("still falls back to fewer ad fields on a permission error (200)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let listCalls = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/ads?")) {
        listCalls += 1;

        return listCalls === 1
          ? new Response(
              JSON.stringify({
                error: {
                  message: "(#200) Requires pages_read_engagement permission",
                  type: "OAuthException",
                  code: 200,
                },
              }),
              { status: 400 },
            )
          : new Response(JSON.stringify({ data: [] }), { status: 200 });
      }

      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new MetaAdapter({}, fetcher);

    await expect(
      adapter.listAds({ accessToken: "meta-token", adAccountId: "act_123" }),
    ).resolves.toEqual([]);
    expect(listCalls).toBe(2);
    vi.restoreAllMocks();
  });

  it("still falls back to fewer ad fields on a parameter error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let listCalls = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);

      if (url.includes("/ads?")) {
        listCalls += 1;

        if (listCalls === 1) {
          return new Response(
            JSON.stringify({
              error: {
                message: "(#100) Tried accessing nonexisting field",
                type: "OAuthException",
                code: 100,
              },
            }),
            { status: 400 },
          );
        }

        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }

      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new MetaAdapter({}, fetcher);

    await expect(
      adapter.listAds({ accessToken: "meta-token", adAccountId: "act_123" }),
    ).resolves.toEqual([]);
    expect(listCalls).toBe(2);
    vi.restoreAllMocks();
  });

  it("records usage headers from Graph list calls without blocking them", async () => {
    const monitor = new MetaGraphUsageMonitor();
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: {
            "x-app-usage": JSON.stringify({ call_count: 97 }),
            "x-fb-ads-insights-throttle": JSON.stringify({
              app_id_util_pct: 10,
              acc_id_util_pct: 55,
            }),
          },
        }),
    ) as unknown as typeof fetch;
    const adapter = new MetaAdapter({}, fetcher, monitor);

    await expect(
      adapter.listCampaigns({
        accessToken: "meta-token",
        adAccountId: "act_7",
      }),
    ).resolves.toEqual([]);

    const snapshot = monitor.snapshot();
    expect(snapshot.app?.percent).toBe(97);
    expect(snapshot.accounts.act_7?.percent).toBe(55);
  });
});

describe("typed Graph errors and the creative thumbnail pause", () => {
  it("is detected as a rate limit by the thumbnail service via its code", () => {
    for (const code of [4, 17, 32, 613]) {
      const error = metaGraphErrorFromPayload(
        { error: { message: "Please slow down", code } },
        400,
        "Meta Graph batch HTTP 400",
      );

      expect(error.code).toBe(code);
      expect(isThumbnailRateLimitError(error)).toBe(true);
    }

    expect(
      isThumbnailRateLimitError(
        metaGraphErrorFromPayload(
          { error: { message: "Invalid OAuth access token", code: 190 } },
          400,
          "Meta Graph HTTP 400",
        ),
      ),
    ).toBe(false);
  });
});
