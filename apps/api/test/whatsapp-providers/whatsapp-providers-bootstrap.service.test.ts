import { describe, expect, it } from "vitest";
import { UazapiAdapter } from "../../src/integrations/uazapi/uazapi.adapter";
import { NodApiWhatsappAdapter } from "../../src/integrations/whatsapp-providers/nod-api-whatsapp.adapter";
import { UazapiByoAdapter } from "../../src/integrations/whatsapp-providers/uazapi-byo.adapter";
import { WhatsappProviderRegistry } from "../../src/integrations/whatsapp-providers/whatsapp-provider.registry";
import { WhatsappProvidersBootstrapService } from "../../src/integrations/whatsapp-providers/whatsapp-providers-bootstrap.service";

function fakeLicenseClient() {
  return { getFingerprint: () => "fp-test" } as ConstructorParameters<
    typeof NodApiWhatsappAdapter
  >[0];
}

function makeBootstrap(registry: WhatsappProviderRegistry) {
  const uazapiByo = new UazapiByoAdapter(new UazapiAdapter({}));
  const nodApi = new NodApiWhatsappAdapter(fakeLicenseClient(), {});
  const bootstrap = new WhatsappProvidersBootstrapService(
    registry,
    uazapiByo,
    nodApi,
  );

  return { bootstrap, uazapiByo, nodApi };
}

describe("WhatsappProvidersBootstrapService", () => {
  it("onModuleInit() registers uazapi_byo in the registry", () => {
    const registry = new WhatsappProviderRegistry();
    const { bootstrap, uazapiByo } = makeBootstrap(registry);

    bootstrap.onModuleInit();

    expect(registry.get("uazapi_byo")).toBe(uazapiByo);
  });

  it("onModuleInit() also registers nod_api unconditionally, for discoverability (health shows disconnected when unconfigured)", () => {
    const registry = new WhatsappProviderRegistry();
    const { bootstrap, nodApi } = makeBootstrap(registry);

    bootstrap.onModuleInit();

    expect(registry.get("nod_api")).toBe(nodApi);
  });

  it("onModuleInit() does not register waha or zapi (still stubs, no auto-registering broken providers)", () => {
    const registry = new WhatsappProviderRegistry();
    const { bootstrap } = makeBootstrap(registry);

    bootstrap.onModuleInit();

    expect(registry.get("waha")).toBeUndefined();
    expect(registry.get("zapi")).toBeUndefined();
    expect(registry.list()).toHaveLength(2);
  });

  it("onModuleInit() is idempotent (calling it twice does not throw)", () => {
    const registry = new WhatsappProviderRegistry();
    const { bootstrap } = makeBootstrap(registry);

    bootstrap.onModuleInit();

    expect(() => bootstrap.onModuleInit()).not.toThrow();
    expect(registry.list()).toHaveLength(2);
  });
});
