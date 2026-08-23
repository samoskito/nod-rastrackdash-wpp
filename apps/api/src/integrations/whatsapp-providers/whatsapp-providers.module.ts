import { Module } from "@nestjs/common";
import { UazapiAdapter } from "../uazapi/uazapi.adapter";
import { UazapiByoAdapter } from "./uazapi-byo.adapter";
import { WhatsappProviderRegistry } from "./whatsapp-provider.registry";
import { WhatsappProvidersBootstrapService } from "./whatsapp-providers-bootstrap.service";

export { WhatsappProviderRegistry } from "./whatsapp-provider.registry";
export { UazapiByoAdapter } from "./uazapi-byo.adapter";
export type {
  WhatsappProviderAdapter,
  WhatsappProviderConfig,
  WhatsappProviderHealthDto,
  WhatsappProviderId,
} from "./whatsapp-provider.types";

/**
 * Owns the WhatsApp provider registry and registers the adapters that are
 * actually ready for production use. Only "uazapi_byo" is registered here
 * as of F5.1 — see ./stubs for the not-yet-implemented providers and
 * ./README.md for the plan.
 */
@Module({
  providers: [
    UazapiAdapter,
    UazapiByoAdapter,
    WhatsappProviderRegistry,
    WhatsappProvidersBootstrapService,
  ],
  exports: [WhatsappProviderRegistry, UazapiByoAdapter, UazapiAdapter],
})
export class WhatsappProvidersModule {}
