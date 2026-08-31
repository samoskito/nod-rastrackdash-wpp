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
      let capturedInit: RequestInit | undefined;
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedInit = init;
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
      expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
      expect(capturedInit?.redirect).toBe("error");
    });

    it("prefers saved credentials over environment credentials", async () => {
      let capturedUrl: string | undefined;
      const fetchImpl = (async (url: string) => {
        capturedUrl = url;
        return jsonResponse(200, { connected: true });
      }) as typeof fetch;
      const adapter = new ZapiWhatsappAdapter(
        {
          ZAPI_BASE_URL: "https://environment.example.com",
          ZAPI_INSTANCE_ID: "environment-instance",
          ZAPI_TOKEN: "environment-token",
        },
        fetchImpl,
      );

      const health = await adapter.getHealth({
        provider: "zapi",
        config: {
          baseUrl: "https://saved.example.com",
          instanceId: "saved-instance",
          token: "saved-token",
        },
      });

      expect(capturedUrl).toBe(
        "https://saved.example.com/instances/saved-instance/token/saved-token/status",
      );
      expect(health.status).toBe("connected");
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
      expect(health.message).toBe("Z-API instance requires QR reconnection");
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
      expect(health.message).toBe("Z-API instance requires QR reconnection");
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
      expect(health.message).toBe("Z-API instance disconnected");
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
      expect(health.message).toBe("Provider request failed");
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

    it("never treats malformed connected values as connected or reflects payload", async () => {
      const fetchImpl = (async () =>
        jsonResponse(200, {
          connected: "true",
          status: "token=super-secret-token",
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
      expect(health.message).toBe("Z-API instance disconnected");
      expect(JSON.stringify(health)).not.toContain("super-secret-token");
    });

    it.each(["http://127.0.0.1:3000", "http://169.254.169.254"])(
      "rejects unsafe base URL %s without a request",
      async (baseUrl) => {
        const fetchImpl = (async () => {
          throw new Error("must not request unsafe URL");
        }) as typeof fetch;
        const adapter = new ZapiWhatsappAdapter(
          {
            ZAPI_BASE_URL: baseUrl,
            ZAPI_INSTANCE_ID: "inst-1",
            ZAPI_TOKEN: "token-1",
          },
          fetchImpl,
        );

        const health = await adapter.getHealth();

        expect(health).toMatchObject({
          status: "error",
          message: "Invalid Z-API base URL",
        });
      },
    );
  });
});
