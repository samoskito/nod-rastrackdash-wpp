import { z } from "zod";

/**
 * Moedas suportadas para o recebimento (conversões enviadas à Meta) e para a
 * correção da moeda por conta de anúncio. O modelo aceita ampliar depois;
 * hoje são só BRL, USD e EUR.
 */
export const supportedCurrencyCodes = ["BRL", "USD", "EUR"] as const;
export const currencyCodeSchema = z.enum(supportedCurrencyCodes);
export type CurrencyCode = z.infer<typeof currencyCodeSchema>;

/** Moeda histórica de tudo que existia antes da moeda configurável. */
export const DEFAULT_CURRENCY_CODE: CurrencyCode = "BRL";

/**
 * Normaliza um código vindo de payload ou do banco ("usd", " EUR ") para a
 * moeda suportada, ou null quando ausente ou fora de BRL/USD/EUR.
 */
export function normalizeCurrencyCode(value: unknown): CurrencyCode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return (supportedCurrencyCodes as readonly string[]).includes(normalized)
    ? (normalized as CurrencyCode)
    : null;
}

export function isSupportedCurrencyCode(value: unknown): value is CurrencyCode {
  return normalizeCurrencyCode(value) === value;
}

/**
 * Moeda efetiva do investimento de uma conta de anúncio:
 * correção manual ?? moeda informada pela Meta ?? BRL.
 */
export function effectiveAccountCurrency(account: {
  currency?: string | null;
  currencyOverride?: string | null;
}): CurrencyCode {
  return (
    normalizeCurrencyCode(account.currencyOverride) ??
    normalizeCurrencyCode(account.currency) ??
    DEFAULT_CURRENCY_CODE
  );
}

/**
 * Ordem de resolução da moeda de uma conversão:
 * moeda da venda/negócio (payload) -> moeda da regra (null = herdar) ->
 * "Moeda das conversões" do workspace -> BRL.
 * Códigos não suportados são ignorados (passa para o próximo nível).
 */
export function resolveConversionCurrency(input: {
  payload?: string | null;
  rule?: string | null;
  workspace?: string | null;
}): CurrencyCode {
  return (
    normalizeCurrencyCode(input.payload) ??
    normalizeCurrencyCode(input.rule) ??
    normalizeCurrencyCode(input.workspace) ??
    DEFAULT_CURRENCY_CODE
  );
}

const currencySymbols: Record<CurrencyCode, string> = {
  BRL: "R$",
  USD: "US$",
  EUR: "€",
};

export function currencySymbol(currency: string | null | undefined): string {
  const code = normalizeCurrencyCode(currency);
  return code ? currencySymbols[code] : (currency?.trim().toUpperCase() ?? "");
}

/**
 * Formatador único de dinheiro (centavos -> texto), para a tela.
 * formatMoney(123456, "BRL") === "R$ 1.234,56"
 * formatMoney(123456, "USD") === "US$ 1.234,56"
 * formatMoney(123456, "EUR") === "€ 1.234,56"
 * Sempre usa espaço normal entre símbolo e número (estável em testes e CSV).
 * Valor nulo ou indefinido vira "-".
 */
export function formatMoney(
  cents: number | null | undefined,
  currency: CurrencyCode | string | null | undefined = DEFAULT_CURRENCY_CODE,
  locale = "pt-BR",
): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) {
    return "-";
  }

  const negative = cents < 0;
  const number = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: true,
  })
    .format(Math.abs(cents) / 100)
    .replace(/[  ]/gu, " ");
  const symbol = currencySymbol(currency ?? DEFAULT_CURRENCY_CODE);

  return `${negative ? "-" : ""}${symbol} ${number}`;
}
