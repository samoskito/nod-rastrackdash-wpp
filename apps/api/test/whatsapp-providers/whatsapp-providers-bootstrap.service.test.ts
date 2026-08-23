import { describe, expect, it } from "vitest";
import { UazapiAdapter } from "../../src/integrations/uazapi/uazapi.adapter";
import { UazapiByoAdapter } from "../../src/integrations/whatsapp-providers/uazapi-byo.adapter";
import { WhatsappProviderRegistry } from "../../src/integrations/whatsapp-providers/whatsapp-provider.registry";
import { WhatsappProvidersBootstrapService } from "../../src/integrations/whatsapp-providers/whatsapp-providers-bootstrap.service";

describe("WhatsappProvidersBootstrapService", () => {
  it("onModuleInit() registers uazapi_byo in the registry", () => {
    const registry = new WhatsappProviderRegistry();
    const uazapiByo = new UazapiByoAdapter(new UazapiAdapter({}));
    const bootstrap = new WhatsappProvidersBootstrapService(registry, uazapiByo);

    bootstrap.onModuleInit();

    expect(registry.get("uazapi_byo")).toBe(uazapiByo);
  });

  it("onModuleInit() does not register nod_api, waha, or zapi (no auto-registering broken providers)", () => {
    const registry = new WhatsappProviderRegistry();
    const bootstrap = new WhatsappProvidersBootstrapService(
      registry,
      new UazapiByoAdapter(new UazapiAdapter({})),
    );

    bootstrap.onModuleInit();

    expect(registry.get("nod_api")).toBeUndefined();
    expect(registry.get("waha")).toBeUndefined();
    expect(registry.get("zapi")).toBeUndefined();
    expect(registry.list()).toHaveLength(1);
  });

  it("onModuleInit() is idempotent (calling it twice does not throw)", () => {
    const registry = new WhatsappProviderRegistry();
    const bootstrap = new WhatsappProvidersBootstrapService(
      registry,
      new UazapiByoAdapter(new UazapiAdapter({})),
    );

    bootstrap.onModuleInit();

    expect(() => bootstrap.onModuleInit()).not.toThrow();
    expect(registry.list()).toHaveLength(1);
  });
});
