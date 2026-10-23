import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ProductRouteLoading from "../src/app/(app)/loading";

describe("product route loading", () => {
  it("shows immediate accessible loading feedback inside the persistent shell", () => {
    const html = renderToStaticMarkup(
      createElement("div", null, createElement(ProductRouteLoading)),
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Carregando página");
    expect(html).toContain("route-loading-grid");
    expect(html).toContain("Carregando dados da página");
  });
});
