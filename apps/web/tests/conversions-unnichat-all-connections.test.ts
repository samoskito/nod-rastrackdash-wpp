// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import type { ProviderConversionRuleCapabilitiesDto } from "@wpptrack/shared";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConversionConnection,
  ConversionNumber,
} from "../src/app/(app)/conversions/conversion-rules-view";
import { buildProviderRuleRows } from "../src/app/(app)/conversions/conversion-rules-view";
import { ScopeStep } from "../src/app/(app)/conversions/new-rule-flow";
import { emptyRuleDraft, type RuleDraft } from "../src/app/(app)/conversions/rule-draft";
import {
  buildRuleUpdatePayload,
  ruleEditDraft,
} from "../src/app/(app)/conversions/rule-edit";
import {
  unifyBannerTitle,
  unifyGroupCountLabel,
  unifyGroupDescription,
  UnifyReviewModal,
} from "../src/app/(app)/conversions/unify-review";
import { capabilitiesWithPayt, providerRule } from "./conversions-fixtures";
import { setupUser } from "./user-shim";

/**
 * Fase 6.1a: porte do SaaS (42ccbc7c, #159), adaptado ao nod (textos "do
 * Unnichat", sem a flag de escopo do workspace, user-shim no lugar do
 * user-event). Caso de um cliente: o Unnichat cria uma conexão por número. A
 * regra "Todos os números do Unnichat (todas as conexões)" vale para todas as
 * conexões; "Números específicos" lista os números de todas as conexões,
 * agrupados, e uma regra específica fica numa conexão só. Dados fictícios.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
});

const capabilities: ProviderConversionRuleCapabilitiesDto = {
  ...capabilitiesWithPayt,
  origins: [
    ...capabilitiesWithPayt.origins,
    {
      origin: "automation_unnichat",
      scopes: ["all_numbers", "specific_numbers"],
      channelProviders: ["unnichat"],
      authorChannelProviders: null,
      connectionBound: true,
      requiresConnection: true,
      labelMatch: null,
      unifiable: false,
    },
  ],
};

const connections: ConversionConnection[] = [
  { id: "conn_5159", provider: "unnichat", displayName: "Loja Exemplo - 5159", status: "production" },
  { id: "conn_5520", provider: "unnichat", displayName: "Loja Exemplo - 5520", status: "production" },
];

function unnichatNumber(
  id: string,
  connection: ConversionConnection,
  phone: string,
): ConversionNumber {
  return {
    id,
    connectionId: connection.id,
    provider: "unnichat",
    connectionName: connection.displayName,
    label: phone,
    phone,
    whatsappInstanceId: null,
    routeIds: [],
    status: "active",
  };
}

const numbers = [
  unnichatNumber("ch_5159", connections[0]!, "+555100005159"),
  unnichatNumber("ch_5520", connections[1]!, "+555100005520"),
];

function renderScope(
  draft: RuleDraft,
  connectionLocked = false,
  initialCrossConnection = true,
) {
  const onChange = vi.fn();
  render(
    createElement(ScopeStep, {
      draft,
      numbers,
      connections,
      capabilities,
      onChange,
      disabled: false,
      connectionLocked,
      initialCrossConnection,
    }),
  );
  return onChange;
}

function unifyGroup(overrides: Record<string, unknown> = {}) {
  return {
    key: "k",
    origin: "automation_unnichat" as const,
    eventName: "Purchase" as const,
    mode: "production" as const,
    name: "Compra",
    triggerPhrases: [],
    ruleIds: ["r1", "r2"],
    channelIds: [],
    newlyCoveredChannelIds: [],
    overriddenChannelIds: [],
    existingGlobalRuleId: null,
    targetRuleId: "r1",
    ...overrides,
  };
}

describe("Unnichat: uma regra para todos os números de todas as conexões", () => {
  it("oferece “Todos os números do Unnichat (todas as conexões)” sem pedir a conexão", () => {
    renderScope(emptyRuleDraft("automation_unnichat"));
    const all = screen.getByRole("radio", {
      name: /Todos os números do Unnichat \(todas as conexões\)/,
    }) as HTMLInputElement;
    expect(all.checked).toBe(true);
    expect(screen.queryByText("Conexão que chama o endereço")).toBeNull();
    expect(
      screen.getByText(/Uma regra serve para todos os números do Unnichat/),
    ).toBeTruthy();
  });

  it("lista os números de TODAS as conexões, agrupados, e mantém uma conexão por regra específica", async () => {
    const user = setupUser();
    const onChange = renderScope({
      ...emptyRuleDraft("automation_unnichat"),
      scope: "specific_numbers",
      channelIds: ["ch_5159"],
    });
    const group5159 = screen.getByRole("group", { name: "Loja Exemplo - 5159" });
    const group5520 = screen.getByRole("group", { name: "Loja Exemplo - 5520" });
    expect(within(group5159).getByRole("checkbox")).toBeTruthy();
    const other = within(group5520).getByRole("checkbox") as HTMLInputElement;
    // Um número de outra conexão não entra nesta regra específica.
    expect(other.disabled).toBe(true);
    expect(
      screen.getByText(/escolha números de uma mesma conexão/),
    ).toBeTruthy();
    await user.click(within(group5159).getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith({ channelIds: [] });
  });

  it("ao editar uma regra específica, mostra só os números da conexão da regra", () => {
    renderScope(
      {
        ...emptyRuleDraft("automation_unnichat"),
        scope: "specific_numbers",
        connectionId: "conn_5520",
        channelIds: ["ch_5520"],
      },
      true,
    );
    expect(screen.queryByRole("group", { name: "Loja Exemplo - 5159" })).toBeNull();
    expect(screen.getByRole("group", { name: "Loja Exemplo - 5520" })).toBeTruthy();
  });

  it("explica o Unificar das automações: as URLs antigas continuam funcionando", () => {
    const group = {
      origin: "automation_unnichat" as const,
      ruleIds: ["a", "b", "c"],
      name: "Lead Qualificado",
      existingGlobalRuleId: null,
    };
    expect(unifyGroupCountLabel(group)).toBe("3 regras por conexão");
    expect(unifyGroupDescription(group)).toMatch(
      /todos os números do Unnichat, de todas as conexões\. As URLs antigas continuam funcionando/,
    );
    expect(unifyGroupDescription(group)).toMatch(/nada no Unnichat agora/);
    expect(
      unifyGroupCountLabel({ origin: "message_phrase", ruleIds: ["a", "b"] }),
    ).toBe("2 cópias");
  });
});

describe("alcance explícito, diferenças no Unificar e textos", () => {
  it("ao editar uma regra antiga oferece “Todos os números de <conexão>” (marcada) e “Ampliar para todas as conexões”", async () => {
    const user = setupUser();
    const onChange = renderScope(
      {
        ...emptyRuleDraft("automation_unnichat"),
        scope: "all_numbers",
        crossConnection: false,
        connectionId: "conn_5159",
      },
      true,
      false,
    );
    const own = screen.getByRole("radio", {
      name: /Todos os números de Loja Exemplo - 5159/,
    }) as HTMLInputElement;
    expect(own.checked).toBe(true);
    const widen = screen.getByRole("radio", {
      name: /Todos os números do Unnichat \(todas as conexões\)/,
    }) as HTMLInputElement;
    expect(widen.checked).toBe(false);
    expect(screen.getByText("Ampliar para todas as conexões.")).toBeTruthy();
    // A opção específica não fala da conexão enquanto não for escolhida.
    expect(screen.queryByText(/a conexão desta regra/)).toBeNull();
    await user.click(widen);
    expect(onChange).toHaveBeenCalledWith({
      scope: "all_numbers",
      crossConnection: true,
      channelIds: [],
    });
  });

  it("manda só crossConnectionScope quando a pessoa amplia uma regra antiga", () => {
    const rule = {
      ...providerRule({
        id: "legacy",
        triggerType: "provider_automation",
        origin: "automation_unnichat",
        eventName: "QualifiedLead",
        connectionId: "conn_5159",
        scope: "all_numbers",
        phrases: [],
      }),
      crossConnectionScope: false,
    };
    const draft = {
      ...ruleEditDraft(rule, "automation_unnichat"),
      crossConnection: true,
    };
    expect(
      buildRuleUpdatePayload(rule, draft, { numbers, connections, capabilities }),
    ).toEqual({ ok: true, value: { crossConnectionScope: true } });
  });

  it("dá ao banner do Unificar um título por conexões nas automações", () => {
    expect(unifyBannerTitle([{ origin: "automation_unnichat" }])).toBe(
      "Há regras iguais em várias conexões do Unnichat",
    );
    expect(unifyBannerTitle([{ origin: "message_phrase" }])).toBe(
      "Há uma regra repetida em vários números",
    );
  });

  it("avisa duas regras do mesmo evento nos mesmos números", () => {
    const base = {
      triggerType: "provider_automation" as const,
      origin: "automation_unnichat" as const,
      eventName: "QualifiedLead" as const,
      scope: "all_numbers" as const,
      effective: ["ch_5159"],
      phrases: [],
    };
    const rows = buildProviderRuleRows(
      [
        {
          ...providerRule({ ...base, id: "a", connectionId: "conn_5159" }),
          crossConnectionScope: true,
        },
        providerRule({ ...base, id: "b", connectionId: "conn_5159" }),
      ],
      numbers,
      connections,
      capabilities,
    );
    for (const row of rows)
      expect(
        row.notes.some((note) =>
          note.startsWith("Duas regras para o mesmo evento em +555100005159"),
        ),
      ).toBe(true);
  });

  it("mostra valor e modo de cada regra, quais valem, e pede confirmação antes de unificar", async () => {
    const user = setupUser();
    const unifyAction = vi.fn(async (_formData: FormData) => ({
      ok: true,
      message: "ok",
    }));
    render(
      createElement(UnifyReviewModal, {
        group: unifyGroup({
          differences: ["mode", "value"],
          members: [
            { ruleId: "r1", name: "Compra 5159", connectionId: "conn_5159", scope: "specific_numbers", crossConnectionScope: false, mode: "production", defaultValueCents: 10000, defaultCurrency: "BRL", defaultContentName: null, numberRemoved: false },
            { ruleId: "r2", name: "Compra 5520", connectionId: "conn_5520", scope: "specific_numbers", crossConnectionScope: false, mode: "observation", defaultValueCents: 25000, defaultCurrency: "BRL", defaultContentName: null, numberRemoved: false },
          ],
        }),
        numbers,
        unifyAction,
        onClose: () => undefined,
        onDone: () => undefined,
      }),
    );
    expect(
      screen.getByText(
        /As regras têm modo \(observação\/envio automático\) e valor diferentes/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/Vão valer os de “Compra 5159”: envio automático, R\$\s?100,00/),
    ).toBeTruthy();
    const unify = screen.getByRole("button", { name: "Unificar" }) as HTMLButtonElement;
    expect(unify.disabled).toBe(true);
    await user.click(
      screen.getByRole("checkbox", { name: "Entendi quais valores vão valer" }),
    );
    expect(unify.disabled).toBe(false);
    await user.click(unify);
    const formData = unifyAction.mock.calls[0]![0] as FormData;
    expect(formData.get("acknowledgeDifferences")).toBe("true");
    expect(formData.getAll("ruleId")).toEqual(["r1", "r2"]);
  });
});

describe("duplicatas antigas, rótulo da URL e confirmação inline", () => {
  it("avisa duas regras específicas antigas do mesmo evento num número, numa linha própria", () => {
    const base = {
      triggerType: "provider_automation" as const,
      origin: "automation_unnichat" as const,
      eventName: "QualifiedLead" as const,
      connectionId: "conn_5159",
      channelIds: ["ch_5159"],
      phrases: [],
    };
    const rows = buildProviderRuleRows(
      [providerRule({ ...base, id: "a" }), providerRule({ ...base, id: "b" })],
      numbers,
      connections,
      capabilities,
    );
    for (const row of rows)
      expect(row.notes).toContain(
        "Duas regras para o mesmo evento em +555100005159 — unifique as regras para ficar só uma.",
      );
  });

  it("nomeia a URL do evento numa regra para todas as conexões", () => {
    const [row] = buildProviderRuleRows(
      [
        {
          ...providerRule({
            id: "cross",
            triggerType: "provider_automation",
            origin: "automation_unnichat",
            eventName: "QualifiedLead",
            connectionId: "conn_5159",
            scope: "all_numbers",
            effective: ["ch_5159"],
            phrases: [],
          }),
          crossConnectionScope: true,
        },
      ],
      numbers,
      connections,
      capabilities,
    );
    expect(row!.triggerDetail).toBe("URL do evento (todas as conexões)");
    expect(row!.scopeLabel).toBe("Todos os números do Unnichat (todas as conexões)");
  });

  it("mostra a confirmação do Unificar como a linha de checkbox do design system", () => {
    render(
      createElement(UnifyReviewModal, {
        group: unifyGroup({
          differences: ["value"],
          members: [
            { ruleId: "r1", name: "Compra 5159", connectionId: "c1", scope: "specific_numbers", crossConnectionScope: false, mode: "production", defaultValueCents: 100, defaultCurrency: "BRL", defaultContentName: null, numberRemoved: false },
            { ruleId: "r2", name: "Compra antiga", connectionId: "c2", scope: "specific_numbers", crossConnectionScope: false, mode: "production", defaultValueCents: 200, defaultCurrency: "BRL", defaultContentName: null, numberRemoved: true },
          ],
        }),
        numbers,
        unifyAction: vi.fn(),
        onClose: () => undefined,
        onDone: () => undefined,
      }),
    );
    const checkbox = screen.getByRole("checkbox", {
      name: "Entendi quais valores vão valer",
    });
    expect(checkbox.closest("label")!.className).toContain("conversion-check");
    expect(screen.getByText("vale para todos").className).toContain("status-chip");
    expect(screen.getByText("número removido").className).toContain(
      "status-chip warn",
    );
  });
});

describe("Número removido", () => {
  it("mostra a regra cujo número foi removido como “Número removido”, nunca como enviando", () => {
    const rows = buildProviderRuleRows(
      [
        {
          ...providerRule({
            id: "removed",
            name: "Lead Qualificado",
            triggerType: "provider_automation",
            origin: "automation_unnichat",
            connectionId: "conn_gone",
            channelIds: ["ch_gone"],
            mode: "production",
            phrases: [],
          }),
          numberRemoved: true,
        },
        // API antiga sem o campo: todos os números escolhidos sumiram.
        providerRule({
          id: "legacy",
          origin: "message_phrase",
          channelIds: ["ch_gone"],
          mode: "production",
        }),
        // Uma regra viva continua igual.
        {
          ...providerRule({
            id: "live",
            triggerType: "provider_automation",
            origin: "automation_unnichat",
            connectionId: "conn_5159",
            channelIds: ["ch_5159"],
            mode: "production",
            phrases: [],
          }),
          numberRemoved: false,
        },
      ],
      numbers,
      connections,
      capabilities,
    );
    expect(rows[0]).toMatchObject({
      status: "number_removed",
      statusLabel: "Número removido",
    });
    // Um destaque (callout), não uma nota apagada.
    expect(rows[0]!.warning).toEqual({
      title: "Número removido",
      body: "Esta regra não recebe mais eventos. Pause, exclua ou unifique.",
    });
    expect(rows[2]!.warning).toBeNull();
    expect(rows[1]).toMatchObject({ status: "number_removed" });
    expect(rows[2]).toMatchObject({
      status: "production",
      statusLabel: "Envio automático",
    });
  });
});

// Fase 6.1b — porte do #165 do SaaS (478f0f9a).
describe("numbers that could not be loaded (GET /channels failed)", () => {
  function renderUnavailable(connectionLocked: boolean) {
    render(
      createElement(ScopeStep, {
        draft: {
          ...emptyRuleDraft("automation_umbler"),
          scope: "specific_numbers",
          connectionId: "conn_umbler",
        },
        numbers: [],
        connections: [
          { id: "conn_umbler", provider: "umbler", displayName: "Umbler", status: "production" },
        ],
        capabilities: null,
        onChange: vi.fn(),
        disabled: false,
        connectionLocked,
        numbersUnavailable: true,
      } as never),
    );
  }

  it("says the numbers could not be loaded instead of “no number”", () => {
    renderUnavailable(false);
    expect(screen.getByText(/Não deu para carregar os números de alguma conexão/)).toBeTruthy();
    expect(screen.queryByText("Nenhum número conectado funciona com esta origem.")).toBeNull();
  });

  it("never tells an edited rule that its number was removed", () => {
    renderUnavailable(true);
    expect(screen.getByText(/Não deu para carregar os números de alguma conexão/)).toBeTruthy();
    expect(screen.queryByText(/O número da conexão desta regra foi removido/)).toBeNull();
  });
});
