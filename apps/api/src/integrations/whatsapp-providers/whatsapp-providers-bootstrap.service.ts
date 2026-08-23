import { Injectable, type OnModuleInit } from "@nestjs/common";
import { UazapiByoAdapter } from "./uazapi-byo.adapter";
import { WhatsappProviderRegistry } from "./whatsapp-provider.registry";

/**
 * Registers the production-ready WhatsApp provider adapters on module
 * init. Deliberately registers only "uazapi_byo" — the nod_api/waha/zapi
 * stub classes are exported from ./stubs for later slices (F5.3-F5.5) to
 * wire in once they have real implementations, but are never auto-
 * registered here.
 */
@Injectable()
export class WhatsappProvidersBootstrapService implements OnModuleInit {
  constructor(
    private readonly registry: WhatsappProviderRegistry,
    private readonly uazapiByo: UazapiByoAdapter,
  ) {}

  onModuleInit(): void {
    if (!this.registry.get(this.uazapiByo.id)) {
      this.registry.register(this.uazapiByo);
    }
  }
}
