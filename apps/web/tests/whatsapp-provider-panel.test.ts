// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhatsappConnectionDto } from "@wpptrack/shared";
import { WhatsappProviderPanel } from "../src/app/(app)/integrations/whatsapp-provider-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const connection: WhatsappConnectionDto = {
  id: "connection_1",
  name: "WAHA comercial",
  displayName: null,
  provider: "waha",
  status: "active",
  lastHealthStatus: null,
  lastHealthCheckedAt: null,
  createdAt: "2026-08-28T12:00:00.000Z",
};

function renderPanel(
  overrides: Partial<{
    createAction: ReturnType<typeof vi.fn>;
    testAction: ReturnType<typeof vi.fn>;
    rotateAction: ReturnType<typeof vi.fn>;
    editAction: ReturnType<typeof vi.fn>;
    loadEditAction: ReturnType<typeof vi.fn>;
  }> = {},
) {
  const noopAction = vi.fn(async () => ({ ok: true as const, message: "ok" }));
  const loadEditAction =
    overrides.loadEditAction ??
    vi.fn(async () => ({
      ok: true as const,
      data: {
        id: connection.id,
        provider: connection.provider,
        name: connection.name,
        displayName: connection.displayName,
        baseUrl: "https://waha.example.test",
        instanceId: null,
        session: "support",
      },
    }));

  const props = {
    connections: [connection],
    canManage: true,
    createAction: overrides.createAction ?? noopAction,
    testAction: overrides.testAction ?? noopAction,
    rotateAction: overrides.rotateAction ?? noopAction,
    editAction: overrides.editAction ?? noopAction,
    loadEditAction,
  };

  render(createElement(WhatsappProviderPanel, props));
  return props;
}

describe("WhatsappProviderPanel edit flow", () => {
  it("loads non-sensitive metadata and pre-fills the edit form without a secret value", async () => {
    const { loadEditAction } = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /editar/i }));

    await waitFor(() => {
      expect(loadEditAction).toHaveBeenCalledWith("connection_1");
    });

    const editForm = within(
      await screen.findByTestId("whatsapp-connection-edit-connection_1"),
    );
    const baseUrlInput = editForm.getByLabelText(
      "URL da API",
    ) as HTMLInputElement;
    const sessionInput = editForm.getByLabelText("Sessao") as HTMLInputElement;
    const secretInput = editForm.getByLabelText(
      /api key/i,
    ) as HTMLInputElement;

    expect(baseUrlInput.value).toBe("https://waha.example.test");
    expect(sessionInput.value).toBe("support");
    expect(secretInput.value).toBe("");
    expect(secretInput.type).toBe("password");
    expect(secretInput.required).toBe(false);
  });

  it("submits the edit form, clears the secret and refreshes on success", async () => {
    const editAction = vi.fn(async () => ({
      ok: true as const,
      message: "Conexao atualizada.",
    }));
    renderPanel({ editAction });

    fireEvent.click(screen.getByRole("button", { name: /editar/i }));
    const editForm = within(
      await screen.findByTestId("whatsapp-connection-edit-connection_1"),
    );

    const secretInput = editForm.getByLabelText(
      /api key/i,
    ) as HTMLInputElement;
    fireEvent.change(secretInput, { target: { value: "new-secret" } });

    fireEvent.click(editForm.getByRole("button", { name: /salvar altera/i }));

    await waitFor(() => {
      expect(editAction).toHaveBeenCalledTimes(1);
    });
    expect(secretInput.value).toBe("");
  });

  it("clears the secret input and stops the pending state when the edit action rejects", async () => {
    const editAction = vi.fn(async () => {
      throw new Error("network down");
    });
    renderPanel({ editAction });

    fireEvent.click(screen.getByRole("button", { name: /editar/i }));
    const editForm = within(
      await screen.findByTestId("whatsapp-connection-edit-connection_1"),
    );

    const secretInput = editForm.getByLabelText(
      /api key/i,
    ) as HTMLInputElement;
    fireEvent.change(secretInput, { target: { value: "leaked-on-error" } });

    const submitButton = editForm.getByRole(
      "button",
      { name: /salvar altera/i },
    ) as HTMLButtonElement;
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(secretInput.value).toBe("");
    });
    await waitFor(() => {
      expect(submitButton.disabled).toBe(false);
    });
  });

  it("never renders the provider as an editable field", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /editar/i }));
    const editForm = within(
      await screen.findByTestId("whatsapp-connection-edit-connection_1"),
    );
    await editForm.findByLabelText("URL da API");

    expect(editForm.queryByRole("combobox")).toBeNull();
  });
});
