import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ExchangeRateTable } from "../../src/currency/exchange-rate.service";
import {
  brlReports,
  brlWorkspaceDb,
  createReportingService,
} from "./currency-report-harness";

// Fase 5.2, sem regressão: os relatórios de um workspace todo em BRL saem com
// os MESMOS números de antes da moeda por conta. O arquivo de referência foi
// gerado com o código anterior à Fase 5.2 (port/f5-1-moeda) e não muda.
const baseline = JSON.parse(
  readFileSync(
    resolve(__dirname, "fixtures", "brl-workspace-baseline.json"),
    "utf8",
  ),
) as Record<string, unknown>;

/** Remove só o que a Fase 5.2 acrescenta: a moeda (sempre "BRL" aqui). */
function withoutCurrency(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCurrency);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "currency")
        .map(([key, item]) => [key, withoutCurrency(item)]),
    );
  }
  return value;
}

function csvWithoutLastColumn(csv: string): string {
  return csv
    .split("\n")
    .map((line) => (line ? line.slice(0, line.lastIndexOf(",")) : line))
    .join("\n");
}

describe("Fase 5.2: workspace todo em BRL não muda", () => {
  it("keeps every number of campaigns, ad sets, ads and summary identical", async () => {
    const reports = await brlReports(createReportingService(brlWorkspaceDb()));

    expect(withoutCurrency(reports.overview)).toEqual(baseline.overview);
    expect(withoutCurrency(reports.overviewByAccount)).toEqual(
      baseline.overviewByAccount,
    );
    expect(withoutCurrency(reports.adSets)).toEqual(baseline.adSets);
    expect(withoutCurrency(reports.ads)).toEqual(baseline.ads);
  });

  it("only adds currency BRL: no groups, no sem cotação, no rate lookup", async () => {
    const service = createReportingService(brlWorkspaceDb());
    const loadRateTable = vi.fn(async () => new ExchangeRateTable());
    Object.assign(service as object, { exchangeRates: { loadRateTable } });

    const reports = await brlReports(service);

    for (const report of [
      reports.overview,
      reports.overviewByAccount,
      reports.adSets,
      reports.ads,
    ]) {
      expect(report.currency).toBe("BRL");
      expect(report.byCurrency).toBeUndefined();
      expect(report.exchangeRateMissing).toBeUndefined();
      expect(report.unconvertedRevenue).toBeUndefined();
    }
    expect(reports.overview.summary?.currency).toBe("BRL");
    expect(reports.overview.summaryByCurrency).toBeUndefined();
    expect(reports.overview.campaigns.map((row) => row.currency)).toEqual([
      "BRL",
      "BRL",
    ]);
    expect(loadRateTable).not.toHaveBeenCalled();
  });

  it("keeps the CSV columns in place and appends Moeda at the end", async () => {
    const reports = await brlReports(createReportingService(brlWorkspaceDb()));

    expect(csvWithoutLastColumn(reports.csv)).toBe(baseline.csv);
    expect(reports.csv.split("\n")[0]).toMatch(/,Moeda$/u);
    expect(reports.csv.split("\n")[1]).toMatch(/,BRL$/u);
  });
});
