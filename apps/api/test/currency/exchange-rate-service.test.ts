import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExchangeRateTable,
  isPtaxSyncEnabled,
  PTAX_SYNC_INTERVAL_MS,
  saoPauloDate,
} from "../../src/currency/exchange-rate.service";
import {
  buildPtaxUrl,
  parsePtaxResponse,
  type PtaxFetch,
} from "../../src/currency/ptax.client";
import {
  bcbPayload,
  ptaxHarness,
  storedRate,
} from "../reporting/currency-report-harness";

// Fase 5.2: PTAX do Banco Central. Portado do SaaS (5981c7c,
// exchange-rate-service) e adaptado à variável PTAX_SYNC_ENABLED do aluno,
// desligada por padrão. Nenhum teste toca a rede: o BCB é sempre falso.

const closing = bcbPayload([
  { date: "2026-10-08", rate: 5.0203, bulletin: "Abertura" },
  { date: "2026-10-08", rate: 5.0119 },
  { date: "2026-10-09", rate: 5.0018, bulletin: "Intermediário" },
  { date: "2026-10-09", rate: 4.9892 },
]);
const okFetch = () =>
  vi.fn<PtaxFetch>(async () => ({
    ok: true,
    status: 200,
    json: async () => closing,
  }));

afterEach(() => {
  vi.useRealTimers();
});

