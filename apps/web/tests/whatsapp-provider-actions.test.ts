import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWhatsappConnectionAction,
  rotateWhatsappWebhookTokenAction,
  testWhatsappConnectionAction,
} from "../src/app/(app)/integrations/whatsapp-provider-actions";

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    toString: (): string => "wpptrack_session=test",
  })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
});

function form(values: Record<string, string>): FormData {
  const result = new FormData();
  for (const [key, value] of Object.entries(values)) result.set(key, value);
  return result;
}

describe("WhatsApp provider actions", () => {
  it("uses the API rotation contract and returns a one-time header token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          connection: {
            id: "connection_1",
            name: "WAHA comercial",
            displayName: null,
            provider: "waha",
            status: "active",
            lastHealthStatus: null,
            lastHealthCheckedAt: null,
            createdAt: "2026-08-28T12:00:00.000Z",
          },
          webhookEndpoint:
            "https://api.example.test/webhooks/whatsapp/connection_1",
          webhookToken: "a".repeat(43),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await rotateWhatsappWebhookTokenAction(
      form({ connectionId: "connection_1" }),
    );

    expect(result).toMatchObject({
      ok: true,
      receiverSecret: {
        endpoint: "https://api.example.test/webhooks/whatsapp/connection_1",
        token: "a".repeat(43),
      },
    });
    expect(result.receiverSecret?.endpoint).not.toContain("token=");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/integrations/whatsapp-connections/connection_1/rotate-webhook-token",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("preserves Testar and allows retry after a receiver error without leaking input secrets", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "receiver unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            connectionId: "connection_1",
            provider: "waha",
            status: "connected",
            checkedAt: "2026-08-28T12:00:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    const request = form({
      connectionId: "connection_1",
      apiKey: "do-not-return",
    });

    const failed = await testWhatsappConnectionAction(request);
    const retried = await testWhatsappConnectionAction(request);

    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain("do-not-return");
    expect(retried).toMatchObject({ ok: true, connectionId: "connection_1" });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "http://localhost:3333/integrations/whatsapp-connections/connection_1/test",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("validates create input locally and never echoes provider credentials", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const result = await createWhatsappConnectionAction(
      form({
        provider: "waha",
        name: "WAHA",
        baseUrl: "ftp://waha.example.test",
        apiKey: "do-not-return",
      }),
    );

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("do-not-return");
    expect(fetch).not.toHaveBeenCalled();
  });
});
