import { Injectable, NotImplementedException } from "@nestjs/common";
import type {
  WhatsappProviderAdapter,
  WhatsappProviderHealthDto,
} from "../whatsapp-provider.types";

/**
 * Stub for the future NOD managed-broker WhatsApp provider (F5.3, private
 * repo). Not auto-registered in WhatsappProvidersModule — exported so
 * F5.3 can wire it in without redoing the registry plumbing.
 */
@Injectable()
export class NodApiWhatsappAdapter implements WhatsappProviderAdapter {
  readonly id = "nod_api" as const;

  async getHealth(): Promise<WhatsappProviderHealthDto> {
    return {
      provider: this.id,
      status: "disconnected",
      checkedAt: new Date().toISOString(),
      message: "not_implemented",
    };
  }

  async listLabels(): Promise<never> {
    throw new NotImplementedException("nod_api provider is not implemented yet (F5.3)");
  }
}
