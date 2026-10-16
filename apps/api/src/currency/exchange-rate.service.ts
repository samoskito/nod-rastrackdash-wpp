import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import type { CurrencyCode } from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  RUNTIME_ENV,
  RUNTIME_FETCH,
  type RuntimeEnv,
} from "../common/runtime/runtime.module";
import {
  fetchPtaxClosingRates,
  type ForeignCurrency,
  type PtaxClosingRate,
  type PtaxFetch,
} from "./ptax.client";

const FOREIGN_CURRENCIES: ForeignCurrency[] = ["USD", "EUR"];
/** Sem boletim no dia, usa o último dia útil anterior até N dias antes. */
export const MAX_RATE_FALLBACK_DAYS = 10;
/** Não repete a busca sob demanda da mesma moeda/dia por este tempo. */
const LAZY_FILL_RETRY_MS = 60 * 60_000;
/** A busca sob demanda nunca pede mais que isto de uma vez. */
const MAX_LAZY_FILL_DAYS = 400;
/** Sincronização periódica: a cada 6 h, os últimos dias de USD e EUR. */
export const PTAX_SYNC_INTERVAL_MS = 6 * 60 * 60_000;
const PTAX_SYNC_LOOKBACK_DAYS = 10;
const PTAX_TIMEZONE = "America/Sao_Paulo";

export type ExchangeRateRequest = { currency: CurrencyCode; date: string };

type ExchangeRateRow = {
  date: Date;
  baseCurrency: string;
  rate: { toString(): string } | number | string;
};

export type ExchangeRateClock = { now(): Date };
export const EXCHANGE_RATE_CLOCK = Symbol("EXCHANGE_RATE_CLOCK");
export const PTAX_FETCH = Symbol("PTAX_FETCH");

