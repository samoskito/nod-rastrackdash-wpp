import { Module } from "@nestjs/common";
import { LicenseClientModule } from "../../licensing-client/license-client.module";
import { INTEGRATION_ENV } from "../integration.types";
import { UazapiAdapter } from "../uazapi/uazapi.adapter";
import { NodApiWhatsappAdapter } from "./nod-api-whatsapp.adapter";
import { UazapiByoAdapter } from "./uazapi-byo.adapter";
import { WahaWhatsappAdapter } from "./waha-whatsapp.adapter";
import { WhatsappProviderRegistry } from "./whatsapp-provider.registry";
import { WhatsappProvidersBootstrapService } from "./whatsapp-providers-bootstrap.service";

export { WhatsappProviderRegistry } from "./whatsapp-provider.registry";
export { UazapiByoAdapter } from "./uazapi-byo.adapter";
export { NodApiWhatsappAdapter } from "./nod-api-whatsapp.adapter";
export { WahaWhatsappAdapter } from "./waha-whatsapp.adapter";
export type {
  WhatsappProviderAdapter,
  WhatsappProviderConfig,
  WhatsappProviderHealthDto,
  WhatsappProviderId,
} from "./whatsapp-provider.types";

/**
 * Owns the WhatsApp provider registry and registers the adapters that are
 * actually ready for production use: "uazapi_byo" (F5.1), "nod_api"
 * (F5.3b) and "waha" (F5.4) — see ./stubs for the not-yet-implemented
 * "zapi" provider and ./README.md for the plan. Imports LicenseClientModule
 * because NodApiWhatsappAdapter authenticates against the PalmUP broker
 * with the operator's license (LICENSE_KEY +
 * LicenseClientService.getFingerprint()).
 */
@Module({
  imports: [LicenseClientModule],
  providers: [
    // UazapiAdapter/WahaWhatsappAdapter need INTEGRATION_ENV and this
    // module declares no imports of its own (leaf module) — provide it
    // locally, same pattern as every other module that instantiates an
    // INTEGRATION_ENV consumer (integrations.module.ts,
    // inbound-webhooks.module.ts).
    { provide: INTEGRATION_ENV, useValue: process.env },
    UazapiAdapter,
    UazapiByoAdapter,
    NodApiWhatsappAdapter,
    WahaWhatsappAdapter,
    WhatsappProviderRegistry,
    WhatsappProvidersBootstrapService,
  ],
  exports: [
    WhatsappProviderRegistry,
    UazapiByoAdapter,
    UazapiAdapter,
    NodApiWhatsappAdapter,
    WahaWhatsappAdapter,
  ],
})
export class WhatsappProvidersModule {}
