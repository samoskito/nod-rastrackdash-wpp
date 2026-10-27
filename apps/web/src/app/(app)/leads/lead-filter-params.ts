// Shared by the Leads server page and the client filters. Keep this module free
// of "use client" and of client imports: exports of a client module are client
// references on the server and cannot be called while rendering.

/** Every lead filter, in canonical URL order ("" = not set). */
export type LeadFilterValues = {
  search: string;
  status: string;
  eventName: string;
  label: string;
  campaignId: string;
  adSetId: string;
  adId: string;
  whatsappInstanceId: string;
  attribution: string;
  since: string;
  until: string;
  /**
   * "" = leads novos (first contact in the period); "returning" = voltaram;
   * "repeat" = 2+ paid conversations in the period.
   */
  base: string;
  pageSize: string;
};

export type LeadFilterKey = keyof LeadFilterValues;

export const leadFilterKeys = [
  "search",
  "status",
  "eventName",
  "label",
  "campaignId",
  "adSetId",
  "adId",
  "whatsappInstanceId",
  "attribution",
  "since",
  "until",
  "base",
  "pageSize",
] as const satisfies readonly LeadFilterKey[];

export const defaultLeadPageSize = "25";

/** Report drill-down scope, counted with the advanced filters. */
export const reportScopeKeys = ["campaignId", "adSetId", "adId"] as const;

/**
 * Not editable here, but carried on every change and kept by Limpar: the
 * report drill-down and the WhatsApp instance the user arrived from.
 */
export const scopeKeys = [...reportScopeKeys, "whatsappInstanceId"] as const;

const emptyLeadFilters: LeadFilterValues = {
  search: "",
  status: "",
  eventName: "",
  label: "",
  campaignId: "",
  adSetId: "",
  adId: "",
  whatsappInstanceId: "",
  attribution: "",
  since: "",
  until: "",
  base: "",
  pageSize: defaultLeadPageSize,
};

/**
 * Canonical, shareable href: fixed param order, blank and default params
 * omitted, and no `page` so a new filter always starts on the first page.
 */
export function leadFiltersHref(filters: LeadFilterValues): string {
  const params = new URLSearchParams();

  for (const key of leadFilterKeys) {
    const value = filters[key].trim();

    if (!value || (key === "pageSize" && value === defaultLeadPageSize)) {
      continue;
    }

    params.set(key, value);
  }

  const query = params.toString();
  return query ? `/leads?${query}` : "/leads";
}

/**
 * Limpar: drops every editable filter but keeps the scope and the page size
 * (how the list is shown, not what it contains).
 */
export function leadFiltersClearHref(filters: LeadFilterValues): string {
  const kept = Object.fromEntries(
    [...scopeKeys, "pageSize" as const].map((key) => [key, filters[key]]),
  );

  return leadFiltersHref({ ...emptyLeadFilters, ...kept });
}

/** Whether Limpar would change anything. */
export function hasEditableLeadFilter(filters: LeadFilterValues): boolean {
  return leadFiltersClearHref(filters) !== leadFiltersHref(filters);
}

export type LeadExportFormat = "csv" | "xlsx";

/**
 * Where the spreadsheet of the applied filters is downloaded from. Only what
 * selects leads goes along: no page and no page size, because the file holds
 * every match, and `maskSensitive` mirrors the "Ocultar dados" toggle.
 */
export function leadExportHref(
  filters: LeadFilterValues,
  format: LeadExportFormat,
  maskSensitive = false,
): string {
  const params = new URLSearchParams();

  for (const key of leadFilterKeys) {
    const value = filters[key].trim();

    if (key !== "pageSize" && value) {
      params.set(key, value);
    }
  }

  params.set("format", format);

  if (maskSensitive) {
    params.set("maskSensitive", "1");
  }

  return `/leads/export?${params.toString()}`;
}
