import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BrandMark, BrandName } from "../src/components/brand";
import { OverviewHero } from "../src/app/(app)/overview/overview-hero";
import { defaultBrandConfig, type BrandConfig } from "../src/lib/brand";

const custom: BrandConfig = {
  ...defaultBrandConfig,
  name: "Agencia Aluno",
};

function render(element: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(element);
}

describe("BrandMark (whitelabel)", () => {
  it("draws the RastrackDash symbol for the default brand", () => {
    const html = render(createElement(BrandMark, { gradientId: "test-r" }));

    expect(html).toContain('class="brand-mark"');
    expect(html).toContain("url(#test-r)");
    expect(html).not.toContain("brand-mark-letter");
  });

  it("uses the first letter of a custom BRAND_NAME instead of the symbol", () => {
    const html = render(createElement(BrandMark, { brand: custom }));

    expect(html).toContain("brand-mark-letter");
    expect(html).toContain(">A</span>");
    expect(html).not.toContain("<svg");
  });

  it("uses the student's BRAND_LOGO_URL when set", () => {
    const html = render(
      createElement(BrandMark, {
        brand: { ...custom, logoUrl: "https://example.com/logo.png" },
      }),
    );

    expect(html).toContain('src="https://example.com/logo.png"');
    expect(html).toContain("brand-mark-logo");
    expect(html).not.toContain("<svg");
  });
});

describe("BrandName (whitelabel)", () => {
  it("shows the RastrackDash wordmark for the default brand", () => {
    const html = render(createElement(BrandName, {}));

    expect(html).toContain("brand-wordmark");
    expect(html).toContain("RASTRACK");
  });

  it("shows the custom name, never the RastrackDash wordmark", () => {
    const html = render(createElement(BrandName, { brand: custom }));

    expect(html).toBe("<strong>Agencia Aluno</strong>");
  });
});

describe("OverviewHero signature (whitelabel)", () => {
  it("signs the print panel with the student's brand name", () => {
    const html = render(
      createElement(OverviewHero, {
        brand: custom,
        breakdown: [],
        currency: "BRL",
        days: null,
        rangeLabel: "22/10 a 23/10",
        revenueCents: 100000,
        roasAvailable: true,
        roasLabel: "ROAS 2,00x",
        showSpend: true,
        spendCents: 50000,
      }),
    );

    expect(html).toContain("AGENCIA ALUNO");
    expect(html).not.toContain("RASTRACKDASH");
  });
});
