import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OnboardingChecklist } from "../src/components/onboarding-checklist";
import type { OnboardingStatusResponse } from "../src/lib/onboarding-status";

function fakeStatus(overrides: Partial<OnboardingStatusResponse["checks"]> = {}): OnboardingStatusResponse {
  const checks = {
    database: true,
    licenseActive: true,
    metaConnected: true,
    hasWorkspace: true,
    ...overrides,
  };

  return {
    checks,
    completedCount: Object.values(checks).filter(Boolean).length,
    totalCount: 4,
  };
}

describe("OnboardingChecklist", () => {
  it("renders the unavailable state when status is null", () => {
    const html = renderToStaticMarkup(createElement(OnboardingChecklist, { status: null }));

    expect(html).toContain("Não foi possível carregar o checklist");
  });

  it("renders all four rows as completed with the 4/4 counter", () => {
    const html = renderToStaticMarkup(createElement(OnboardingChecklist, { status: fakeStatus() }));

    expect(html).toContain("4/4 concluídos");
    expect(html).toContain("Banco de dados conectado");
    expect(html).toContain("Licença ativa");
    expect(html).toContain("Meta Ads conectado");
    expect(html).toContain("Workspace criado");
    expect(html.match(/Concluído/g)?.length).toBe(4);
    expect(html).not.toContain("Pendente");
  });

  it("renders pending rows with links to their configuration page", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingChecklist, {
        status: fakeStatus({ licenseActive: false, metaConnected: false, hasWorkspace: true }),
      }),
    );

    expect(html).toContain("2/4 concluídos");
    expect(html.match(/Pendente/g)?.length).toBe(2);
    expect(html).toContain('href="/backoffice/license"');
    expect(html).toContain('href="/integrations"');
  });

  it("never links the database row (it has no dedicated configuration page)", () => {
    const html = renderToStaticMarkup(createElement(OnboardingChecklist, { status: fakeStatus() }));
    const databaseRowMatch = html.match(/<li[^>]*>(?:(?!<\/li>).)*Banco de dados conectado.*?<\/li>/s);

    expect(databaseRowMatch?.[0]).not.toContain("<a ");
  });
});
