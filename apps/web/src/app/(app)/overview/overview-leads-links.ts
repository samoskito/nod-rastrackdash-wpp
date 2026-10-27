// Shared by the overview page and its tests: page modules may only export the
// page itself.

export type OverviewLeadsScope = {
  adAccountId?: string;
  businessId?: string;
  whatsappInstanceId?: string;
  campaignIds: string[];
};

/**
 * The Leads list that reproduces an overview number, or null when the Leads
 * page cannot. The overview counts leads de anúncio, so the link carries that
 * origin.
 * - The Leads page has no BM/conta filter and takes a single campaign.
 * - "returning" and "repeat" count conversations by the campaign of each
 *   conversation, while the Leads campaign filter follows the FIRST contact:
 *   with a campaign they could disagree, so no link.
 * - "repeat" with a WhatsApp number: the overview only sees conversations
 *   that carry the lead id, while the Leads page also links the ones without
 *   it by phone, so the totals could differ: no link.
 * - "returning" needs a period start (without one nobody came "back") and
 *   "repeat" a period (conversations inside it).
 */
export function overviewLeadsHref(
  scope: OverviewLeadsScope,
  period: { since?: string | null; until?: string | null },
  base: "new" | "returning" | "repeat",
  attribution: "paid" | "organic" = "paid",
): string | null {
  if (scope.businessId || scope.adAccountId || scope.campaignIds.length > 1) {
    return null;
  }

  const since = period.since ?? undefined;
  const until = period.until ?? undefined;

  if (base !== "new" && (scope.campaignIds.length > 0 || !since)) {
    return null;
  }

  if (base === "repeat" && scope.whatsappInstanceId) {
    return null;
  }

  // Same key order as the Leads page builds its own links.
  const params = new URLSearchParams();

  if (scope.campaignIds[0]) {
    params.set("campaignId", scope.campaignIds[0]);
  }

  if (scope.whatsappInstanceId) {
    params.set("whatsappInstanceId", scope.whatsappInstanceId);
  }

  params.set("attribution", attribution);

  if (since) {
    params.set("since", since);
  }

  if (until) {
    params.set("until", until);
  }

  if (base !== "new") {
    params.set("base", base);
  }

  return `/leads?${params.toString()}`;
}
