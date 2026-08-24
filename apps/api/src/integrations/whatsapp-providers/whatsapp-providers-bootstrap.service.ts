import { Injectable, type OnModuleInit } from "@nestjs/common";
import { NodApiWhatsappAdapter } from "./nod-api-whatsapp.adapter";
import { UazapiByoAdapter } from "./uazapi-byo.adapter";
import { WhatsappProviderRegistry } from "./whatsapp-provider.registry";

/**
 * Registers the production-ready WhatsApp provider adapters on module
 * init: "uazapi_byo" (F5.1) and "nod_api" (F5.3b). Both are registered
 * unconditionally, even when unconfigured (no UAZAPI_TOKEN / LICENSE_KEY)
 * — health then reports "disconnected" with a clear message instead of
 * the registry treating the provider as absent, so the FE can always
 * discover and display both. "waha"/"zapi" stub classes are exported from
 * ./stubs for later slices (F5.4-F5.5) to wire in once they have real
 * implementations, but are never auto-registered here.
 */
@Injectable()
export class WhatsappProvidersBootstrapService implements OnModuleInit {
  constructor(
    private readonly registry: WhatsappProviderRegistry,
    private readonly uazapiByo: UazapiByoAdapter,
    private readonly nodApi: NodApiWhatsappAdapter,
  ) {}

  onModuleInit(): void {
    if (!this.registry.get(this.uazapiByo.id)) {
      this.registry.register(this.uazapiByo);
    }
    if (!this.registry.get(this.nodApi.id)) {
      this.registry.register(this.nodApi);
    }
  }
}
