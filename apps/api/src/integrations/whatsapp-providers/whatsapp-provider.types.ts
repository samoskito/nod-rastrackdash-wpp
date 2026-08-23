import type { WhatsappLabelDto } from "@wpptrack/shared";
import type { IntegrationStatus } from "../integration.types";

/**
 * Identifiers for every WhatsApp connectivity provider the product plans to
 * support (F5 plan). Only "uazapi_byo" has a real, HTTP-backed adapter as of
 * F5.1 — the rest are stub classes exported for later slices (F5.3-F5.5).
 */
export type WhatsappProviderId = "uazapi_byo" | "nod_api" | "waha" | "zapi";

export type UazapiByoConfig = {
  baseUrl: string;
  token: string;
  instanceId?: string;
};

/**
 * Placeholder shape for the future NOD managed-broker provider. The broker
 * URL will come from server-side env in F5.3 — this config only tracks
 * whether the provider is enabled for a workspace.
 */
export type NodApiConfig = {
  enabled: boolean;
};

/** Stub config for F5.4. */
export type WahaConfig = {
  baseUrl: string;
  apiKey: string;
  session?: string;
};

/** Stub config for F5.5. */
export type ZapiConfig = {
  baseUrl: string;
  instanceId: string;
  token: string;
};

export type WhatsappProviderConfig =
  | { provider: "uazapi_byo"; config: UazapiByoConfig }
  | { provider: "nod_api"; config: NodApiConfig }
  | { provider: "waha"; config: WahaConfig }
  | { provider: "zapi"; config: ZapiConfig };

export interface WhatsappProviderHealthDto {
  provider: WhatsappProviderId;
  status: IntegrationStatus;
  checkedAt: string;
  message?: string;
}

export interface WhatsappLabelListResult {
  status: "success" | "not_configured" | "error";
  message: string | null;
  labels: WhatsappLabelDto[];
}

/**
 * Minimal surface the product actually calls today across
 * integrations.service.ts and inbound-webhooks. Extracted from
 * UazapiAdapter rather than invented up front — only `getHealth` and
 * `listLabels` have live call sites (see F5.1 done report); everything
 * else stays out of the interface until a real caller needs it.
 */
export interface WhatsappProviderAdapter {
  readonly id: WhatsappProviderId;
  getHealth(): Promise<WhatsappProviderHealthDto>;
  listLabels?(
    instanceRef: string,
    instanceToken?: string | null,
  ): Promise<WhatsappLabelListResult>;
}
