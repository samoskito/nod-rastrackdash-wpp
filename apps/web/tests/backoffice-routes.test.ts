import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import BackofficeClientsPage from "../src/app/(backoffice)/backoffice/clients/page";
import BackofficeHomePage from "../src/app/(backoffice)/backoffice/page";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Routes fetch by absolute URL (apiBaseUrl + path); matching on a path
 * fragment keeps the mock independent of call ordering.
 */
function mockApi(routes: Record<string, () => Promise<Response>>): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const match = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((path) => url.includes(path));

    if (!match) {
      throw new Error(`unexpected fetch: ${url}`);
    }

    return routes[match]!();
  });
}

async function renderPage(element: unknown): Promise<string> {
  return renderToStaticMarkup(createElement("div", null, element as never));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/backoffice", () => {
  it("still renders the student home with the three navigation targets", async () => {
    mockApi({
      "/onboarding/status": async () =>
        jsonResponse({
          checks: {
            database: true,
            licenseActive: true,
            metaConnected: false,
            hasWorkspace: true,
          },
          completedCount: 3,
          totalCount: 4,
        }),
    });

    const html = await renderPage(await BackofficeHomePage());

    expect(html).toContain('href="/backoffice/clients"');
    expect(html).toContain('href="/backoffice/inbound-webhooks"');
    expect(html).toContain('href="/backoffice/license"');
    expect(html).not.toContain('href="/backoffice/billing"');
  });
});

describe("/backoffice/clients", () => {
  // Full coverage (create/list/empty/error/activation actions) lives in
  // backoffice-clients-page.test.ts; this is a smoke test confirming the
  // route wires the real multi-client workspaces API and keeps the shared
  // backoffice navigation.
  it("renders real workspaces from the API instead of a placeholder", async () => {
    mockApi({
      "/backoffice/workspaces": async () =>
        jsonResponse([
          {
            id: "ws_1",
            name: "Cliente Exemplo",
            slug: "cliente-exemplo",
            operationalStatus: "active",
            createdAt: "2026-08-01T12:00:00.000Z",
            responsible: {
              id: "user_1",
              name: "Fulano",
              email: "fulano@cliente.com",
              role: "owner",
              status: "active",
            },
          },
        ]),
    });

    const html = await renderPage(await BackofficeClientsPage());

    expect(html).toContain("Clientes e acessos");
    expect(html).toContain("Cliente Exemplo");
    expect(html).toContain("cliente-exemplo");
    expect(html).toContain("fulano@cliente.com");
    expect(html).toContain('href="/backoffice"');
    expect(html).toContain('aria-label="Areas do backoffice"');
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain("Sem backend multi-cliente neste template");
  });
});
