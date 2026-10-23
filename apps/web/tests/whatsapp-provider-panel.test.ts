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
    connections: WhatsappConnectionDto[];
    createAction: ReturnType<typeof vi.fn>;
    testAction: ReturnType<typeof vi.fn>;
    rotateAction: ReturnType<typeof vi.fn>;
    editAction: ReturnType<typeof vi.fn>;
    loadEditAction: ReturnType<typeof vi.fn>;
    deleteAction: ReturnType<typeof vi.fn>;
    canManage: boolean;
    configureWebhookAction: ReturnType<typeof vi.fn>;
    provider: WhatsappConnectionDto["provider"];
    licenseLocked: boolean;
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
    connections: overrides.connections ?? [connection],
    canManage: overrides.canManage ?? true,
    createAction: overrides.createAction ?? noopAction,
    testAction: overrides.testAction ?? noopAction,
    rotateAction: overrides.rotateAction ?? noopAction,
    editAction: overrides.editAction ?? noopAction,
    loadEditAction,
    deleteAction: overrides.deleteAction ?? noopAction,
    ...(overrides.configureWebhookAction
      ? { configureWebhookAction: overrides.configureWebhookAction }
      : {}),
    ...(overrides.provider ? { provider: overrides.provider } : {}),
    ...(overrides.licenseLocked ? { licenseLocked: true } : {}),
  };

  render(createElement(WhatsappProviderPanel, props));
  return props;
}

function connectionFor(
  provider: WhatsappConnectionDto["provider"],
  id: string,
): WhatsappConnectionDto {
  return {
    ...connection,
    id,
    provider,
    name: `${provider} connection`,
  };
}

/** "Configurar webhook" asks first (the WAHA restarts the session). */
async function confirmConfigureWebhook() {
  fireEvent.click(screen.getByRole("button", { name: /configurar webhook/i }));
  const confirm = within(await screen.findByTestId("waha-configure-confirm"));
  fireEvent.click(
    confirm.getByRole("button", { name: /reiniciar e configurar/i }),
  );
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
    const sessionInput = editForm.getByLabelText("Sessão") as HTMLInputElement;
    const secretInput = editForm.getByLabelText(/api key/i) as HTMLInputElement;

    expect(baseUrlInput.value).toBe("https://waha.example.test");
    expect(sessionInput.value).toBe("support");
    expect(secretInput.value).toBe("");
    expect(secretInput.type).toBe("password");
    expect(secretInput.required).toBe(false);
  });

  it("submits the edit form, clears the secret and refreshes on success", async () => {
    const editAction = vi.fn(async () => ({
      ok: true as const,
      message: "Conexão atualizada.",
    }));
    renderPanel({ editAction });

    fireEvent.click(screen.getByRole("button", { name: /editar/i }));
    const editForm = within(
      await screen.findByTestId("whatsapp-connection-edit-connection_1"),
    );

    const secretInput = editForm.getByLabelText(/api key/i) as HTMLInputElement;
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

    const secretInput = editForm.getByLabelText(/api key/i) as HTMLInputElement;
    fireEvent.change(secretInput, { target: { value: "leaked-on-error" } });

    const submitButton = editForm.getByRole("button", {
      name: /salvar altera/i,
    }) as HTMLButtonElement;
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

describe("WhatsappProviderPanel receiver instruction", () => {
  it("mentions the Uazapi webhook field and the one-time URL after generating a receiver for a Uazapi connection", async () => {
    const uazapiConnection = connectionFor("uazapi_byo", "connection_uazapi");
    const rotateAction = vi.fn(async () => ({
      ok: true as const,
      message: "Receiver gerado.",
      receiverSecret: { webhookUrl: "https://api.test/webhook/uazapi-token" },
    }));
    renderPanel({ connections: [uazapiConnection], rotateAction });

    fireEvent.click(screen.getByRole("button", { name: /gerar receiver/i }));

    await waitFor(() => {
      expect(rotateAction).toHaveBeenCalledTimes(1);
    });

    await screen.findByText(/campo url do webhook da uazapi/i);
    const webhookInput = screen.getByLabelText(
      "URL completa do receiver WhatsApp",
    ) as HTMLInputElement;
    expect(webhookInput.value).toBe("https://api.test/webhook/uazapi-token");
    expect(screen.getByText(/exibido uma única vez/i)).not.toBeNull();
  });

  it("points students to the inbound webhooks block for Umbler Talk and Gupshup", () => {
    renderPanel();

    expect(screen.getByText(/umbler talk ou gupshup/i)).not.toBeNull();
    expect(screen.getByText(/bloco de webhooks logo abaixo/i)).not.toBeNull();
  });
});

describe("WhatsappProviderPanel delete flow", () => {
  it("does not call the DELETE endpoint via a native confirm dialog", () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /excluir/i }));

    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("requires typing the exact connection name before enabling the confirm button", async () => {
    const deleteAction = vi.fn(async () => ({
      ok: true as const,
      message: "Conexão excluída.",
    }));
    renderPanel({ deleteAction });

    fireEvent.click(screen.getByRole("button", { name: /excluir/i }));
    const confirmPanel = within(
      await screen.findByTestId(
        "whatsapp-connection-delete-confirm-connection_1",
      ),
    );

    const confirmButton = confirmPanel.getByRole("button", {
      name: /confirmar exclus/i,
    }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);

    fireEvent.change(confirmPanel.getByLabelText(/confirmar exclusão/i), {
      target: { value: "wrong name" },
    });
    expect(confirmButton.disabled).toBe(true);

    fireEvent.change(confirmPanel.getByLabelText(/confirmar exclusão/i), {
      target: { value: connection.name },
    });
    expect(confirmButton.disabled).toBe(false);

    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(deleteAction).toHaveBeenCalledTimes(1);
    });
  });

  it("cancels the delete confirmation without calling the action", () => {
    const deleteAction = vi.fn(async () => ({
      ok: true as const,
      message: "Conexão excluída.",
    }));
    renderPanel({ deleteAction });

    fireEvent.click(screen.getByRole("button", { name: /excluir/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancelar/i }));

    expect(
      screen.queryByTestId("whatsapp-connection-delete-confirm-connection_1"),
    ).toBeNull();
    expect(deleteAction).not.toHaveBeenCalled();
  });

  it("shows an error and keeps the panel open when the delete action fails", async () => {
    const deleteAction = vi.fn(async () => ({
      ok: false as const,
      message: "Não foi possível excluir a conexão WhatsApp.",
    }));
    renderPanel({ deleteAction });

    fireEvent.click(screen.getByRole("button", { name: /excluir/i }));
    const confirmPanel = within(
      await screen.findByTestId(
        "whatsapp-connection-delete-confirm-connection_1",
      ),
    );
    fireEvent.change(confirmPanel.getByLabelText(/confirmar exclusão/i), {
      target: { value: connection.name },
    });
    fireEvent.click(
      confirmPanel.getByRole("button", { name: /confirmar exclus/i }),
    );

    await screen.findByText(/não foi possível excluir/i);
    expect(
      screen.getByTestId("whatsapp-connection-delete-confirm-connection_1"),
    ).not.toBeNull();
  });

  it("does not render the Excluir control for read-only users", () => {
    renderPanel({ canManage: false });

    expect(screen.queryByRole("button", { name: /excluir/i })).toBeNull();
  });
});

