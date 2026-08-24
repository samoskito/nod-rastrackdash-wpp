import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandFooter } from "../src/components/brand-footer";
import { defaultBrandConfig } from "../src/lib/brand";

describe("BrandFooter", () => {
  it("always contains the RastrackDash and powered-by-PalmUP residual", () => {
    const html = renderToStaticMarkup(
      createElement(BrandFooter, { brand: defaultBrandConfig }),
    );

    expect(html).toContain("RastrackDash");
    expect(html).toContain("powered by PalmUP");
  });

  it("includes both the custom agency name and the residual brands", () => {
    const html = renderToStaticMarkup(
      createElement(BrandFooter, {
        brand: { ...defaultBrandConfig, name: "Minha Agencia" },
      }),
    );

    expect(html).toContain("Minha Agencia");
    expect(html).toContain("RastrackDash");
    expect(html).toContain("powered by PalmUP");
  });

  it("does not accept any prop that could hide the residual brands", () => {
    const source = BrandFooter.toString();

    expect(source).not.toMatch(/hide/i);
  });
});
