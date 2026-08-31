import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
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

async function renderPage(
  props: Record<string, unknown> = {},
): Promise<string> {
  const element = await BackofficeInboundWebhooksPage(props as never);
  return renderToStaticMarkup(createElement("div", null, element as never));
}

const connection = {
  id: "conn_1",
  name: "uazapi-principal",
  provider: "uazapi_byo",
  status: "active",
  webhookConfigured: true,
};

const historyItem = {
  id: "log_1",
  receivedAt: "2026-08-30T12:00:00.000Z",
  status: "received",
  source: "uazapi",
  provider: "uazapi_byo",
  eventType: "message.received",
  externalEventId: "ext_1",
  leadId: "lead_1",
  errorCode: null,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/backoffice/inbound-webhooks", () => {
  it("lists the WhatsApp BYO connections of the workspace instead of the empty placeholder", async () => {
    mockApi({
      "/backoffice/whatsapp-webhooks/connections": async () =>
        jsonResponse([connection]),
      "/backoffice/whatsapp-webhooks/connections/conn_1/history": async () =>
        jsonResponse({
          items: [historyItem],
          pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
        }),
    });

    const html = await renderPage();

    expect(html).toContain("uazapi-principal");
    expect(html).toContain("Uazapi (BYO)");
    expect(html).not.toContain("Nenhuma conexão de webhook");
  });

  it("renders paginated, analyzable history rows for the selected connection", async () => {
    mockApi({
      "/backoffice/whatsapp-webhooks/connections": async () =>
        jsonResponse([connection]),
      "/backoffice/whatsapp-webhooks/connections/conn_1/history": async () =>
        jsonResponse({
          items: [historyItem],
          pagination: { page: 1, pageSize: 25, total: 30, totalPages: 2 },
        }),
    });

    const html = await renderPage({
      searchParams: Promise.resolve({ connectionId: "conn_1" }),
    });

    expect(html).toContain("received");
    expect(html).toContain("message.received");
    expect(html).not.toContain("ext_1"); // list view never leaks the raw external event id
    expect(html).not.toContain("lead_1"); // list view never leaks the raw lead id
    expect(html).toContain("Sim"); // leadId present -> CTWA lead created
    expect(html).toContain("Página 1 de 2");
    expect(html).toContain("Próxima");
    expect(html).toContain("Inspecionar");
  });

  it("shows an honest empty state when a connection has no webhook history yet", async () => {
    mockApi({
      "/backoffice/whatsapp-webhooks/connections": async () =>
        jsonResponse([connection]),
      "/backoffice/whatsapp-webhooks/connections/conn_1/history": async () =>
        jsonResponse({
          items: [],
          pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 },
        }),
    });

    const html = await renderPage();

    expect(html).toContain("Nenhum webhook recebido nesta conexão");
  });

  it("shows an honest error state when the connections read fails", async () => {
    mockApi({
      "/backoffice/whatsapp-webhooks/connections": async () =>
        jsonResponse({ message: "boom" }, 503),
    });

    const html = await renderPage();

    expect(html).toContain("API indisponível");
    expect(html).toContain("Não foi possível carregar os dados de webhook");
  });

  it("shows an honest error state when the history read fails but connections loaded", async () => {
    mockApi({
      "/backoffice/whatsapp-webhooks/connections": async () =>
        jsonResponse([connection]),
      "/backoffice/whatsapp-webhooks/connections/conn_1/history": async () =>
        jsonResponse({ message: "boom" }, 503),
    });

    const html = await renderPage();

    expect(html).toContain("uazapi-principal");
    expect(html).toContain("Não foi possível carregar os dados de webhook");
  });
});
