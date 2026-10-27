/**
 * Campaign selection <-> URL (UX contract §3.1), shared by the server page and
 * the client filter bar:
 * - 0 selected: no param (all campaigns)
 * - 1 selected: `campaignId=<id>` (every pre-multi link stays byte-identical)
 * - 2+ selected: `campaignIds=<id>,<id>` in selection order
 */

/** Same limit as the API (`reportCampaignIdsSchema`). */
export const maxOverviewCampaigns = 10;

function splitIds(value: unknown): string[] {
  return typeof value === "string"
    ? value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    : [];
}

/**
 * Legacy `campaignId` first, then the `campaignIds` list; deduped, keeping the
 * first occurrence. Mirrors the API merge, so a hand-edited URL with both
 * reads the same on the page and in the report.
 */
export function parseCampaignIdsParam(
  campaignId: unknown,
  campaignIds: unknown,
): string[] {
  return [...new Set([...splitIds(campaignId), ...splitIds(campaignIds)])];
}

export function setCampaignParams(params: URLSearchParams, ids: string[]) {
  if (ids.length === 1) {
    params.set("campaignId", ids[0]!);
  } else if (ids.length > 1) {
    params.set("campaignIds", ids.join(","));
  }
}
