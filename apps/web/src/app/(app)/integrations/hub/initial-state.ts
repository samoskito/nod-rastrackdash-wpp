import {
  integrationTabFromQuery,
  type IntegrationProviderId,
  type IntegrationTabId,
} from "./integration-registry";

export type IntegrationsHubSearchParams = {
  aba?: string;
  meta?: string;
  notice?: string;
};

/**
 * Server-side starting point of the hub: `?aba=` picks the tab, and the
 * redirects that come back from a Meta or WhatsApp action reopen the modal
 * where that action happened so its result is in view.
 */
export function integrationsHubInitialState(
  searchParams: IntegrationsHubSearchParams,
): { tab: IntegrationTabId; provider: IntegrationProviderId | null } {
  const notice = searchParams.notice ?? "";

  if (searchParams.meta === "connected" || searchParams.meta === "error") {
    return { tab: "conversions", provider: "meta" };
  }

  if (notice.startsWith("meta-")) {
    return { tab: "conversions", provider: "meta" };
  }

  return {
    tab: integrationTabFromQuery(searchParams.aba) ?? "whatsapp",
    provider: null,
  };
}
