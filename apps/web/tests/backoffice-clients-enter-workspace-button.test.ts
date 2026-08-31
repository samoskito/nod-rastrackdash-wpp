// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { switchActiveWorkspace, routerPush } = vi.hoisted(() => ({
  switchActiveWorkspace: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock("../src/app/actions/workspaces", () => ({ switchActiveWorkspace }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}));

import { BackofficeClientsEnterWorkspaceButton } from "../src/components/backoffice-clients-enter-workspace-button";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  switchActiveWorkspace.mockReset();
  routerPush.mockReset();
});

describe("BackofficeClientsEnterWorkspaceButton", () => {
  it("switches into the workspace with the backoffice context and redirects to the operational area", async () => {
    switchActiveWorkspace.mockResolvedValueOnce({ ok: true });

    render(
      createElement(BackofficeClientsEnterWorkspaceButton, {
        workspaceId: "workspace_1",
        workspaceName: "Loja Ativa",
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /entrar no workspace loja ativa/i }),
    );

    await waitFor(() => {
      expect(routerPush).toHaveBeenCalledWith("/overview");
    });

    expect(switchActiveWorkspace).toHaveBeenCalledWith(
      "workspace_1",
      "backoffice",
    );
  });

  it("shows an honest error and does not redirect when the switch is rejected", async () => {
    switchActiveWorkspace.mockResolvedValueOnce({ ok: false });

    render(
      createElement(BackofficeClientsEnterWorkspaceButton, {
        workspaceId: "workspace_2",
        workspaceName: "Loja Bloqueada",
      }),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /entrar no workspace loja bloqueada/i,
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          "Não foi possível entrar no workspace. Tente novamente.",
        ),
      ).toBeTruthy();
    });

    expect(routerPush).not.toHaveBeenCalled();
  });

  it("shows a pending label while the switch is in flight", async () => {
    let resolveSwitch: (value: { ok: boolean }) => void = () => {};
    switchActiveWorkspace.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSwitch = resolve;
        }),
    );

    render(
      createElement(BackofficeClientsEnterWorkspaceButton, {
        workspaceId: "workspace_3",
        workspaceName: "Loja Pendente",
      }),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /entrar no workspace loja pendente/i,
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("Entrando...")).toBeTruthy();
    });

    resolveSwitch({ ok: true });

    await waitFor(() => {
      expect(routerPush).toHaveBeenCalledWith("/overview");
    });
  });
});
