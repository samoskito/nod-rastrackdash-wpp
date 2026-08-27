import { Injectable } from "@nestjs/common";
import { UazapiAdapter } from "../uazapi/uazapi.adapter";
import type {
  WhatsappLabelListResult,
  WhatsappProviderAdapter,
  WhatsappProviderConfig,
  WhatsappProviderHealthDto,
} from "./whatsapp-provider.types";

/**
 * First real WhatsApp provider adapter: thin wrapper around the existing
 * UazapiAdapter (composition, not a rewrite) that adapts it to the
 * WhatsappProviderAdapter interface. Keeps UazapiAdapter itself untouched
 * so its other call sites (inbound-webhooks, IntegrationsService) keep
 * working exactly as before.
 */
@Injectable()
export class UazapiByoAdapter implements WhatsappProviderAdapter {
  readonly id = "uazapi_byo" as const;

  constructor(private readonly uazapi: UazapiAdapter) {}

  async getHealth(
    config?: WhatsappProviderConfig,
  ): Promise<WhatsappProviderHealthDto> {
    if (config?.provider === this.id) {
      const hasCredentials = Boolean(
        config.config.baseUrl.trim() && config.config.token.trim(),
      );

      return {
        provider: this.id,
        status: hasCredentials ? "connected" : "disconnected",
        checkedAt: new Date().toISOString(),
        message: hasCredentials
          ? undefined
          : "Missing Uazapi connection credentials",
      };
    }

    const health = await this.uazapi.getHealth();

    return {
      provider: this.id,
      status: health.status,
      checkedAt: health.checkedAt,
      message: health.message,
    };
  }

  async listLabels(
    instanceRef: string,
    instanceToken?: string | null,
  ): Promise<WhatsappLabelListResult> {
    return this.uazapi.listLabels(instanceRef, instanceToken);
  }
}
