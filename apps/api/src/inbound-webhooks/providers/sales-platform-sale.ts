import {
  braipSaleEventNameOf,
  parseBraipAutomationV1,
  parseBraipSaleEventV1,
  type ParsedBraipAutomationV1,
} from "./braip/braip-automation-v1.parser";
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
 * única — Payt e Braip. Mesmo contrato normalizado (evento do status, pedido,
 * produto/oferta, valor em centavos, telefone com candidatos BR), mesma
 * identidade de compra (workspace + provedor + conta + pedido + evento) e
 * mesmo roteamento. As datas sem fuso das duas são lidas como hora de
 * Brasília pelo leitor da fase 6.0 (sao-paulo-timestamp.ts) e nunca ficam
 * depois do recebimento.
 *
 * Hotmart (6.6) e Yampi (6.7) entram aqui quando forem portadas.
 */
export const SALES_PLATFORM_PROVIDERS = ["payt", "braip"] as const;
export type SalesPlatformProvider = (typeof SALES_PLATFORM_PROVIDERS)[number];
export const SALES_PLATFORM_PARSER_VERSION = "automation-v1";

export type ParsedSaleAutomationV1 =
  | ParsedPaytAutomationV1
  | ParsedBraipAutomationV1;

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
  return provider === "braip"
    ? braipSaleEventNameOf(payload)
    : paytSaleEventNameOf(payload);
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
  return provider === "braip"
    ? parseBraipAutomationV1(payload, options)
    : parsePaytAutomationV1(payload, options);
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
