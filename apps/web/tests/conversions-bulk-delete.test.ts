// @vitest-environment jsdom

import type { ProviderConversionRuleDto } from "@wpptrack/shared";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { setupUser } from "./user-shim";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bulkDeleteItems,
  cleanupCandidateIds,
  oldUrlWarningText,
} from "../src/app/(app)/conversions/bulk-delete";
import {
  buildProviderRuleRows,
  emptyRuleFilters,
  filterRuleRows,
} from "../src/app/(app)/conversions/conversion-rules-view";
import {
  ConversionsScreen,
  type ConversionsScreenProps,
} from "../src/app/(app)/conversions/conversions-screen";
import {
  connections as baseConnections,
  numbers as baseNumbers,
  providerRule,
} from "./conversions-fixtures";

/**
 * Fase 6.1a: porte do SaaS (0f6e010d, #161). O mundo de teste do nod não tem
 * número Unnichat: este teste acrescenta um (dados fictícios).
 */
const connections = [
  ...baseConnections,
  { id: "conn_unnichat", provider: "unnichat" as const, displayName: "Loja online", status: "production" as const },
];
const numbers = [
  ...baseNumbers,
  {
    ...baseNumbers[0]!,
    id: "ch_04",
    connectionId: "conn_unnichat",
    provider: "unnichat",
    connectionName: "Loja online",
    label: "Loja online",
    phone: "+5511987650004",
    routeIds: [],
  },
];

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.body.style.overflow = "";
});

const day = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * day).toISOString();

function endpointFor(ruleId: string, lastDeliveryAt: string | null) {
  return {
    id: `endpoint_${ruleId}`,
    workspaceId: "workspace_1",
    providerRuleId: ruleId,
    secretVersion: 1,
    lastDeliveryAt,
    lastSuccessfulParseAt: lastDeliveryAt,
    rotatedAt: null,
    removedAt: null,
    publicUrlDisabledAt: null,
    createdAt: daysAgo(60),
    updatedAt: daysAgo(60),
  };
}

function automation(
  id: string,
  name: string,
  extra: Partial<ProviderConversionRuleDto> & {
    unifiedIntoRuleId?: string | null;
    active?: boolean;
    scope?: "all_numbers" | "specific_numbers";
    lastDeliveryAt?: string | null;
  } = {},
): ProviderConversionRuleDto {
  const { lastDeliveryAt = null, active, scope, unifiedIntoRuleId, ...rest } = extra;
  return {
    ...providerRule({
      id,
      name,
      origin: "automation_unnichat",
      triggerType: "provider_automation",
      eventName: "QualifiedLead",
      connectionId: "conn_unnichat",
      scope: scope ?? "specific_numbers",
      channelIds: scope === "all_numbers" ? [] : ["ch_04"],
      effective: scope === "all_numbers" ? ["ch_04"] : [],
      active: active ?? true,
      unifiedIntoRuleId: unifiedIntoRuleId ?? null,
    }),
    endpoint: endpointFor(id, lastDeliveryAt),
    ...rest,
  };
}

const targetRule = automation("rule_target", "Lead qualificado (todos)", {
  scope: "all_numbers",
  crossConnectionScope: true,
});
const recentRule = automation("rule_recent", "Lead qualificado - Loja 1", {
  active: false,
  unifiedIntoRuleId: "rule_target",
  lastDeliveryAt: daysAgo(2),
});
const staleRule = automation("rule_stale", "Lead qualificado - Loja 2", {
  active: false,
  unifiedIntoRuleId: "rule_target",
  lastDeliveryAt: daysAgo(40),
});
const neverRule = automation("rule_never", "Lead qualificado - Loja 3", {
  active: false,
  unifiedIntoRuleId: "rule_target",
  lastDeliveryAt: null,
});
const orphanRule = automation("rule_orphan", "Lead qualificado - Loja removida", {
  active: false,
  unifiedIntoRuleId: "rule_target",
  numberRemoved: true,
  lastDeliveryAt: daysAgo(1),
});
const plainRule = providerRule({
  id: "rule_plain",
  name: "Orçamento enviado",
  origin: "message_phrase",
  channelIds: ["ch_01"],
});
const allRules = [targetRule, recentRule, staleRule, neverRule, orphanRule, plainRule];

function ok(message = "ok") {
  return vi.fn(async (_formData: FormData) => ({ ok: true, message }));
}

