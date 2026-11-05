// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import {
  OverviewHeroChart,
  dayRoas,
  niceAxisMax,
  type HeroChartDay,
} from "../src/app/(app)/overview/overview-hero-chart";

afterEach(cleanup);

// The production case Samuel saw: revenue ~5x below spend (ROAS 0,19x).
const days: HeroChartDay[] = [
  { date: "2026-10-22", spendCents: 36000, revenueCents: 0 },
  { date: "2026-10-23", spendCents: 38000, revenueCents: 4900 },
  { date: "2026-10-24", spendCents: 35000, revenueCents: 0 },
  { date: "2026-10-25", spendCents: 37000, revenueCents: 9900 },
  { date: "2026-10-26", spendCents: 36500, revenueCents: 14900 },
  { date: "2026-10-27", spendCents: 37034, revenueCents: 19479 },
  { date: "2026-10-28", spendCents: 36000, revenueCents: 0 },
];

function renderChart(showSpend = true) {
  return render(
    React.createElement(OverviewHeroChart, { days, currency: "USD", showSpend }),
  );
}

/** Top of a revenue point and of a bar, as fractions of the plot height. */
function scaleOf(container: HTMLElement, index: number) {
  const bar = container.querySelectorAll("rect.hero-chart-bar")[index]!;
  const line = container.querySelector("path.hero-chart-line")!.getAttribute("d")!;
  const points = [...line.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => Number(m[2]));
  return {
    barTop: Number(bar.getAttribute("y")),
    lineY: points[index]!,
  };
}

describe("niceAxisMax", () => {
  it("rounds the axis top up to 1, 2, 2.5 or 5 x 10^n", () => {
    expect(niceAxisMax(38000)).toBe(50000);
    expect(niceAxisMax(20000)).toBe(20000);
    expect(niceAxisMax(21000)).toBe(25000);
    expect(niceAxisMax(0)).toBe(100);
  });
});

describe("dayRoas", () => {
  it("divides revenue by spend, and is null without spend", () => {
    expect(dayRoas({ date: "d", spendCents: 20000, revenueCents: 10000 })).toBe(0.5);
    expect(dayRoas({ date: "d", spendCents: 0, revenueCents: 10000 })).toBeNull();
  });
});

describe("OverviewHeroChart", () => {
  it("draws spend and revenue on the same scale (revenue below spend stays below)", () => {
    const { container } = renderChart();

    // Every day here has less revenue than spend: the line never goes above
    // the top of the bar of the same day (SVG y grows downwards).
    days.forEach((_, index) => {
      const { barTop, lineY } = scaleOf(container, index);
      expect(lineY).toBeGreaterThanOrEqual(barTop);
    });
  });

  it("labels the Y axis in the account currency; the legend names the series", () => {
    renderChart();

    const legend = document.querySelector(".hero-chart-legend")!.textContent!;
    expect(legend).toContain("Investimento");
    expect(legend).toContain("Receita");
    // The reading is in the legend; no visible subtitle repeats it.
    expect(document.querySelector(".hero-chart-title")).toBeNull();
    const axis = document.querySelector(".hero-chart-axis")!.textContent!;
    expect(axis).toMatch(/US\$/);
    expect(axis).toMatch(/500/);
  });

  it("labels the last day's revenue and the largest spend directly", () => {
    const { container } = renderChart();
    const labels = [...container.querySelectorAll(".hero-chart-label")].map(
      (label) => label.textContent,
    );

    expect(labels).toHaveLength(2);
    expect(labels[0]).toMatch(/US\$\s?0/);
    expect(labels[1]).toMatch(/US\$\s?380/);
  });

  it("shows day, spend, revenue and the day's ROAS from the keyboard", () => {
    renderChart();
    const plot = screen.getByRole("group");

    fireEvent.keyDown(plot, { key: "ArrowLeft" });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain("28/10");

    fireEvent.keyDown(plot, { key: "ArrowLeft" });
    const text = screen.getByRole("tooltip").textContent!;
    expect(text).toContain("27/10");
    expect(text).toMatch(/Investimento\s*US\$\s?370,34/);
    expect(text).toMatch(/Receita\s*US\$\s?194,79/);
    expect(text).toMatch(/ROAS do dia\s*0,53x/);

    fireEvent.keyDown(plot, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("opens the day under the finger on tap", () => {
    renderChart();
    const plot = screen.getByRole("group");
    plot.getBoundingClientRect = () =>
      ({ left: 0, width: 700, top: 0, height: 200, right: 700, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    fireEvent.pointerDown(plot, { clientX: 5, pointerType: "touch" });
    expect(screen.getByRole("tooltip").textContent).toContain("22/10");
  });

  it("keeps a table of every day for screen readers", () => {
    const { container } = renderChart();
    const rows = container.querySelectorAll("table.sr-only tbody tr");

    expect(rows).toHaveLength(7);
    expect(rows[5]!.textContent).toContain("0,53x");
  });

  it("without the spend scope shows only the revenue", () => {
    const { container } = renderChart(false);

    expect(container.querySelectorAll("rect.hero-chart-bar")).toHaveLength(0);
    expect(document.querySelector(".hero-chart-legend")!.textContent).toBe(
      "Receita",
    );
  });
});
