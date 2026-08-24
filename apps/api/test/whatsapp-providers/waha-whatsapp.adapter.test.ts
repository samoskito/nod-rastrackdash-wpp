import { describe, expect, it } from "vitest";
import { WahaWhatsappAdapter } from "../../src/integrations/whatsapp-providers/waha-whatsapp.adapter";
import type { WhatsappProviderAdapter } from "../../src/integrations/whatsapp-providers/whatsapp-provider.types";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("WahaWhatsappAdapter", () => {
  it("has id 'waha'", () => {
    const adapter = new WahaWhatsappAdapter({});

    expect(adapter.id).toBe("waha");
  });

  it("does not implement listLabels (WAHA has no label catalog)", () => {
    const adapter: WhatsappProviderAdapter = new WahaWhatsappAdapter({});

    expect(adapter.listLabels).toBeUndefined();
  });

  describe("getHealth()", () => {
    it("reports disconnected with a message when WAHA_BASE_URL is missing", async () => {
      const adapter = new WahaWhatsappAdapter({ WAHA_API_KEY: "key-123" });

      const health = await adapter.getHealth();

      expect(health).toEqual({
        provider: "waha",
        status: "disconnected",
        checkedAt: expect.any(String),
        message: "Missing WAHA_BASE_URL or WAHA_API_KEY",
      });
    });

    it("reports disconnected with a message when WAHA_API_KEY is missing", async () => {
      const adapter = new WahaWhatsappAdapter({
        WAHA_BASE_URL: "http://waha:3000",
      });

      const health = await adapter.getHealth();

      expect(health).toEqual({
        provider: "waha",
        status: "disconnected",
        checkedAt: expect.any(String),
        message: "Missing WAHA_BASE_URL or WAHA_API_KEY",
      });
    });

    it("GETs the session status with X-Api-Key header, default session 'default'", async () => {
      let capturedUrl: string | undefined;
      let capturedHeaders: Record<string, string> | undefined;
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedHeaders = init?.headers as Record<string, string>;
        return jsonResponse(200, { status: "WORKING" });
      }) as typeof fetch;
      const adapter = new WahaWhatsappAdapter(
        { WAHA_BASE_URL: "http://waha:3000", WAHA_API_KEY: "key-123" },
        fetchImpl,
      );

      await adapter.getHealth();

      expect(capturedUrl).toBe("http://waha:3000/api/sessions/default");
      expect(capturedHeaders?.["X-Api-Key"]).toBe("key-123");
    });

    it("uses WAHA_SESSION when set", async () => {
      let capturedUrl: string | undefined;
      const fetchImpl = (async (url: string) => {
        capturedUrl = url;
        return jsonResponse(200, { status: "WORKING" });
      }) as typeof fetch;
      const adapter = new WahaWhatsappAdapter(
        {
          WAHA_BASE_URL: "http://waha:3000/",
          WAHA_API_KEY: "key-123",
          WAHA_SESSION: "sales",
        },
        fetchImpl,
      );

      await adapter.getHealth();

      expect(capturedUrl).toBe("http://waha:3000/api/sessions/sales");
    });

    it("maps WORKING to connected", async () => {
      const fetchImpl = (async () =>
        jsonResponse(200, { status: "WORKING" })) as typeof fetch;
      const adapter = new WahaWhatsappAdapter(
        { WAHA_BASE_URL: "http://waha:3000", WAHA_API_KEY: "key-123" },
        fetchImpl,
      );

      const health = await adapter.getHealth();

      expect(health.status).toBe("connected");
      expect(health.message).toBeUndefined();
    });

    it("maps authenticated to connected", async () => {
      const fetchImpl = (async () =>
        jsonResponse(200, { status: "authenticated" })) as typeof fetch;
      const adapter = new WahaWhatsappAdapter(
        { WAHA_BASE_URL: "http://waha:3000", WAHA_API_KEY: "key-123" },
        fetchImpl,
      );

      const health = await adapter.getHealth();

      expect(health.status).toBe("connected");
    });

    it("maps SCAN_QR_CODE to needs_reconnect", async () => {
      const fetchImpl = (async () =>
        jsonResponse(200, { status: "SCAN_QR_CODE" })) as typeof fetch;
      const adapter = new WahaWhatsappAdapter(
        { WAHA_BASE_URL: "http://waha:3000", WAHA_API_KEY: "key-123" },
        fetchImpl,
      );

      const health = await adapter.getHealth();

      expect(health.status).toBe("needs_reconnect");
      expect(health.message).toBe("WAHA session status: SCAN_QR_CODE");
    });

    it("maps STOPPED to disconnected", async () => {
      const fetchImpl = (async () =>
        jsonResponse(200, { status: "STOPPED" })) as typeof fetch;
      const adapter = new WahaWhatsappAdapter(
        { WAHA_BASE_URL: "http://waha:3000", WAHA_API_KEY: "key-123" },
        fetchImpl,
      );

      const health = await adapter.getHealth();

      expect(health.status).toBe("disconnected");
      expect(health.message).toBe("WAHA session status: STOPPED");
    });

    it("maps FAILED to error", async () => {
      const fetchImpl = (async () =>
        jsonResponse(200, { status: "FAILED" })) as typeof fetch;
      const adapter = new WahaWhatsappAdapter(
        { WAHA_BASE_URL: "http://waha:3000", WAHA_API_KEY: "key-123" },
        fetchImpl,
      );

      const health = await adapter.getHealth();

      expect(health.status).toBe("error");
      expect(health.message).toBe("WAHA session status: FAILED");
    });

    it("reports error with the HTTP status when the session API responds non-ok", async () => {
      const fetchImpl = (async () =>
        jsonResponse(404, { message: "session not found" })) as typeof fetch;
      const adapter = new WahaWhatsappAdapter(
        { WAHA_BASE_URL: "http://waha:3000", WAHA_API_KEY: "key-123" },
        fetchImpl,
      );

      const health = await adapter.getHealth();

      expect(health.status).toBe("error");
      expect(health.message).toBe("WAHA session API HTTP 404");
    });

    it("never throws uncaught — reports status 'error' when fetch rejects", async () => {
      const fetchImpl = (async () => {
        throw new Error("network down");
      }) as typeof fetch;
      const adapter = new WahaWhatsappAdapter(
        { WAHA_BASE_URL: "http://waha:3000", WAHA_API_KEY: "key-123" },
        fetchImpl,
      );

      const health = await adapter.getHealth();

      expect(health.status).toBe("error");
      expect(health.message).toBe("network down");
    });

    it("does not leak the API key into the health response", async () => {
      const fetchImpl = (async () =>
        jsonResponse(200, { status: "WORKING" })) as typeof fetch;
      const adapter = new WahaWhatsappAdapter(
        { WAHA_BASE_URL: "http://waha:3000", WAHA_API_KEY: "super-secret-key" },
        fetchImpl,
      );

      const health = await adapter.getHealth();

      expect(JSON.stringify(health)).not.toContain("super-secret-key");
    });
  });
});
