import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  RUNTIME_FETCH,
  type RuntimeFetch,
} from "../../common/runtime/runtime.module";
import { LicenseClientService } from "../../licensing-client/license-client.service";
import { INTEGRATION_ENV } from "../integration.types";
import type { IntegrationEnv } from "../integration.types";
import type { IntegrationStatus } from "@wpptrack/shared";
import type {
  NodApiManagedInstanceDto,
  NodApiManagedInstanceStatusDto,
  WhatsappProviderAdapter,
  WhatsappProviderConfig,
  WhatsappProviderHealthDto,
} from "./whatsapp-provider.types";
import {
  fetchProviderUrl,
  normalizeProviderBaseUrl,
  providerRequestFailureMessage,
} from "./whatsapp-provider-http";

/** Prod PalmUP broker — see .claude-task-f5-3b-nod-api-client.md. */
const DEFAULT_BROKER_URL = "https://wpptrack-api.rastrack.app";

/**
 * Real "nod_api" WhatsApp provider adapter (F5.3b): calls the private
 * PalmUP broker (already live in prod) instead of talking to WhatsApp
 * directly. Every request is authenticated with the operator's own
 * license — `x-license-key` + `x-license-fingerprint` (from
 * LicenseClientService, same fingerprint the license heartbeat uses),
 * plus optional `x-license-account-identity`.
 *
 * `listLabels` is intentionally NOT implemented — the broker MVP has no
 * label-catalog endpoint. It stays `undefined` (the interface method is
 * optional) rather than throwing, so callers that check
 * `adapter.listLabels?.(...)` treat it as "not supported" instead of
 * "broken".
 */
@Injectable()
export class NodApiWhatsappAdapter implements WhatsappProviderAdapter {
  readonly id = "nod_api" as const;

  constructor(
    @Inject(LicenseClientService)
    private readonly license: LicenseClientService,
    @Inject(INTEGRATION_ENV) private readonly env: IntegrationEnv = process.env,
    @Optional()
    @Inject(RUNTIME_FETCH)
    private readonly fetchImpl: RuntimeFetch = fetch,
  ) {}

