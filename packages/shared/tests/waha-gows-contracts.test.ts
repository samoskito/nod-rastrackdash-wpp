import { describe, expect, it } from "vitest";
import {
  inboundWebhookProviderSchema,
  WAHA_GOWS_WEBHOOK_EVENTS,
  WAHA_WEBHOOK_TOKEN_HEADER,
  whatsappConnectionTestResultSchema,
  whatsappConnectionWebhookConfigureResultSchema,
  whatsappConnectionWebhookTokenRotateResultSchema,
} from "../src";

const connection = {
  id: "connection-waha",
  name: "WAHA do cliente",
  displayName: null,
  provider: "waha" as const,
  status: "active" as const,
  lastHealthStatus: "connected",
  lastHealthCheckedAt: "2026-10-22T12:00:00.000Z",
  connectedPhone: null,
  createdAt: "2026-10-22T12:00:00.000Z",
};

describe("WAHA GoWS contracts for the connection screen", () => {
  it("lists the webhook events and the token header", () => {
    expect(WAHA_GOWS_WEBHOOK_EVENTS).toEqual([
      "message",
      "message.any",
      "session.status",
    ]);
    expect(WAHA_WEBHOOK_TOKEN_HEADER).toBe("X-Wpptrack-Webhook-Token");
    expect(inboundWebhookProviderSchema.parse("waha")).toBe("waha");
  });

  it("accepts the configure-webhook result (success and failure) and rejects extra fields", () => {
    const success = {
      connectionId: "connection-waha",
      provider: "waha",
      configured: true,
      webhookEndpoint: "https://api.example.com/webhooks/whatsapp/connection-waha",
      events: ["message", "message.any", "session.status"],
      sessionStatus: "WORKING",
    };
    expect(whatsappConnectionWebhookConfigureResultSchema.parse(success)).toEqual(
      success,
    );
    expect(
      whatsappConnectionWebhookConfigureResultSchema.parse({
        ...success,
        configured: false,
        sessionStatus: null,
        reason: "engine_not_supported",
        message: "Esta sessão usa o motor NOWEB.",
      }).reason,
    ).toBe("engine_not_supported");
    expect(() =>
      whatsappConnectionWebhookConfigureResultSchema.parse({
        ...success,
        webhookToken: "never-returned",
      }),
    ).toThrow();
  });

  it("keeps the manual setup optional on the token rotation result", () => {
    const base = {
      connection,
      webhookEndpoint: "https://api.example.com/webhooks/whatsapp/connection-waha",
      webhookToken: "t".repeat(43),
    };
    expect(whatsappConnectionWebhookTokenRotateResultSchema.parse(base)).toEqual(base);
    expect(
      whatsappConnectionWebhookTokenRotateResultSchema.parse({
        ...base,
        wahaManualSetup: {
          webhookUrl: base.webhookEndpoint,
          webhookUrlWithToken: `${base.webhookEndpoint}?token=${base.webhookToken}`,
          events: [...WAHA_GOWS_WEBHOOK_EVENTS],
          tokenHeaderName: WAHA_WEBHOOK_TOKEN_HEADER,
        },
      }).wahaManualSetup?.events,
    ).toHaveLength(3);
  });

  it("accepts the raw WAHA session status on the test result", () => {
    expect(
      whatsappConnectionTestResultSchema.parse({
        connectionId: "connection-waha",
        provider: "waha",
        status: "needs_reconnect",
        checkedAt: "2026-10-22T12:00:00.000Z",
        providerStatus: "SCAN_QR_CODE",
      }).providerStatus,
    ).toBe("SCAN_QR_CODE");
  });
});
