import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/inbound-webhooks/authorized-ctwa-destination", async (load) => ({
  ...(await load<
    typeof import("../../src/inbound-webhooks/authorized-ctwa-destination")
  >()),
  // The page/pixel is still authorized for the channel.
  ctwaIntentAuthorized: vi.fn(async () => true),
}));

import { resolveCtwaLeadProof } from "../../src/conversion-rules/ctwa-lead-proof";

/**
 * Tarefa 20: an Unnichat CTWA entry deferred to the provider rule keeps its
 * receipt (not_eligible, lead_submitted_deferred_to_rule) with the full CTWA
 * destination. It must remain the lead's proof of origin, so a later
 * Purchase/QualifiedLead of that lead still routes to the same page/pixel.
 */
describe("CTWA lead proof with a deferred entry receipt", () => {
  it("accepts the not_eligible deferred receipt as proof (no status filter)", async () => {
    const destination = {
      kind: "authorized_ctwa_destination",
      workspaceId: "workspace_1",
      channelId: "channel_1",
      connectionId: "connection_1",
      organizationId: "org_1",
      providerChannelId: "provider_channel_1",
      destinationId: "destination_1",
      businessConnectionId: "business_1",
      credentialId: "credential_1",
      credentialFingerprint: "fingerprint_1",
      deliveryKind: "page_pixel",
      pixelId: "pixel_1",
      pageId: "page_1",
    };
    const receipt = {
      id: "log_entry",
      adId: null,
      status: "not_eligible",
      errorCode: "lead_submitted_deferred_to_rule",
      sourcePayload: {
        provider: "unnichat",
        connectionId: "connection_1",
        channelId: "channel_1",
        inboundEventId: "event_1",
        leadSubmittedDeferredToRuleIds: ["rule_1"],
        ctwaDestination: destination,
      },
    };
    const findMany = vi.fn(async ({ where }: any) => {
      // The proof query never filters by status (deferred receipts count).
      expect(where.status).toBeUndefined();
      return [receipt];
    });
    const client = {
      conversionEventLog: { findMany },
      inboundWebhookEvent: {
        findFirst: vi.fn(async ({ where }: any) => {
          const item = where.OR[0].productionItem.is;
          return item.conversionEventLogId === "log_entry" &&
            item.status.in.includes("materialized")
            ? { id: "event_1" }
            : null;
        }),
      },
    };

    await expect(
      resolveCtwaLeadProof(client as never, {
        workspaceId: "workspace_1",
        leadId: "lead_1",
        phoneHash: "phone_1",
        ctwaClid: "clid_1",
      }),
    ).resolves.toEqual(destination);
    expect(findMany).toHaveBeenCalledOnce();
  });
});
