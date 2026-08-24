import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WhatsappProviderAdapter,
  WhatsappProviderHealthDto,
  WhatsappProviderId,
} from "../../src/integrations/whatsapp-providers/whatsapp-provider.types";
import type { WhatsappProviderRegistry } from "../../src/integrations/whatsapp-providers/whatsapp-provider.registry";
import { WhatsappDisconnectAlertsService } from "../../src/ops-alerts/whatsapp-disconnect-alerts.service";

function health(
  status: WhatsappProviderHealthDto["status"],
  message?: string,
): WhatsappProviderHealthDto {
  return {
    provider: "uazapi_byo",
    status,
    checkedAt: new Date().toISOString(),
    message,
  };
}

function fakeAdapter(
  id: WhatsappProviderId,
  responses: Array<WhatsappProviderHealthDto | Error>,
): WhatsappProviderAdapter {
  let call = 0;
  const getHealth = vi.fn(async () => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;

    if (next instanceof Error) {
      throw next;
    }

    return next;
  });

  return { id, getHealth } as unknown as WhatsappProviderAdapter;
}

function fakeRegistry(
  adapters: WhatsappProviderAdapter[],
): WhatsappProviderRegistry {
  return {
    list: () => adapters,
    get: (id: WhatsappProviderId) => adapters.find((a) => a.id === id),
  } as unknown as WhatsappProviderRegistry;
}

const WEBHOOK_URL = "https://ops.example/hook";

