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
  WhatsappProviderConfig,
  WhatsappProviderHealthDto,
} from "./whatsapp-provider.types";
import {
  fetchProviderUrl,
  normalizeProviderBaseUrl,
  providerRequestFailureMessage,
} from "./whatsapp-provider-http";

const DEFAULT_SESSION = "default";

/**
 * Real "waha" WhatsApp provider adapter (F5.4): talks directly to a
 * student self-hosted WAHA (devlikeape/waha) instance's session API. Pure
 * BYO — no PalmUP broker, no admin tokens, no PalmUP secrets.
 *
 * Contract (see ./README.md):
 *   GET {WAHA_BASE_URL}/api/sessions/{WAHA_SESSION}
 *   Header: X-Api-Key: {WAHA_API_KEY}
 *
 * `listLabels` is intentionally NOT implemented — WAHA has no
 * Uazapi-style label catalog, so it stays `undefined` (the interface
 * method is optional) rather than throwing, so callers that check
 * `adapter.listLabels?.(...)` treat it as "not supported" instead of
 * "broken".
 *
 * Inbound webhook parsing for WAHA events is out of scope for this slice
 * — see README.md ("F5.6 / follow-up").
 */
@Injectable()
export class WahaWhatsappAdapter implements WhatsappProviderAdapter {
  readonly id = "waha" as const;

  constructor(
    @Inject(INTEGRATION_ENV) private readonly env: IntegrationEnv = process.env,
    @Optional()
    @Inject(RUNTIME_FETCH)
    private readonly fetchImpl: RuntimeFetch = fetch,
  ) {}

  async getHealth(
    config?: WhatsappProviderConfig,
  ): Promise<WhatsappProviderHealthDto> {
    const checkedAt = new Date().toISOString();
    const saved = config?.provider === this.id ? config.config : null;
    const configuredBaseUrl =
      saved?.baseUrl.trim() ?? this.env.WAHA_BASE_URL?.trim();
    const apiKey = saved?.apiKey.trim() ?? this.env.WAHA_API_KEY?.trim();

    if (!configuredBaseUrl || !apiKey) {
      return {
        provider: this.id,
        status: "disconnected",
        checkedAt,
        message: "Missing WAHA_BASE_URL or WAHA_API_KEY",
      };
    }

    const baseUrl = normalizeProviderBaseUrl(configuredBaseUrl);
    if (!baseUrl) {
      return {
        provider: this.id,
        status: "error",
        checkedAt,
        message: "Invalid WAHA base URL",
      };
    }

    const session =
      saved?.session?.trim() ||
      this.env.WAHA_SESSION?.trim() ||
      DEFAULT_SESSION;

    try {
      const response = await fetchProviderUrl(
        this.fetchImpl,
        `${baseUrl.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(session)}`,
        {
          method: "GET",
          headers: { "X-Api-Key": apiKey },
        },
      );

      if (!response.ok) {
        return {
          provider: this.id,
          status: "error",
          checkedAt,
          message: `WAHA session API HTTP ${response.status}`,
        };
      }

      const payload = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const status = typeof payload.status === "string" ? payload.status : null;

      return {
        provider: this.id,
        status: this.mapStatus(status),
        checkedAt,
        message: this.statusMessage(status),
      };
    } catch (error) {
      return {
        provider: this.id,
        status: "error",
        checkedAt,
        message: providerRequestFailureMessage(error),
      };
    }
  }

  private mapStatus(status: string | null): IntegrationStatus {
    switch (status) {
      case "WORKING":
      case "authenticated":
        return "connected";
      case "SCAN_QR_CODE":
        return "needs_reconnect";
      case "STOPPED":
        return "disconnected";
      case "FAILED":
      default:
        return "error";
    }
  }

  private statusMessage(status: string | null): string | undefined {
    switch (status) {
      case "WORKING":
      case "authenticated":
        return undefined;
      case "SCAN_QR_CODE":
        return "WAHA session requires QR reconnection";
      case "STOPPED":
        return "WAHA session stopped";
      case "FAILED":
        return "WAHA session error";
      default:
        return "WAHA session API returned an unknown status";
    }
  }
}
