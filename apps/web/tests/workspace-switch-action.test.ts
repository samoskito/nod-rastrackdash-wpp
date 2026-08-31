import { afterEach, describe, expect, it, vi } from "vitest";
import { switchActiveWorkspace } from "../src/app/actions/workspaces";

const nextCache = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => nextCache);

afterEach(() => {
  vi.restoreAllMocks();
  nextCache.revalidatePath.mockReset();
});

describe("workspace switch action", () => {
  it("switches through the authenticated API and refreshes the product layout", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
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
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(switchActiveWorkspace("workspace_b")).resolves.toEqual({
      ok: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/workspaces\/active$/),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ workspaceId: "workspace_b" }),
      }),
    );
    expect(nextCache.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("returns the same generic result for unauthorized and missing targets", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        workspaceId?: string;
      };

      return new Response(
        JSON.stringify({
          statusCode: 404,
          message: `Workspace ${body.workspaceId} nao encontrado`,
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    });

    const results = await Promise.all([
      switchActiveWorkspace("workspace_secret"),
      switchActiveWorkspace("workspace_missing"),
    ]);

    expect(results).toEqual([{ ok: false }, { ok: false }]);
    expect(JSON.stringify(results)).not.toContain("secret");
    expect(JSON.stringify(results)).not.toContain("missing");
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
  });

  it("keeps the existing action while marking a backoffice workspace switch", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "workspace_client" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    await expect(
      switchActiveWorkspace("workspace_client", "backoffice"),
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/workspaces\/active$/),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          workspaceId: "workspace_client",
          backoffice: true,
        }),
      }),
    );
  });
});
