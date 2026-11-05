import type {
  CurrencyCode,
  ReportDailyComparisonPointDto,
} from "@wpptrack/shared";
import { BrandMark } from "../../../components/brand";
import { defaultBrandConfig, type BrandConfig } from "../../../lib/brand";
import { formatReportMoney } from "../../../lib/report-currency";
import { OverviewHeroChart } from "./overview-hero-chart";

const formatMoneyCents = (cents: number, currency: CurrencyCode) =>
  formatReportMoney(cents, currency);

/**
 * "Painel de print" hero of the Visao geral: receita de trafego and ROAS in
 * large type, and under them investimento (bars) x receita (line) per day,
 * the two sides of the ROAS. The chart stretches to the height the row
 * gives the card (the KPI grid next to it sets it), so the card never ends
 * with empty space. Without the daily series a breakdown fills that space.
 */

export type OverviewHeroDay = {
  date: string;
  spendCents: number;
  revenueCents: number;
};

/** Days with the daily money fields, or null when the API did not send them. */
export function overviewHeroDays(
  points: ReportDailyComparisonPointDto[],
): OverviewHeroDay[] | null {
  if (
    points.length === 0 ||
    points.some(
      (point) =>
        point.spendCents === undefined ||
        point.trafficRevenueCents === undefined,
    )
  ) {
    return null;
  }

  return points.map((point) => ({
    date: point.date,
    spendCents: point.spendCents ?? 0,
    revenueCents: point.trafficRevenueCents ?? 0,
  }));
}

export function OverviewHero({
  brand = defaultBrandConfig,
  revenueCents,
  spendCents,
  roasLabel,
  roasAvailable,
  rangeLabel,
  currency,
  days,
  showSpend,
  breakdown,
}: {
  /** The signature follows the student's whitelabel (BRAND_NAME / logo). */
  brand?: BrandConfig;
  revenueCents: number;
  spendCents: number;
  /** "ROAS 12,61x", or the reason it is unavailable. */
  roasLabel: string;
  roasAvailable: boolean;
  rangeLabel: string;
  currency: CurrencyCode;
  /** Daily series; null shows the breakdown instead of the chart. */
  days: OverviewHeroDay[] | null;
  /** Spend bars only when the spend matches the page scope. */
  showSpend: boolean;
  breakdown: Array<{ label: string; value: string }>;
}) {
  return (
    // No visible title: the period is in the filters and the currency in the
    // symbol. Screen readers still get what the number is.
    <section
      className="overview-hero"
      aria-label={`Receita do tráfego, ${rangeLabel}`}
    >
      <div className="overview-hero-top">
        <strong className="overview-hero-value">
          {formatMoneyCents(revenueCents, currency)}
        </strong>
        {/* Every screenshot of this card carries the brand. */}
        <span className="overview-hero-signature" aria-hidden="true">
          <BrandMark brand={brand} gradientId="rastrackdash-r-hero" />
          {brand.name.toUpperCase()}
        </span>
      </div>
      <div className="overview-hero-roas">
        <span className={roasAvailable ? "is-roas" : "is-muted"}>
          {roasLabel}
        </span>
        {roasAvailable && showSpend ? (
          <small>
            com {formatMoneyCents(spendCents, currency)} investidos
          </small>
        ) : null}
      </div>
      {days && days.length > 1 ? (
        <OverviewHeroChart days={days} currency={currency} showSpend={showSpend} />
      ) : (
        <dl className="overview-hero-breakdown">
          {breakdown.map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
