import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  RUNTIME_FETCH,
  type RuntimeFetch,
} from "../../common/runtime/runtime.module";
import { INTEGRATION_ENV } from "../integration.types";
import type { IntegrationEnv } from "../integration.types";
import type { IntegrationStatus } from "@wpptrack/shared";
import type {
  WhatsappProviderAdapter,
  WhatsappProviderHealthDto,
} from "./whatsapp-provider.types";

/**
 * Real "zapi" WhatsApp provider adapter (F5.5): talks directly to a
 * student self-hosted/self-owned Z-API (z-api.cloud) instance's status
 * API. Pure BYO — no PalmUP broker, no admin tokens, no PalmUP secrets.
 *
 * Contract (see ./README.md):
 *   GET {ZAPI_BASE_URL}/instances/{ZAPI_INSTANCE_ID}/token/{ZAPI_TOKEN}/status
 *
 * Z-API's documented field names vary slightly across their docs/versions,
 * so the response is read defensively: `connected` (bool) is the primary
 * signal, with `state`/`status` strings used only to detect a pending-QR
 * hint when disconnected.
 *
 * `listLabels` is intentionally NOT implemented — Z-API has no
 * Uazapi-style label catalog, so it stays `undefined` (the interface
 * method is optional) rather than throwing, so callers that check
 * `adapter.listLabels?.(...)` treat it as "not supported" instead of
 * "broken".
 *
 * Inbound webhook parsing for Z-API events is out of scope for this slice
 * — see README.md ("F5.6 / follow-up").
 */
@Injectable()
export class ZapiWhatsappAdapter implements WhatsappProviderAdapter {
  readonly id = "zapi" as const;

  constructor(
    @Inject(INTEGRATION_ENV) private readonly env: IntegrationEnv = process.env,
    @Optional()
    @Inject(RUNTIME_FETCH)
    private readonly fetchImpl: RuntimeFetch = fetch,
  ) {}

  async getHealth(): Promise<WhatsappProviderHealthDto> {
    const checkedAt = new Date().toISOString();
    const baseUrl = this.env.ZAPI_BASE_URL?.trim();
    const instanceId = this.env.ZAPI_INSTANCE_ID?.trim();
    const token = this.env.ZAPI_TOKEN?.trim();

    if (!baseUrl || !instanceId || !token) {
      return {
        provider: this.id,
        status: "disconnected",
        checkedAt,
        message: "Missing ZAPI_BASE_URL, ZAPI_INSTANCE_ID or ZAPI_TOKEN",
      };
    }

    try {
      const response = await this.fetchImpl(
        `${baseUrl.replace(/\/$/, "")}/instances/${encodeURIComponent(
          instanceId,
        )}/token/${encodeURIComponent(token)}/status`,
        { method: "GET" },
      );

      if (!response.ok) {
        return {
          provider: this.id,
          status: "error",
          checkedAt,
          message: `Z-API instance status API HTTP ${response.status}`,
        };
      }

      const payload = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const connected = payload.connected === true;
      const statusHint =
        (typeof payload.status === "string" && payload.status) ||
        (typeof payload.state === "string" && payload.state) ||
        null;

      return {
        provider: this.id,
        status: this.mapStatus(connected, statusHint),
        checkedAt,
        message: this.statusMessage(connected, statusHint),
      };
    } catch (error) {
      return {
        provider: this.id,
        status: "error",
        checkedAt,
        message:
          error instanceof Error
            ? error.message
            : "Erro ao chamar Z-API instance status API",
      };
    }
  }

  private mapStatus(
    connected: boolean,
    statusHint: string | null,
  ): IntegrationStatus {
    if (connected) {
      return "connected";
    }

    if (statusHint && /qr/i.test(statusHint)) {
      return "needs_reconnect";
    }

    return "disconnected";
  }

  private statusMessage(
    connected: boolean,
    statusHint: string | null,
  ): string | undefined {
    if (connected) {
      return undefined;
    }

    return statusHint ? `Z-API instance status: ${statusHint}` : undefined;
  }
}
