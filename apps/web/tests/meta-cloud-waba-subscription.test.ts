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
    mode: "standard",
    callback: {
      expectedUrl: "https://api.exemplo.test/webhooks/inbound/conn",
      wabaOverride: "none",
      wabaOverrideHost: null,
      appCallback: "this_connection",
      appMessagesField: true,
      phoneOverrides: [{ phoneNumberId: "106540352242922", target: "none" }],
      phoneOverridesNotChecked: 0,
      effective: "this_connection",
    },
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

const VERIFY = "synthetic-verify-token-web-0123456789";

describe("App central da agência no cartão da conexão", () => {
  it("padrão continua selecionado; o modo App central pede o token de verificação", async () => {
    mount();
    const standard = screen.getByRole("radio", { name: /App desta conexão \(padrão\)/ }) as HTMLInputElement;
    expect(standard.checked).toBe(true);
    expect(screen.queryByLabelText("Token de verificação desta conexão")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /App central da agência/ }));
    expect(screen.getByText(/Preparar o app central \(uma vez só\)/)).toBeTruthy();
    expect(screen.getByText(/compartilha a WABA com o\s+Business Manager da agência como parceiro/)).toBeTruthy();
    const verify = screen.getByLabelText("Token de verificação desta conexão") as HTMLInputElement;
    expect(verify.type).toBe("password");
    expect(verify.getAttribute("autocomplete")).toBe("new-password");
    fill();
    const subscribe = screen.getByRole("button", { name: /Inscrever com a URL desta conexão/ }) as HTMLButtonElement;
    expect(subscribe.disabled).toBe(true);
  });

  it("inscreve com mode agency_central_app e o token de verificação, e limpa os dois tokens da tela", async () => {
    vi.mocked(subscribeMetaCloudWabaAction).mockResolvedValue({
      ok: true,
      data: status({
        outcome: "override_set",
        mode: "agency_central_app",
        callback: {
          expectedUrl: "https://api.exemplo.test/webhooks/inbound/conn",
          wabaOverride: "this_connection",
          wabaOverrideHost: null,
          appCallback: "other_url",
          appMessagesField: true,
          phoneOverrides: [],
          phoneOverridesNotChecked: 0,
          effective: "this_connection",
        },
      }),
    });
    mount();
    fireEvent.click(screen.getByRole("radio", { name: /App central da agência/ }));
    fill();
    fireEvent.change(screen.getByLabelText("Token de verificação desta conexão"), { target: { value: VERIFY } });
    await click(/Inscrever com a URL desta conexão/);

    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining("URL desta conexão"));
    expect(subscribeMetaCloudWabaAction).toHaveBeenCalledWith("conn", {
      wabaId: WABA,
      accessToken: TOKEN,
      confirm: true,
      mode: "agency_central_app",
      verifyToken: VERIFY,
    });
    expect(screen.getByText(/Inscrição feita com a URL desta conexão/)).toBeTruthy();
    expect(screen.getByText("As mensagens desta WABA chegam nesta conexão.")).toBeTruthy();
    expect(screen.getByText(/App central da agência ativo/)).toBeTruthy();
    expect(screen.getByText(/outro endereço, fora deste painel/)).toBeTruthy();
    expect(screen.getByText("https://api.exemplo.test/webhooks/inbound/conn")).toBeTruthy();
    expect((screen.getByLabelText("Token de verificação desta conexão") as HTMLInputElement).value).toBe("");
    expect(document.body.innerHTML).not.toContain(VERIFY);
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it("WABA apontando para outro endereço: aviso com só o domínio", async () => {
    vi.mocked(lookupMetaCloudWabaAction).mockResolvedValue({
      ok: true,
      data: status({
        callback: {
          expectedUrl: "https://api.exemplo.test/webhooks/inbound/conn",
          wabaOverride: "other_url",
          wabaOverrideHost: "crm-terceiro.test",
          appCallback: "unknown",
          appMessagesField: null,
          phoneOverrides: [],
          phoneOverridesNotChecked: 0,
          effective: "elsewhere",
        },
      }),
    });
    mount();
    fill();
    await click(/Consultar/);
    expect(screen.getByText(/estão indo para outro lugar, não para esta conexão/)).toBeTruthy();
    expect(screen.getByText(/aponta para outro endereço \(crm-terceiro\.test\)/)).toBeTruthy();
    expect(screen.getByText(/não deu para ler/)).toBeTruthy();
  });

  it("sem desvio: vale a URL do app; campo messages não assinado vira aviso", async () => {
    vi.mocked(lookupMetaCloudWabaAction).mockResolvedValue({
      ok: true,
      data: status({
        callback: {
          expectedUrl: "https://api.exemplo.test/webhooks/inbound/conn",
          wabaOverride: "none",
          wabaOverrideHost: null,
          appCallback: "this_connection",
          appMessagesField: false,
          phoneOverrides: [{ phoneNumberId: "106540352242922", target: "other_url" }],
          phoneOverridesNotChecked: 0,
          effective: "elsewhere",
        },
      }),
    });
    mount();
    fill();
    await click(/Consultar/);
    expect(screen.getByText(/nenhum; vale a URL configurada no app/)).toBeTruthy();
    expect(screen.getByText(/Campo messages não assinado no app/)).toBeTruthy();
    expect(screen.getByText(/1 número desta WABA aponta para outro lugar/)).toBeTruthy();
  });

  it("token de verificação errado: mostra a mensagem sem o guia manual", async () => {
    vi.mocked(subscribeMetaCloudWabaAction).mockResolvedValue({
      ok: false,
      status: 422,
      code: "verify_token_mismatch",
      message: "Esse não é o token de verificação desta conexão.",
    });
    mount();
    fireEvent.click(screen.getByRole("radio", { name: /App central da agência/ }));
    fill();
    fireEvent.change(screen.getByLabelText("Token de verificação desta conexão"), { target: { value: VERIFY } });
    await click(/Inscrever com a URL desta conexão/);
    expect(screen.getByRole("alert").textContent).toContain("token de verificação");
    expect(screen.queryByText("Fazer a inscrição manualmente")).toBeNull();
  });

  it("app sem o campo messages: aviso de que a Meta não entrega nada", async () => {
    vi.mocked(lookupMetaCloudWabaAction).mockResolvedValue({
      ok: true,
      data: status({
        callback: {
          expectedUrl: "https://api.exemplo.test/webhooks/inbound/conn",
          wabaOverride: "this_connection",
          wabaOverrideHost: null,
          appCallback: "other_url",
          appMessagesField: false,
          phoneOverrides: [],
          phoneOverridesNotChecked: 0,
          effective: "app_messages_off",
        },
      }),
    });
    mount();
    fill();
    await click(/Consultar/);
    expect(screen.getByText(/O app não assina o campo messages: a Meta não entrega nada/)).toBeTruthy();
    expect(screen.queryByText("As mensagens desta WABA chegam nesta conexão.")).toBeNull();
  });

  it("números não conferidos: diz quantos e quais, sem o verde", async () => {
    vi.mocked(lookupMetaCloudWabaAction).mockResolvedValue({
      ok: true,
      data: status({
        callback: {
          expectedUrl: "https://api.exemplo.test/webhooks/inbound/conn",
          wabaOverride: "this_connection",
          wabaOverrideHost: null,
          appCallback: "other_url",
          appMessagesField: true,
          phoneOverrides: [{ phoneNumberId: "106540352242922", target: "unknown" }],
          phoneOverridesNotChecked: 3,
          effective: "unknown",
        },
      }),
    });
    mount();
    fill();
    await click(/Consultar/);
    expect(screen.getByText(/Não deu para confirmar para onde vão/)).toBeTruthy();
    expect(screen.getByText(/4 números desta WABA não puderam ser conferidos/)).toBeTruthy();
    expect(screen.getByText(/a Meta não respondeu para: 106540352242922/)).toBeTruthy();
    expect(screen.getByText(/3 acima do limite de 20/)).toBeTruthy();
  });

  it("desvio aceito sem confirmação: pede para clicar em Consultar", async () => {
    vi.mocked(subscribeMetaCloudWabaAction).mockResolvedValue({
      ok: true,
      data: status({
        outcome: "override_unconfirmed",
        mode: "agency_central_app",
        callback: {
          expectedUrl: "https://api.exemplo.test/webhooks/inbound/conn",
          wabaOverride: "none",
          wabaOverrideHost: null,
          appCallback: "unknown",
          appMessagesField: null,
          phoneOverrides: [],
          phoneOverridesNotChecked: 0,
          effective: "unknown",
        },
      }),
    });
    mount();
    fireEvent.click(screen.getByRole("radio", { name: /App central da agência/ }));
    fill();
    fireEvent.change(screen.getByLabelText("Token de verificação desta conexão"), { target: { value: VERIFY } });
    await click(/Inscrever com a URL desta conexão/);
    expect(screen.getByText(/Clique em Consultar em alguns minutos/)).toBeTruthy();
  });
});
