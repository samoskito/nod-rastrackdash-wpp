import { describe, expect, it } from "vitest";
import { IntegrationsService } from "../../src/integrations/integrations.service";
import type { MetaAdapter } from "../../src/integrations/meta/meta.adapter";
import { WhatsappProviderRegistry } from "../../src/integrations/whatsapp-providers/whatsapp-provider.registry";
import type {
  WhatsappProviderAdapter,
  WhatsappProviderHealthDto,
} from "../../src/integrations/whatsapp-providers/whatsapp-provider.types";

function fakeMetaAdapter(
  health: { status: "connected" | "disconnected"; checkedAt: string } = {
    status: "connected",
    checkedAt: "2026-08-24T00:00:00.000Z",
  },
): MetaAdapter {
  return {
    provider: "meta",
    getHealth: async () => ({
      provider: "meta" as const,
      status: health.status,
      checkedAt: health.checkedAt,
    }),
  } as unknown as MetaAdapter;
}

function fakeUazapiByoAdapter(
  health: WhatsappProviderHealthDto,
): WhatsappProviderAdapter {
  return {
    id: "uazapi_byo",
    getHealth: async () => health,
  };
}

describe("IntegrationsService.getHealthSummary", () => {
  it("resolves WhatsApp health via WhatsappProviderRegistry.require('uazapi_byo') and reports provider id 'uazapi_byo'", async () => {
    const registry = new WhatsappProviderRegistry();
    registry.register(
      fakeUazapiByoAdapter({
        provider: "uazapi_byo",
        status: "connected",
        checkedAt: "2026-08-24T00:00:00.000Z",
      }),
    );
    const service = new IntegrationsService(fakeMetaAdapter(), registry, {});

    const summary = await service.getHealthSummary();

    expect(summary.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "uazapi_byo",
          status: "connected",
          checkedAt: "2026-08-24T00:00:00.000Z",
        }),
      ]),
    );
  });

  it("passes through the adapter's message (e.g. missing BYO env)", async () => {
    const registry = new WhatsappProviderRegistry();
    registry.register(
      fakeUazapiByoAdapter({
        provider: "uazapi_byo",
        status: "disconnected",
        checkedAt: "2026-08-24T00:00:00.000Z",
        message: "Missing UAZAPI_BASE_URL or UAZAPI_TOKEN",
      }),
    );
    const service = new IntegrationsService(fakeMetaAdapter(), registry, {});

    const summary = await service.getHealthSummary();
    const uazapi = summary.providers.find(
      (item) => item.provider === "uazapi_byo",
    );

    expect(uazapi?.status).toBe("disconnected");
    expect(uazapi?.message).toBe("Missing UAZAPI_BASE_URL or UAZAPI_TOKEN");
  });

  it("still reports meta health alongside uazapi_byo", async () => {
    const registry = new WhatsappProviderRegistry();
    registry.register(
      fakeUazapiByoAdapter({
        provider: "uazapi_byo",
        status: "connected",
        checkedAt: "2026-08-24T00:00:00.000Z",
      }),
    );
    const service = new IntegrationsService(fakeMetaAdapter(), registry, {});

    const summary = await service.getHealthSummary();

    expect(summary.providers).toHaveLength(2);
    expect(summary.providers.map((item) => item.provider).sort()).toEqual([
      "meta",
      "uazapi_byo",
    ]);
  });

  it("fails closed (throws) when uazapi_byo is not registered, instead of silently omitting it", async () => {
    const registry = new WhatsappProviderRegistry();
    const service = new IntegrationsService(fakeMetaAdapter(), registry, {});

    await expect(service.getHealthSummary()).rejects.toThrow(/uazapi_byo/);
  });
});
