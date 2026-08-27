import { describe, expect, it } from "vitest";
import { UazapiAdapter } from "../../src/integrations/uazapi/uazapi.adapter";
import { UazapiByoAdapter } from "../../src/integrations/whatsapp-providers/uazapi-byo.adapter";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("UazapiByoAdapter", () => {
  it("has id 'uazapi_byo'", () => {
    const adapter = new UazapiByoAdapter(new UazapiAdapter({}));

    expect(adapter.id).toBe("uazapi_byo");
  });

  it("getHealth() reports disconnected with a message when credentials are missing", async () => {
    const adapter = new UazapiByoAdapter(new UazapiAdapter({}));

    const health = await adapter.getHealth();

    expect(health).toEqual({
      provider: "uazapi_byo",
      status: "disconnected",
      checkedAt: expect.any(String),
      message: "Missing UAZAPI_BASE_URL or UAZAPI_TOKEN",
    });
  });

  it("uses the legacy environment health fallback when no connection config is supplied", async () => {
    const adapter = new UazapiByoAdapter(
      new UazapiAdapter({
        UAZAPI_BASE_URL: "https://uazapi.example.com",
        UAZAPI_TOKEN: "instance-token",
      }),
    );

    const health = await adapter.getHealth();

    expect(health.provider).toBe("uazapi_byo");
    expect(health.status).toBe("connected");
    expect(health.message).toBeUndefined();
  });

  describe("getHealth() with saved Uazapi connection credentials", () => {
    const connectionConfig = {
      provider: "uazapi_byo" as const,
      config: {
        baseUrl: "https://uazapi.example.com/",
        token: "connection-token",
      },
    };

    it("checks the saved connection status with its own URL and token", async () => {
      let capturedUrl: string | undefined;
      let capturedHeaders: Record<string, string> | undefined;
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedHeaders = init?.headers as Record<string, string>;
        return jsonResponse(200, { instance: { status: "connected" } });
      }) as typeof fetch;
      const adapter = new UazapiByoAdapter(
        new UazapiAdapter(
          {
            UAZAPI_BASE_URL: "https://legacy.example.com",
            UAZAPI_TOKEN: "legacy-token",
          },
          fetchImpl,
        ),
      );

      const health = await adapter.getHealth(connectionConfig);

      expect(capturedUrl).toBe("https://uazapi.example.com/instance/status");
      expect(capturedHeaders?.token).toBe("connection-token");
      expect(health.status).toBe("connected");
      expect(health.message).toBeUndefined();
    });

    it.each([
      ["disconnected", "disconnected", "disconnected"],
      ["qr", "needs_reconnect", "qr_required"],
      ["connecting", "syncing", "pending"],
      ["error", "error", "error"],
    ] as const)(
      "maps Uazapi %s status to %s",
      async (providerStatus, expectedStatus, expectedMessageStatus) => {
        const fetchImpl = (async () =>
          jsonResponse(200, {
            instance: { status: providerStatus },
          })) as typeof fetch;
        const adapter = new UazapiByoAdapter(new UazapiAdapter({}, fetchImpl));

        const health = await adapter.getHealth(connectionConfig);

        expect(health.status).toBe(expectedStatus);
        expect(health.message).toBe(
          `Uazapi instance status: ${expectedMessageStatus}`,
        );
      },
    );

    it("fails closed on a non-2xx response without leaking saved credentials", async () => {
      const fetchImpl = (async () =>
        jsonResponse(401, {
          message:
            "Unauthorized https://uazapi.example.com/?token=connection-token",
        })) as typeof fetch;
      const adapter = new UazapiByoAdapter(new UazapiAdapter({}, fetchImpl));

      const health = await adapter.getHealth(connectionConfig);

      expect(health.status).toBe("error");
      expect(health.message).toBe("Uazapi instance status: error");
      expect(JSON.stringify(health)).not.toContain("connection-token");
      expect(JSON.stringify(health)).not.toContain("uazapi.example.com");
    });

    it.each([new Error("network down"), new Error("timeout connection-token")])(
      "fails closed on network or timeout errors without leaking credentials",
      async (error) => {
        const fetchImpl = (async () => {
          throw error;
        }) as typeof fetch;
        const adapter = new UazapiByoAdapter(new UazapiAdapter({}, fetchImpl));

        const health = await adapter.getHealth(connectionConfig);

        expect(health.status).toBe("error");
        expect(health.message).toBe("Uazapi instance status: error");
        expect(JSON.stringify(health)).not.toContain("connection-token");
      },
    );

    it("reports disconnected without a request when saved credentials are absent", async () => {
      const fetchImpl = (async () => {
        throw new Error("should not be called");
      }) as typeof fetch;
      const adapter = new UazapiByoAdapter(new UazapiAdapter({}, fetchImpl));

      const health = await adapter.getHealth({
        provider: "uazapi_byo",
        config: { baseUrl: "  ", token: "" },
      });

      expect(health).toEqual({
        provider: "uazapi_byo",
        status: "disconnected",
        checkedAt: expect.any(String),
        message: "Missing Uazapi connection credentials",
      });
    });
  });

  it("listLabels() delegates to the wrapped UazapiAdapter and returns its labels", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify([{ id: "1", name: "VIP", labelid: "1" }]), {
        status: 200,
      })) as typeof fetch;
    const adapter = new UazapiByoAdapter(
      new UazapiAdapter(
        {
          UAZAPI_BASE_URL: "https://uazapi.example.com",
          UAZAPI_TOKEN: "instance-token",
        },
        fetchImpl,
      ),
    );

    const result = await adapter.listLabels?.("instance-1");

    expect(result?.status).toBe("success");
    expect(result?.labels).toEqual([
      { id: "1", name: "VIP", colorHex: null, labelId: "1" },
    ]);
  });
});
