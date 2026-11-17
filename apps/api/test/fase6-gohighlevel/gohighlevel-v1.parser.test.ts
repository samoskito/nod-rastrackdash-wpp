import { describe, expect, it } from "vitest";
import { buildInboundWebhookEventDedupeKey } from "../../src/inbound-webhooks/providers/inbound-webhook-parser";
import { InboundWebhookParserRegistry } from "../../src/inbound-webhooks/providers/inbound-webhook-parser.registry";
import {
  GOHIGHLEVEL_V1_PROVIDER,
  GoHighLevelV1Parser,
} from "../../src/inbound-webhooks/providers/gohighlevel/gohighlevel-v1.parser";

const parser = new GoHighLevelV1Parser();
const context = {
  organizationId: "workspace_synthetic_001",
  connectedPhone: "+15550008888",
};

function ghlContact(overrides: Record<string, unknown> = {}) {
  return {
    attributionSource: {
      ctwa_clid: "synthetic-ctwa-clid-primary",
      adId: "ad_synthetic_primary",
      url: "https://ads.example.test/primary",
      adName: "Synthetic Primary Ad",
    },
    lastAttributionSource: {
      ctwa_clid: "synthetic-ctwa-clid-last",
      adId: "ad_synthetic_last",
      url: "https://ads.example.test/last",
      adName: "Synthetic Last Ad",
    },
    ...overrides,
  };
}

function ghlBody(overrides: Record<string, unknown> = {}) {
  return {
    contact_id: "contact_synthetic_001",
    phone: "+15550001111",
    full_name: "Synthetic Example Lead",
    date_created: "2026-10-01T12:34:56.000Z",
    location: {
      id: "location_synthetic_001",
      name: "Synthetic Clinic",
    },
    workflow: { id: "workflow_synthetic_001", name: "Synthetic Workflow" },
    contact: ghlContact(),
    attributionSource: {},
    ...overrides,
  };
}

describe("GoHighLevel v1 inbound webhook parser", () => {
  it("unwraps the sanitized n8n body and prefers contact.attributionSource CTWA", () => {
    const result = parser.parse([{ body: ghlBody() }], context);
    const event = result.events[0]!;
    const expectedExternalMessageId =
      "contact_synthetic_001:2026-10-01T12:34:56.000Z:workflow_synthetic_001";

    expect(result).toMatchObject({
      provider: "gohighlevel",
      parserVersion: "v1",
      classification: "eligible_route_unresolved",
      error: null,
    });
    expect(event).toMatchObject({
      externalMessageId: expectedExternalMessageId,
      organizationId: "workspace_synthetic_001",
      channel: {
        providerChannelId: "location_synthetic_001",
        name: "Synthetic Clinic",
        connectedPhone: "+15550008888",
      },
      contact: {
        externalContactId: "contact_synthetic_001",
        phoneNumber: "+15550001111",
        name: "Synthetic Example Lead",
      },
      message: { direction: "inbound", text: null },
      ctwaClid: "synthetic-ctwa-clid-primary",
      adId: "ad_synthetic_primary",
      ad: {
        sourceUrl: "https://ads.example.test/primary",
        title: "Synthetic Primary Ad",
      },
      hasCtwa: true,
    });
    expect(event.dedupeKey).toBe(
      buildInboundWebhookEventDedupeKey({
        provider: GOHIGHLEVEL_V1_PROVIDER,
        organizationId: "workspace_synthetic_001",
        providerChannelId: "location_synthetic_001",
        externalMessageId: expectedExternalMessageId,
      }),
    );
  });

  it("uses lastAttributionSource only when the primary nested source has no CTWA", () => {
    const result = parser.parse(
      [
        {
          body: ghlBody({
            user: { phone: "+15550009999" },
            "CTWA Clid": "",
            contact: ghlContact({
              attributionSource: {
                adId: "ad_synthetic_facebook_form",
                url: "https://ads.example.test/facebook-form",
                adName: "Synthetic Form Ad",
                medium: "facebook",
              },
              lastAttributionSource: {
                ctwa_clid: "synthetic-ctwa-clid-last",
                adId: "ad_synthetic_last",
                url: "https://ads.example.test/last",
                adName: "Synthetic Last Ad",
                medium: "whatsapp",
              },
            }),
          }),
        },
      ],
      context,
    );

    expect(result).toMatchObject({
      classification: "eligible_route_unresolved",
    });
    expect(result.events[0]).toMatchObject({
      channel: { connectedPhone: "+15550008888" },
      ctwaClid: "synthetic-ctwa-clid-last",
      adId: "ad_synthetic_last",
      ad: {
        sourceUrl: "https://ads.example.test/last",
        title: "Synthetic Last Ad",
      },
      hasCtwa: true,
    });
  });

  it("accepts a direct object but observes it without CTWA when both nested sources are empty", () => {
    const result = parser.parse(
      ghlBody({
        contact: ghlContact({
          attributionSource: { ctwa_clid: "" },
          lastAttributionSource: { ctwa_clid: "" },
        }),
        attributionSource: { ctwa_clid: "synthetic-root-must-be-ignored" },
        "CTWA Clid": "synthetic-custom-root-must-be-ignored",
      }),
      context,
    );

    expect(result).toMatchObject({
      classification: "ignored_no_ctwa",
      error: null,
      events: [
        {
          hasCtwa: false,
          ctwaClid: null,
          adId: null,
          ad: null,
          classificationReason: "ctwa_missing",
          message: { direction: "inbound", text: null },
        },
      ],
    });
  });

  it("requires context-provided organization and connected-phone binds", () => {
    const payload = ghlBody({
      organizationId: "payload-organization-must-ignore",
    });

    expect(parser.parse(payload)).toMatchObject({
      classification: "invalid_payload",
      classificationReason: "organization_context_missing",
      error: { code: "gohighlevel_v1_invalid_payload" },
    });
    expect(
      parser.parse(payload, { organizationId: context.organizationId }),
    ).toMatchObject({
      classification: "invalid_payload",
      classificationReason: "connected_phone_context_missing",
      error: { code: "gohighlevel_v1_invalid_payload" },
    });
    expect(parser.parse(payload, context).events[0]?.organizationId).toBe(
      context.organizationId,
    );
  });

  it("fails closed when location identity is absent", () => {
    const result = parser.parse(
      ghlBody({ location: { name: "Label only" } }),
      context,
    );

    expect(result).toMatchObject({
      classification: "invalid_payload",
      classificationReason: "payload_validation_failed",
      events: [],
      error: { code: "gohighlevel_v1_invalid_payload" },
    });
  });

  it("registers the exact gohighlevel v1 parser", () => {
    const parserFromRegistry = new InboundWebhookParserRegistry().resolve({
      provider: "gohighlevel",
      parserVersion: "v1",
    });

    expect(parserFromRegistry).toBeInstanceOf(GoHighLevelV1Parser);
  });
});
