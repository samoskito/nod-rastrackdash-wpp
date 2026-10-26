// @vitest-environment jsdom

import type {
  ProviderConversionRuleExecutionAuditDto,
  ProviderConversionRulePendingNumberDto,
} from "@wpptrack/shared";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupUser } from "./user-shim";

const { isApiRequestError, isLicenseLockedError, revalidatePath, serverApiFetch } =
  vi.hoisted(() => ({
    isApiRequestError: vi.fn(
      (error: unknown) =>
        error instanceof Error &&
        (error.name === "ApiRequestError" || error.name === "LicenseLockedError"),
    ),
    isLicenseLockedError: vi.fn(
      (error: unknown) => error instanceof Error && error.name === "LicenseLockedError",
    ),
    revalidatePath: vi.fn(),
    serverApiFetch: vi.fn(),
  }));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/lib/server-api", () => ({
  isApiRequestError,
  isLicenseLockedError,
  serverApiFetch,
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import {
  activateRuleNumberAction,
  createConversionRuleAction,
  reprocessBlockedExecutionsAction,
  type ConversionScreenActionResult,
} from "../src/app/(app)/conversions/actions";
import {
  buildProviderRuleRows,
  pendingNumbersTitle,
  pendingNumberViews,
} from "../src/app/(app)/conversions/conversion-rules-view";
import {
  ConversionsScreen,
  type ConversionsScreenProps,
} from "../src/app/(app)/conversions/conversions-screen";
import { PendingNumbersWarning } from "../src/app/(app)/conversions/pending-numbers";
import { RuleExecutions } from "../src/app/(app)/conversions/rule-executions";
import { capabilities, connections, numbers, providerRule } from "./conversions-fixtures";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  serverApiFetch.mockReset();
  document.body.style.overflow = "";
});

function apiError(status: number, message: string, code?: string) {
  return Object.assign(new Error(message), {
    name: "ApiRequestError",
    status,
    ...(code ? { code } : {}),
  });
}

function licenseLocked() {
  return Object.assign(new Error("Licença bloqueada"), {
    name: "LicenseLockedError",
    status: 423,
  });
}

const lockedMessage =
  "Licença bloqueada: alterações indisponíveis. Verifique /backoffice/license.";

function form(values: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) formData.set(key, value);
  return formData;
}

function pending(
  channelId: string,
  reason: ProviderConversionRulePendingNumberDto["reason"],
  extra: Partial<ProviderConversionRulePendingNumberDto> = {},
): ProviderConversionRulePendingNumberDto {
  return {
    channelId,
    connectionId: `conn_${channelId}`,
    provider: "uazapi",
    label: null,
    phone: null,
    reason,
    channelStatus: reason === "channel_not_active" ? "discovered" : "active",
    connectionStatus: "observation",
    activatable:
      reason === "channel_not_active" || reason === "connection_not_production",
    ...extra,
  };
}

function globalRule(
  mode: "observation" | "production",
  pendingNumbers: ProviderConversionRulePendingNumberDto[],
) {
  return {
    ...providerRule({
      id: "rule_global",
      name: "Frase do QR code",
      origin: "message_phrase",
      scope: "all_numbers",
      effective: ["ch_01", "ch_02", "ch_03"],
      mode,
    }),
    pendingNumbers,
  };
}

