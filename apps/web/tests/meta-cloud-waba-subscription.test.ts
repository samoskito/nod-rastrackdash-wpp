// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MetaCloudWabaSubscriptionStatusDto } from "@wpptrack/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetaCloudWabaSubscriptionPanel } from "../src/app/(app)/integrations/meta-cloud-waba-subscription";
import {
  lookupMetaCloudWabaAction,
  subscribeMetaCloudWabaAction,
} from "../src/app/(app)/integrations/meta-cloud-waba-actions";

vi.mock("../src/app/(app)/integrations/meta-cloud-waba-actions", () => ({
  lookupMetaCloudWabaAction: vi.fn(),
  subscribeMetaCloudWabaAction: vi.fn(),
}));

const TOKEN = "EAAGsyntheticWebToken" + "Z".repeat(30);
const WABA = "102290129340398";

function status(change: Partial<MetaCloudWabaSubscriptionStatusDto> = {}): MetaCloudWabaSubscriptionStatusDto {
  return {
    connectionId: "conn",
    wabaId: WABA,
    thisAppId: "111222333444555",
    thisAppSubscribed: true,
    apps: [
      { appId: "111222333444555", name: "App da instalação", isThisApp: true },
      { appId: "999888777666555", name: "Outro CRM", isThisApp: false },
    ],
    phoneNumbers: [{ id: "106540352242922", displayPhoneNumber: "+55 11 4000-0000", verifiedName: "Loja" }],
    channelCheck: { status: "all_match", mismatchedChannels: 0 },
    outcome: "lookup",
    checkedAt: "2026-10-24T12:00:00.000Z",
    ...change,
  };
}

function mount(props: Partial<{ canManage: boolean; licenseLocked: boolean }> = {}) {
  return render(
    createElement(MetaCloudWabaSubscriptionPanel, {
      connectionId: "conn",
      canManage: props.canManage ?? true,
      licenseLocked: props.licenseLocked ?? false,
    }),
  );
}

function fill() {
  fireEvent.change(screen.getByLabelText(/WABA ID/), { target: { value: WABA } });
  fireEvent.change(screen.getByLabelText("Token do app Meta"), { target: { value: TOKEN } });
}

async function click(name: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.mocked(lookupMetaCloudWabaAction).mockResolvedValue({ ok: true, data: status() });
  vi.mocked(subscribeMetaCloudWabaAction).mockResolvedValue({
    ok: true,
    data: status({ outcome: "subscribed" }),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("bloco Inscrição do app na sua WABA", () => {
  it("vazio: explica os três passos e desabilita as ações sem WABA ID e token", () => {
    mount();
    expect(screen.getByRole("heading", { name: "Inscrição do app na sua WABA" })).toBeTruthy();
    expect(screen.getByText(/Confirmar a URL \(handshake\)/)).toBeTruthy();
    expect(screen.getByText(/Assinar o campo messages no app/)).toBeTruthy();
    expect(screen.getByText(/Inscrever o app na WABA/)).toBeTruthy();
    expect(screen.getByText(/Não é o ID do número/)).toBeTruthy();
    expect(screen.getByText(/token temporário/)).toBeTruthy();
    const token = screen.getByLabelText("Token do app Meta") as HTMLInputElement;
    expect(token.type).toBe("password");
    expect(token.getAttribute("autocomplete")).toBe("new-password");
    expect(token.getAttribute("data-1p-ignore")).toBe("true");
    expect(token.getAttribute("data-lpignore")).toBe("true");
    expect((screen.getByRole("button", { name: /Consultar/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Inscrever este app/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("consulta, mostra a lista com 'Este app' e limpa o token da tela", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    mount();
    fill();
    await click(/Consultar/);

    expect(lookupMetaCloudWabaAction).toHaveBeenCalledWith("conn", { wabaId: WABA, accessToken: TOKEN });
    expect(screen.getByText("Este app está inscrito na WABA.", { exact: false })).toBeTruthy();
    expect(screen.getByText("Este app")).toBeTruthy();
    expect(screen.getByText("Outro CRM")).toBeTruthy();
    expect(screen.getByText(/Outros apps continuam inscritos/)).toBeTruthy();
    expect((screen.getByLabelText("Token do app Meta") as HTMLInputElement).value).toBe("");
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("ausente: avisa e pede a inscrição", async () => {
    vi.mocked(lookupMetaCloudWabaAction).mockResolvedValue({
      ok: true,
      data: status({ thisAppSubscribed: false, apps: [], channelCheck: { status: "mismatch", mismatchedChannels: 1 } }),
    });
    mount();
    fill();
    await click(/Consultar/);
    expect(screen.getByText(/ainda não está inscrito/)).toBeTruthy();
    expect(screen.getByText("Nenhum app inscrito nesta WABA.")).toBeTruthy();
    expect(screen.getByText(/1 número desta conexão não pertence a esta WABA/)).toBeTruthy();
  });

  it("inscrever pede confirmação e não chama a API se cancelar", async () => {
    mount();
    fill();
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await click(/Inscrever este app/);
    expect(subscribeMetaCloudWabaAction).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Token do app Meta") as HTMLInputElement).value).toBe(TOKEN);

    await click(/Inscrever este app/);
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining("Outros apps inscritos não são removidos"));
    expect(subscribeMetaCloudWabaAction).toHaveBeenCalledWith("conn", {
      wabaId: WABA,
      accessToken: TOKEN,
      confirm: true,
    });
    expect(screen.getByText(/Inscrição feita e confirmada/)).toBeTruthy();
  });

  it("erro de app divergente mostra a mensagem e o guia manual", async () => {
    vi.mocked(subscribeMetaCloudWabaAction).mockResolvedValue({
      ok: false,
      status: 422,
      code: "token_app_mismatch",
      message: "Este token foi gerado para outro app Meta.",
    });
    mount();
    fill();
    await click(/Inscrever este app/);
    expect(screen.getByRole("alert").textContent).toContain("outro app Meta");
    expect(screen.getByText("Fazer a inscrição manualmente")).toBeTruthy();
    expect(screen.getByText(/Graph API Explorer/, { selector: "li" })).toBeTruthy();
  });

  it.each([
    [403, "Só o dono ou um admin do workspace pode consultar ou inscrever a WABA."],
    [423, "Licença bloqueada — operações de escrita desativadas."],
  ])("erro %s mostra a mensagem sem o guia manual", async (code, message) => {
    vi.mocked(lookupMetaCloudWabaAction).mockResolvedValue({ ok: false, status: code, message });
    mount();
    fill();
    await click(/Consultar/);
    expect(screen.getByRole("alert").textContent).toContain(message);
    expect(screen.queryByText("Fazer a inscrição manualmente")).toBeNull();
  });

  it("licença bloqueada ou sem permissão: campos e botões desabilitados", () => {
    mount({ licenseLocked: true });
    expect(screen.getByText(/Licença bloqueada: consultar e inscrever/)).toBeTruthy();
    expect((screen.getByLabelText("Token do app Meta") as HTMLInputElement).disabled).toBe(true);
    cleanup();
    mount({ canManage: false });
    expect(screen.getByText(/Só o dono ou um admin/)).toBeTruthy();
    expect((screen.getByLabelText(/WABA ID/) as HTMLInputElement).disabled).toBe(true);
  });

  it("deixa claro que regras de frase da equipe não valem no Meta Cloud", () => {
    mount();
    expect(screen.getByText(/Regras de frase da equipe não funcionam no Meta Cloud/)).toBeTruthy();
  });
});
