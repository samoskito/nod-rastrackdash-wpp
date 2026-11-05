"use client";

import { formatMoney, type CurrencyCode } from "@wpptrack/shared";
import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";

/**
 * Investimento (bars) x receita (line) per day, on ONE money scale with a
 * labelled Y axis, so a line above the bars always means more revenue than
 * spend that day. Hover, tap or the arrow keys show the day's numbers (spend,
 * revenue, ROAS of the day); the last day's revenue and the largest spend are
 * labelled directly, so a screenshot reads without hovering.
 *
 * The plot stretches to the height its card has left (no empty space under
 * it). Shapes live in a stretched SVG; every text and dot is HTML placed in
 * percent, so nothing gets distorted.
 */

export type HeroChartDay = {
  date: string;
  spendCents: number;
  revenueCents: number;
};

/** Round the top of the axis up to 1, 2, 2.5 or 5 x 10^n. */
export function niceAxisMax(valueCents: number): number {
  if (valueCents <= 0) return 100;
  const exponent = Math.floor(Math.log10(valueCents));
  const base = 10 ** exponent;
  const step = [1, 2, 2.5, 5, 10].find((factor) => valueCents <= factor * base);
  return (step ?? 10) * base;
}

/** ROAS of one day, or null when nothing was invested that day. */
export function dayRoas(day: HeroChartDay): number | null {
  return day.spendCents > 0 ? day.revenueCents / day.spendCents : null;
}

function dayLabel(date: string) {
  const [, month, day] = date.split("-");
  return `${day}/${month}`;
}

function compactMoney(cents: number, currency: CurrencyCode) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency,
    notation: "compact",
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(cents / 100);
}

function roasText(roas: number | null) {
  return roas === null
    ? "sem investimento"
    : `${roas.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}x`;
}

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 1000;

