import { describe, expect, it } from "vitest";
import { pagePixelHarness } from "../helpers/ctwa-harness";
import { offline } from "../fase4-unnichat/helpers/first-entry-offline";
import {
  CTWA_DESTINATION_AD_HINT_REASON,
  CTWA_DESTINATION_PROVIDERS,
  CTWA_DESTINATION_REASON,
  CTWA_DESTINATION_SOURCE_TRIGGERS,
  isCtwaDestinationEntry,
  isCtwaDestinationProvider,
  resolveCtwaDestination,
} from "../../src/inbound-webhooks/authorized-ctwa-destination";
import { InboundWebhookChannelRoutesService } from "../../src/inbound-webhooks/inbound-webhook-channel-routes.service";
import { InboundWebhookMetaRouteReaderService } from "../../src/inbound-webhooks/inbound-webhook-meta-route-reader.service";
import { crmChannelDestination } from "../../src/crm-channels/crm-channel-policy";

/**
 * GoHighLevel: the same "anúncio sem id" fallback as Unnichat. A CTWA lead
 * whose ad id is missing follows the unique (pixel, page) pair of the
 * client's Meta integration. Unnichat behavior is unchanged; other providers
 * (Gupshup, Umbler, DataCrazy) keep their explicit routes. Synthetic data.
 */

function ghl<T extends { channel: any }>(h: T, provider = "gohighlevel"): T {
  h.channel.connection.provider = provider;
  h.channel.whatsappInstanceId = null;
  // GHL channels have no routing mode column set (legacy NULL): with no route
  // rows nor manual audit they inherit the workspace configuration.
  h.channel.metaRoutingMode = null;
  h.channel.providerChannelId = "location_synthetic_a";
  return h;
}

function routes(prisma: any) {
  return new InboundWebhookChannelRoutesService(
    prisma,
    new InboundWebhookMetaRouteReaderService(prisma),
  ) as any;
}

