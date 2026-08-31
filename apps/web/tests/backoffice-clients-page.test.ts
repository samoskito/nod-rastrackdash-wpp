import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import BackofficeClientsPage from "../src/app/(backoffice)/backoffice/clients/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: () => undefined,
  }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function renderPage(element: unknown): Promise<string> {
  return renderToStaticMarkup(createElement("div", null, element as never));
}

const activeWorkspace = {
  id: "ws_active",
  name: "Loja Ativa",
  slug: "loja-ativa",
  operationalStatus: "active",
  createdAt: "2026-07-01T12:00:00.000Z",
  responsible: {
    id: "user_active",
    name: "Responsável Ativo",
    email: "ativo@cliente.com",
    role: "owner",
    status: "active",
  },
};

const pendingWorkspace = {
  id: "ws_pending",
  name: "Loja Pendente",
  slug: "loja-pendente",
  operationalStatus: "blocked",
  createdAt: "2026-08-01T12:00:00.000Z",
  responsible: {
    id: "user_pending",
    name: "Responsável Pendente",
    email: "pendente@cliente.com",
    role: "owner",
    status: "pending_activation",
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("backoffice clients page", () => {
  it("lists real workspaces with slug, status and responsible", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse([activeWorkspace, pendingWorkspace]),
    );

    const html = await renderPage(await BackofficeClientsPage());

    expect(html).toContain("Loja Ativa");
    expect(html).toContain("loja-ativa");
    expect(html).toContain("ativo@cliente.com");
    expect(html).toContain("Loja Pendente");
    expect(html).toContain("pendente@cliente.com");
    expect(html).toContain("Ativação pendente");
    expect(html).toContain("2 workspaces");
  });

  it("offers an entry action into each listed workspace", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse([activeWorkspace, pendingWorkspace]),
    );

    const html = await renderPage(await BackofficeClientsPage());

    expect(html).toContain('aria-label="Entrar no workspace Loja Ativa"');
    expect(html).toContain(
      'aria-label="Entrar no workspace Loja Pendente"',
    );
  });

  it("uses natural pt-BR singular for a single workspace", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse([activeWorkspace]),
    );

    const html = await renderPage(await BackofficeClientsPage());

    expect(html).toContain("1 workspace");
    expect(html).not.toContain("1 workspaces");
    expect(html).not.toContain("workspace(s)");
  });

  it("shows resend and generate-link actions only for pending responsibles", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse([activeWorkspace, pendingWorkspace]),
    );

    const html = await renderPage(await BackofficeClientsPage());

    expect(html).toContain("Reenviar e-mail");
    expect(html).toContain("Gerar link de ativação");
  });

  it("always renders the create-workspace form fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse([]));

    const html = await renderPage(await BackofficeClientsPage());

    expect(html).toContain('name="workspaceName"');
    expect(html).toContain('name="responsibleName"');
    expect(html).toContain('name="responsibleEmail"');
    expect(html).toContain('name="reuseExistingUser"');
    expect(html).toContain("Reutilizar usuário existente com este e-mail");
    expect(html).toContain("Criar workspace");
  });

  it("shows an honest empty state without fabricating rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse([]));

    const html = await renderPage(await BackofficeClientsPage());

    expect(html).toContain("Nenhum workspace cadastrado ainda");
    expect(html).not.toContain("<table");
  });

  it("shows the API's pt-BR error message and no data when the list call fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ message: "Sessão expirada, faça login novamente." }, 401),
    );

    const html = await renderPage(await BackofficeClientsPage());

    expect(html).toContain("API indisponível");
    expect(html).toContain("Não foi possível carregar os workspaces");
    expect(html).toContain("Sessão expirada, faça login novamente.");
    expect(html).not.toContain("<table");
  });
});