function screenProps(
  overrides: Partial<ConversionsScreenProps> = {},
): ConversionsScreenProps {
  const providerRules = overrides.providerRules ?? allRules;
  return {
    rows: buildProviderRuleRows(providerRules, numbers, connections),
    numbers,
    connections,
    offeredOrigins: ["message_phrase"],
    capabilities: null,
    confirmCreateAction: vi.fn(),
    unifyGroups: [],
    canManage: true,
    rulesState: "real",
    numbersPartial: false,
    crmVisible: true,
    crmError: false,
    createAction: vi.fn(),
    unifyAction: vi.fn(),
    bulkRemoveAction: ok("2 regras excluídas. O histórico continua salvo."),
    updateRuleAction: ok(),
    loadExecutionsAction: vi.fn(async () => ({ ok: false, message: "x" })),
    providerRules,
    legacyRules: [],
    legacyRulesState: "real",
    ...overrides,
  };
}

function rowsFor(providerRules = allRules) {
  return buildProviderRuleRows(providerRules, numbers, connections);
}

describe("bulk delete: view model", () => {
  it("marks the unify target, the unified rules, the orphan and the old URL date", () => {
    const rows = rowsFor();
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get("rule_target")!.isUnifyTarget).toBe(true);
    expect(byId.get("rule_recent")).toMatchObject({
      status: "unified",
      unifiedIntoRuleId: "rule_target",
      isUnifyTarget: false,
      numberRemoved: false,
      providerName: "Unnichat",
    });
    expect(byId.get("rule_recent")!.oldUrlLastDeliveryAt).toBe(
      recentRule.endpoint!.lastDeliveryAt,
    );
    expect(byId.get("rule_orphan")!.numberRemoved).toBe(true);
  });

  it("classifies the old URL: recent warns, old/never does not, orphan never does", () => {
    const rows = rowsFor();
    const items = new Map(
      bulkDeleteItems(rows).map((item) => [item.row.id, item]),
    );
    expect(items.get("rule_recent")).toMatchObject({ kind: "unified", stillReceiving: true });
    expect(items.get("rule_stale")).toMatchObject({ kind: "unified", stillReceiving: false });
    expect(items.get("rule_never")).toMatchObject({
      kind: "unified",
      stillReceiving: false,
      lastOldUrlEventAt: null,
    });
    expect(items.get("rule_orphan")).toMatchObject({
      kind: "orphan",
      stillReceiving: false,
      lastOldUrlEventAt: null,
    });
    expect(items.get("rule_target")!.kind).toBe("target");
    expect(items.get("rule_plain")!.kind).toBe("plain");
  });

  it("the cleanup shortcut selects unified and orphan rules but never the target", () => {
    expect(cleanupCandidateIds(rowsFor()).sort()).toEqual(
      ["rule_never", "rule_orphan", "rule_recent", "rule_stale"].sort(),
    );
  });

  it("hides unified rules only when asked", () => {
    const rows = rowsFor();
    expect(filterRuleRows(rows, emptyRuleFilters)).toHaveLength(6);
    expect(
      filterRuleRows(rows, { ...emptyRuleFilters, hideUnified: true }).map(
        (row) => row.id,
      ),
    ).toEqual(["rule_target", "rule_plain"]);
  });
});