describe("GoHighLevel CTWA lead without ad id: page/pixel fallback (same as Unnichat)", () => {
  it("lists only Unnichat and GoHighLevel as fallback providers", () => {
    expect([...CTWA_DESTINATION_PROVIDERS]).toEqual(["unnichat", "gohighlevel"]);
    expect(CTWA_DESTINATION_SOURCE_TRIGGERS).toEqual([
      "inbound_webhook:unnichat",
      "inbound_webhook:gohighlevel",
    ]);
    for (const provider of ["gupshup", "umbler", "datacrazy", "uazapi", "roichat", null])
      expect(isCtwaDestinationProvider(provider)).toBe(false);
  });

  it("resolves the client's unique (pixel, page) for a GHL number", async () => {
    const h = ghl(pagePixelHarness());
    expect(await resolveCtwaDestination(h.prisma, h.channel)).toMatchObject({
      kind: "authorized_ctwa_destination",
      deliveryKind: "page_pixel",
      channelId: "ch",
      connectionId: "c",
      providerChannelId: "location_synthetic_a",
      destinationId: "dest",
      pixelId: "synthetic_pixel",
      pageId: "synthetic_page",
    });
    // The CRM path for a GHL number is unchanged (same destination).
    expect(await crmChannelDestination(h.prisma, h.channel)).toMatchObject({
      kind: "authorized_ctwa_destination",
      destinationId: "dest",
    });
  });

  it("classifies a GHL entry without adId as routed by the page/pixel destination (no more route_ad_missing)", async () => {
    const h = ghl(pagePixelHarness());
    const decision = await routes(h.prisma).evaluateEventRoute(h.channel, null);
    expect(decision).toMatchObject({
      classification: "eligible_route_resolved",
      reason: CTWA_DESTINATION_REASON,
      preview: {
        businessConnectionId: "bm",
        reportingAccountId: null,
        conversionDestinationId: "dest",
      },
    });
    expect(
      isCtwaDestinationEntry({
        provider: "gohighlevel",
        classificationReason: CTWA_DESTINATION_REASON,
        adId: null,
      }),
    ).toBe(true);
    expect(
      isCtwaDestinationEntry({
        provider: "gohighlevel",
        classificationReason: CTWA_DESTINATION_AD_HINT_REASON,
        adId: "120000000000000001",
      }),
    ).toBe(true);
  });

  it("never guesses: two (pixel, page) pairs keep the GHL entry unresolved", async () => {
    const h = ghl(pagePixelHarness());
    h.accounts[0]!.allowedDestinations = ["dest", "other"].map(
      (conversionDestinationId) => ({
        active: true,
        conversionDestinationId,
        workspaceId: "w",
        reportingAccountId: h.accounts[0]!.id,
      }),
    ) as any;
    h.prisma.metaConversionDestination.findMany.mockResolvedValue([
      h.destination,
      { ...h.destination, id: "other", pixelId: "other_pixel", pageId: "other_page" },
    ]);
    expect(await routes(h.prisma).evaluateEventRoute(h.channel, null)).toMatchObject({
      classification: "eligible_route_unresolved",
      reason: "ctwa_destination_ambiguous",
    });
  });

  it("keeps Unnichat exactly as before (regression)", async () => {
    const h = pagePixelHarness();
    expect(h.channel.connection.provider).toBe("unnichat");
    expect(await routes(h.prisma).evaluateEventRoute(h.channel, null)).toMatchObject({
      classification: "eligible_route_resolved",
      reason: CTWA_DESTINATION_REASON,
    });
    expect(
      isCtwaDestinationEntry({
        provider: "unnichat",
        classificationReason: CTWA_DESTINATION_REASON,
        adId: null,
      }),
    ).toBe(true);
  });

  it("production materializes the GHL entry without adId on the page/pixel and sends one event to Meta", async () => {
    const base = offline({ provider: "gohighlevel" });
    const h = { ...base, ...pagePixelHarness(base) };
    await h.production.processItem({ workspaceId: "w", productionItemId: "item" });
    expect(h.item.status).toBe("materialized");
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({
      eventName: "LeadSubmitted",
      sourceTrigger: "inbound_webhook:gohighlevel",
      status: "ready_to_send",
      adId: null,
      metaAccountId: null,
      campaignId: null,
      ctwaClid: "synthetic-ghl-click",
    });
    expect(h.logs[0].sourcePayload).toMatchObject({
      provider: "gohighlevel",
      channelId: "ch",
      processingMode: "live_production",
      ctwaDestination: { deliveryKind: "page_pixel", pixelId: "synthetic_pixel" },
    });
    expect(h.leads[0]).toMatchObject({ source: "gohighlevel" });
    expect(await h.processor.process(h.jobs[0])).toMatchObject({ status: "sent" });
    // A retry of the same item never sends twice.
    await h.production.processItem({ workspaceId: "w", productionItemId: "item" });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toContain("/synthetic_pixel/events");
    expect(h.calls[0].body.data[0].user_data).toMatchObject({
      page_id: "synthetic_page",
      ctwa_clid: "synthetic-ghl-click",
    });
    expect(h.calls[0].body.data[0].custom_data).not.toHaveProperty("ad_id");
  });

  it("other providers keep their explicit routes (Gupshup, Umbler, DataCrazy)", async () => {
    for (const provider of ["gupshup", "umbler", "datacrazy"]) {
      const h = ghl(pagePixelHarness(), provider);
      expect(await resolveCtwaDestination(h.prisma, h.channel)).toEqual({
        kind: "blocked_ctwa_destination",
        reason: "ctwa_channel_scope_invalid",
      });
      expect(await routes(h.prisma).evaluateEventRoute(h.channel, null)).toMatchObject({
        classification: "eligible_route_unresolved",
        reason: "route_ad_missing",
      });
    }
  });
});
