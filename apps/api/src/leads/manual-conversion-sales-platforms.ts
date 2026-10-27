import { parseBraipSaleEventV1 } from "../inbound-webhooks/providers/braip/braip-automation-v1.parser";
import { parsePaytSaleEventV1 } from "../inbound-webhooks/providers/payt/payt-automation-v1.parser";

/**
 * Plataformas de venda cuja Compra deduplica contra a compra manual com
 * pedido (porte do SaaS #158). Cada plataforma lê o número do pedido do
 * callback preservado com o seu próprio leitor.
 *
 * Ponto de extensão: Payt e Braip (fase 6.5, `trans_key` da venda) já
 * participam; Hotmart (6.6) e Yampi (6.7) entram aqui quando forem portadas,
 * cada uma com o leitor do seu postback. Uma compra de outra plataforma nunca
 * é lida.
 */
export type ManualPurchaseSalesPlatform = {
  provider: string;
  /** Versão do parser da regra que gravou a venda. */
  parserVersion: string;
  /** Número do pedido/venda do callback (null quando não é lido). */
  readOrderRef(payload: unknown): string | null;
};

export const MANUAL_PURCHASE_SALES_PLATFORMS: readonly ManualPurchaseSalesPlatform[] =
  [
    {
      provider: "payt",
      parserVersion: "automation-v1",
      readOrderRef(payload) {
        const parsed = parsePaytSaleEventV1(payload);
        return parsed.ok ? parsed.value.orderRef : null;
      },
    },
    {
      // Fase 6.5 (porte do hunk de compra do SaaS #158): o pedido da Braip
      // é a transação (trans_key) do postback guardado.
      provider: "braip",
      parserVersion: "automation-v1",
      readOrderRef(payload) {
        const parsed = parseBraipSaleEventV1(payload);
        return parsed.ok ? parsed.value.orderRef : null;
      },
    },
  ];

/** Plataforma da regra (provedor + versão do parser), ou null. */
export function manualPurchaseSalesPlatformOf(
  release: { provider: string; version: string } | null | undefined,
): ManualPurchaseSalesPlatform | null {
  if (!release) return null;
  return (
    MANUAL_PURCHASE_SALES_PLATFORMS.find(
      (platform) =>
        platform.provider === release.provider &&
        platform.parserVersion === release.version,
    ) ?? null
  );
}

/** Prefixos de sourceTrigger das compras dessas plataformas. */
export function manualPurchaseSalesPlatformTriggers(): string[] {
  return MANUAL_PURCHASE_SALES_PLATFORMS.map(
    (platform) => `inbound_webhook:${platform.provider}:`,
  );
}
