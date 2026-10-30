// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { InboundWebhookMetaAppDto } from "@wpptrack/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetaCloudAppCredentialsPanel } from "../src/app/(app)/integrations/meta-cloud-app-credentials";
import {
  removeMetaCloudAppAction,
  saveMetaCloudAppAction,
} from "../src/app/(app)/integrations/meta-cloud-app-actions";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("../src/app/(app)/integrations/meta-cloud-app-actions", () => ({
  saveMetaCloudAppAction: vi.fn(),
  removeMetaCloudAppAction: vi.fn(),
}));

const APP_ID = "1234567890123456";
const SECRET = "0123456789abcdef0123456789abcdef";

function metaApp(change: Partial<InboundWebhookMetaAppDto> = {}): InboundWebhookMetaAppDto {
  return {
    appId: null,
    appSecretConfigured: false,
    appSecretSource: "none",
    appSecretUpdatedAt: null,
    ...change,
  };
}

function mount(
  props: Partial<{
    metaApp: InboundWebhookMetaAppDto | null;
    canManage: boolean;
    licenseLocked: boolean;
  }> = {},
) {
  return render(
    createElement(MetaCloudAppCredentialsPanel, {
      connectionId: "conn",
      metaApp: props.metaApp === undefined ? metaApp() : props.metaApp,
      canManage: props.canManage ?? true,
      licenseLocked: props.licenseLocked ?? false,
    }),
  );
}

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(saveMetaCloudAppAction).mockReset();
  vi.mocked(removeMetaCloudAppAction).mockReset();
  refresh.mockReset();
});

describe("App do Meta desta conexão", () => {
  it("mostra de onde vem o segredo", () => {
    const view = mount();
    expect(screen.getByText(/Nenhum segredo configurado/)).toBeTruthy();
    view.rerender(
      createElement(MetaCloudAppCredentialsPanel, {
        connectionId: "env",
        metaApp: metaApp({ appSecretSource: "environment" }),
        canManage: true,
      }),
    );
    expect(screen.getByText(/Usando o META_APP_SECRET do servidor/)).toBeTruthy();
    cleanup();
    mount({
      metaApp: metaApp({
        appId: APP_ID,
        appSecretConfigured: true,
        appSecretSource: "connection",
        appSecretUpdatedAt: "2026-10-30T12:00:00.000Z",
      }),
    });
    expect(screen.getByText(/Segredo configurado nesta conexão/)).toBeTruthy();
    expect(screen.getByText(new RegExp(APP_ID))).toBeTruthy();
  });

  it("campo do segredo é senha, sem autocomplete, sensível e nunca vem preenchido", () => {
    mount({
      metaApp: metaApp({
        appId: APP_ID,
        appSecretConfigured: true,
        appSecretSource: "connection",
      }),
    });
    const secret = screen.getByLabelText("App Secret") as HTMLInputElement;
    expect(secret.type).toBe("password");
    expect(secret.value).toBe("");
    expect(secret.getAttribute("autocomplete")).toBe("new-password");
    expect(secret.getAttribute("data-presentation-sensitive-field")).toBe("true");
    expect((screen.getByLabelText("App ID") as HTMLInputElement).value).toBe(APP_ID);
  });

  it("salva, limpa o segredo da tela e atualiza", async () => {
    vi.mocked(saveMetaCloudAppAction).mockResolvedValue({
      ok: true,
      message: "App Secret salvo nesta conexão.",
      metaApp: metaApp({
        appId: APP_ID,
        appSecretConfigured: true,
        appSecretSource: "connection",
      }),
    });
    mount();
    fireEvent.change(screen.getByLabelText("App ID"), { target: { value: APP_ID } });
    fireEvent.change(screen.getByLabelText("App Secret"), { target: { value: SECRET } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Salvar/ }));
    });

    expect(saveMetaCloudAppAction).toHaveBeenCalledWith("conn", {
      appId: APP_ID,
      appSecret: SECRET,
    });
    expect((screen.getByLabelText("App Secret") as HTMLInputElement).value).toBe("");
    expect(screen.getByText(/Segredo configurado nesta conexão/)).toBeTruthy();
    expect(document.body.textContent).not.toContain(SECRET);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("mostra a recusa da API ao remover", async () => {
    vi.mocked(removeMetaCloudAppAction).mockResolvedValue({
      ok: false,
      message: "Esta conexão está enviando e o servidor não tem META_APP_SECRET de reserva.",
    });
    mount({
      metaApp: metaApp({
        appId: APP_ID,
        appSecretConfigured: true,
        appSecretSource: "connection",
      }),
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Remover/ }));
    });
    expect(removeMetaCloudAppAction).toHaveBeenCalledWith("conn");
    expect(screen.getByRole("alert").textContent).toContain("META_APP_SECRET de reserva");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("sem permissão ou com a licença bloqueada não deixa alterar", () => {
    mount({ canManage: false });
    expect(screen.queryByRole("button", { name: /Salvar/ })).toBeNull();
    cleanup();
    mount({ licenseLocked: true });
    expect(
      (screen.getByRole("button", { name: /Salvar/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/Licença bloqueada/)).toBeTruthy();
  });
});
