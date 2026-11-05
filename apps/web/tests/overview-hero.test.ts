import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  OverviewHero,
  overviewHeroDays,
} from "../src/app/(app)/overview/overview-hero";

const points = [
  {
    date: "2026-10-22",
    metaConversationsStarted: 10,
    realConversations: 8,
    spendCents: 61000,
    trafficRevenueCents: 690000,
  },
  {
    date: "2026-10-23",
    metaConversationsStarted: 12,
    realConversations: 9,
    spendCents: 65500,
    trafficRevenueCents: 820000,
  },
];

function hero(overrides: Partial<Parameters<typeof OverviewHero>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(OverviewHero, {
      revenueCents: 1510000,
      spendCents: 126500,
      roasLabel: "ROAS 11,94x",
      roasAvailable: true,
      rangeLabel: "22/10 a 23/10",
      currency: "BRL",
      days: overviewHeroDays(points),
      showSpend: true,
      breakdown: [
        { label: "Primeira compra", value: "R$ 15.100,00" },
        { label: "Recompra", value: "R$ 0,00" },
      ],
      ...overrides,
    }),
  );
}

describe("overviewHeroDays", () => {
  it("reads investimento and receita per day", () => {
    expect(overviewHeroDays(points)).toEqual([
      { date: "2026-10-22", spendCents: 61000, revenueCents: 690000 },
      { date: "2026-10-23", spendCents: 65500, revenueCents: 820000 },
    ]);
  });

  it("returns null when the API did not send the daily money fields", () => {
    expect(
      overviewHeroDays([
        { date: "2026-10-22", metaConversationsStarted: 1, realConversations: 1 },
      ]),
    ).toBeNull();
    expect(overviewHeroDays([])).toBeNull();
  });
});

describe("OverviewHero", () => {
  it("shows receita, ROAS, the brand and the investimento x receita chart", () => {
    const html = hero();

    // No visible title: the period is in the filters, the currency in the
    // symbol and the reading in the legend. The value is named for screen
    // readers only.
    expect(html).toContain("aria-label=\"Receita do tráfego, 22/10 a 23/10\"");
    expect(html).not.toContain("overview-hero-label");
    expect(html).toMatch(/R\$\s?15\.100,00/);
    expect(html).toContain("ROAS 11,94x");
    expect(html).toContain("RASTRACKDASH");
    expect(html).toContain("hero-chart-plot");
    expect(html).toContain("hero-chart-bar");
    expect(html).not.toContain("Investimento (barras) × Receita (linha) por dia");
    expect(html).not.toContain("Valores em BRL");
    expect(html).toContain("hero-chart-legend");
    expect(html).not.toContain("overview-hero-breakdown");
  });

  it("fills the card with the breakdown when there is no daily series", () => {
    const html = hero({ days: null });

    expect(html).toContain("overview-hero-breakdown");
    expect(html).toContain("Primeira compra");
    expect(html).not.toContain("hero-chart-plot");
  });

  it("drops the spend bars when the spend does not match the page scope", () => {
    const html = hero({
      showSpend: false,
      roasAvailable: false,
      roasLabel: "Receita do numero; ROAS indisponivel",
    });

    expect(html).not.toContain("hero-chart-bar");
    expect(html).not.toContain("investidos");
    expect(html).toContain("Receita do numero; ROAS indisponivel");
  });
});
