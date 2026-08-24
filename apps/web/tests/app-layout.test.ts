import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProductLayout from "../src/app/(app)/layout";
import { WorkspaceAccessGate } from "../src/components/workspace-access-gate";

const requestHeaderState = vi.hoisted(() => ({
  pathname: "/overview",
}));

const redirectMock = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock("next/headers", () => ({
  cookies: async () => ({
    toString: () => "",
  }),
  headers: async () => ({
    get: (name: string) =>
      name === "x-wpptrack-pathname" ? requestHeaderState.pathname : null,
  }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/overview",
  useRouter: () => ({
    refresh: () => undefined,
  }),
  redirect: redirectMock,
}));

const fullOwnerPermissions = {
  canInviteMembers: true,
  canManageMembers: true,
  canGrantMemberManager: true,
  canManageBilling: true,
  canManageIntegrations: true,
  canManageWorkspaceSettings: true,
  canTransferOwnership: true,
  canViewReports: true,
  canExportReports: true,
};

const analystPermissions = {
  canInviteMembers: false,
  canManageMembers: false,
  canGrantMemberManager: false,
  canManageBilling: false,
  canManageIntegrations: false,
  canManageWorkspaceSettings: false,
  canTransferOwnership: false,
  canViewReports: true,
  canExportReports: true,
};

afterEach(() => {
  requestHeaderState.pathname = "/overview";
  redirectMock.mockClear();
  vi.restoreAllMocks();
});

describe("product app layout", () => {
  it("renders a blocked workspace state before client pages load", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          statusCode: 403,
          message: "Workspace bloqueado operacionalmente",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );

    const element = await WorkspaceAccessGate({
      children: createElement("p", null, "Conteudo privado"),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Workspace bloqueado");
    expect(html).toContain("Fale com o suporte da plataforma");
    expect(html).not.toContain("Conteudo privado");
  });

  it("renders client content when the workspace is active", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "workspace_1",
          name: "Comunidade NOD",
          slug: "comunidade-nod",
          role: "owner",
          operationalStatus: "active",
          permissions: fullOwnerPermissions,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const element = await WorkspaceAccessGate({
      children: createElement("p", null, "Conteudo privado"),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Conteudo privado");
    expect(html).not.toContain("Workspace bloqueado");
  });

  it("does not reintroduce PalmUP package/subscription gating in the student edition", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);

        if (url.endsWith("/workspaces/current")) {
          return new Response(
            JSON.stringify({
              id: "workspace_1",
              name: "Comunidade NOD",
              slug: "comunidade-nod",
              role: "owner",
              operationalStatus: "active",
              accessMode: "member",
              permissions: fullOwnerPermissions,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (url.endsWith("/workspaces")) {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.endsWith("/integrations/whatsapp/source")) {
          return new Response(JSON.stringify({ source: "uazapi" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ message: "not configured" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      });

    const element = await WorkspaceAccessGate({
      children: createElement("p", null, "Conteudo privado"),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    // Student edition uses license soft-lock (banner) instead of PalmUP
    // package/subscription gates — content stays available when workspace is active.
    expect(html).toContain("Conteudo privado");
    expect(html).not.toContain("Gerenciar assinatura");
    expect(html).not.toContain('href="/subscription"');
    expect(html).toContain("RastrackDash · powered by PalmUP");
    expect(
      fetchSpy.mock.calls.some(([input]) =>
        String(input).includes("/billing/package/access"),
      ),
    ).toBe(false);
  });

  it("renders residual brand footer even when the product shell has no custom brand name", async () => {
    requestHeaderState.pathname = "/overview";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);

      if (url.endsWith("/workspaces/current")) {
        return new Response(
          JSON.stringify({
            id: "workspace_1",
            name: "Comunidade NOD",
            slug: "comunidade-nod",
            role: "owner",
            operationalStatus: "active",
            accessMode: "member",
            permissions: fullOwnerPermissions,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.endsWith("/integrations/whatsapp/source")) {
        return new Response(JSON.stringify({ source: "uazapi" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const element = await WorkspaceAccessGate({
      children: createElement("p", null, "Pagina normal"),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Pagina normal");
    expect(html).toContain("RastrackDash");
    expect(html).toContain("powered by PalmUP");
  });

  it("passes only authenticated memberships to the workspace selector", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);

      if (url.endsWith("/workspaces/current")) {
        return new Response(
          JSON.stringify({
            id: "workspace_a",
            name: "Empresa A",
            slug: "empresa-a",
            role: "owner",
            operationalStatus: "active",
            permissions: fullOwnerPermissions,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.endsWith("/workspaces")) {
        return new Response(
          JSON.stringify([
            {
              id: "workspace_a",
              name: "Empresa A",
              slug: "empresa-a",
              role: "owner",
              operationalStatus: "active",
              permissions: fullOwnerPermissions,
            },
            {
              id: "workspace_b",
              name: "Empresa B",
              slug: "empresa-b",
              role: "member",
              operationalStatus: "active",
              permissions: {
                canInviteMembers: false,
                canManageBilling: false,
                canManageIntegrations: false,
                canViewReports: true,
              },
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ message: "not configured" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });

    const element = await WorkspaceAccessGate({
      children: createElement("p", null, "Conteudo privado"),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Empresa A");
    expect(html).toContain("Empresa B");
    expect(html).not.toContain("Empresa Confidencial");
    expect(html).not.toContain("workspace_secret");
  });

  it("keeps the desktop sidebar fixed while product pages scroll", () => {
    const css = readFileSync(
      join(process.cwd(), "src/styles/globals.css"),
      "utf8",
    );

    expect(css).toMatch(/\.app-shell\s*{[^}]*--sidebar-width:\s*260px/s);
    expect(css).toMatch(
      /\.app-shell\.sidebar-collapsed\s*{[^}]*--sidebar-width:\s*76px/s,
    );
    expect(css).toMatch(/\.sidebar\s*{[^}]*position:\s*fixed/s);
    expect(css).toMatch(/\.sidebar\s*{[^}]*height:\s*100vh/s);
    expect(css).toMatch(/\.sidebar\s*{[^}]*overflow-y:\s*auto/s);
    expect(css).toMatch(
      /\.content\s*{[^}]*padding-left:\s*var\(--sidebar-width\)/s,
    );
  });

  it("uses a compact desktop sidebar while preserving scroll as a fallback", () => {
    const css = readFileSync(
      join(process.cwd(), "src/styles/layout-system.css"),
      "utf8",
    );

    expect(css).toMatch(
      /@media \(min-width:\s*901px\)\s*{[\s\S]*?\.sidebar-nav a\s*{[^}]*min-height:\s*36px[^}]*font-size:\s*14px/s,
    );
    expect(css).toMatch(
      /\.sidebar\s*{[^}]*scrollbar-gutter:\s*auto[^}]*scrollbar-width:\s*thin/s,
    );
    expect(css).toContain(".workspace-selector-trigger");
  });

  it("only compacts status chips that live inside the collapsed sidebar", () => {
    const css = readFileSync(
      join(process.cwd(), "src/styles/globals.css"),
      "utf8",
    );

    expect(css).toContain(".sidebar-collapsed .sidebar .status-chip");
    expect(css).not.toMatch(/\.sidebar-collapsed\s+\.status-chip(?:\s|,|\{)/);
  });

  it("wraps workspace authorization in Suspense so the shell can render first", () => {
    const source = readFileSync(
      join(process.cwd(), "src/app/(app)/layout.tsx"),
      "utf8",
    );

    expect(ProductLayout).toBeTypeOf("function");
    expect(source).toContain("<Suspense");
    expect(source).toContain("<ProductRouteLoading />");
    expect(source).toContain("<WorkspaceAccessGate>");
  });

  it("mounts the license status banner above the app shell content", () => {
    const source = readFileSync(
      join(process.cwd(), "src/app/(app)/layout.tsx"),
      "utf8",
    );

    expect(source).toContain("LicenseStatusBanner");
    expect(source.indexOf("<LicenseStatusBanner")).toBeLessThan(
      source.indexOf("<Suspense"),
    );
  });

  it("forwards the protected pathname to the server access gate", () => {
    const source = readFileSync(
      join(process.cwd(), "src/middleware.ts"),
      "utf8",
    );

    expect(source).toContain('requestHeaders.set("x-wpptrack-pathname"');
    expect(source).toContain("request: {");
    expect(source).toContain("headers: requestHeaders");
  });

  it("refreshes workspace data without a full reload or a tab-return refresh", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/data-auto-refresh.tsx"),
      "utf8",
    );

    expect(source).toContain("router.refresh()");
    expect(source).not.toContain("window.location.reload");
    expect(source).not.toContain("visibilitychange");
  });

  it("revalidates workspace access after protected route changes", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/app-shell.tsx"),
      "utf8",
    );

    expect(source).toContain("previousAccessPathnameRef");
    expect(source).toContain(
      "previousAccessPathnameRef.current = pathname;\n    router.refresh();",
    );
  });
  it("redirects analysts away from management routes", async () => {
    requestHeaderState.pathname = "/settings";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/workspaces/current")) {
        return new Response(
          JSON.stringify({
            id: "workspace_member",
            name: "Workspace Analista",
            slug: "workspace-analista",
            role: "member",
            operationalStatus: "active",
            permissions: analystPermissions,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/workspaces")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ message: "not configured" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });

    await expect(
      WorkspaceAccessGate({
        children: createElement("p", null, "Conteudo privado"),
      }),
    ).rejects.toThrow("NEXT_REDIRECT:/overview");
    expect(redirectMock).toHaveBeenCalledWith("/overview");
  });

  it("mounts the residual brand footer in the app shell sidebar", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/app-shell.tsx"),
      "utf8",
    );

    expect(source).toContain("<BrandFooter brand={brand} />");
  });

  it("passes server-computed brand props into the client app shell instead of NEXT_PUBLIC_ env sprawl", () => {
    const layoutSource = readFileSync(
      join(process.cwd(), "src/app/(app)/layout.tsx"),
      "utf8",
    );
    const gateSource = readFileSync(
      join(process.cwd(), "src/components/workspace-access-gate.tsx"),
      "utf8",
    );

    expect(layoutSource).toContain("getBrandConfig()");
    expect(layoutSource).toContain("brand={brand}");
    expect(gateSource).toContain("getBrandConfig()");
    expect(gateSource).toContain("brand={brand}");
  });

  it("mounts the residual brand footer on the login page and the backoffice layout", () => {
    const loginSource = readFileSync(
      join(process.cwd(), "src/app/login/page.tsx"),
      "utf8",
    );
    const backofficeLayoutSource = readFileSync(
      join(process.cwd(), "src/app/(backoffice)/layout.tsx"),
      "utf8",
    );

    expect(loginSource).toContain("<BrandFooter");
    expect(backofficeLayoutSource).toContain("<BrandFooter");
  });

  it("derives the root layout title/favicon and --brand-primary from env, with no BRAND_HIDE_FOOTER escape hatch anywhere", () => {
    const rootLayoutSource = readFileSync(
      join(process.cwd(), "src/app/layout.tsx"),
      "utf8",
    );

    expect(rootLayoutSource).toContain("getBrandConfig()");
    expect(rootLayoutSource).toContain("--brand-primary");
    expect(rootLayoutSource).not.toMatch(/BRAND_HIDE_FOOTER/i);

    const footerSource = readFileSync(
      join(process.cwd(), "src/components/brand-footer.tsx"),
      "utf8",
    );
    expect(footerSource).not.toMatch(/BRAND_HIDE_FOOTER/i);
  });
});
