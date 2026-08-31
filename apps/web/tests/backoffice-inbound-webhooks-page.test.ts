import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import BackofficeInboundWebhooksPage from "../src/app/(backoffice)/backoffice/inbound-webhooks/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: () => undefined,
  }),
}));

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

const currentWorkspace = {
  id: "workspace_a",
  name: "Empresa A",
  slug: "empresa-a",
  role: "owner",
  operationalStatus: "active",
  permissions: {
    canInviteMembers: true,
    canManageBilling: true,
    canManageIntegrations: true,
    canViewReports: true,
  },
  accessMode: "member",
  platformRole: "admin",
};

const workspaceList = [
  {
    id: "workspace_a",
    name: "Empresa A",
    slug: "empresa-a",
    operationalStatus: "active",
    createdAt: "2026-08-31T10:00:00.000Z",
    responsible: null,
  },
];

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
      "/workspaces/current": async () => jsonResponse(currentWorkspace),
      "/backoffice/workspaces": async () => jsonResponse(workspaceList),
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
      "/workspaces/current": async () => jsonResponse(currentWorkspace),
      "/backoffice/workspaces": async () => jsonResponse(workspaceList),
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
      "/workspaces/current": async () => jsonResponse(currentWorkspace),
      "/backoffice/workspaces": async () => jsonResponse(workspaceList),
    });

    const html = await renderPage();

    expect(html).toContain("Nenhum webhook recebido nesta conexão");
  });

  it("shows an honest error state when the connections read fails", async () => {
    mockApi({
      "/backoffice/whatsapp-webhooks/connections": async () =>
        jsonResponse({ message: "boom" }, 503),
      "/workspaces/current": async () => jsonResponse(currentWorkspace),
      "/backoffice/workspaces": async () => jsonResponse(workspaceList),
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
      "/workspaces/current": async () => jsonResponse(currentWorkspace),
      "/backoffice/workspaces": async () => jsonResponse(workspaceList),
    });

    const html = await renderPage();

    expect(html).toContain("uazapi-principal");
    expect(html).toContain("Não foi possível carregar os dados de webhook");
  });

  it("shows an actionable workspace-selection state instead of a generic API error when no workspace context is selected, without calling getConnections/getHistory", async () => {
    // No "/backoffice/whatsapp-webhooks/*" routes are registered here on
    // purpose: with no active workspace, the page must never call
    // getConnections/getHistory. If it did, mockApi would throw "unexpected
    // fetch" and fail this test.
    mockApi({
      "/workspaces/current": async () =>
        jsonResponse({ message: "not found" }, 404),
      "/backoffice/workspaces": async () => jsonResponse(workspaceList),
    });

    const html = await renderPage();

    expect(html).toContain(
      "Selecione um workspace para consultar os webhooks WhatsApp",
    );
    expect(html).not.toContain("API indisponível");
    expect(html).toContain("Empresa A");
    expect(html).toContain("Selecione um workspace");
  });

  it("keeps the no-workspace state when the backoffice catalogue is empty", async () => {
    mockApi({
      "/workspaces/current": async () =>
        jsonResponse({ message: "not found" }, 404),
      "/backoffice/workspaces": async () => jsonResponse([]),
    });

    const html = await renderPage();

    expect(html).toContain("Nenhum workspace está disponível");
    expect(html).not.toContain("Workspace disponível");
  });

  it("fails closed to the no-workspace state when the backoffice catalogue cannot load", async () => {
    mockApi({
      "/workspaces/current": async () =>
        jsonResponse({ message: "not found" }, 404),
      "/backoffice/workspaces": async () =>
        jsonResponse({ message: "unavailable" }, 503),
    });

    const html = await renderPage();

    expect(html).toContain("Nenhum workspace está disponível");
    expect(html).not.toContain("API indisponível");
  });

  it("renders the workspace selector with a single workspace and loads the connections for it", async () => {
    mockApi({
      "/backoffice/whatsapp-webhooks/connections": async () =>
        jsonResponse([connection]),
      "/backoffice/whatsapp-webhooks/connections/conn_1/history": async () =>
        jsonResponse({
          items: [historyItem],
          pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
        }),
      "/workspaces/current": async () => jsonResponse(currentWorkspace),
      "/backoffice/workspaces": async () => jsonResponse(workspaceList),
    });

    const html = await renderPage();

    expect(html).toContain("Empresa A");
    expect(html).toContain("Workspace disponível");
    expect(html).toContain("uazapi-principal");
    expect(html).not.toContain("Selecione um workspace para consultar");
  });

  it("renders every workspace as a clickable option and preserves the active selection", async () => {
    mockApi({
      "/backoffice/whatsapp-webhooks/connections": async () =>
        jsonResponse([connection]),
      "/backoffice/whatsapp-webhooks/connections/conn_1/history": async () =>
        jsonResponse({
          items: [historyItem],
          pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
        }),
      "/workspaces/current": async () =>
        jsonResponse({
          id: "workspace_b",
          name: "Empresa B",
          slug: "empresa-b",
          role: "admin",
          operationalStatus: "active",
          permissions: {
            canInviteMembers: true,
            canManageBilling: false,
            canManageIntegrations: true,
            canViewReports: true,
          },
          accessMode: "member",
          platformRole: "admin",
        }),
      "/backoffice/workspaces": async () =>
        jsonResponse([
          {
            id: "workspace_a",
            name: "Empresa A",
            slug: "empresa-a",
            operationalStatus: "active",
            createdAt: "2026-08-31T10:00:00.000Z",
            responsible: null,
          },
          {
            id: "workspace_b",
            name: "Empresa B",
            slug: "empresa-b",
            operationalStatus: "active",
            createdAt: "2026-08-31T11:00:00.000Z",
            responsible: null,
          },
        ]),
    });

    const html = await renderPage();

    expect(html).toContain("2 workspaces disponíveis");
    expect(html).toContain('<option value="workspace_a">Empresa A</option>');
    expect(html).toContain(
      '<option value="workspace_b" selected="">Empresa B</option>',
    );
  });
});
