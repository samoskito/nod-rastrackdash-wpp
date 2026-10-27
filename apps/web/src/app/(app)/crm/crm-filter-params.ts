// Shared by the CRM server page, its server actions and the client board.
// Keep it free of "use client" and of client imports.

import {
  CRM_DEFAULT_PERIOD_DAYS,
  CRM_MAX_PERIOD_DAYS,
  crmPeriodDays,
} from "@wpptrack/shared";

/** CRM filters in the URL ("" = not set). */
export type CrmFilterValues = {
  since: string;
  until: string;
  whatsappInstanceId: string;
  campaignId: string;
};

export const crmFilterKeys = [
  "since",
  "until",
  "whatsappInstanceId",
  "campaignId",
] as const satisfies readonly (keyof CrmFilterValues)[];

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

function calendarDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days))
    .toISOString()
    .slice(0, 10);
}

/** Default period (design §3): the last 30 days, Sao Paulo calendar. */
export function defaultCrmPeriod(now: Date = new Date()): {
  since: string;
  until: string;
} {
  const until = calendarDate(now);
  return { since: shiftDate(until, -(CRM_DEFAULT_PERIOD_DAYS - 1)), until };
}

function single(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.trim() ?? "";
}

/** URL search params -> filters, with the default period filled in. */
export function crmFiltersFromSearchParams(
  params: Record<string, string | string[] | undefined>,
  now: Date = new Date(),
): CrmFilterValues {
  const fallback = defaultCrmPeriod(now);
  const since = single(params.since);
  const until = single(params.until);
  const validPeriod =
    datePattern.test(since) &&
    datePattern.test(until) &&
    since <= until &&
    crmPeriodDays(since, until) <= CRM_MAX_PERIOD_DAYS;
  return {
    since: validPeriod ? since : fallback.since,
    until: validPeriod ? until : fallback.until,
    whatsappInstanceId: single(params.whatsappInstanceId),
    campaignId: single(params.campaignId),
  };
}

/** API query string (/crm/board, /crm/board/columns/:key). */
export function crmQueryString(
  filters: CrmFilterValues,
  extra: Record<string, string | null | undefined> = {},
): string {
  const params = new URLSearchParams();
  for (const key of crmFilterKeys) {
    const value = filters[key].trim();
    if (value) params.set(key, value);
  }
  for (const [key, value] of Object.entries(extra))
    if (value) params.set(key, value);
  return params.toString();
}

/** Canonical, shareable page href; the default period stays out of it. */
export function crmFiltersHref(
  filters: CrmFilterValues,
  now: Date = new Date(),
): string {
  const fallback = defaultCrmPeriod(now);
  const isDefaultPeriod =
    filters.since === fallback.since && filters.until === fallback.until;
  const query = crmQueryString(
    isDefaultPeriod ? { ...filters, since: "", until: "" } : filters,
  );
  return query ? `/crm?${query}` : "/crm";
}
