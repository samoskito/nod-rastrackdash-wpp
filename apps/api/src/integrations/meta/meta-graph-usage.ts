import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable } from "@nestjs/common";

/**
 * Passive observer of Meta rate-limit headers. It never blocks a request;
 * background jobs read the snapshot and decide to yield, so user-facing
 * OAuth/login flows are not affected.
 */

export type MetaGraphUsageEntry = {
  /** Highest usage percentage observed (0-100+). */
  percent: number;
  /** When Meta said access is regained (epoch ms), if informed. */
  regainAtMs: number | null;
  observedAtMs: number;
};

export type MetaGraphUsageSnapshot = {
  app: MetaGraphUsageEntry | null;
  accounts: Record<string, MetaGraphUsageEntry>;
};

export type ParsedMetaGraphUsage = {
  appPercent: number | null;
  accountPercent: number | null;
  regainAfterMs: number | null;
};

type HeaderReader = { get(name: string): string | null };

/**
 * nod: which Meta app a background call runs on. A student installation may
 * use the PalmUP Meta app (button "Conectar Meta (PalmUP)") and/or a token
 * from the student's own app, and Meta's application-level limit
 * (X-App-Usage) is per app. App-level usage is tracked per scope, so one hot
 * app does not pause the other. Per ad account usage (BUC) is unaffected.
 * Outside a scope (e.g. SaaS-style callers) the single default app entry is
 * used, as in the SaaS.
 */
export type MetaGraphAppScope = "palmup" | "own";

/** Label the PalmUP social login gives the credential it creates. */
export const META_PALMUP_CREDENTIAL_LABEL = "Login social PalmUP";

const appScopeStorage = new AsyncLocalStorage<MetaGraphAppScope>();

export function metaGraphAppScopeForCredentialLabel(
  label: string | null | undefined,
): MetaGraphAppScope {
  return label?.trim() === META_PALMUP_CREDENTIAL_LABEL ? "palmup" : "own";
}

/** Runs fn with every Graph call inside it attributed to this app scope. */
export function runWithMetaGraphAppScope<T>(
  scope: MetaGraphAppScope | null | undefined,
  fn: () => T,
): T {
  return scope ? appScopeStorage.run(scope, fn) : fn();
}

export function currentMetaGraphAppScope(): MetaGraphAppScope | null {
  return appScopeStorage.getStore() ?? null;
}

/** Observations older than this are considered stale (Meta uses 1h windows). */
export const META_GRAPH_USAGE_TTL_MS = 10 * 60_000;

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function maxOf(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);

  return present.length > 0 ? Math.max(...present) : null;
}

export function parseMetaGraphUsageHeaders(
  headers: HeaderReader | null | undefined,
): ParsedMetaGraphUsage | null {
  if (!headers || typeof headers.get !== "function") {
    return null;
  }

  const appUsage = parseJsonRecord(headers.get("x-app-usage"));
  const insightsThrottle = parseJsonRecord(
    headers.get("x-fb-ads-insights-throttle"),
  );
  const adAccountUsage = parseJsonRecord(headers.get("x-ad-account-usage"));
  const businessUsage = parseJsonRecord(
    headers.get("x-business-use-case-usage"),
  );
  const businessEntries = Object.values(businessUsage ?? {}).flatMap((value) =>
    Array.isArray(value)
      ? value.filter(
          (entry): entry is Record<string, unknown> =>
            Boolean(entry) && typeof entry === "object",
        )
      : [],
  );

  const appPercent = maxOf([
    toNumber(appUsage?.call_count),
    toNumber(appUsage?.total_time),
    toNumber(appUsage?.total_cputime),
    toNumber(insightsThrottle?.app_id_util_pct),
  ]);
  const accountPercent = maxOf([
    toNumber(insightsThrottle?.acc_id_util_pct),
    toNumber(adAccountUsage?.acc_id_util_pct),
    ...businessEntries.flatMap((entry) => [
      toNumber(entry.call_count),
      toNumber(entry.total_time),
      toNumber(entry.total_cputime),
    ]),
  ]);
  const regainMinutes = maxOf(
    businessEntries.map((entry) =>
      toNumber(entry.estimated_time_to_regain_access),
    ),
  );
  const resetSeconds = toNumber(adAccountUsage?.reset_time_duration);
  const regainAfterMs = maxOf([
    regainMinutes !== null ? regainMinutes * 60_000 : null,
    resetSeconds !== null ? resetSeconds * 1_000 : null,
  ]);

  if (appPercent === null && accountPercent === null && !regainAfterMs) {
    return null;
  }

  return {
    appPercent,
    accountPercent,
    regainAfterMs: regainAfterMs && regainAfterMs > 0 ? regainAfterMs : null,
  };
}