export function OverviewHeroChart({
  days,
  currency,
  showSpend,
}: {
  days: HeroChartDay[];
  currency: CurrencyCode;
  /** Spend bars only when the spend matches the page scope. */
  showSpend: boolean;
}) {
  const [active, setActive] = useState<number | null>(null);
  const tooltipId = useId();
  const count = days.length;
  const axisMax = niceAxisMax(
    Math.max(
      0,
      ...days.map((day) =>
        showSpend ? Math.max(day.spendCents, day.revenueCents) : day.revenueCents,
      ),
    ),
  );
  /** Height in percent of the plot for a value in cents. */
  const pct = (cents: number) => (cents / axisMax) * 100;
  const slot = VIEW_WIDTH / count;
  const center = (index: number) => ((index + 0.5) / count) * 100;
  const barWidth = Math.max(4, slot * 0.46);
  const linePoints = days.map(
    (day, index) =>
      `${(index * slot + slot / 2).toFixed(1)} ${(VIEW_HEIGHT - (pct(day.revenueCents) / 100) * VIEW_HEIGHT).toFixed(1)}`,
  );
  const line = linePoints.map((point, index) => `${index ? "L" : "M"}${point}`).join(" ");
  const area = `${line} L${(VIEW_WIDTH - slot / 2).toFixed(1)} ${VIEW_HEIGHT} L${(slot / 2).toFixed(1)} ${VIEW_HEIGHT}Z`;
  const lastIndex = count - 1;
  const last = days[lastIndex]!;
  const maxSpendIndex = days.reduce(
    (best, day, index) => (day.spendCents > days[best]!.spendCents ? index : best),
    0,
  );
  const every = Math.max(1, Math.ceil(count / 7));
  const ticks = [axisMax, axisMax / 2, 0];
  const shown = active === null ? null : days[active]!;

  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / Math.max(rect.width, 1);
    setActive(Math.min(lastIndex, Math.max(0, Math.floor(ratio * count))));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      setActive((current) =>
        Math.min(lastIndex, Math.max(0, (current ?? (step > 0 ? -1 : count)) + step)),
      );
    } else if (event.key === "Escape") {
      setActive(null);
    }
  };

  return (
    <figure className="hero-chart">
      {/* The legend says it all on screen; the caption stays for screen readers. */}
      <figcaption className="hero-chart-caption">
        <span className="sr-only">
          {showSpend
            ? "Investimento (barras) e receita (linha) por dia"
            : "Receita por dia"}
        </span>
        <span className="hero-chart-legend" aria-hidden="true">
          {showSpend ? (
            <span>
              <i className="spend" />
              Investimento
            </span>
          ) : null}
          <span>
            <i className="revenue" />
            Receita
          </span>
        </span>
      </figcaption>

      <div className="hero-chart-body">
        <div className="hero-chart-axis" aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick} style={{ top: `${100 - pct(tick)}%` }}>
              {compactMoney(tick, currency)}
            </span>
          ))}
        </div>

        <div
          className="hero-chart-plot"
          role="group"
          tabIndex={0}
          aria-label={`Investimento e receita por dia, na mesma escala, em ${currency}. Use as setas para ver cada dia.`}
          aria-describedby={shown ? tooltipId : undefined}
          onPointerMove={pick}
          onPointerDown={pick}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse") setActive(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setActive(null)}
        >
          <svg
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {ticks.map((tick) => (
              <line
                key={tick}
                className={tick === 0 ? "hero-chart-baseline" : "hero-chart-grid"}
                x1="0"
                x2={VIEW_WIDTH}
                y1={VIEW_HEIGHT - (pct(tick) / 100) * VIEW_HEIGHT}
                y2={VIEW_HEIGHT - (pct(tick) / 100) * VIEW_HEIGHT}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {showSpend
              ? days.map((day, index) => {
                  const height = (pct(day.spendCents) / 100) * VIEW_HEIGHT;
                  return (
                    <rect
                      key={day.date}
                      className={`hero-chart-bar${active === index ? " is-active" : ""}`}
                      x={index * slot + (slot - barWidth) / 2}
                      y={VIEW_HEIGHT - height}
                      width={barWidth}
                      height={height}
                    />
                  );
                })
              : null}
            <path className="hero-chart-area" d={area} />
            <path
              className="hero-chart-line"
              d={line}
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          {/* Last day: dot + value, so the print explains itself. */}
          <span
            className="hero-chart-dot"
            style={{ left: `${center(lastIndex)}%`, bottom: `${pct(last.revenueCents)}%` }}
            aria-hidden="true"
          />
          <span
            className="hero-chart-label is-revenue"
            style={{ right: `${100 - center(lastIndex)}%`, bottom: `${pct(last.revenueCents)}%` }}
            aria-hidden="true"
          >
            {compactMoney(last.revenueCents, currency)}
          </span>
          {showSpend && days[maxSpendIndex]!.spendCents > 0 ? (
            <span
              className="hero-chart-label is-spend"
              style={{
                left: `${center(maxSpendIndex)}%`,
                bottom: `${pct(days[maxSpendIndex]!.spendCents)}%`,
              }}
              aria-hidden="true"
            >
              {compactMoney(days[maxSpendIndex]!.spendCents, currency)}
            </span>
          ) : null}

          {shown && active !== null ? (
            <>
              <span
                className="hero-chart-crosshair"
                style={{ left: `${center(active)}%` }}
                aria-hidden="true"
              />
              <span
                className="hero-chart-dot is-active"
                style={{ left: `${center(active)}%`, bottom: `${pct(shown.revenueCents)}%` }}
                aria-hidden="true"
              />
              <div
                id={tooltipId}
                role="tooltip"
                className={`hero-chart-tooltip${center(active) > 55 ? " is-left" : ""}`}
                style={{ left: `${center(active)}%` }}
              >
                <strong>{dayLabel(shown.date)}</strong>
                {showSpend ? (
                  <span>
                    <i className="spend" aria-hidden="true" />
                    Investimento <b>{formatMoney(shown.spendCents, currency)}</b>
                  </span>
                ) : null}
                <span>
                  <i className="revenue" aria-hidden="true" />
                  Receita <b>{formatMoney(shown.revenueCents, currency)}</b>
                </span>
                {showSpend ? (
                  <span>
                    ROAS do dia <b>{roasText(dayRoas(shown))}</b>
                  </span>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </div>

      <div className="hero-chart-days" aria-hidden="true">
        {days.map((day, index) => (
          <span key={day.date}>
            {index % every === 0 || index === lastIndex ? dayLabel(day.date) : ""}
          </span>
        ))}
      </div>

      {/* Table view for screen readers. */}
      <table className="sr-only">
        <caption>Investimento e receita por dia ({currency})</caption>
        <thead>
          <tr>
            <th scope="col">Dia</th>
            {showSpend ? <th scope="col">Investimento</th> : null}
            <th scope="col">Receita</th>
            {showSpend ? <th scope="col">ROAS do dia</th> : null}
          </tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.date}>
              <th scope="row">{dayLabel(day.date)}</th>
              {showSpend ? <td>{formatMoney(day.spendCents, currency)}</td> : null}
              <td>{formatMoney(day.revenueCents, currency)}</td>
              {showSpend ? <td>{roasText(dayRoas(day))}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
