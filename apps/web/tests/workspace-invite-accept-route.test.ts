import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import WorkspaceInviteAcceptPage from "../src/app/invite/accept/page";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workspace invite accept route", () => {
  it("renders the same invalid state when the token is missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const element = await WorkspaceInviteAcceptPage({
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(html).toContain("Convite indisponível");
    expect(html).toContain(
      "inválido, expirou, foi revogado ou já foi utilizado",
    );
    expect(html).toContain("suporte@rastrack.app");
  });

  it("renders a login continuation for an existing invited account", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          state: "valid",
          workspaceName: "Comunidade NOD",
          emailHint: "ad***@wpptrack.com",
          role: "admin",
          accountMode: "login",
          expiresAt: "2026-07-09T03:00:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const element = await WorkspaceInviteAcceptPage({
      searchParams: Promise.resolve({
        token: "invite-token-1234567890",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/workspaces/invites/inspect?token=invite-token-1234567890",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(html).toContain("Comunidade NOD");
    expect(html).toContain("ad***@wpptrack.com");
    expect(html).not.toContain("admin@wpptrack.com");
    expect(html).toContain("Entrar para aceitar");
    expect(html).toContain("redirectTo=");
  });

  it("renders account creation only for a valid new-user invitation", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          state: "valid",
          workspaceName: "Loja Samuel",
          emailHint: "no******@example.com",
          role: "member",
          accountMode: "create",
          expiresAt: "2026-07-09T03:00:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const element = await WorkspaceInviteAcceptPage({
      searchParams: Promise.resolve({
        token: "invite-token-1234567890",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Loja Samuel");
    expect(html).toContain('name="name"');
    expect(html).toContain('name="password"');
    expect(html).toContain("Criar acesso e entrar");
    expect(html).not.toContain('name="email"');
  });

  it("does not disclose whether an unknown token ever existed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ state: "invalid" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const element = await WorkspaceInviteAcceptPage({
      searchParams: Promise.resolve({
        token: "unknown-token-1234567890",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Convite indisponível");
    expect(html).not.toContain("Workspace");
    expect(html).not.toContain("email");
  });
});
