// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("../src/app/(app)/leads/[leadId]/delete-lead-action", () => ({
  deleteLeadAction: vi.fn(),
}));

import { DeleteLeadButton } from "../src/app/(app)/leads/[leadId]/delete-lead-button";

afterEach(() => {
  cleanup();
  push.mockReset();
});

function open(action: ReturnType<typeof vi.fn>) {
  render(
    createElement(DeleteLeadButton, {
      leadId: "lead_1",
      leadName: "Maria Exemplo",
      action: action as never,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Excluir lead" }));
}

function confirmButton() {
  const buttons = screen.getAllByRole("button", { name: "Excluir lead" });
  return buttons[buttons.length - 1] as HTMLButtonElement;
}

describe("Excluir lead (porte do SaaS #292)", () => {
  it("warns that Meta sends are not undone and only enables after the typed word", () => {
    const action = vi.fn();
    open(action);
    expect(screen.getByText("Conversões já enviadas à Meta não são desfeitas.")).toBeTruthy();
    expect(confirmButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Digite EXCLUIR para confirmar"), {
      target: { value: "excluir" },
    });
    expect(confirmButton().disabled).toBe(false);
    expect(action).not.toHaveBeenCalled();
  });

  it("shows the API refusal (409) in the dialog and stays on the lead", async () => {
    const action = vi.fn(async () => ({
      ok: false as const,
      message: "Este lead tem conversões enviadas ou na fila da Meta e não pode ser excluído.",
    }));
    open(action);
    fireEvent.change(screen.getByLabelText("Digite EXCLUIR para confirmar"), {
      target: { value: "EXCLUIR" },
    });
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    expect(action).toHaveBeenCalledWith("lead_1");
    expect(await screen.findByText(/enviadas ou na fila da Meta/u)).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it("goes back to Leads after deleting", async () => {
    const action = vi.fn(async () => ({ ok: true as const }));
    open(action);
    fireEvent.change(screen.getByLabelText("Digite EXCLUIR para confirmar"), {
      target: { value: "EXCLUIR" },
    });
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    expect(push).toHaveBeenCalledWith("/leads");
  });
});
