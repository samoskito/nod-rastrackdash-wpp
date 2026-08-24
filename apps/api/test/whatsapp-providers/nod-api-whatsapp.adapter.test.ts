import { describe, expect, it } from "vitest";
import { NodApiWhatsappAdapter } from "../../src/integrations/whatsapp-providers/nod-api-whatsapp.adapter";
import type { LicenseClientService } from "../../src/licensing-client/license-client.service";

function fakeLicenseClient(fingerprint = "fp-123"): LicenseClientService {
  return {
    getFingerprint: () => fingerprint,
  } as unknown as LicenseClientService;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("NodApiWhatsappAdapter", () => {
  it("has id 'nod_api'", () => {
    const adapter = new NodApiWhatsappAdapter(fakeLicenseClient(), {});

    expect(adapter.id).toBe("nod_api");
  });

  describe("getHealth()", () => {
    it("reports disconnected with a message when LICENSE_KEY is missing", async () => {
      const adapter = new NodApiWhatsappAdapter(fakeLicenseClient(), {});

      const health = await adapter.getHealth();

      expect(health).toEqual({
        provider: "nod_api",
        status: "disconnected",
        checkedAt: expect.any(String),
        message: "Missing LICENSE_KEY",
      });
    });

    it("sends license headers to the configured broker and reports connected when nodApiEnabled + upstreamConfigured", async () => {
      let capturedUrl: string | undefined;
      let capturedHeaders: Record<string, string> | undefined;
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedHeaders = init?.headers as Record<string, string>;
        return jsonResponse(200, { nodApiEnabled: true, upstreamConfigured: true });
      }) as typeof fetch;

      const adapter = new NodApiWhatsappAdapter(
        fakeLicenseClient("fp-abc"),
        {
          LICENSE_KEY: "lic-key",
          LICENSE_ACCOUNT_IDENTITY: "owner@example.com",
          NOD_API_BROKER_URL: "https://broker.example.com",
        },
        fetchImpl,
      );

      const health = await adapter.getHealth();

      expect(capturedUrl).toBe("https://broker.example.com/nod-api/health");
      expect(capturedHeaders?.["x-license-key"]).toBe("lic-key");
      expect(capturedHeaders?.["x-license-fingerprint"]).toBe("fp-abc");
      expect(capturedHeaders?.["x-license-account-identity"]).toBe(
        "owner@example.com",
      );
      expect(health.status).toBe("connected");
      expect(health.message).toBeUndefined();
    });

    it("defaults to the prod broker URL when NOD_API_BROKER_URL is unset", async () => {
      let capturedUrl: string | undefined;
      const fetchImpl = (async (url: string) => {
        capturedUrl = url;
        return jsonResponse(200, { nodApiEnabled: true, upstreamConfigured: true });
      }) as typeof fetch;
      const adapter = new NodApiWhatsappAdapter(
        fakeLicenseClient(),
        { LICENSE_KEY: "lic-key" },
        fetchImpl,
      );

      await adapter.getHealth();

      expect(capturedUrl).toBe("https://wpptrack-api.rastrack.app/nod-api/health");
    });

    it("reports needs_reconnect when nodApiEnabled but upstream is not configured", async () => {
      const fetchImpl = (async () =>
        jsonResponse(200, { nodApiEnabled: true, upstreamConfigured: false })) as typeof fetch;
      const adapter = new NodApiWhatsappAdapter(
        fakeLicenseClient(),
        { LICENSE_KEY: "lic-key" },
        fetchImpl,
      );

      const health = await adapter.getHealth();

      expect(health.status).toBe("needs_reconnect");
      expect(health.message).toBe("NOD API broker upstream not configured yet");
    });

    it("reports disconnected 'NOD API not enabled on license' on HTTP 403 nod_api_disabled", async () => {
      const fetchImpl = (async () =>
        jsonResponse(403, { code: "nod_api_disabled" })) as typeof fetch;
      const adapter = new NodApiWhatsappAdapter(
        fakeLicenseClient(),
        { LICENSE_KEY: "lic-key" },
        fetchImpl,
      );

      const health = await adapter.getHealth();

      expect(health).toEqual({
        provider: "nod_api",
        status: "disconnected",
        checkedAt: expect.any(String),
        message: "NOD API not enabled on license",
      });
    });

    it("reports needs_reconnect on nod_api_invalid_license / license_blocked / expired", async () => {
      const fetchImpl = (async () =>
        jsonResponse(401, {
          code: "nod_api_invalid_license",
          message: "License is invalid",
        })) as typeof fetch;
      const adapter = new NodApiWhatsappAdapter(
        fakeLicenseClient(),
        { LICENSE_KEY: "lic-key" },
        fetchImpl,
      );

      const health = await adapter.getHealth();

      expect(health.status).toBe("needs_reconnect");
      expect(health.message).toBe("License is invalid");
    });

    it("never throws uncaught — reports status 'error' when fetch rejects", async () => {
      const fetchImpl = (async () => {
        throw new Error("network down");
      }) as typeof fetch;
      const adapter = new NodApiWhatsappAdapter(
        fakeLicenseClient(),
        { LICENSE_KEY: "lic-key" },
        fetchImpl,
      );

      const health = await adapter.getHealth();

      expect(health.status).toBe("error");
      expect(health.message).toBe("network down");
    });

    it("scrubs admin* fields from the broker payload before returning", async () => {
      const fetchImpl = (async () =>
        jsonResponse(200, {
          nodApiEnabled: true,
          upstreamConfigured: true,
          adminToken: "should-not-leak",
        })) as typeof fetch;
      const adapter = new NodApiWhatsappAdapter(
        fakeLicenseClient(),
        { LICENSE_KEY: "lic-key" },
        fetchImpl,
      );

      const health = await adapter.getHealth();

      expect(JSON.stringify(health)).not.toContain("should-not-leak");
    });
  });

  describe("createManagedInstance()", () => {
    it("posts to /nod-api/instances and returns the created instance", async () => {
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        expect(url).toBe("https://wpptrack-api.rastrack.app/nod-api/instances");
        expect(JSON.parse(init?.body as string)).toEqual({ name: "sales" });
        return jsonResponse(200, {
          instanceId: "inst-1",
          instanceToken: "tok-1",
          status: "pending",
        });
      }) as typeof fetch;
      const adapter = new NodApiWhatsappAdapter(
        fakeLicenseClient(),
        { LICENSE_KEY: "lic-key" },
        fetchImpl,
      );

      const result = await adapter.createManagedInstance?.("sales");

      expect(result).toEqual({
        instanceId: "inst-1",
        instanceToken: "tok-1",
        status: "pending",
      });
    });

    it("throws when the broker reports nod_api_disabled", async () => {
      const fetchImpl = (async () =>
        jsonResponse(403, {
          code: "nod_api_disabled",
          message: "NOD API not enabled",
        })) as typeof fetch;
      const adapter = new NodApiWhatsappAdapter(
        fakeLicenseClient(),
        { LICENSE_KEY: "lic-key" },
        fetchImpl,
      );

      await expect(adapter.createManagedInstance?.()).rejects.toThrow(
        /nod_api_disabled|NOD API not enabled/,
      );
    });

    it("throws nod_api_missing_license_key when LICENSE_KEY is unset", async () => {
      const adapter = new NodApiWhatsappAdapter(fakeLicenseClient(), {});

      await expect(adapter.createManagedInstance?.()).rejects.toThrow(
        "nod_api_missing_license_key",
      );
    });
  });

  describe("getManagedInstanceStatus()", () => {
    it("posts instanceId + instanceToken and returns status/qr/phone", async () => {
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        expect(url).toBe(
          "https://wpptrack-api.rastrack.app/nod-api/instances/status",
        );
        expect(JSON.parse(init?.body as string)).toEqual({
          instanceId: "inst-1",
          instanceToken: "tok-1",
        });
        return jsonResponse(200, { status: "connected", phone: "+551199999999" });
      }) as typeof fetch;
      const adapter = new NodApiWhatsappAdapter(
        fakeLicenseClient(),
        { LICENSE_KEY: "lic-key" },
        fetchImpl,
      );

      const result = await adapter.getManagedInstanceStatus?.(
        "inst-1",
        "tok-1",
      );

      expect(result).toEqual({
        status: "connected",
        qr: null,
        phone: "+551199999999",
      });
    });
  });
});