describe("ações: Todos os números", () => {
  it("criar uma regra para todos os números devolve os números pendentes", async () => {
    const rule = globalRule("observation", [pending("ch_03", "whatsapp_connection_inactive")]);
    serverApiFetch.mockResolvedValueOnce({
      outcome: "created",
      receipt: { ruleId: "rule_global", connectionId: null, createdAt: rule.createdAt },
      rule,
      webhookUrl: null,
    });

    const result = await createConversionRuleAction(
      form({
        requestKey: "prc_0123456789abcdef0123456789abcdef",
        payload: JSON.stringify({
          name: "Qualificado",
          scope: "all_numbers",
          channelIds: [],
          mode: "observation",
          triggerType: "message_phrase",
          eventName: "QualifiedLead",
          valueMode: "fixed",
          exampleMessage: null,
          triggerPhrases: ["pagamento confirmado"],
          messageAuthorScope: "team",
        }),
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      ruleMode: "observation",
      pendingNumbers: [expect.objectContaining({ reason: "whatsapp_connection_inactive" })],
    });
  });

  it("ativa um número coberto pela rota da regra", async () => {
    const rule = { ...globalRule("production", []) };
    serverApiFetch.mockResolvedValueOnce({ outcome: "promoted", reason: null, rule });

    const result = await activateRuleNumberAction(form({ ruleId: "rule_global", channelId: "ch_02" }));

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/conversion-rules/providers/rule_global/numbers/ch_02/activate",
      { method: "POST" },
    );
    expect(result).toMatchObject({
      ok: true,
      numberActivation: { outcome: "promoted", reason: null },
      pendingNumbers: [],
    });
    expect(revalidatePath).toHaveBeenCalledWith("/conversions");
  });

  it("conexão WhatsApp não ativa e conexão pausada são resolvidos em Integrações", async () => {
    const rule = globalRule("production", []);
    serverApiFetch.mockResolvedValueOnce({
      outcome: "pending",
      reason: "whatsapp_connection_inactive",
      rule,
    });
    const disconnected = await activateRuleNumberAction(
      form({ ruleId: "rule_global", channelId: "ch_03" }),
    );
    expect(disconnected.ok).toBe(false);
    expect(disconnected.message).toContain("Reative-a em Integrações");

    serverApiFetch.mockResolvedValueOnce({ outcome: "pending", reason: "connection_paused", rule });
    const paused = await activateRuleNumberAction(form({ ruleId: "rule_global", channelId: "ch_01" }));
    expect(paused.message).toContain("retomada em Integrações");
  });

  it("nunca chama a API sem os dois ids", async () => {
    expect(await activateRuleNumberAction(form({ ruleId: "rule_global" }))).toMatchObject({
      ok: false,
    });
    expect(await reprocessBlockedExecutionsAction(form({}))).toMatchObject({ ok: false });
    expect(serverApiFetch).not.toHaveBeenCalled();
  });

  it("reprocessa e resume as contagens", async () => {
    serverApiFetch.mockResolvedValueOnce({
      windowDays: 7,
      reprocessed: 2,
      stillBlocked: 1,
      expired: 3,
      skipped: 0,
      failed: 0,
      remaining: 0,
    });

    const result = await reprocessBlockedExecutionsAction(form({ ruleId: "rule_global" }));

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/conversion-rules/providers/rule_global/reprocess-blocked",
      { method: "POST" },
    );
    expect(result).toMatchObject({ ok: true, reprocess: { reprocessed: 2 } });
    expect(result.message).toBe(
      "2 conversas reenviadas para a fila de envio. 1 fica como está (número ainda sem envio ativo, pausado de propósito na época ou que não é Uazapi/WAHA). 3 são mais antigas que 7 dias e não podem mais ser enviadas à Meta.",
    );
  });

  it("traduz 409 (regra pausada / rodada em andamento) e 429 (intervalo)", async () => {
    serverApiFetch.mockRejectedValueOnce(
      apiError(
        409,
        "Ative o envio automático da regra antes de reprocessar as conversas bloqueadas",
        "provider_rule_reprocess_rule_inactive",
      ),
    );
    expect(
      (await reprocessBlockedExecutionsAction(form({ ruleId: "rule_global" }))).message,
    ).toContain("pausada ou com o envio desligado");

    // The decision comes from the code, not from the wording of the message.
    serverApiFetch.mockRejectedValueOnce(
      apiError(409, "Mensagem qualquer", "provider_rule_reprocess_in_progress"),
    );
    expect(
      (await reprocessBlockedExecutionsAction(form({ ruleId: "rule_global" }))).message,
    ).toContain("em andamento");

    serverApiFetch.mockRejectedValueOnce(apiError(429, "Aguarde"));
    const cooldown = await reprocessBlockedExecutionsAction(form({ ruleId: "rule_global" }));
    expect(cooldown).toMatchObject({ ok: false });
    expect(cooldown.message).toContain("Aguarde alguns segundos");
  });

  it("licença bloqueada (423): as duas escritas avisam e nada muda", async () => {
    serverApiFetch.mockRejectedValueOnce(licenseLocked());
    expect(
      await activateRuleNumberAction(form({ ruleId: "rule_global", channelId: "ch_02" })),
    ).toEqual({ ok: false, licenseLocked: true, message: lockedMessage });

    serverApiFetch.mockRejectedValueOnce(licenseLocked());
    expect(await reprocessBlockedExecutionsAction(form({ ruleId: "rule_global" }))).toEqual({
      ok: false,
      licenseLocked: true,
      message: lockedMessage,
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("Todos os números: números que ainda não enviam (view model)", () => {
  it("descreve cada motivo em português simples e escolhe a ação certa", () => {
    const views = pendingNumberViews(
      [
        pending("ch_02", "channel_not_active"),
        pending("ch_03", "whatsapp_connection_inactive", { activatable: false }),
        pending("ch_01", "meta_route_missing", { provider: "umbler", activatable: false }),
        pending("ch_09", "connection_paused", {
          label: "Número novo",
          connectionStatus: "paused",
          activatable: false,
        }),
      ],
      numbers,
      "production",
    );

    expect(views).toEqual([
      {
        channelId: "ch_02",
        label: "Atendimento",
        detail: "O envio deste número ainda não foi ativado.",
        action: "activate",
      },
      {
        channelId: "ch_03",
        label: "Pós-venda",
        detail:
          "A conexão WhatsApp deste número não está ativa (suspensa ou removida). Reative-a em Integrações.",
        action: "integrations",
      },
      {
        channelId: "ch_01",
        label: "Recepção",
        detail: "Falta uma rota Meta válida para este número. Configure em Integrações.",
        action: "integrations",
      },
      {
        channelId: "ch_09",
        label: "Número novo",
        detail:
          "A conexão deste número foi pausada em Integrações. Retome por lá se quiser voltar a enviar.",
        action: "integrations",
      },
    ]);
    expect(
      pendingNumberViews([pending("ch_02", "channel_not_active")], numbers, "observation")[0]!
        .action,
    ).toBeNull();
    expect(pendingNumbersTitle(1, "production")).toBe(
      "Esta regra ainda não envia eventos em 1 número",
    );
    expect(pendingNumbersTitle(2, "observation")).toBe(
      "Ao ativar o envio, 2 números ainda precisam de atenção",
    );
  });

  it("só regras ativas para todos os números levam pendências para a linha", () => {
    const [row] = buildProviderRuleRows(
      [globalRule("production", [pending("ch_02", "channel_not_active")])],
      numbers,
      connections,
      capabilities,
    );
    expect(row!.pendingNumbers).toHaveLength(1);

    const paused = globalRule("production", [pending("ch_02", "channel_not_active")]);
    const [pausedRow] = buildProviderRuleRows(
      [{ ...paused, conversionRule: { ...paused.conversionRule, active: false } }],
      numbers,
      connections,
      capabilities,
    );
    expect(pausedRow!.pendingNumbers).toEqual([]);
  });
});

function screenProps(
  rule: ReturnType<typeof globalRule>,
  overrides: Partial<ConversionsScreenProps> = {},
): ConversionsScreenProps {
  return {
    rows: buildProviderRuleRows([rule], numbers, connections, capabilities),
    numbers,
    connections,
    offeredOrigins: ["message_phrase"],
    capabilities,
    unifyGroups: [],
    canManage: true,
    rulesState: "real",
    numbersPartial: false,
    crmVisible: true,
    crmError: false,
    createAction: vi.fn(),
    confirmCreateAction: vi.fn(),
    unifyAction: vi.fn(),
    updateRuleAction: vi.fn(async () => ({ ok: true, message: "ok" })),
    loadExecutionsAction: vi.fn(async () => ({ ok: false, message: "x" })),
    providerRules: [rule],
    activateNumberAction: vi.fn(
      async (): Promise<ConversionScreenActionResult> => ({
        ok: true,
        message: "Envio ativado neste número. As próximas conversas dele já vão para a Meta.",
        numberActivation: { outcome: "promoted", reason: null },
      }),
    ),
    ...overrides,
  };
}

describe("Todos os números: aviso na lista de regras", () => {
  it("lista os pendentes, ativa um pelo botão e manda o outro para Integrações", async () => {
    const user = setupUser();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const props = screenProps(
      globalRule("production", [
        pending("ch_02", "channel_not_active"),
        pending("ch_03", "whatsapp_connection_inactive", { activatable: false }),
      ]),
    );
    render(createElement(ConversionsScreen, props));

    const warning = screen.getByRole("region", { name: "Números que ainda não enviam" });
    expect(within(warning).getByText("Esta regra ainda não envia eventos em 2 números")).toBeTruthy();
    expect(within(warning).getByText("Atendimento")).toBeTruthy();
    expect(within(warning).getByText("Pós-venda")).toBeTruthy();
    const integrations = within(warning).getByRole("link", { name: /Resolver em Integrações/ });
    expect(integrations.getAttribute("href")).toBe("/integrations");
    const buttons = within(warning).getAllByRole("button", { name: /Ativar envio neste número/ });
    expect(buttons).toHaveLength(1);

    await user.click(buttons[0]!);

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Ativar o envio de Atendimento"));
    await waitFor(() => expect(props.activateNumberAction).toHaveBeenCalledTimes(1));
    const formData = (props.activateNumberAction as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as FormData;
    expect(formData.get("ruleId")).toBe("rule_global");
    expect(formData.get("channelId")).toBe("ch_02");
    expect(await within(warning).findByText(/Envio ativado neste número/)).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it("não faz nada quando o operador cancela a confirmação", async () => {
    const user = setupUser();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const props = screenProps(globalRule("production", [pending("ch_02", "channel_not_active")]));
    render(createElement(ConversionsScreen, props));

    await user.click(screen.getByRole("button", { name: /Ativar envio neste número/ }));
    expect(props.activateNumberAction).not.toHaveBeenCalled();
  });

  it("esconde as ações de quem só lê e com a licença bloqueada; some quando todos enviam", () => {
    const { unmount } = render(
      createElement(
        ConversionsScreen,
        screenProps(globalRule("production", [pending("ch_02", "channel_not_active")]), {
          canManage: false,
        }),
      ),
    );
    expect(screen.getByText("Esta regra ainda não envia eventos em 1 número")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Ativar envio neste número/ })).toBeNull();
    unmount();

    const locked = render(
      createElement(
        ConversionsScreen,
        screenProps(globalRule("production", [pending("ch_02", "channel_not_active")]), {
          licenseLocked: true,
        }),
      ),
    );
    expect(screen.queryByRole("button", { name: /Ativar envio neste número/ })).toBeNull();
    locked.unmount();

    render(createElement(ConversionsScreen, screenProps(globalRule("production", []))));
    expect(screen.queryByRole("region", { name: "Números que ainda não enviam" })).toBeNull();
  });

  it("numa regra em observação lista só o que ativar a regra não resolve", () => {
    render(
      createElement(
        ConversionsScreen,
        screenProps(
          globalRule("observation", [
            pending("ch_02", "channel_not_active"),
            pending("ch_03", "whatsapp_connection_inactive", { activatable: false }),
          ]),
        ),
      ),
    );

    const warning = screen.getByRole("region", { name: "Números que ainda não enviam" });
    expect(within(warning).getByText("Ao ativar o envio, 1 número ainda precisa de atenção")).toBeTruthy();
    expect(within(warning).queryByText("Atendimento")).toBeNull();
    expect(within(warning).getByText("Pós-venda")).toBeTruthy();
    expect(
      within(warning).getByText(
        "Outro número passa a enviar assim que você ativar o envio automático.",
      ),
    ).toBeTruthy();
    expect(within(warning).queryByRole("button")).toBeNull();
  });

  it("depois de criar a regra (Nova regra), mostra o que vai precisar de atenção", () => {
    render(
      createElement(PendingNumbersWarning, {
        ruleId: "rule_new",
        pendingNumbers: [
          pending("ch_02", "channel_not_active"),
          pending("ch_03", "whatsapp_connection_inactive", { activatable: false }),
        ],
        numbers,
        mode: "observation",
        canManage: true,
      }),
    );
    const warning = screen.getByRole("region", { name: "Números que ainda não enviam" });
    expect(within(warning).getByText("Pós-venda")).toBeTruthy();
    expect(within(warning).getByText(/Reative-a em Integrações/)).toBeTruthy();
  });
});

describe("Últimas execuções: Reprocessar bloqueadas", () => {
  function audit(
    blockedReprocess: ProviderConversionRuleExecutionAuditDto["blockedReprocess"],
  ): ProviderConversionRuleExecutionAuditDto {
    return {
      providerRuleId: "rule_global",
      eventName: "QualifiedLead",
      summary: {
        total: 4,
        observed: 0,
        eligible: 0,
        materialized: 0,
        duplicate: 0,
        blocked: 4,
        failed: 0,
      },
      items: [],
      pagination: { page: 1, pageSize: 25, totalItems: 4, totalPages: 1 },
      blockedReprocess,
    };
  }

  it("reenvia as prontas e mostra as contagens (expiradas nunca são reenviadas)", async () => {
    const user = setupUser();
    const loadAction = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        message: "ok",
        executionAudit: audit({ windowDays: 7, ready: 2, stillBlocked: 1, expired: 1 }),
      })
      .mockResolvedValue({
        ok: true,
        message: "ok",
        executionAudit: audit({ windowDays: 7, ready: 0, stillBlocked: 1, expired: 1 }),
      });
    const reprocessAction = vi.fn(
      async (): Promise<ConversionScreenActionResult> => ({
        ok: true,
        message:
          "2 conversas reenviadas para a fila de envio. 1 fica como está (número ainda sem envio ativo, pausado de propósito na época ou que não é QR). 1 é mais antiga que 7 dias e não pode mais ser enviada à Meta.",
        reprocess: {
          windowDays: 7,
          reprocessed: 2,
          stillBlocked: 1,
          expired: 1,
          skipped: 0,
          failed: 0,
          remaining: 0,
        },
      }),
    );
    render(
      createElement(RuleExecutions, {
        ruleId: "rule_global",
        loadAction,
        canManage: true,
        reprocessAction,
      }),
    );

    const panel = await screen.findByRole("region", { name: "Conversas bloqueadas antes do envio" });
    expect(within(panel).getByText("prontas para reenviar")).toBeTruthy();
    expect(within(panel).getByText(/expirada \(mais de/)).toBeTruthy();
    expect(within(panel).getByText(/limite da Meta/)).toBeTruthy();

    await user.click(within(panel).getByRole("button", { name: "Reprocessar bloqueadas" }));

    await waitFor(() => expect(reprocessAction).toHaveBeenCalledTimes(1));
    expect((reprocessAction.mock.calls[0] as unknown as [FormData])[0].get("ruleId")).toBe(
      "rule_global",
    );
    expect(await screen.findByText(/2 conversas reenviadas para a fila de envio/)).toBeTruthy();
    await waitFor(() => expect(loadAction).toHaveBeenCalledTimes(2));
    const button = await screen.findByRole("button", { name: "Reprocessar bloqueadas" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Nenhuma destas conversas pode ser reenviada agora/)).toBeTruthy();
  });

  it("avisa que a regra está pausada e não oferece botão", async () => {
    render(
      createElement(RuleExecutions, {
        ruleId: "rule_global",
        loadAction: vi.fn(async () => ({
          ok: true,
          message: "ok",
          executionAudit: audit({
            windowDays: 7,
            ready: 0,
            stillBlocked: 3,
            expired: 0,
            ruleSendsNow: false,
          }),
        })),
        canManage: true,
        reprocessAction: vi.fn(),
      }),
    );

    const panel = await screen.findByRole("region", { name: "Conversas bloqueadas antes do envio" });
    expect(within(panel).getByText(/A regra está pausada ou com o envio desligado/)).toBeTruthy();
    expect(within(panel).queryByRole("button")).toBeNull();
  });

  it("some quando nada foi bloqueado e não mostra botão a quem só lê", async () => {
    const { unmount } = render(
      createElement(RuleExecutions, {
        ruleId: "rule_global",
        loadAction: vi.fn(async () => ({
          ok: true,
          message: "ok",
          executionAudit: audit({ windowDays: 7, ready: 0, stillBlocked: 0, expired: 0 }),
        })),
        canManage: true,
        reprocessAction: vi.fn(),
      }),
    );
    await screen.findByText("Esta regra ainda não reconheceu nenhuma conversa.");
    expect(screen.queryByRole("region", { name: "Conversas bloqueadas antes do envio" })).toBeNull();
    unmount();

    render(
      createElement(RuleExecutions, {
        ruleId: "rule_global",
        loadAction: vi.fn(async () => ({
          ok: true,
          message: "ok",
          executionAudit: audit({ windowDays: 7, ready: 1, stillBlocked: 0, expired: 0 }),
        })),
        canManage: false,
        reprocessAction: vi.fn(),
      }),
    );
    await screen.findByRole("region", { name: "Conversas bloqueadas antes do envio" });
    expect(screen.queryByRole("button", { name: "Reprocessar bloqueadas" })).toBeNull();
  });
});
