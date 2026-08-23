import { Injectable, NotImplementedException } from "@nestjs/common";
import type {
  WhatsappProviderAdapter,
  WhatsappProviderHealthDto,
} from "../whatsapp-provider.types";

/**
 * Stub for the future WAHA WhatsApp provider (F5.4). Not auto-registered
 * in WhatsappProvidersModule — exported so F5.4 can wire it in without
 * redoing the registry plumbing.
 */
@Injectable()
export class WahaWhatsappAdapter implements WhatsappProviderAdapter {
  readonly id = "waha" as const;

  async getHealth(): Promise<WhatsappProviderHealthDto> {
    return {
      provider: this.id,
      status: "disconnected",
      checkedAt: new Date().toISOString(),
      message: "not_implemented",
    };
  }

  async listLabels(): Promise<never> {
    throw new NotImplementedException("waha provider is not implemented yet (F5.4)");
  }
}
