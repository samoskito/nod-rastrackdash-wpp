import { describe, expect, it } from "vitest";
import { ZapiWhatsappAdapter } from "../../src/integrations/whatsapp-providers/zapi-whatsapp.adapter";
import type { WhatsappProviderAdapter } from "../../src/integrations/whatsapp-providers/whatsapp-provider.types";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ZapiWhatsappAdapter", () => {
  it("has id 'zapi'", () => {
    const adapter = new ZapiWhatsappAdapter({});

    expect(adapter.id).toBe("zapi");
  });

  it("does not implement listLabels (Z-API has no Uazapi-style label catalog)", () => {
    const adapter: WhatsappProviderAdapter = new ZapiWhatsappAdapter({});

    expect(adapter.listLabels).toBeUndefined();
  });

  describe("getHealth()", () => {
    it("reports disconnected with a message when ZAPI_BASE_URL is missing", async () => {
      const adapter = new ZapiWhatsappAdapter({
        ZAPI_INSTANCE_ID: "inst-1",
        ZAPI_TOKEN: "token-1",
      });

      const health = await adapter.getHealth();

      expect(health).toEqual({
        provider: "zapi",
        status: "disconnected",
        checkedAt: expect.any(String),
        message: "Missing ZAPI_BASE_URL, ZAPI_INSTANCE_ID or ZAPI_TOKEN",
      });
    });

    it("reports disconnected with a message when ZAPI_INSTANCE_ID is missing", async () => {
      const adapter = new ZapiWhatsappAdapter({
        ZAPI_BASE_URL: "https://api.z-api.io",
        ZAPI_TOKEN: "token-1",
      });

      const health = await adapter.getHealth();

      expect(health).toEqual({
        provider: "zapi",
        status: "disconnected",
        checkedAt: expect.any(String),
        message: "Missing ZAPI_BASE_URL, ZAPI_INSTANCE_ID or ZAPI_TOKEN",
      });
    });

    it("reports disconnected with a message when ZAPI_TOKEN is missing", async () => {
      const adapter = new ZapiWhatsappAdapter({
        ZAPI_BASE_URL: "https://api.z-api.io",
        ZAPI_INSTANCE_ID: "inst-1",
      });

      const health = await adapter.getHealth();

      expect(health).toEqual({
        provider: "zapi",
        status: "disconnected",
        checkedAt: expect.any(String),
        message: "Missing ZAPI_BASE_URL, ZAPI_INSTANCE_ID or ZAPI_TOKEN",
      });
    });

    it("GETs the instance status endpoint built from base URL, instance id and token", async () => {
      let capturedUrl: string | undefined;
      const fetchImpl = (async (url: string) => {
        capturedUrl = url;
        return jsonResponse(200, { connected: true });
      }) as typeof fetch;
      const adapter = new ZapiWhatsappAdapter(
        {
          ZAPI_BASE_URL: "https://api.z-api.io/",
          ZAPI_INSTANCE_ID: "inst-1",
          ZAPI_TOKEN: "token-1",
        },
        fetchImpl,
      );

      await adapter.getHealth();

      expect(capturedUrl).toBe(
        "https://api.z-api.io/instances/inst-1/token/token-1/status",
      );
    });

    it("maps connected:true to connected", async () => {
      const fetchImpl = (async () =>
        jsonResponse(200, { connected: true })) as typeof fetch;
      const adapter = new ZapiWhatsappAdapter(
        {
          ZAPI_BASE_URL: "https://api.z-api.io",
          ZAPI_INSTANCE_ID: "inst-1",
          ZAPI_TOKEN: "token-1",
        },
        fetchImpl,
      );

      const health = await adapter.getHealth();

      expect(health.status).toBe("connected");
      expect(health.message).toBeUndefined();
    });

    it("maps connected:false with a qr status hint to needs_reconnect", async () => {
      const fetchImpl = (async () =>
        jsonResponse(200, {
          connected: false,
          status: "qrCode",
        })) as typeof fetch;
      const adapter = new ZapiWhatsappAdapter(
        {
          ZAPI_BASE_URL: "https://api.z-api.io",
          ZAPI_INSTANCE_ID: "inst-1",
          ZAPI_TOKEN: "token-1",
        },
        fetchImpl,
      );

      const health = await adapter.getHealth();

      expect(health.status).toBe("needs_reconnect");
      expect(health.message).toBe("Z-API instance status: qrCode");
    });

    it("maps connected:false with a pendingQR state hint to needs_reconnect", async () => {
      const fetchImpl = (async () =>
        jsonResponse(200, {
          connected: false,
          state: "pendingQR",
        })) as typeof fetch;
      const adapter = new ZapiWhatsappAdapter(
        {
          ZAPI_BASE_URL: "https://api.z-api.io",
          ZAPI_INSTANCE_ID: "inst-1",
          ZAPI_TOKEN: "token-1",
        },
        fetchImpl,
      );

      const health = await adapter.getHealth();

      expect(health.status).toBe("needs_reconnect");
      expect(health.message).toBe("Z-API instance status: pendingQR");
    });

    it("maps plain connected:false (no qr hint) to disconnected", async () => {
      const fetchImpl = (async () =>
        jsonResponse(200, {
          connected: false,
          status: "disconnected",
        })) as typeof fetch;
      const adapter = new ZapiWhatsappAdapter(
        {
          ZAPI_BASE_URL: "https://api.z-api.io",
          ZAPI_INSTANCE_ID: "inst-1",
          ZAPI_TOKEN: "token-1",
        },
        fetchImpl,
      );

      const health = await adapter.getHealth();

      expect(health.status).toBe("disconnected");
      expect(health.message).toBe("Z-API instance status: disconnected");
    });

    it("maps connected:false with no status/state fields to disconnected", async () => {
      const fetchImpl = (async () =>
        jsonResponse(200, { connected: false })) as typeof fetch;
      const adapter = new ZapiWhatsappAdapter(
        {
          ZAPI_BASE_URL: "https://api.z-api.io",
          ZAPI_INSTANCE_ID: "inst-1",
          ZAPI_TOKEN: "token-1",
        },
        fetchImpl,
      );

      const health = await adapter.getHealth();

      expect(health.status).toBe("disconnected");
    });

    it("reports error with the HTTP status when the status API responds non-ok", async () => {
      const fetchImpl = (async () =>
        jsonResponse(404, { message: "instance not found" })) as typeof fetch;
      const adapter = new ZapiWhatsappAdapter(
        {
          ZAPI_BASE_URL: "https://api.z-api.io",
          ZAPI_INSTANCE_ID: "inst-1",
          ZAPI_TOKEN: "token-1",
        },
        fetchImpl,
      );

      const health = await adapter.getHealth();

      expect(health.status).toBe("error");
      expect(health.message).toBe("Z-API instance status API HTTP 404");
    });

    it("never throws uncaught — reports status 'error' when fetch rejects", async () => {
      const fetchImpl = (async () => {
        throw new Error("network down");
      }) as typeof fetch;
      const adapter = new ZapiWhatsappAdapter(
        {
          ZAPI_BASE_URL: "https://api.z-api.io",
          ZAPI_INSTANCE_ID: "inst-1",
          ZAPI_TOKEN: "token-1",
        },
        fetchImpl,
      );

      const health = await adapter.getHealth();

      expect(health.status).toBe("error");
      expect(health.message).toBe("network down");
    });

    it("does not leak the token into the health response", async () => {
      const fetchImpl = (async () =>
        jsonResponse(200, { connected: true })) as typeof fetch;
      const adapter = new ZapiWhatsappAdapter(
        {
          ZAPI_BASE_URL: "https://api.z-api.io",
          ZAPI_INSTANCE_ID: "inst-1",
          ZAPI_TOKEN: "super-secret-token",
        },
        fetchImpl,
      );

      const health = await adapter.getHealth();

      expect(JSON.stringify(health)).not.toContain("super-secret-token");
    });
  });
});
