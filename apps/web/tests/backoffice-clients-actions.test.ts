import { afterEach, describe, expect, it, vi } from "vitest";

const { isApiRequestError, revalidatePath, serverApiFetch } = vi.hoisted(
  () => ({
    isApiRequestError: vi.fn(
      (error: unknown) =>
        error instanceof Error && error.name === "ApiRequestError",
    ),
    revalidatePath: vi.fn(),
    serverApiFetch: vi.fn(),
  }),
);

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/lib/server-api", () => ({
  isApiRequestError,
  serverApiFetch,
}));

import {
  createBackofficeWorkspaceAction,
  generateActivationLinkAction,
  resendActivationEmailAction,
  type BackofficeClientsActionState,
} from "../src/lib/backoffice-clients-actions";

const initialState: BackofficeClientsActionState = {
  status: "idle",
  message: "",
  nonce: 0,
};

afterEach(() => {
  revalidatePath.mockReset();
  serverApiFetch.mockReset();
});

function form(values: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) {
    formData.set(key, value);
  }
  return formData;
}

function apiError(message: string, status: number): Error {
  const error = new Error(message);
  error.name = "ApiRequestError";
  Object.assign(error, { status });
  return error;
}

describe("createBackofficeWorkspaceAction", () => {
  it("creates the workspace and revalidates the clients list", async () => {
    serverApiFetch.mockResolvedValueOnce({
      id: "ws_1",
      name: "Cliente Exemplo",
      slug: "cliente-exemplo",
      operationalStatus: "active",
      createdAt: "2026-08-01T12:00:00.000Z",
      responsible: {
        id: "user_1",
        name: "Fulano",
        email: "fulano@cliente.com",
        role: "owner",
        status: "pending_activation",
      },
      reusedExistingUser: false,
      deliveryStatus: "queued",
    });

    const result = await createBackofficeWorkspaceAction(
      initialState,
      form({
        workspaceName: "Cliente Exemplo",
        responsibleName: "Fulano",
        responsibleEmail: "fulano@cliente.com",
      }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith("/backoffice/workspaces", {
      method: "POST",
      body: JSON.stringify({
        name: "Cliente Exemplo",
        responsible: { name: "Fulano", email: "fulano@cliente.com" },
        reuseExistingUser: false,
      }),
    });
    expect(revalidatePath).toHaveBeenCalledWith("/backoffice/clients");
    expect(result.status).toBe("success");
    expect(result.message).toContain("Cliente Exemplo");
  });

  it("maps the reuse-existing-user checkbox", async () => {
    serverApiFetch.mockResolvedValueOnce({
      id: "ws_1",
      name: "Cliente Exemplo",
      slug: "cliente-exemplo",
      operationalStatus: "active",
      createdAt: "2026-08-01T12:00:00.000Z",
      responsible: null,
      reusedExistingUser: true,
      deliveryStatus: "not_required",
    });

    await createBackofficeWorkspaceAction(
      initialState,
      form({
        workspaceName: "Cliente Exemplo",
        responsibleName: "Fulano",
        responsibleEmail: "fulano@cliente.com",
        reuseExistingUser: "on",
      }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/backoffice/workspaces",
      expect.objectContaining({
        body: JSON.stringify({
          name: "Cliente Exemplo",
          responsible: { name: "Fulano", email: "fulano@cliente.com" },
          reuseExistingUser: true,
        }),
      }),
    );
  });

  it("warns without promising delivery when the activation e-mail fails to queue", async () => {
    serverApiFetch.mockResolvedValueOnce({
      id: "ws_1",
      name: "Cliente Exemplo",
      slug: "cliente-exemplo",
      operationalStatus: "active",
      createdAt: "2026-08-01T12:00:00.000Z",
      responsible: null,
      reusedExistingUser: false,
      deliveryStatus: "failed",
    });

    const result = await createBackofficeWorkspaceAction(
      initialState,
      form({
        workspaceName: "Cliente Exemplo",
        responsibleName: "Fulano",
        responsibleEmail: "fulano@cliente.com",
      }),
    );

    expect(result.status).toBe("success");
    expect(result.message).toContain("não foi enfileirado");
    expect(result.message).toContain("link de ativação manual");
    expect(result.message).not.toMatch(/enviado|entregue/i);
  });

  it("rejects an empty workspace name before calling the API", async () => {
    const result = await createBackofficeWorkspaceAction(
      initialState,
      form({
        responsibleName: "Fulano",
        responsibleEmail: "fulano@cliente.com",
      }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toContain("workspace");
    expect(serverApiFetch).not.toHaveBeenCalled();
  });

  it("surfaces the API's pt-BR error message (e.g. license lock) verbatim", async () => {
    serverApiFetch.mockRejectedValueOnce(
      apiError(
        "Licença não utilizável — operações de escrita bloqueadas.",
        423,
      ),
    );

    const result = await createBackofficeWorkspaceAction(
      initialState,
      form({
        workspaceName: "Cliente Exemplo",
        responsibleName: "Fulano",
        responsibleEmail: "fulano@cliente.com",
      }),
    );

    expect(result).toEqual({
      status: "error",
      message: "Licença não utilizável — operações de escrita bloqueadas.",
      nonce: expect.any(Number),
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("resendActivationEmailAction", () => {
  it("posts to the resend endpoint and confirms only that sending was requested", async () => {
    serverApiFetch.mockResolvedValueOnce({
      accepted: true,
      deliveryStatus: "queued",
    });

    const result = await resendActivationEmailAction(
      initialState,
      form({ workspaceId: "ws_1", ownerUserId: "user_1" }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/backoffice/workspaces/ws_1/owners/user_1/activation/resend",
      { method: "POST" },
    );
    expect(result).toEqual({
      status: "success",
      message: "Envio solicitado.",
      nonce: expect.any(Number),
    });
  });

  it("requires the owner to be identified before calling the API", async () => {
    const result = await resendActivationEmailAction(
      initialState,
      form({ workspaceId: "ws_1" }),
    );

    expect(result.status).toBe("error");
    expect(serverApiFetch).not.toHaveBeenCalled();
  });

  it("surfaces the API's error message on failure", async () => {
    serverApiFetch.mockRejectedValueOnce(
      apiError("Responsavel do workspace nao encontrado", 404),
    );

    const result = await resendActivationEmailAction(
      initialState,
      form({ workspaceId: "ws_1", ownerUserId: "user_1" }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBe("Responsavel do workspace nao encontrado");
  });
});

describe("generateActivationLinkAction", () => {
  it("returns the one-time activation link and its expiry without touching the list cache", async () => {
    serverApiFetch.mockResolvedValueOnce({
      ok: true,
      mode: "activation",
      delivery: "link_only",
      activationUrl: "https://app.example.com/activate?token=abc123",
      expiresAt: "2026-09-02T12:00:00.000Z",
      emailAttempted: false,
    });

    const result = await generateActivationLinkAction(
      initialState,
      form({ workspaceId: "ws_1", ownerUserId: "user_1" }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/backoffice/workspaces/ws_1/owners/user_1/activation-link",
      { method: "POST" },
    );
    expect(result.status).toBe("success");
    expect(result.activationUrl).toBe(
      "https://app.example.com/activate?token=abc123",
    );
    expect(result.activationExpiresAt).toBe("2026-09-02T12:00:00.000Z");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("requires the owner to be identified before calling the API", async () => {
    const result = await generateActivationLinkAction(
      initialState,
      form({ workspaceId: "ws_1" }),
    );

    expect(result.status).toBe("error");
    expect(serverApiFetch).not.toHaveBeenCalled();
  });

  it("surfaces the API's error message and never fabricates a link on failure", async () => {
    serverApiFetch.mockRejectedValueOnce(
      apiError("Acao restrita ao proprietario da plataforma", 403),
    );

    const result = await generateActivationLinkAction(
      initialState,
      form({ workspaceId: "ws_1", ownerUserId: "user_1" }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toBe("Acao restrita ao proprietario da plataforma");
    expect(result.activationUrl).toBeUndefined();
  });
});
