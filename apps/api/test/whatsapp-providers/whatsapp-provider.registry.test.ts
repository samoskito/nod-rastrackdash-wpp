import { describe, expect, it } from "vitest";
import { WhatsappProviderRegistry } from "../../src/integrations/whatsapp-providers/whatsapp-provider.registry";
import type {
  WhatsappProviderAdapter,
  WhatsappProviderHealthDto,
  WhatsappProviderId,
} from "../../src/integrations/whatsapp-providers/whatsapp-provider.types";

function fakeAdapter(id: WhatsappProviderId): WhatsappProviderAdapter {
  return {
    id,
    async getHealth(): Promise<WhatsappProviderHealthDto> {
      return {
        provider: id,
        status: "connected",
        checkedAt: new Date(0).toISOString(),
      };
    },
  };
}

describe("WhatsappProviderRegistry", () => {
  it("get() returns undefined for a provider that was never registered", () => {
    const registry = new WhatsappProviderRegistry();

    expect(registry.get("uazapi_byo")).toBeUndefined();
  });

  it("register() then get() returns the same adapter instance", () => {
    const registry = new WhatsappProviderRegistry();
    const adapter = fakeAdapter("uazapi_byo");

    registry.register(adapter);

    expect(registry.get("uazapi_byo")).toBe(adapter);
  });

  it("register() rejects a second adapter for an id already registered", () => {
    const registry = new WhatsappProviderRegistry();
    registry.register(fakeAdapter("uazapi_byo"));

    expect(() => registry.register(fakeAdapter("uazapi_byo"))).toThrow(
      /uazapi_byo/,
    );
  });

  it("require() returns the registered adapter", () => {
    const registry = new WhatsappProviderRegistry();
    const adapter = fakeAdapter("waha");

    registry.register(adapter);

    expect(registry.require("waha")).toBe(adapter);
  });

  it("require() throws for a provider that was never registered", () => {
    const registry = new WhatsappProviderRegistry();

    expect(() => registry.require("zapi")).toThrow(/zapi/);
  });

  it("list() returns every registered adapter", () => {
    const registry = new WhatsappProviderRegistry();
    const uazapi = fakeAdapter("uazapi_byo");
    const waha = fakeAdapter("waha");
    registry.register(uazapi);
    registry.register(waha);

    expect(registry.list()).toEqual(
      expect.arrayContaining([uazapi, waha]),
    );
    expect(registry.list()).toHaveLength(2);
  });

  it("list() returns an empty array when nothing is registered", () => {
    const registry = new WhatsappProviderRegistry();

    expect(registry.list()).toEqual([]);
  });
});