/** "2026-10-15" + n dias. */
export function shiftIsoDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Dia (America/Sao_Paulo) de um instante: o dia da venda para a PTAX. */
export function saoPauloDate(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PTAX_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value ?? "";

  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Sábado/domingo -> sexta anterior; dias úteis ficam iguais. */
export function previousWeekday(date: string): string {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day === 6
    ? shiftIsoDate(date, -1)
    : day === 0
      ? shiftIsoDate(date, -2)
      : date;
}

/**
 * `PTAX_SYNC_ENABLED`: desligada por padrão. Desligada, nada é buscado no
 * Banco Central e nada é convertido (venda em outra moeda fica na moeda
 * original, "sem cotação").
 */
export function isPtaxSyncEnabled(env: RuntimeEnv = process.env): boolean {
  const value = env.PTAX_SYNC_ENABLED?.trim().toLowerCase();
  return Boolean(value && ["1", "true", "yes", "sim", "on"].includes(value));
}

/**
 * Cotações carregadas para um relatório. Converte entre BRL/USD/EUR (USD<->EUR
 * via BRL) pela PTAX do dia ou, sem boletim nesse dia, pela do último dia útil
 * anterior (até MAX_RATE_FALLBACK_DAYS). Sem cotação, `convert` devolve null:
 * o relatório nunca quebra.
 */
export class ExchangeRateTable {
  private readonly rates = new Map<ForeignCurrency, Array<[string, number]>>();

  constructor(
    rows: Array<{ currency: ForeignCurrency; date: string; rate: number }> = [],
  ) {
    for (const row of rows) this.add(row.currency, row.date, row.rate);
  }

  add(currency: ForeignCurrency, date: string, rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    const list = this.rates.get(currency) ?? [];
    const index = list.findIndex(([existing]) => existing === date);
    if (index >= 0) list[index] = [date, rate];
    else list.push([date, rate]);
    list.sort((a, b) => a[0].localeCompare(b[0]));
    this.rates.set(currency, list);
  }

  hasExact(currency: ForeignCurrency, date: string): boolean {
    return (this.rates.get(currency) ?? []).some(([day]) => day === date);
  }

  /** Reais por 1 unidade (BRL = 1), ou null sem cotação. */
  brlRate(currency: CurrencyCode, date: string): number | null {
    if (currency === "BRL") return 1;
    const list = this.rates.get(currency) ?? [];
    const oldest = shiftIsoDate(date, -MAX_RATE_FALLBACK_DAYS);

    for (let index = list.length - 1; index >= 0; index -= 1) {
      const [day, rate] = list[index]!;
      if (day > date) continue;
      return day >= oldest ? rate : null;
    }

    return null;
  }

  /** Taxa from->to (1 from = N to) no dia, ou null sem cotação. */
  rate(from: CurrencyCode, to: CurrencyCode, date: string): number | null {
    if (from === to) return 1;
    const fromBrl = this.brlRate(from, date);
    const toBrl = this.brlRate(to, date);
    return fromBrl === null || toBrl === null ? null : fromBrl / toBrl;
  }

  convert(
    cents: number,
    from: CurrencyCode,
    to: CurrencyCode,
    date: string,
  ): number | null {
    if (from === to) return cents;
    const rate = this.rate(from, to, date);
    return rate === null ? null : Math.round(cents * rate);
  }
}

/**
 * Cotação PTAX (Banco Central) para os relatórios por moeda (Fase 5.2).
 * Mesmo padrão do sync automático da Meta: um timer no processo da API,
 * ligado só por variável de ambiente. Nada aqui envia algo à Meta e nenhum
 * erro do Banco Central sobe para quem chamou: no pior caso, "sem cotação".
 */
@Injectable()
export class ExchangeRateService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ExchangeRateService.name);
  private readonly lazyAttempts = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional()
    @Inject(PTAX_FETCH)
    private readonly ptaxFetch?: PtaxFetch,
    @Optional()
    @Inject(RUNTIME_FETCH)
    private readonly runtimeFetch?: typeof fetch,
    @Optional()
    @Inject(RUNTIME_ENV)
    private readonly env: RuntimeEnv = process.env,
    @Optional()
    @Inject(EXCHANGE_RATE_CLOCK)
    private readonly clock: ExchangeRateClock = { now: () => new Date() },
  ) {}

  enabled(): boolean {
    return isPtaxSyncEnabled(this.env ?? process.env);
  }

  onApplicationBootstrap() {
    if (!this.enabled()) {
      return;
    }

    const run = () => {
      void this.syncRecentRates()
        .then((result) => {
          this.logger.log(
            `PTAX sync stored=${result.stored} failed=${result.failed.join(",") || "-"}`,
          );
        })
        .catch(() => {
          this.logger.warn("PTAX_SYNC_FAILED");
        });
    };

    this.logger.log(
      "PTAX sync ligada: primeira busca em 1-2 min, depois a cada 6 h",
    );
    this.initialTimer = setTimeout(
      run,
      60_000 + Math.floor(Math.random() * 60_000),
    );
    this.timer = setInterval(run, PTAX_SYNC_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.timer) clearInterval(this.timer);
    this.initialTimer = null;
    this.timer = null;
  }

  /**
   * Sincronização periódica: guarda a PTAX dos últimos dias de USD e EUR.
   * Idempotente (única por dia e par de moedas); falha do BCB só gera log e
   * as cotações já guardadas continuam valendo.
   */
  async syncRecentRates(): Promise<{
    stored: number;
    failed: ForeignCurrency[];
  }> {
    if (!this.enabled() || this.running) {
      return { stored: 0, failed: [] };
    }

    this.running = true;
    const today = saoPauloDate(this.clock.now());
    const from = shiftIsoDate(today, -PTAX_SYNC_LOOKBACK_DAYS);
    let stored = 0;
    const failed: ForeignCurrency[] = [];

    try {
      for (const currency of FOREIGN_CURRENCIES) {
        try {
          const rates = await this.fetchRates(currency, from, today);
          stored += await this.storeRates(currency, rates);
        } catch {
          failed.push(currency);
          this.logger.warn(`PTAX_SYNC_UNAVAILABLE currency=${currency}`);
        }
      }
    } finally {
      this.running = false;
    }

    return { stored, failed };
  }

  /**
   * Cotações para converter vendas nas datas pedidas. Desligada: tabela
   * vazia, sem ler o banco nem a rede. Ligada: lê o que está guardado e busca
   * no BCB, uma vez por hora no máximo, os dias úteis que faltam. Nunca lança.
   */
  async loadRateTable(
    requests: ExchangeRateRequest[],
  ): Promise<ExchangeRateTable> {
    const table = new ExchangeRateTable();

    if (!this.enabled()) {
      return table;
    }

    const datesByCurrency = new Map<ForeignCurrency, Set<string>>();

    for (const request of requests) {
      if (request.currency === "BRL") continue;
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(request.date)) continue;
      const dates = datesByCurrency.get(request.currency) ?? new Set<string>();
      dates.add(request.date);
      datesByCurrency.set(request.currency, dates);
    }

    if (datesByCurrency.size === 0) return table;

    const allDates = [...datesByCurrency.values()].flatMap((dates) => [
      ...dates,
    ]);
    const minDate = allDates.reduce((a, b) => (a < b ? a : b));
    const maxDate = allDates.reduce((a, b) => (a > b ? a : b));

    try {
      const rows = (await this.prisma.exchangeRate.findMany({
        where: {
          baseCurrency: { in: [...datesByCurrency.keys()] },
          quoteCurrency: "BRL",
          date: {
            gte: new Date(
              `${shiftIsoDate(minDate, -MAX_RATE_FALLBACK_DAYS)}T00:00:00.000Z`,
            ),
            lte: new Date(`${maxDate}T00:00:00.000Z`),
          },
        },
        select: { date: true, baseCurrency: true, rate: true },
      })) as ExchangeRateRow[];

      for (const row of rows) {
        table.add(
          row.baseCurrency as ForeignCurrency,
          row.date.toISOString().slice(0, 10),
          Number(row.rate.toString()),
        );
      }
    } catch {
      this.logger.warn("EXCHANGE_RATE_READ_FAILED");
      return table;
    }

    const today = saoPauloDate(this.clock.now());
    const nowMs = this.clock.now().getTime();

    for (const [currency, dates] of datesByCurrency) {
      const businessDays = new Set([...dates].map(previousWeekday));
      const missing = [...businessDays]
        .filter(
          (date) =>
            date <= today &&
            !table.hasExact(currency, date) &&
            nowMs - (this.lazyAttempts.get(`${currency}:${date}`) ?? 0) >=
              LAZY_FILL_RETRY_MS,
        )
        .sort();

      if (missing.length === 0) continue;

      const to = missing[missing.length - 1]!;
      const earliest = shiftIsoDate(to, -MAX_LAZY_FILL_DAYS);
      const from = shiftIsoDate(
        missing[0]! < earliest ? earliest : missing[0]!,
        -MAX_RATE_FALLBACK_DAYS,
      );

      for (const date of missing) {
        this.lazyAttempts.set(`${currency}:${date}`, nowMs);
      }

      try {
        const rates = await this.fetchRates(currency, from, to);
        for (const rate of rates) table.add(currency, rate.date, rate.rate);
        await this.storeRates(currency, rates);
      } catch {
        this.logger.warn(
          `PTAX_LAZY_FILL_UNAVAILABLE currency=${currency} from=${from} to=${to}`,
        );
      }
    }

    if (this.lazyAttempts.size > 5_000) this.lazyAttempts.clear();

    return table;
  }

  private async fetchRates(
    currency: ForeignCurrency,
    from: string,
    to: string,
  ): Promise<PtaxClosingRate[]> {
    const fetchImpl =
      this.ptaxFetch ??
      (this.runtimeFetch as unknown as PtaxFetch | undefined) ??
      (fetch as unknown as PtaxFetch);

    return fetchPtaxClosingRates(fetchImpl, { currency, from, to });
  }

  private async storeRates(
    currency: ForeignCurrency,
    rates: PtaxClosingRate[],
  ): Promise<number> {
    if (rates.length === 0) return 0;

    try {
      const result = await this.prisma.exchangeRate.createMany({
        data: rates.map((rate) => ({
          date: new Date(`${rate.date}T00:00:00.000Z`),
          baseCurrency: currency,
          quoteCurrency: "BRL" as const,
          rate: rate.rate.toFixed(8),
          source: "bcb_ptax",
          bulletinAt: rate.bulletinAt,
          fetchedAt: this.clock.now(),
        })),
        skipDuplicates: true,
      });
      return result.count;
    } catch {
      this.logger.warn(`EXCHANGE_RATE_STORE_FAILED currency=${currency}`);
      return 0;
    }
  }
}