describe("WhatsappDisconnectAlertsService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("enablement", () => {
    it("stays inert when DISCONNECT_ALERTS_ENABLED is unset: no interval, no health checks", () => {
      vi.useFakeTimers();
      const adapter = fakeAdapter("uazapi_byo", [health("disconnected")]);
      const registry = fakeRegistry([adapter]);
      const service = new WhatsappDisconnectAlertsService(registry, {});

      service.onModuleInit();
      vi.advanceTimersByTime(60 * 60_000);

      expect(adapter.getHealth).not.toHaveBeenCalled();

      service.onModuleDestroy();
    });

    it("starts a setInterval loop that runs health checks when enabled", () => {
      vi.useFakeTimers();
      const adapter = fakeAdapter("uazapi_byo", [health("connected")]);
      const registry = fakeRegistry([adapter]);
      const service = new WhatsappDisconnectAlertsService(registry, {
        DISCONNECT_ALERTS_ENABLED: "true",
        DISCONNECT_ALERT_INTERVAL_MS: "1000",
      });

      service.onModuleInit();
      vi.advanceTimersByTime(1000);

      expect(adapter.getHealth).toHaveBeenCalledTimes(1);

      service.onModuleDestroy();
      vi.advanceTimersByTime(5000);

      expect(adapter.getHealth).toHaveBeenCalledTimes(1);
    });
  });

  describe("evaluateProviderHealth()", () => {
    it("does not alert before the streak reaches the default threshold (3)", async () => {
      const adapter = fakeAdapter("uazapi_byo", [
        health("disconnected"),
        health("disconnected"),
      ]);
      const registry = fakeRegistry([adapter]);
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      const service = new WhatsappDisconnectAlertsService(
        registry,
        { DISCONNECT_ALERTS_ENABLED: "true", OPS_ALERT_WEBHOOK_URL: WEBHOOK_URL },
        fetchMock as unknown as typeof fetch,
      );

      await service.evaluateProviderHealth("uazapi_byo");
      await service.evaluateProviderHealth("uazapi_byo");

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("alerts once when the disconnect streak reaches the threshold, posting the webhook payload", async () => {
      const adapter = fakeAdapter("uazapi_byo", [
        health("disconnected", "instance offline"),
      ]);
      const registry = fakeRegistry([adapter]);
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      const service = new WhatsappDisconnectAlertsService(
        registry,
        { DISCONNECT_ALERTS_ENABLED: "true", OPS_ALERT_WEBHOOK_URL: WEBHOOK_URL },
        fetchMock as unknown as typeof fetch,
      );

      await service.evaluateProviderHealth("uazapi_byo");
      await service.evaluateProviderHealth("uazapi_byo");
      await service.evaluateProviderHealth("uazapi_byo");
      await service.evaluateProviderHealth("uazapi_byo");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe(WEBHOOK_URL);
      expect(JSON.parse(init.body as string)).toEqual({
        type: "whatsapp_disconnect",
        provider: "uazapi_byo",
        streak: 3,
        message: "instance offline",
        checkedAt: expect.any(String),
      });
    });

    it("honors a DISCONNECT_ALERT_STREAK override", async () => {
      const adapter = fakeAdapter("uazapi_byo", [health("disconnected")]);
      const registry = fakeRegistry([adapter]);
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      const service = new WhatsappDisconnectAlertsService(
        registry,
        {
          DISCONNECT_ALERTS_ENABLED: "true",
          DISCONNECT_ALERT_STREAK: "2",
          OPS_ALERT_WEBHOOK_URL: WEBHOOK_URL,
        },
        fetchMock as unknown as typeof fetch,
      );

      await service.evaluateProviderHealth("uazapi_byo");
      expect(fetchMock).not.toHaveBeenCalled();

      await service.evaluateProviderHealth("uazapi_byo");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("resets the streak on connected, then alerts again after a fresh disconnect streak", async () => {
      const adapter = fakeAdapter("uazapi_byo", [
        health("disconnected"),
        health("disconnected"),
        health("disconnected"),
        health("connected"),
        health("disconnected"),
        health("disconnected"),
        health("disconnected"),
      ]);
      const registry = fakeRegistry([adapter]);
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      const service = new WhatsappDisconnectAlertsService(
        registry,
        { DISCONNECT_ALERTS_ENABLED: "true", OPS_ALERT_WEBHOOK_URL: WEBHOOK_URL },
        fetchMock as unknown as typeof fetch,
      );

      for (let i = 0; i < 7; i += 1) {
        await service.evaluateProviderHealth("uazapi_byo");
      }

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not count or reset the streak on ambiguous statuses (error, needs_reconnect)", async () => {
      const adapter = fakeAdapter("uazapi_byo", [
        health("disconnected"),
        health("disconnected"),
        health("error"),
        health("needs_reconnect"),
        health("disconnected"),
      ]);
      const registry = fakeRegistry([adapter]);
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      const service = new WhatsappDisconnectAlertsService(
        registry,
        { DISCONNECT_ALERTS_ENABLED: "true", OPS_ALERT_WEBHOOK_URL: WEBHOOK_URL },
        fetchMock as unknown as typeof fetch,
      );

      for (let i = 0; i < 5; i += 1) {
        await service.evaluateProviderHealth("uazapi_byo");
      }

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not throw when the webhook call fails, and still logs the alert", async () => {
      const adapter = fakeAdapter("uazapi_byo", [
        health("disconnected"),
        health("disconnected"),
        health("disconnected"),
      ]);
      const registry = fakeRegistry([adapter]);
      const fetchMock = vi.fn(async () => {
        throw new Error("network down");
      });
      const service = new WhatsappDisconnectAlertsService(
        registry,
        { DISCONNECT_ALERTS_ENABLED: "true", OPS_ALERT_WEBHOOK_URL: WEBHOOK_URL },
        fetchMock as unknown as typeof fetch,
      );

      await service.evaluateProviderHealth("uazapi_byo");
      await service.evaluateProviderHealth("uazapi_byo");
      await expect(
        service.evaluateProviderHealth("uazapi_byo"),
      ).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("skips the webhook call (and does not throw) when OPS_ALERT_WEBHOOK_URL is unset", async () => {
      const adapter = fakeAdapter("uazapi_byo", [health("disconnected")]);
      const registry = fakeRegistry([adapter]);
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      const service = new WhatsappDisconnectAlertsService(
        registry,
        { DISCONNECT_ALERTS_ENABLED: "true" },
        fetchMock as unknown as typeof fetch,
      );

      await service.evaluateProviderHealth("uazapi_byo");
      await service.evaluateProviderHealth("uazapi_byo");
      await service.evaluateProviderHealth("uazapi_byo");

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("runOnce()", () => {
    it("evaluates every provider in the registry", async () => {
      const uazapi = fakeAdapter("uazapi_byo", [health("connected")]);
      const waha = fakeAdapter("waha", [health("connected")]);
      const registry = fakeRegistry([uazapi, waha]);
      const service = new WhatsappDisconnectAlertsService(registry, {
        DISCONNECT_ALERTS_ENABLED: "true",
      });

      await service.runOnce();

      expect(uazapi.getHealth).toHaveBeenCalledTimes(1);
      expect(waha.getHealth).toHaveBeenCalledTimes(1);
    });
  });
});
