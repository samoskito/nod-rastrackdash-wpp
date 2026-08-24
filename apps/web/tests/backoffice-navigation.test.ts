import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BackofficeNavigation } from "../src/components/backoffice-navigation";

describe("BackofficeNavigation", () => {
  it("does not render the PalmUP billing or platform-operations areas", () => {
    const html = renderToStaticMarkup(
      createElement(BackofficeNavigation, { active: "home" }),
    );

    expect(html).not.toContain("/backoffice/billing");
    expect(html).not.toContain("Assinaturas");
    expect(html).not.toContain("backoffice?view=operations");
    expect(html).not.toContain("Operacoes internas");
  });

  it("keeps the client-relevant areas and adds the read-only license tab", () => {
    const html = renderToStaticMarkup(
      createElement(BackofficeNavigation, { active: "license" }),
    );

    expect(html).toContain('href="/backoffice"');
    expect(html).toContain('href="/backoffice/clients"');
    expect(html).toContain('href="/backoffice/inbound-webhooks"');
    expect(html).toContain('href="/backoffice/license"');
    expect(html).toContain("Licença");
  });
});
