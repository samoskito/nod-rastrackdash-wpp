import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import BackofficeClientsPage from "../src/app/(backoffice)/backoffice/clients/page";
import BackofficeHomePage from "../src/app/(backoffice)/backoffice/page";
import BackofficeInboundWebhooksPage from "../src/app/(backoffice)/backoffice/inbound-webhooks/page";

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

const connection = {
  id: "conn_1",
  workspaceId: "ws_1",
  provider: "umbler",
  displayName: "Umbler Vendas",
  parserVersion: "v1",
  parserReleaseStatus: "certified",
  status: "observation",
  productionActivatedAt: null,
  lastDeliveryAt: "2026-08-01T12:00:00.000Z",
  lastSuccessfulParseAt: "2026-08-01T12:00:00.000Z",
  createdAt: "2026-07-01T12:00:00.000Z",
  updatedAt: "2026-08-01T12:00:00.000Z",
};

const capabilities = {
  enabled: true,
  productionEnabled: false,
  providers: [
    {
      provider: "umbler",
      parserVersion: "v1",
      parserReleaseStatus: "certified",
      creationEnabled: true,
    },
  ],
};

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
  it("renders a status page instead of inventing client records", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const html = await renderPage(BackofficeClientsPage());

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(html).toContain("Clientes e acessos");
    expect(html).toContain("Sem backend multi-cliente neste template");
    // No client rows, no counters, no mutation forms.
    expect(html).not.toContain("<table");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    expect(html).not.toMatch(/\d+\s*(workspaces|clientes|leads)/iu);
  });

  it("names the areas that are missing and links only to real ones", async () => {
    const html = await renderPage(BackofficeClientsPage());

    expect(html).toContain("Painel de workspaces");
    expect(html).toContain("Equipe da plataforma");
    expect(html).toContain("Conectores externos");

    expect(html).toContain('href="/settings"');
    expect(html).toContain('href="/integrations"');
    expect(html).toContain('href="/backoffice/license"');
    expect(html).toContain('href="/backoffice/inbound-webhooks"');
    expect(html).not.toContain("/backoffice/workspaces");
    expect(html).not.toContain("/backoffice/platform-users");
    expect(html).not.toContain("/backoffice/external-data");
  });

  it("keeps the backoffice navigation so the route is not a dead end", async () => {
    const html = await renderPage(BackofficeClientsPage());

    expect(html).toContain('href="/backoffice"');
    expect(html).toContain('aria-label="Areas do backoffice"');
    expect(html).toContain('aria-current="page"');
  });
});

describe("/backoffice/inbound-webhooks", () => {
  it("renders workspace connections and the real observation counters", async () => {
    mockApi({
      "/integrations/inbound-webhooks/capabilities": async () =>
        jsonResponse(capabilities),
      "/integrations/inbound-webhooks/conn_1/overview": async () =>
        jsonResponse({
          connection,
          counters: {
            eligibleRouted: 7,
            eligibleUnresolved: 2,
            ignoredNoCtwa: 5,
            duplicate: 1,
            invalid: 0,
          },
        }),
      "/integrations/inbound-webhooks": async () => jsonResponse([connection]),
    });

    const html = await renderPage(await BackofficeInboundWebhooksPage());

    expect(html).toContain("Umbler Vendas");
    expect(html).toContain("Umbler Talk");
    expect(html).toContain("Observando");
    expect(html).toContain("CTWA roteado");
    expect(html).toContain("<strong>7</strong>");
    expect(html).toContain("Parser certificado");
  });

  it("states that the platform-wide delivery console is not part of this edition", async () => {
    mockApi({
      "/integrations/inbound-webhooks/capabilities": async () =>
        jsonResponse(capabilities),
      "/integrations/inbound-webhooks": async () => jsonResponse([]),
    });

    const html = await renderPage(await BackofficeInboundWebhooksPage());

    expect(html).toContain("Somente leitura");
    expect(html).toContain("console multi-cliente");
    expect(html).toContain("Nenhuma conexão de webhook neste workspace");
    // The private build's delivery search / replay surfaces stay absent.
    expect(html).not.toContain("/backoffice/inbound-webhooks/replay");
    expect(html).not.toContain("/backoffice/inbound-webhooks/recovery");
    expect(html).not.toContain("/backoffice/diagnostics/webhooks");
  });

  it("marks counters as unavailable instead of showing zeros when the overview fails", async () => {
    mockApi({
      "/integrations/inbound-webhooks/capabilities": async () =>
        jsonResponse(capabilities),
      "/integrations/inbound-webhooks/conn_1/overview": async () =>
        jsonResponse({ message: "boom" }, 500),
      "/integrations/inbound-webhooks": async () => jsonResponse([connection]),
    });

    const html = await renderPage(await BackofficeInboundWebhooksPage());

    expect(html).toContain("Umbler Vendas");
    expect(html).toContain("Contadores de observação indisponíveis");
    expect(html).toContain("temporariamente indisponível");
    expect(html).not.toContain("CTWA roteado");
  });

  it("renders an honest error state when the connection list fails", async () => {
    mockApi({
      "/integrations/inbound-webhooks/capabilities": async () =>
        jsonResponse({ message: "boom" }, 503),
      "/integrations/inbound-webhooks": async () =>
        jsonResponse({ message: "boom" }, 503),
    });

    const html = await renderPage(await BackofficeInboundWebhooksPage());

    expect(html).toContain("API indisponível");
    expect(html).toContain("Não foi possível carregar as conexões de webhook");
    expect(html).not.toContain("CTWA roteado");
    expect(html).not.toContain("Recursos de webhook habilitados");
  });
});