/** Extracts the ad account (act_123) a Graph URL targets, never the token. */
export function metaAdAccountFromGraphUrl(url: string | null | undefined) {
  const match = /\/(act_\d+)(?:[/?]|$)/.exec(url ?? "");

  return match?.[1] ?? null;
}

@Injectable()
export class MetaGraphUsageMonitor {
  private app: MetaGraphUsageEntry | null = null;
  private readonly scopedApps = new Map<
    MetaGraphAppScope,
    MetaGraphUsageEntry
  >();
  private readonly accounts = new Map<string, MetaGraphUsageEntry>();

  record(
    headers: HeaderReader | null | undefined,
    url?: string | null,
    nowMs = Date.now(),
  ): void {
    const parsed = parseMetaGraphUsageHeaders(headers);

    if (!parsed) {
      return;
    }

    const regainAtMs = parsed.regainAfterMs
      ? nowMs + parsed.regainAfterMs
      : null;

    if (parsed.appPercent !== null) {
      this.setApp(currentMetaGraphAppScope(), {
        percent: parsed.appPercent,
        regainAtMs: null,
        observedAtMs: nowMs,
      });
    }

    const account = metaAdAccountFromGraphUrl(url);

    if (account && (parsed.accountPercent !== null || regainAtMs)) {
      this.accounts.set(account, {
        percent: parsed.accountPercent ?? 0,
        regainAtMs,
        observedAtMs: nowMs,
      });
    }
  }

  /** Records an explicit throttle response (4/17/613/80000+). */
  recordThrottle(
    scope: "app" | "account",
    key: string | null,
    cooldownMs: number,
    nowMs = Date.now(),
    appScope: MetaGraphAppScope | null = currentMetaGraphAppScope(),
  ): void {
    const entry: MetaGraphUsageEntry = {
      percent: 100,
      regainAtMs: nowMs + cooldownMs,
      observedAtMs: nowMs,
    };

    if (scope === "app") {
      this.setApp(appScope, entry);
      return;
    }

    if (key) {
      this.accounts.set(key, entry);
    }
  }

  /** `app` is the entry of `appScope` (default: the current scope). */
  snapshot(
    nowMs = Date.now(),
    appScope: MetaGraphAppScope | null = currentMetaGraphAppScope(),
  ): MetaGraphUsageSnapshot {
    const fresh = (entry: MetaGraphUsageEntry | null | undefined) =>
      Boolean(entry) &&
      (nowMs - (entry as MetaGraphUsageEntry).observedAtMs <=
        META_GRAPH_USAGE_TTL_MS ||
        ((entry as MetaGraphUsageEntry).regainAtMs ?? 0) > nowMs);
    const accounts: Record<string, MetaGraphUsageEntry> = {};

    for (const [key, entry] of this.accounts) {
      if (fresh(entry)) {
        accounts[key] = entry;
      } else {
        this.accounts.delete(key);
      }
    }

    if (!fresh(this.app)) {
      this.app = null;
    }

    for (const [key, entry] of this.scopedApps) {
      if (!fresh(entry)) {
        this.scopedApps.delete(key);
      }
    }

    return {
      app: appScope ? (this.scopedApps.get(appScope) ?? null) : this.app,
      accounts,
    };
  }

  reset(): void {
    this.app = null;
    this.scopedApps.clear();
    this.accounts.clear();
  }

  private setApp(
    appScope: MetaGraphAppScope | null,
    entry: MetaGraphUsageEntry,
  ): void {
    if (appScope) {
      this.scopedApps.set(appScope, entry);
    } else {
      this.app = entry;
    }
  }
}