describe("PTAX_SYNC_ENABLED", () => {
  it("is off unless explicitly turned on", () => {
    expect(isPtaxSyncEnabled({})).toBe(false);
    expect(isPtaxSyncEnabled({ PTAX_SYNC_ENABLED: "" })).toBe(false);
    expect(isPtaxSyncEnabled({ PTAX_SYNC_ENABLED: "false" })).toBe(false);
    expect(isPtaxSyncEnabled({ PTAX_SYNC_ENABLED: "0" })).toBe(false);
    // The SaaS flag name does nothing here.
    expect(isPtaxSyncEnabled({ WPPTRACK_PTAX_SYNC_ENABLED: "true" })).toBe(
      false,
    );
    for (const value of ["true", "TRUE", " 1 ", "sim", "on", "yes"]) {
      expect(isPtaxSyncEnabled({ PTAX_SYNC_ENABLED: value })).toBe(true);
    }
  });

  it("off: no timer, no database read and no BCB call", async () => {
    vi.useFakeTimers();
    const { service, prisma, fetchImpl } = ptaxHarness({ enabled: false });

    service.onApplicationBootstrap();
    expect(vi.getTimerCount()).toBe(0);

    const table = await service.loadRateTable([
      { currency: "USD", date: "2026-10-09" },
    ]);
    expect(table.convert(1000, "USD", "BRL", "2026-10-09")).toBeNull();
    await expect(service.syncRecentRates()).resolves.toEqual({
      stored: 0,
      failed: [],
    });
    expect(prisma.exchangeRate.findMany).not.toHaveBeenCalled();
    expect(prisma.exchangeRate.createMany).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("on: syncs every 6 hours (first run 1-2 min after boot) and stops on shutdown", async () => {
    vi.useFakeTimers();
    const fetchImpl = okFetch();
    const { service } = ptaxHarness({ enabled: true, fetchImpl });

    service.onApplicationBootstrap();
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(120_000);
    // USD and EUR.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(PTAX_SYNC_INTERVAL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(PTAX_SYNC_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);

    service.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("PTAX client", () => {
  it("builds the Olinda URL with MM-DD-YYYY dates", () => {
    const url = buildPtaxUrl({
      currency: "USD",
      from: "2026-10-08",
      to: "2026-10-14",
    });
    expect(url.startsWith("https://olinda.bcb.gov.br/")).toBe(true);
    expect(url).toContain("@moeda=%27USD%27");
    expect(url).toContain("@dataInicial=%2710-08-2026%27");
    expect(url).toContain("@dataFinalCotacao=%2710-14-2026%27");
    expect(url).toContain("$format=json");
  });

  it("keeps only the closing bulletin (sell rate) of each day", () => {
    expect(
      parsePtaxResponse(closing).map(({ date, rate }) => ({ date, rate })),
    ).toEqual([
      { date: "2026-10-08", rate: 5.0119 },
      { date: "2026-10-09", rate: 4.9892 },
    ]);
    expect(() => parsePtaxResponse({ nope: true })).toThrow();
  });
});

describe("ExchangeRateTable", () => {
  const table = new ExchangeRateTable([
    { currency: "USD", date: "2026-10-09", rate: 5 },
    { currency: "EUR", date: "2026-10-09", rate: 5.5 },
  ]);

  it("converts via BRL, including cross rates USD<->EUR", () => {
    expect(table.convert(1000, "USD", "BRL", "2026-10-09")).toBe(5000);
    expect(table.convert(5000, "BRL", "USD", "2026-10-09")).toBe(1000);
    expect(table.convert(1000, "EUR", "USD", "2026-10-09")).toBe(1100);
    expect(table.convert(1100, "USD", "EUR", "2026-10-09")).toBe(1000);
    expect(table.convert(1234, "BRL", "BRL", "2026-01-01")).toBe(1234);
  });

  it("falls back to the last previous business-day rate, never a future one", () => {
    // Saturday, Sunday and the 12/10 holiday use Friday's PTAX.
    expect(table.convert(1000, "USD", "BRL", "2026-10-10")).toBe(5000);
    expect(table.convert(1000, "USD", "BRL", "2026-10-12")).toBe(5000);
    expect(table.convert(1000, "USD", "BRL", "2026-10-08")).toBeNull();
    // Too old a gap: no rate ("sem cotação").
    expect(table.convert(1000, "USD", "BRL", "2026-11-30")).toBeNull();
  });

  it("uses the Sao Paulo calendar day of the sale", () => {
    expect(saoPauloDate(new Date("2026-10-10T02:00:00.000Z"))).toBe(
      "2026-10-09",
    );
    expect(saoPauloDate(new Date("2026-10-10T03:00:00.000Z"))).toBe(
      "2026-10-10",
    );
  });
});

describe("ExchangeRateService (PTAX ligada)", () => {
  it("returns an empty table without any IO for BRL-only requests", async () => {
    const { service, prisma, fetchImpl } = ptaxHarness({ enabled: true });
    const table = await service.loadRateTable([
      { currency: "BRL", date: "2026-10-09" },
    ]);
    expect(table.convert(100, "BRL", "BRL", "2026-10-09")).toBe(100);
    expect(prisma.exchangeRate.findMany).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses stored rates without calling the BCB", async () => {
    const { service, fetchImpl } = ptaxHarness({
      enabled: true,
      rows: [storedRate("2026-10-09", "USD", "4.98920000")],
    });
    const table = await service.loadRateTable([
      { currency: "USD", date: "2026-10-09" },
      { currency: "USD", date: "2026-10-11" },
    ]);
    expect(table.convert(10000, "USD", "BRL", "2026-10-11")).toBe(49892);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fills a missing business day from the BCB once and stores it", async () => {
    const fetchImpl = okFetch();
    const { service, rows } = ptaxHarness({ enabled: true, fetchImpl });
    const table = await service.loadRateTable([
      { currency: "USD", date: "2026-10-09" },
    ]);
    expect(table.convert(10000, "USD", "BRL", "2026-10-09")).toBe(49892);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("olinda.bcb.gov.br");
    expect(rows).toHaveLength(2);

    // A second report in the same hour does not hit the BCB again.
    await service.loadRateTable([{ currency: "USD", date: "2026-10-09" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never breaks when the BCB is down: stored rate if any, otherwise null", async () => {
    const down = vi.fn<PtaxFetch>(async () => {
      throw new Error("ECONNRESET");
    });
    const empty = ptaxHarness({ enabled: true, fetchImpl: down });
    const none = await empty.service.loadRateTable([
      { currency: "EUR", date: "2026-10-09" },
    ]);
    expect(none.convert(1000, "EUR", "BRL", "2026-10-09")).toBeNull();

    const withStored = ptaxHarness({
      enabled: true,
      fetchImpl: down,
      rows: [storedRate("2026-10-07", "EUR", "5.80000000")],
    });
    const fallback = await withStored.service.loadRateTable([
      { currency: "EUR", date: "2026-10-09" },
    ]);
    // Last stored rate before the sale day.
    expect(fallback.convert(1000, "EUR", "BRL", "2026-10-09")).toBe(5800);

    const failing = ptaxHarness({
      enabled: true,
      fetchImpl: vi.fn<PtaxFetch>(async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
      })),
    });
    await expect(failing.service.syncRecentRates()).resolves.toEqual({
      stored: 0,
      failed: ["USD", "EUR"],
    });
  });

  it("periodic sync stores the last days of USD and EUR idempotently", async () => {
    const fetchImpl = okFetch();
    const { service, rows } = ptaxHarness({ enabled: true, fetchImpl });
    await expect(service.syncRecentRates()).resolves.toEqual({
      stored: 4,
      failed: [],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(service.syncRecentRates()).resolves.toEqual({
      stored: 0,
      failed: [],
    });
    expect(rows).toHaveLength(4);
  });
});
