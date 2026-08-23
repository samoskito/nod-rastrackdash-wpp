import { Injectable, NotImplementedException } from "@nestjs/common";
import type {
  WhatsappProviderAdapter,
  WhatsappProviderHealthDto,
} from "../whatsapp-provider.types";

/**
 * Stub for the future Z-API WhatsApp provider (F5.5). Not auto-registered
 * in WhatsappProvidersModule — exported so F5.5 can wire it in without
 * redoing the registry plumbing.
 */
@Injectable()
export class ZapiWhatsappAdapter implements WhatsappProviderAdapter {
  readonly id = "zapi" as const;

  async getHealth(): Promise<WhatsappProviderHealthDto> {
    return {
      provider: this.id,
      status: "disconnected",
      checkedAt: new Date().toISOString(),
      message: "not_implemented",
    };
  }

  async listLabels(): Promise<never> {
    throw new NotImplementedException("zapi provider is not implemented yet (F5.5)");
  }
}