describe("bulk delete: Conversions list", () => {
  it("shows a checkbox per rule and no toolbar until something is selected", async () => {
    render(createElement(ConversionsScreen, screenProps()));

    expect(screen.getAllByRole("checkbox", { name: /^Selecionar / })).toHaveLength(6);
    expect(screen.queryByRole("button", { name: /Excluir selecionadas/ })).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Selecionar unificadas e de número removido (4)",
      }),
    ).toBeTruthy();
  });

  it("has no checkboxes for people who cannot manage or without the action", () => {
    const { unmount } = render(
      createElement(ConversionsScreen, screenProps({ canManage: false })),
    );
    expect(screen.queryAllByRole("checkbox", { name: /^Selecionar / })).toHaveLength(0);
    unmount();
    render(
      createElement(ConversionsScreen, screenProps({ bulkRemoveAction: undefined })),
    );
    expect(screen.queryAllByRole("checkbox", { name: /^Selecionar / })).toHaveLength(0);
  });

  it("the shortcut selects unified/orphan rules, not the target, and counts them", async () => {
    const user = setupUser();
    render(createElement(ConversionsScreen, screenProps()));

    await user.click(
      screen.getByRole("button", { name: "Selecionar unificadas e de número removido (4)" }),
    );

    expect(
      (screen.getByRole("checkbox", { name: "Selecionar Lead qualificado (todos)" }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(
      (screen.getByRole("checkbox", { name: "Selecionar Lead qualificado - Loja 1" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Excluir selecionadas (4)" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Limpar seleção" }));
    expect(screen.queryByRole("button", { name: /Excluir selecionadas/ })).toBeNull();
  });

  it("lists the rules in the confirmation, warns about the recent old URL and not about the orphan", async () => {
    const user = setupUser();
    render(createElement(ConversionsScreen, screenProps()));
    for (const name of [
      "Lead qualificado - Loja 1",
      "Lead qualificado - Loja 2",
      "Lead qualificado - Loja 3",
      "Lead qualificado - Loja removida",
    ]) {
      await user.click(screen.getByRole("checkbox", { name: `Selecionar ${name}` }));
    }
    await user.click(screen.getByRole("button", { name: "Excluir selecionadas (4)" }));

    const dialog = screen.getByRole("dialog", { name: "Excluir 4 regras?" });
    const items = within(dialog).getAllByRole("listitem");
    expect(items).toHaveLength(4);

    const recent = items.find((item) => within(item).queryByText("Lead qualificado - Loja 1"))!;
    expect(within(recent).getByText(/Último evento pela URL antiga:/)).toBeTruthy();
    expect(within(recent).getByRole("alert").textContent).toBe(oldUrlWarningText("Unnichat"));
    expect(oldUrlWarningText("Unnichat")).toContain("troque a URL no Unnichat antes de excluir");

    const stale = items.find((item) => within(item).queryByText("Lead qualificado - Loja 2"))!;
    expect(within(stale).getByText(/Último evento pela URL antiga:/)).toBeTruthy();
    expect(within(stale).queryByRole("alert")).toBeNull();

    const never = items.find((item) => within(item).queryByText("Lead qualificado - Loja 3"))!;
    expect(within(never).getByText(/URL antiga: nenhum/)).toBeTruthy();
    expect(within(never).queryByRole("alert")).toBeNull();

    const orphan = items.find((item) => within(item).queryByText("Lead qualificado - Loja removida"))!;
    expect(within(orphan).queryByText(/URL antiga/)).toBeNull();
    expect(within(orphan).queryByRole("alert")).toBeNull();
    expect(within(orphan).getByText(/número removido/)).toBeTruthy();
  });

  it("sends the selected ids and reports success", async () => {
    const user = setupUser();
    const props = screenProps();
    render(createElement(ConversionsScreen, props));
    await user.click(screen.getByRole("checkbox", { name: "Selecionar Lead qualificado - Loja 2" }));
    await user.click(
      screen.getByRole("checkbox", { name: "Selecionar Lead qualificado - Loja removida" }),
    );
    await user.click(screen.getByRole("button", { name: "Excluir selecionadas (2)" }));
    const dialog = screen.getByRole("dialog", { name: "Excluir 2 regras?" });
    expect(props.bulkRemoveAction).not.toHaveBeenCalled();

    // Both removed -> the API answers with the per-rule report.
    (props.bulkRemoveAction as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      message: "2 regras excluídas. O histórico continua salvo.",
      bulkRemove: {
        removedCount: 2,
        results: [
          { ruleId: "rule_stale", status: "removed", message: null },
          { ruleId: "rule_orphan", status: "removed", message: null },
        ],
      },
    });
    await user.click(within(dialog).getByRole("button", { name: "Excluir 2 regras" }));

    await waitFor(() => expect(props.bulkRemoveAction).toHaveBeenCalledTimes(1));
    const form = (props.bulkRemoveAction as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as FormData;
    expect(form.getAll("ruleId").sort()).toEqual(["rule_orphan", "rule_stale"]);
    expect(form.getAll("confirmTargetId")).toEqual([]);
    expect(await screen.findByText("2 regras excluídas. O histórico continua salvo.")).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Excluir 2 regras?" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Excluir selecionadas/ })).toBeNull();
  });

  it("reports a partial success and keeps the failed rule selected", async () => {
    const user = setupUser();
    const props = screenProps({
      bulkRemoveAction: vi.fn(async (_formData: FormData) => ({
        ok: false,
        message: "1 de 2 excluídas. Veja abaixo o que ficou.",
        bulkRemove: {
          removedCount: 1,
          results: [
            { ruleId: "rule_stale", status: "removed" as const, message: null },
            {
              ruleId: "rule_orphan",
              status: "failed" as const,
              message: "Não foi possível excluir esta regra.",
            },
          ],
        },
      })),
    });
    render(createElement(ConversionsScreen, props));
    await user.click(screen.getByRole("checkbox", { name: "Selecionar Lead qualificado - Loja 2" }));
    await user.click(
      screen.getByRole("checkbox", { name: "Selecionar Lead qualificado - Loja removida" }),
    );
    await user.click(screen.getByRole("button", { name: "Excluir selecionadas (2)" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Excluir 2 regras" }),
    );

    const dialog = await screen.findByRole("dialog", { name: "Excluir 2 regras?" });
    expect(
      await within(dialog).findByText("Algumas regras não foram excluídas. As outras já saíram da lista."),
    ).toBeTruthy();
    expect(within(dialog).getByText("Lead qualificado - Loja removida")).toBeTruthy();
    expect(within(dialog).getByText("Não foi possível excluir esta regra.")).toBeTruthy();
    expect(within(dialog).queryByText("Lead qualificado - Loja 2")).toBeNull();
    expect(refresh).toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Concluir" }));
    // Only the rule that failed is still selected.
    expect(screen.getByRole("button", { name: "Excluir selecionadas (1)" })).toBeTruthy();
  });

  it("shows a visible error when the request itself fails", async () => {
    const user = setupUser();
    const props = screenProps({
      bulkRemoveAction: vi.fn(async (_formData: FormData) => ({
        ok: false,
        message: "Não foi possível excluir as regras selecionadas.",
      })),
    });
    render(createElement(ConversionsScreen, props));
    await user.click(screen.getByRole("checkbox", { name: "Selecionar Orçamento enviado" }));
    await user.click(screen.getByRole("button", { name: "Excluir selecionadas (1)" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Excluir 1 regra" }),
    );

    expect(
      await screen.findByText("Não foi possível excluir as regras selecionadas."),
    ).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Excluir 1 regra?" })).toBeTruthy();
  });

  it("never deletes the rule for all numbers without its own explicit confirmation", async () => {
    const user = setupUser();
    const props = screenProps();
    render(createElement(ConversionsScreen, props));
    await user.click(screen.getByRole("checkbox", { name: "Selecionar Lead qualificado (todos)" }));
    await user.click(screen.getByRole("button", { name: "Excluir selecionadas (1)" }));

    const dialog = screen.getByRole("dialog", { name: "Excluir 1 regra?" });
    expect(within(dialog).getByText("Esta é a regra que vale para todos os números")).toBeTruthy();
    const submit = within(dialog).getByRole("button", { name: "Excluir 1 regra" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    await user.click(
      within(dialog).getByRole("checkbox", { name: /Quero excluir também/ }),
    );
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    await user.click(submit);

    await waitFor(() => expect(props.bulkRemoveAction).toHaveBeenCalledTimes(1));
    const form = (props.bulkRemoveAction as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as FormData;
    expect(form.getAll("ruleId")).toEqual(["rule_target"]);
    expect(form.getAll("confirmTargetId")).toEqual(["rule_target"]);
  });

  it("has an 'Ocultar regras unificadas' toggle, off by default", async () => {
    const user = setupUser();
    render(createElement(ConversionsScreen, screenProps()));
    const toggle = screen.getByRole("checkbox", { name: "Ocultar regras unificadas" });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(screen.getAllByRole("checkbox", { name: /^Selecionar / })).toHaveLength(6);

    await user.click(toggle);
    expect(screen.getAllByRole("checkbox", { name: /^Selecionar / })).toHaveLength(2);
    expect(screen.queryByRole("checkbox", { name: "Selecionar Lead qualificado - Loja 1" })).toBeNull();
    // Rules left on screen only: hidden ones are not offered by the shortcut.
    expect(screen.queryByRole("button", { name: /Selecionar unificadas/ })).toBeNull();
  });

  it("explains the old URL stops working when deleting a unified rule from Gerenciar", async () => {
    const user = setupUser();
    render(
      createElement(
        ConversionsScreen,
        screenProps({
          ruleActions: {
            remove: ok("Regra removida."),
            rotateEndpoint: vi.fn(),
            loadReceivedEvents: vi.fn(),
            loadReceivedPayload: vi.fn(),
            reprocessReceivedEvents: vi.fn(),
            testCatalogMessage: vi.fn(),
          },
        }),
      ),
    );
    await user.click(
      screen.getByRole("button", { name: "Gerenciar Lead qualificado - Loja 1" }),
    );
    await user.click(screen.getByRole("button", { name: "Excluir regra" }));
    expect(
      screen.getByText(/Esta regra foi unificada: a URL antiga dela encaminha os eventos/),
    ).toBeTruthy();
  });
});
