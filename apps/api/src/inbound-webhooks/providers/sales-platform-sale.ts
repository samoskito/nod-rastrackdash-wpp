import {
  braipSaleEventNameOf,
  parseBraipAutomationV1,
  parseBraipSaleEventV1,
  type ParsedBraipAutomationV1,
} from "./braip/braip-automation-v1.parser";
import {
  parseYampiAutomationV1,
  parseYampiSaleEventV1,
  yampiCapiCustomData,
  yampiSaleEventNameOf,
  type ParsedYampiAutomationV1,
  type YampiCapiCustomData,
} from "./yampi/yampi-automation-v1.parser";
import {
  parsePaytAutomationV1,
  parsePaytSaleEventV1,
  paytProductFilterMatches,
  paytSaleEventNameOf,
  type ParsedPaytAutomationV1,
  type PaytParseOptions,
  type PaytSaleEventName,
} from "./payt/payt-automation-v1.parser";

/**
 * Fase 6.5 (porte do SaaS 09d7303a): plataformas de venda (checkout) com URL
 * única — Payt, Braip e (fase 6.7) Yampi. Mesmo contrato normalizado (evento
 * do status, pedido, produto/oferta, valor em centavos, telefone com
 * candidatos BR), mesma identidade de compra (workspace + provedor + conta +
 * pedido + evento) e mesmo roteamento. As datas sem fuso são lidas como hora de
 * Brasília pelo leitor da fase 6.0 (sao-paulo-timestamp.ts) e nunca ficam
 * depois do recebimento.
 *
 * Yampi (6.7, porte do SaaS #186/#187/#188): liberada para todos os
 * workspaces; só ela leva os itens reais do pedido à Meta (saleCapiCustomData).
 * Hotmart (6.6) entra aqui quando for portada.
 */
export const SALES_PLATFORM_PROVIDERS = ["payt", "braip", "yampi"] as const;
export type SalesPlatformProvider = (typeof SALES_PLATFORM_PROVIDERS)[number];
export const SALES_PLATFORM_PARSER_VERSION = "automation-v1";

export type ParsedSaleAutomationV1 =
  | ParsedPaytAutomationV1
  | ParsedBraipAutomationV1
  | ParsedYampiAutomationV1;

export function isSalesPlatformProvider(
  provider: string | null | undefined,
): provider is SalesPlatformProvider {
  return (SALES_PLATFORM_PROVIDERS as readonly string[]).includes(
    provider ?? "",
  );
}

/** Rule's sales-platform parser (provider + automation-v1), else null. */
export function salesPlatformOf(
  release: { provider: string; version: string } | null | undefined,
): SalesPlatformProvider | null {
  return release &&
    release.version === SALES_PLATFORM_PARSER_VERSION &&
    isSalesPlatformProvider(release.provider)
    ? release.provider
    : null;
}

export type SaleEventParseResult =
  | { ok: true; value: ParsedSaleAutomationV1 }
  | {
      ok: false;
      /** status_not_supported | invalid_payload | identity_missing */
      kind: "status_not_supported" | "invalid";
      errorCode: string;
      providerStatus?: string | null;
    };

export function saleEventNameOf(
  provider: SalesPlatformProvider,
  payload: unknown,
): PaytSaleEventName | null {
  switch (provider) {
    case "braip":
      return braipSaleEventNameOf(payload);
    case "yampi":
      return yampiSaleEventNameOf(payload);
    default:
      return paytSaleEventNameOf(payload);
  }
}

/**
 * Real order lines for the Meta custom_data of a sale, or null when the
 * platform keeps the generic default item (Payt, Braip). Yampi only (SaaS
 * #188): see yampiCapiCustomData.
 */
export function saleCapiCustomData(
  provider: SalesPlatformProvider,
  payload: unknown,
): YampiCapiCustomData | null {
  return provider === "yampi" ? yampiCapiCustomData(payload) : null;
}

/**
 * Parse options. `receivedAt` (arrival of the postback, default now) caps an
 * event time that would land in the future.
 */
export type SaleParseOptions = PaytParseOptions;

/** Every mapped event (URL única and non-Purchase rules). */
export function parseSaleEventV1(
  provider: SalesPlatformProvider,
  payload: unknown,
  options: SaleParseOptions = {},
): SaleEventParseResult {
  const parsed =
    provider === "braip"
      ? parseBraipSaleEventV1(payload, options)
      : provider === "yampi"
        ? parseYampiSaleEventV1(payload, options)
        : parsePaytSaleEventV1(payload, options);
  if (parsed.ok) return parsed;
  return {
    ok: false,
    kind: parsed.errorCode.endsWith("_status_not_supported")
      ? "status_not_supported"
      : "invalid",
    errorCode: parsed.errorCode,
    providerStatus: parsed.providerStatus ?? null,
  };
}

/** Historical Purchase-only contract of a per-rule URL. */
export function parseSalePurchaseV1(
  provider: SalesPlatformProvider,
  payload: unknown,
  options: SaleParseOptions = {},
):
  | { ok: true; value: ParsedSaleAutomationV1 }
  | { ok: false; errorCode: string } {
  switch (provider) {
    case "braip":
      return parseBraipAutomationV1(payload, options);
    case "yampi":
      return parseYampiAutomationV1(payload, options);
    default:
      return parsePaytAutomationV1(payload, options);
  }
}

/** "Not this rule's event" parse error of a sales platform (ignored). */
export function saleNotThisRuleErrorCode(
  provider: SalesPlatformProvider,
  ruleEventName: string,
): string {
  return ruleEventName === "Purchase"
    ? `${provider}_automation_v1_not_purchase`
    : `${provider}_automation_v1_event_not_in_rule`;
}

/** Whether a rule's product filter accepts the sale (empty = any product). */
export const saleProductFilterMatches = paytProductFilterMatches;
