// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { deleteBackofficeWorkspaceAction } = vi.hoisted(() => ({
  deleteBackofficeWorkspaceAction: vi.fn(),
}));

vi.mock("../src/lib/backoffice-clients-actions", () => ({
  deleteBackofficeWorkspaceAction,
}));

import { BackofficeClientsDeleteWorkspaceForm } from "../src/components/backoffice-clients-delete-workspace-form";

afterEach(() => {
  cleanup();
  deleteBackofficeWorkspaceAction.mockReset();
});

describe("BackofficeClientsDeleteWorkspaceForm", () => {
  it("collapses behind an accessible Excluir action and shows the slug once opened", () => {
    render(
      createElement(BackofficeClientsDeleteWorkspaceForm, {
        workspaceId: "ws_1",
        workspaceName: "Loja Ativa",
        workspaceSlug: "loja-ativa",
      }),
    );

    expect(screen.queryByLabelText(/confirmar exclusão/i)).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Excluir workspace Loja Ativa" }),
    );

    expect(screen.getByText("loja-ativa")).toBeTruthy();
    expect(
      screen.getByLabelText(
        /confirmar exclusão do workspace loja ativa digitando o slug/i,
      ),
    ).toBeTruthy();
  });

  it("keeps submit disabled until the typed slug matches exactly", () => {
    render(
      createElement(BackofficeClientsDeleteWorkspaceForm, {
        workspaceId: "ws_1",
        workspaceName: "Loja Ativa",
        workspaceSlug: "loja-ativa",
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Excluir workspace Loja Ativa" }),
    );

    const submit = screen.getByRole("button", {
      name: "Confirmar exclusão",
    }) as HTMLButtonElement;
    const input = screen.getByLabelText(
      /confirmar exclusão do workspace loja ativa digitando o slug/i,
    );

    expect(submit.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "loja-ativ" } });
    expect(submit.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "loja-ativa" } });
    expect(submit.disabled).toBe(false);
  });

  it("cancels back to the collapsed state without submitting", () => {
    render(
      createElement(BackofficeClientsDeleteWorkspaceForm, {
        workspaceId: "ws_1",
        workspaceName: "Loja Ativa",
        workspaceSlug: "loja-ativa",
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Excluir workspace Loja Ativa" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(
      screen.getByRole("button", { name: "Excluir workspace Loja Ativa" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/confirmar exclusão/i)).toBeNull();
    expect(deleteBackofficeWorkspaceAction).not.toHaveBeenCalled();
  });
});
