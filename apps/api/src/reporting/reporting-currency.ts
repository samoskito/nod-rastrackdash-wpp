import {
  DEFAULT_CURRENCY_CODE,
  normalizeCurrencyCode,
  supportedCurrencyCodes,
  type CurrencyCode,
  type ReportCurrencyGroupDto,
  type ReportTotalsDto,
  type UnconvertedRevenueDto,
} from "@wpptrack/shared";
import {
  saoPauloDate,
  type ExchangeRateRequest,
  type ExchangeRateTable,
} from "../currency/exchange-rate.service";
import type {
  ReportingMetricEvent,
  ReportingMetricLead,
} from "./reporting-metrics.engine";

/**
 * Moeda nos relatórios (Fase 5.2).
 *
 * - Gasto: sempre na moeda da conta de anúncio (correção manual -> moeda da
 *   Meta -> BRL). Moedas diferentes NUNCA são somadas.
 * - Receita atribuída a um anúncio: convertida para a moeda da conta desse
 *   anúncio pela PTAX do dia da venda (America/Sao_Paulo).
 * - Receita sem anúncio: fica na própria moeda (grupo dessa moeda).
 * - Sem cotação (PTAX desligada, BCB fora, dia sem boletim): a venda conta
 *   como compra, mas o valor sai da receita e vai para `unconvertedRevenue`
 *   na moeda original (a tela mostra "sem cotação").
 * - Evento antigo sem moeda = BRL (padrão histórico).
 */

export type ReportAttribution = {
  campaignId: string | null;
  adSetId: string | null;
  adId: string | null;
};

export type CurrencyConvertedEvent = ReportingMetricEvent & {
  /** Valor e moeda como a venda chegou (antes da PTAX). */
  originalValueCents?: number | null;
  originalCurrency?: string | null;
  exchangeRateMissing?: boolean;
};

export type CurrencyEntity = {
  currency: CurrencyCode;
  adAccountId: string | null;
  spendCents: number;
  metaConversationsStarted: number;
};

export type AttributionCurrencyResolver = (
  item: ReportAttribution,
) => CurrencyCode | null;

/** Moeda própria de um evento (null quando a moeda não é suportada). */
export function eventOwnCurrency(event: {
  currency: string | null;
}): CurrencyCode | null {
  return event.currency?.trim()
    ? normalizeCurrencyCode(event.currency)
    : DEFAULT_CURRENCY_CODE;
}

/** Cotações necessárias para converter as vendas dos eventos. */
export function exchangeRateRequests(
  events: ReportingMetricEvent[],
  targetOf: AttributionCurrencyResolver,
): ExchangeRateRequest[] {
  const requests: ExchangeRateRequest[] = [];

  for (const event of events) {
    if (event.valueCents == null) continue;
    const from = eventOwnCurrency(event);
    const to = targetOf(event);
    if (!from || !to || from === to) continue;
    const date = saoPauloDate(new Date(event.eventOccurredAt));
    requests.push({ currency: from, date }, { currency: to, date });
  }

  return requests;
}

/**
 * Converte o valor de cada venda para a moeda da conta do anúncio a que foi
 * atribuída (vendas sem anúncio ficam na própria moeda). Todo evento sai com
 * `currency` = moeda em que o valor está agora. Sem cotação, `valueCents`
 * vira null e o valor original fica em `originalValueCents`.
 */
export function convertEventValues<E extends ReportingMetricEvent>(
  events: E[],
  targetOf: AttributionCurrencyResolver,
  table: ExchangeRateTable | null,
): Array<E & CurrencyConvertedEvent> {
  return events.map((event) => {
    const own = eventOwnCurrency(event);
    const target = targetOf(event) ?? own;

    if (event.valueCents == null) {
      return { ...event, currency: target ?? DEFAULT_CURRENCY_CODE };
    }

    // Código fora de BRL/USD/EUR gravado antes da moeda configurável: sem
    // como converter, segue somado como sempre foi (na moeda do anúncio).
    if (!own) {
      return { ...event, currency: target ?? DEFAULT_CURRENCY_CODE };
    }

    if (!target || own === target) {
      return { ...event, currency: own };
    }

    const converted = table
      ? table.convert(
          event.valueCents,
          own,
          target,
          saoPauloDate(new Date(event.eventOccurredAt)),
        )
      : null;

    return {
      ...event,
      currency: target,
      valueCents: converted,
      originalValueCents: event.valueCents,
      originalCurrency: own,
      ...(converted === null ? { exchangeRateMissing: true } : {}),
    };
  });
}

function groupCurrency(
  item: ReportAttribution & { currency?: string | null },
  resolve: AttributionCurrencyResolver,
  fallback: CurrencyCode,
): CurrencyCode {
  return normalizeCurrencyCode(item.currency) ?? resolve(item) ?? fallback;
}

/** Receita sem cotação dos eventos, somada por moeda original. */
export function unconvertedRevenueOf(
  events: CurrencyConvertedEvent[],
): UnconvertedRevenueDto[] {
  const totals = new Map<CurrencyCode, number>();

  for (const event of events) {
    if (!event.exchangeRateMissing || !event.originalValueCents) continue;
    const currency = normalizeCurrencyCode(event.originalCurrency);
    if (!currency) continue;
    totals.set(
      currency,
      (totals.get(currency) ?? 0) + event.originalValueCents,
    );
  }

  return supportedCurrencyCodes
    .filter((currency) => totals.has(currency))
    .map((currency) => ({ currency, valueCents: totals.get(currency)! }));
}