  async getHealth(
    config?: WhatsappProviderConfig,
  ): Promise<WhatsappProviderHealthDto> {
    const checkedAt = new Date().toISOString();
    if (
      config?.provider === this.id &&
      config.config.instanceId &&
      config.config.instanceToken
    ) {
      try {
        const instance = await this.getManagedInstanceStatus(
          config.config.instanceId,
          config.config.instanceToken,
        );
        return {
          provider: this.id,
          status: this.managedInstanceStatus(instance.status),
          checkedAt,
        };
      } catch (error) {
        return {
          provider: this.id,
          status: "error",
          checkedAt,
          message: "NOD API managed instance request failed",
        };
      }
    }

    const licenseKey = this.env.LICENSE_KEY?.trim();

    if (!licenseKey) {
      return {
        provider: this.id,
        status: "disconnected",
        checkedAt,
        message: "Missing LICENSE_KEY",
      };
    }

    try {
      const response = await this.fetchBroker(
        `${this.brokerUrl()}/nod-api/health`,
        {
          method: "GET",
          headers: this.licenseHeaders(licenseKey),
        },
      );
      const payload = await this.parseJson(response);
      const code = this.asString(payload.code);

      if (response.status === 403 && code === "nod_api_disabled") {
        return {
          provider: this.id,
          status: "disconnected",
          checkedAt,
          message: "NOD API not enabled on license",
        };
      }

      if (!response.ok) {
        return {
          provider: this.id,
          status: this.errorStatus(code),
          checkedAt,
          message: this.healthErrorMessage(code, response.status),
        };
      }

      if (payload.nodApiEnabled !== true) {
        return {
          provider: this.id,
          status: "disconnected",
          checkedAt,
          message: "NOD API not enabled on license",
        };
      }

      const upstreamConfigured = payload.upstreamConfigured === true;

      return {
        provider: this.id,
        status: upstreamConfigured ? "connected" : "needs_reconnect",
        checkedAt,
        message: upstreamConfigured
          ? undefined
          : "NOD API broker upstream not configured yet",
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

  async createManagedInstance(
    name?: string,
  ): Promise<NodApiManagedInstanceDto> {
    const licenseKey = this.requireLicenseKey();
    const response = await this.fetchBroker(
      `${this.brokerUrl()}/nod-api/instances`,
      {
        method: "POST",
        headers: {
          ...this.licenseHeaders(licenseKey),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(name ? { name } : {}),
      },
    );
    const payload = await this.parseJson(response);

    if (!response.ok) {
      throw new Error(this.brokerErrorMessage(payload, response.status));
    }

    return {
      instanceId: this.asString(payload.instanceId) ?? "",
      instanceToken: this.asString(payload.instanceToken) ?? "",
      status: this.asString(payload.status) ?? "unknown",
    };
  }

  async getManagedInstanceStatus(
    instanceId: string,
    instanceToken: string,
  ): Promise<NodApiManagedInstanceStatusDto> {
    const licenseKey = this.requireLicenseKey();
    const response = await this.fetchBroker(
      `${this.brokerUrl()}/nod-api/instances/status`,
      {
        method: "POST",
        headers: {
          ...this.licenseHeaders(licenseKey),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ instanceId, instanceToken }),
      },
    );
    const payload = await this.parseJson(response);

    if (!response.ok) {
      throw new Error(this.brokerErrorMessage(payload, response.status));
    }

    return {
      status: this.asString(payload.status) ?? "unknown",
      // Broker contract (private F5.3): qrCode + connectedPhone
      qr: this.asString(payload.qrCode) ?? this.asString(payload.qr) ?? null,
      phone:
        this.asString(payload.connectedPhone) ??
        this.asString(payload.phone) ??
        null,
    };
  }

  private brokerUrl(): string {
    const brokerUrl = normalizeProviderBaseUrl(
      this.env.NOD_API_BROKER_URL?.trim() || DEFAULT_BROKER_URL,
    );

    if (!brokerUrl) {
      throw new Error("nod_api_invalid_broker_url");
    }

    return brokerUrl;
  }

  private async fetchBroker(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchProviderUrl(this.fetchImpl, url, init);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      throw new Error("nod_api_broker_request_failed");
    }
  }

  private requireLicenseKey(): string {
    const licenseKey = this.env.LICENSE_KEY?.trim();

    if (!licenseKey) {
      throw new Error("nod_api_missing_license_key");
    }

    return licenseKey;
  }

  private licenseHeaders(licenseKey: string): Record<string, string> {
    const headers: Record<string, string> = {
      "x-license-key": licenseKey,
      "x-license-fingerprint": this.license.getFingerprint(),
    };
    const accountIdentity = this.env.LICENSE_ACCOUNT_IDENTITY?.trim();

    if (accountIdentity) {
      headers["x-license-account-identity"] = accountIdentity;
    }

    return headers;
  }

  private errorStatus(code: string | null): IntegrationStatus {
    switch (code) {
      case "nod_api_invalid_license":
      case "nod_api_license_blocked":
      case "nod_api_expired":
        return "needs_reconnect";
      default:
        return "error";
    }
  }

  private managedInstanceStatus(status: string): IntegrationStatus {
    switch (status.trim().toLowerCase()) {
      case "connected":
      case "working":
      case "active":
        return "connected";
      case "qr":
      case "qr_required":
      case "needs_reconnect":
      case "reconnect":
      case "pending":
        return "needs_reconnect";
      case "disconnected":
      case "stopped":
        return "disconnected";
      default:
        return "error";
    }
  }

  private brokerErrorMessage(
    payload: Record<string, unknown>,
    status: number,
  ): string {
    void payload;
    return `nod_api_broker_http_${status}`;
  }

  private healthErrorMessage(code: string | null, status: number): string {
    switch (code) {
      case "nod_api_invalid_license":
      case "nod_api_license_blocked":
      case "nod_api_expired":
        return "NOD API license needs attention";
      default:
        return `NOD API broker HTTP ${status}`;
    }
  }

  /** Never trust admin* fields from the broker response — scrub before use. */
  private async parseJson(
    response: Response,
  ): Promise<Record<string, unknown>> {
    const payload = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    return this.scrubAdminFields(payload);
  }

  private scrubAdminFields(
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const scrubbed: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(payload)) {
      if (/^admin/i.test(key)) {
        continue;
      }

      scrubbed[key] = value;
    }

    return scrubbed;
  }

  private asString(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
  }
}
