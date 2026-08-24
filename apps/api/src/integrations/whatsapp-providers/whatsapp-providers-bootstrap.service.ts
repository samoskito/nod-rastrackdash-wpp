import { Injectable, type OnModuleInit } from "@nestjs/common";
import { NodApiWhatsappAdapter } from "./nod-api-whatsapp.adapter";
import { UazapiByoAdapter } from "./uazapi-byo.adapter";
import { WahaWhatsappAdapter } from "./waha-whatsapp.adapter";
import { WhatsappProviderRegistry } from "./whatsapp-provider.registry";

/**
 * Registers the production-ready WhatsApp provider adapters on module
 * init: "uazapi_byo" (F5.1), "nod_api" (F5.3b) and "waha" (F5.4). All
 * three are registered unconditionally, even when unconfigured (no
 * UAZAPI_TOKEN / LICENSE_KEY / WAHA_BASE_URL) — health then reports
 * "disconnected" with a clear message instead of the registry treating
 * the provider as absent, so the FE can always discover and display all
 * three. The "zapi" stub class is exported from ./stubs for a later slice
 * (F5.5) to wire in once it has a real implementation, but is never
 * auto-registered here.
 */
@Injectable()
export class WhatsappProvidersBootstrapService implements OnModuleInit {
  constructor(
    private readonly registry: WhatsappProviderRegistry,
    private readonly uazapiByo: UazapiByoAdapter,
    private readonly nodApi: NodApiWhatsappAdapter,
    private readonly waha: WahaWhatsappAdapter,
  ) {}

  onModuleInit(): void {
    if (!this.registry.get(this.uazapiByo.id)) {
      this.registry.register(this.uazapiByo);
    }
    if (!this.registry.get(this.nodApi.id)) {
      this.registry.register(this.nodApi);
    }
    if (!this.registry.get(this.waha.id)) {
      this.registry.register(this.waha);
    }
  }
}
