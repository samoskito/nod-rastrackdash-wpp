import { Injectable } from "@nestjs/common";
import { UazapiAdapter } from "../uazapi/uazapi.adapter";
import type { IntegrationStatus } from "../integration.types";
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
      const baseUrl = config.config.baseUrl.trim();
      const token = config.config.token.trim();
      const checkedAt = new Date().toISOString();

      if (!baseUrl || !token) {
        return {
          provider: this.id,
          status: "disconnected",
          checkedAt,
          message: "Missing Uazapi connection credentials",
        };
      }

      const connection = await this.uazapi.getInstanceStatusForConnection(
        baseUrl,
        token,
      );

      return {
        provider: this.id,
        status: this.mapConnectionStatus(connection.connectionStatus),
        checkedAt,
        message: this.connectionStatusMessage(connection.connectionStatus),
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

  private mapConnectionStatus(
    status:
      | "not_configured"
      | "pending"
      | "qr_required"
      | "connected"
      | "disconnected"
      | "error",
  ): IntegrationStatus {
    switch (status) {
      case "connected":
        return "connected";
      case "disconnected":
      case "not_configured":
        return "disconnected";
      case "qr_required":
        return "needs_reconnect";
      case "pending":
        return "syncing";
      case "error":
        return "error";
    }
  }

  private connectionStatusMessage(
    status:
      | "not_configured"
      | "pending"
      | "qr_required"
      | "connected"
      | "disconnected"
      | "error",
  ): string | undefined {
    return status === "connected"
      ? undefined
      : `Uazapi instance status: ${status}`;
  }

  async listLabels(
    instanceRef: string,
    instanceToken?: string | null,
  ): Promise<WhatsappLabelListResult> {
    return this.uazapi.listLabels(instanceRef, instanceToken);
  }
}