/** Campos de "sem cotação" de uma linha (vazio quando tudo foi convertido). */
export function rowExchangeRateFields(events: CurrencyConvertedEvent[]): {
  exchangeRateMissing?: true;
  unconvertedRevenue?: UnconvertedRevenueDto[];
} {
  return events.some((event) => event.exchangeRateMissing)
    ? {
        exchangeRateMissing: true,
        unconvertedRevenue: unconvertedRevenueOf(events),
      }
    : {};
}

export type CurrencyBreakdown = {
  /** Moeda única do relatório, ou null quando há mais de uma. */
  currency: CurrencyCode | null;
  byCurrency?: ReportCurrencyGroupDto[];
  exchangeRateMissing: boolean;
  unconvertedRevenue: UnconvertedRevenueDto[];
};

/**
 * Moedas com movimento REAL no período/filtro: gasto > 0 ou receita
 * (convertida ou sem cotação) > 0 nessa moeda. Uma conta em USD sem gasto e
 * sem venda no período não cria grupo (nunca mostrar grupo zerado).
 */
export function reportCurrencies(input: {
  entities: CurrencyEntity[];
  events: CurrencyConvertedEvent[];
}): CurrencyCode[] {
  const present = new Set<CurrencyCode>(
    input.entities
      .filter((entity) => entity.spendCents > 0)
      .map((entity) => entity.currency),
  );

  for (const event of input.events) {
    const hasValue = Boolean(event.valueCents && event.valueCents > 0);
    const hasUnconverted = Boolean(
      event.exchangeRateMissing &&
      event.originalValueCents &&
      event.originalValueCents > 0,
    );
    if (!hasValue && !hasUnconverted) continue;
    const currency = normalizeCurrencyCode(event.currency);
    if (currency) present.add(currency);
  }

  return supportedCurrencyCodes.filter((currency) => present.has(currency));
}

/**
 * Totais por moeda. Com uma moeda ativa só (todo workspace em BRL, mesmo com
 * uma conta USD parada no período), devolve só `currency` e os totais de
 * sempre continuam valendo; sem nenhuma moeda ativa, devolve
 * `fallbackCurrency`; com mais de uma, um grupo por moeda ativa (mesmo
 * formato de `totals` + `currency`), nunca um grupo zerado.
 */
export function buildCurrencyBreakdown<
  E extends CurrencyConvertedEvent,
  L extends ReportingMetricLead,
>(input: {
  entities: CurrencyEntity[];
  events: E[];
  leads: L[];
  returningEvents: E[];
  attributionCurrency: AttributionCurrencyResolver;
  /**
   * Moeda de leads/eventos sem anúncio quando há mais de uma moeda ativa, e
   * moeda do relatório quando nenhuma moeda teve movimento.
   */
  fallbackCurrency: CurrencyCode;
  calculate: (args: {
    spendCents: number;
    metaConversationsStarted: number;
    events: E[];
    leads: L[];
    returningEvents: E[];
  }) => ReportTotalsDto;
}): CurrencyBreakdown {
  const currencies = reportCurrencies(input);
  const exchangeRateMissing = input.events.some(
    (event) => event.exchangeRateMissing,
  );
  const unconvertedRevenue = unconvertedRevenueOf(input.events);

  if (currencies.length <= 1) {
    return {
      currency: currencies[0] ?? input.fallbackCurrency,
      exchangeRateMissing,
      unconvertedRevenue,
    };
  }

  const byCurrency = currencies.map((currency): ReportCurrencyGroupDto => {
    const entities = input.entities.filter(
      (entity) => entity.currency === currency,
    );
    const events = input.events.filter(
      (event) =>
        groupCurrency(
          event,
          input.attributionCurrency,
          input.fallbackCurrency,
        ) === currency,
    );
    const metrics = input.calculate({
      spendCents: entities.reduce((sum, entity) => sum + entity.spendCents, 0),
      metaConversationsStarted: entities.reduce(
        (sum, entity) => sum + entity.metaConversationsStarted,
        0,
      ),
      events,
      leads: input.leads.filter(
        (lead) =>
          (input.attributionCurrency(lead) ?? input.fallbackCurrency) ===
          currency,
      ),
      returningEvents: input.returningEvents.filter(
        (event) =>
          (input.attributionCurrency(event) ?? input.fallbackCurrency) ===
          currency,
      ),
    });

    return {
      ...metrics,
      currency,
      adAccountIds: [
        ...new Set(
          entities
            .map((entity) => entity.adAccountId)
            .filter((id): id is string => Boolean(id)),
        ),
      ],
      exchangeRateMissing: events.some((event) => event.exchangeRateMissing),
      unconvertedRevenue: unconvertedRevenueOf(events),
    };
  });

  return {
    currency: null,
    byCurrency,
    exchangeRateMissing,
    unconvertedRevenue,
  };
}
