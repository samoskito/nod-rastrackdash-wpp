import { Injectable } from "@nestjs/common";
import type {
  WhatsappProviderAdapter,
  WhatsappProviderId,
} from "./whatsapp-provider.types";

/**
 * Holds every WhatsApp provider adapter registered for this deployment.
 * Only adapters explicitly registered (see WhatsappProvidersModule) are
 * reachable — unimplemented providers are simply absent, not silently
 * available and broken.
 */
@Injectable()
export class WhatsappProviderRegistry {
  private readonly adapters = new Map<WhatsappProviderId, WhatsappProviderAdapter>();

  register(adapter: WhatsappProviderAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(
        `WhatsApp provider "${adapter.id}" is already registered`,
      );
    }

    this.adapters.set(adapter.id, adapter);
  }

  get(id: WhatsappProviderId): WhatsappProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  require(id: WhatsappProviderId): WhatsappProviderAdapter {
    const adapter = this.get(id);

    if (!adapter) {
      throw new Error(`WhatsApp provider "${id}" is not registered`);
    }

    return adapter;
  }

  list(): WhatsappProviderAdapter[] {
    return [...this.adapters.values()];
  }
}