describe("WhatsappProviderPanel WAHA (GoWS)", () => {
  const sessionResult = (providerStatus: string, ok = false) =>
    vi.fn(async () => ({
      ok,
      message: "texto da API",
      connectionId: "connection_1",
      providerStatus,
    }));

  it("mounts the scoped WAHA panel without any connection, with the own-server guidance and the create fields", () => {
    renderPanel({ connections: [], provider: "waha" });

    const intro = within(screen.getByTestId("waha-intro"));
    expect(intro.getAllByText(/sua WAHA/i).length).toBeGreaterThan(0);
    expect(intro.getByText(/não mostra QR/i)).not.toBeNull();
    expect(screen.getByLabelText("Nome")).not.toBeNull();
    expect(screen.getByLabelText(/URL da API/)).not.toBeNull();
    const apiKey = screen.getByLabelText(/API key/) as HTMLInputElement;
    expect(apiKey.type).toBe("password");
    expect((screen.getByLabelText(/Sessão/) as HTMLInputElement).required).toBe(
      true,
    );
    expect(screen.queryByText(/Em breve: novas conexões/)).toBeNull();
    // Phrase rules stay "em breve"; CTWA lead entry already works.
    expect(
      screen.getByText(/regras de frase da WAHA seguem em breve/i),
    ).not.toBeNull();
    expect(screen.queryByText("Nome exibido")).toBeNull();
  });

  it("validates the create form locally and clears the API key", async () => {
    const createAction = vi.fn(async () => ({ ok: true, message: "ok" }));
    renderPanel({ connections: [], provider: "waha", createAction });

    const url = screen.getByLabelText(/URL da API/) as HTMLInputElement;
    const apiKey = screen.getByLabelText(/API key/) as HTMLInputElement;
    fireEvent.change(screen.getByLabelText("Nome"), {
      target: { value: "Loja" },
    });
    fireEvent.change(url, { target: { value: "ftp://waha.test" } });
    fireEvent.change(apiKey, { target: { value: "segredo" } });
    fireEvent.change(screen.getByLabelText(/Sessão/), {
      target: { value: "loja" },
    });
    fireEvent.submit(url.closest("form") as HTMLFormElement);

    expect(await screen.findByText(/começando com http/i)).not.toBeNull();
    expect(createAction).not.toHaveBeenCalled();
    expect(apiKey.value).toBe("");
  });

  it("submits a valid create form with the provider fixed to WAHA", async () => {
    const createAction = vi.fn(async (_data: FormData) => ({
      ok: true,
      message: "Conexão salva. Agora teste a conexão e configure o webhook.",
    }));
    renderPanel({ connections: [], provider: "waha", createAction });

    const url = screen.getByLabelText(/URL da API/) as HTMLInputElement;
    fireEvent.change(screen.getByLabelText("Nome"), {
      target: { value: "Loja" },
    });
    fireEvent.change(url, { target: { value: "https://waha.test" } });
    fireEvent.change(screen.getByLabelText(/API key/), {
      target: { value: "segredo" },
    });
    fireEvent.change(screen.getByLabelText(/Sessão/), {
      target: { value: "loja" },
    });
    fireEvent.submit(url.closest("form") as HTMLFormElement);

    await waitFor(() => expect(createAction).toHaveBeenCalledTimes(1));
    const data = createAction.mock.calls[0]![0];
    expect(data.get("provider")).toBe("waha");
    expect(data.get("session")).toBe("loja");
    await screen.findByText(/Conexão salva/);
  });

  it("shows WORKING with the next step", async () => {
    const testAction = sessionResult("WORKING", true);
    renderPanel({ testAction });

    fireEvent.click(screen.getByRole("button", { name: /testar conexão/i }));

    const status = await screen.findByTestId("waha-session-status");
    expect(within(status).getByText("WORKING")).not.toBeNull();
    expect(status.textContent).toMatch(/Sessão conectada/);
    expect(status.className).toContain("ok");
  });

  it("tells the student to read the QR in their own WAHA panel on SCAN_QR_CODE", async () => {
    const testAction = sessionResult("SCAN_QR_CODE");
    renderPanel({ testAction });

    fireEvent.click(screen.getByRole("button", { name: /testar conexão/i }));

    const status = await screen.findByTestId("waha-session-status");
    expect(within(status).getByText("SCAN_QR_CODE")).not.toBeNull();
    expect(status.textContent).toMatch(/painel da sua WAHA/);
    expect(status.className).toContain("warn");
    // The app never renders a QR code.
    expect(document.querySelector("img, canvas")).toBeNull();
  });

  it.each([
    ["STOPPED", /Inicie a sessão/],
    ["FAILED", /logs/],
    ["STARTING", /subindo/],
  ])("shows the instruction for %s", async (providerStatus, pattern) => {
    renderPanel({ testAction: sessionResult(providerStatus) });

    fireEvent.click(screen.getByRole("button", { name: /testar conexão/i }));

    const status = await screen.findByTestId("waha-session-status");
    expect(within(status).getByText(providerStatus)).not.toBeNull();
    expect(status.textContent).toMatch(pattern);
  });

  it("warns that the WAHA session restarts before configuring, and cancel calls nothing", async () => {
    const configureWebhookAction = vi.fn();
    renderPanel({ configureWebhookAction });

    fireEvent.click(
      screen.getByRole("button", { name: /configurar webhook/i }),
    );
    const confirm = within(await screen.findByTestId("waha-configure-confirm"));
    expect(confirm.getByText(/reinicia a sessão/i)).not.toBeNull();
    expect(configureWebhookAction).not.toHaveBeenCalled();

    fireEvent.click(confirm.getByRole("button", { name: /cancelar/i }));
    expect(screen.queryByTestId("waha-configure-confirm")).toBeNull();
    expect(configureWebhookAction).not.toHaveBeenCalled();
  });

  it("configures the webhook automatically and lists the subscribed events", async () => {
    const configureWebhookAction = vi.fn(async () => ({
      ok: true,
      message:
        "Webhook configurado na sua WAHA. O token anterior deixou de valer.",
      connectionId: "connection_1",
      providerStatus: "WORKING",
      wahaWebhook: {
        configured: true,
        events: ["message", "message.any", "session.status"],
        sessionStatus: "WORKING",
      },
    }));
    renderPanel({ configureWebhookAction });

    await confirmConfigureWebhook();

    const result = await screen.findByTestId("waha-webhook-result");
    expect(within(result).getByText("Webhook configurado")).not.toBeNull();
    expect(result.textContent).toContain(
      "message, message.any, session.status",
    );
    expect(result.textContent).not.toMatch(/token=|X-Wpptrack/);
    expect(screen.queryByTestId("waha-manual-setup")).toBeNull();
  });

  it("reports a refused automatic webhook and keeps the manual alternative", async () => {
    const configureWebhookAction = vi.fn(async () => ({
      ok: false,
      message: "A WAHA recusou a API key. Confira a chave na conexão (Editar).",
      connectionId: "connection_1",
      wahaWebhook: {
        configured: false,
        events: [] as string[],
        sessionStatus: null,
        reason: "unauthorized",
      },
    }));
    renderPanel({ configureWebhookAction });

    await confirmConfigureWebhook();

    const result = await screen.findByTestId("waha-webhook-result");
    expect(within(result).getByText("Webhook não configurado")).not.toBeNull();
    expect(result.textContent).toMatch(/recusou a API key/);
    expect(result.textContent).toMatch(/configuração manual/);
    expect(
      screen.getByRole("button", { name: /configuração manual/i }),
    ).not.toBeNull();
  });

  it("asks for confirmation before rotating the token and only then shows the manual setup", async () => {
    const token = "t".repeat(43);
    const rotateAction = vi.fn(async () => ({
      ok: true,
      message: "Novo token gerado.",
      connectionId: "connection_1",
      wahaManualSetup: {
        webhookUrl: "https://api.test/webhooks/whatsapp/connection_1",
        webhookUrlWithToken:
          "https://api.test/webhooks/whatsapp/connection_1?token=" + token,
        events: ["message", "message.any", "session.status"],
        tokenHeaderName: "X-Wpptrack-Webhook-Token",
        webhookToken: token,
      },
    }));
    renderPanel({ rotateAction });

    // Nothing sensitive before the student asks.
    expect(screen.queryByTestId("waha-manual-setup")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /configuração manual/i }),
    );
    const confirm = within(await screen.findByTestId("waha-rotate-confirm"));
    expect(confirm.getByText(/webhook atual deixa de valer/i)).not.toBeNull();
    expect(rotateAction).not.toHaveBeenCalled();

    fireEvent.click(confirm.getByRole("button", { name: /gerar novo token/i }));

    const manual = within(await screen.findByTestId("waha-manual-setup"));
    expect(rotateAction).toHaveBeenCalledTimes(1);
    expect(
      (manual.getByLabelText("URL do webhook com token") as HTMLInputElement)
        .value,
    ).toContain("?token=" + token);
    expect(
      manual.getByText("message, message.any, session.status"),
    ).not.toBeNull();
    // Header first: URL without token + header + token.
    expect(
      (manual.getByLabelText("URL do webhook") as HTMLInputElement).value,
    ).toBe("https://api.test/webhooks/whatsapp/connection_1");
    expect(manual.getAllByText("X-Wpptrack-Webhook-Token").length).toBeGreaterThan(0);
    // The ?token= URL is only the alternative, with the logs warning.
    expect(manual.getByText(/logs da WAHA e do\s+proxy/)).not.toBeNull();
    expect(
      (manual.getByLabelText("Token do webhook") as HTMLInputElement).value,
    ).toBe(token);

    fireEvent.click(manual.getByRole("button", { name: /ocultar/i }));
    expect(screen.queryByTestId("waha-manual-setup")).toBeNull();
  });

  it("cancels the token rotation without calling the API", () => {
    const rotateAction = vi.fn();
    renderPanel({ rotateAction });

    fireEvent.click(
      screen.getByRole("button", { name: /configuração manual/i }),
    );
    const confirm = within(screen.getByTestId("waha-rotate-confirm"));
    fireEvent.click(confirm.getByRole("button", { name: /cancelar/i }));

    expect(screen.queryByTestId("waha-rotate-confirm")).toBeNull();
    expect(rotateAction).not.toHaveBeenCalled();
  });

  it("shows the standard license message on a 423 and disables the controls when locked", async () => {
    const lockedMessage =
      "Licença bloqueada: alterações indisponíveis. Verifique /backoffice/license.";
    const configureWebhookAction = vi.fn(async () => ({
      ok: false,
      message: lockedMessage,
      licenseLocked: true,
    }));
    renderPanel({ configureWebhookAction });

    await confirmConfigureWebhook();

    expect(await screen.findByText(lockedMessage)).not.toBeNull();
    expect(screen.queryByTestId("waha-webhook-result")).toBeNull();

    cleanup();
    renderPanel({ licenseLocked: true });
    expect(screen.getByText(/Licença bloqueada: criar, testar/)).not.toBeNull();
    expect(
      (
        screen
          .getByRole("button", { name: /testar conexão/i })
          .closest("fieldset") as HTMLFieldSetElement
      ).disabled,
    ).toBe(true);
  });

  it("never puts the saved API key back on the screen when editing", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /editar/i }));
    const editForm = within(
      await screen.findByTestId("whatsapp-connection-edit-connection_1"),
    );
    const secret = editForm.getByLabelText(/api key/i) as HTMLInputElement;
    expect(secret.value).toBe("");
    expect(secret.placeholder).toMatch(/em branco/i);
  });
});
