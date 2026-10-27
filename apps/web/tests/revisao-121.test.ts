// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupUser } from "./user-shim";
import { buildProviderRuleRows } from "../src/app/(app)/conversions/conversion-rules-view";
import {
  ConversionsScreen,
  type ConversionsScreenProps,
} from "../src/app/(app)/conversions/conversions-screen";
import {
  activateRuleCopy,
  conversionSendingOffCopy,
} from "../src/app/(app)/conversions/lead-submitted-override";
import { capabilities, connections, numbers, providerRule } from "./conversions-fixtures";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.body.style.overflow = "";
});

/**
 * Revisão do #121: D1 (a regra "Lead recebido" em observação não é ligada
 * pela atualização; o aluno liga com "Ligar esta regra"), aviso de envio
 * desligado no servidor.
 */

function props(
  overrides: Partial<ConversionsScreenProps> & { eventName?: string } = {},
): ConversionsScreenProps {
  const { eventName = "LeadSubmitted", ...rest } = overrides;
  const rows = buildProviderRuleRows(
    [
      providerRule({
        id: "rule_lead",
        name: "Lead recebido Recepção",
        connectionId: "conn_umbler",
        channelIds: ["ch_01"],
        eventName: eventName as never,
      }),
    ],
    numbers,
    connections,
    capabilities,
  );
  return {
    rows,
    numbers,
    connections,
    offeredOrigins: ["message_phrase"],
    capabilities: { ...capabilities, leadSubmittedRuleOverrideEnabled: true },
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
    ...rest,
  } as ConversionsScreenProps;
}

describe("D1: ligar a regra Lead recebido", () => {
  it("a regra Lead recebido sem envio mostra “Ligar esta regra” e avisa o que muda", async () => {
    const user = setupUser();
    const screenProps = props();
    render(createElement(ConversionsScreen, screenProps));

    await user.click(
      screen.getByRole("button", { name: "Ligar a regra Lead recebido Recepção" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Ligar esta regra" });
    expect(dialog.textContent).toContain(
      "deixa de ir para a Meta na entrada da conversa",
    );
    expect(dialog.textContent).not.toMatch(/observa[cç][aã]o/iu);
    await user.click(within(dialog).getByRole("button", { name: "Ligar esta regra" }));

    await waitFor(() => expect(screenProps.updateRuleAction).toHaveBeenCalledTimes(1));
    const formData = (screenProps.updateRuleAction as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as FormData;
    expect(JSON.parse(String(formData.get("payload")))).toEqual({ mode: "production" });
  });

  it("outras regras continuam com “Ativar envio”", () => {
    expect(
      activateRuleCopy({
        name: "X",
        eventName: "QualifiedLead",
        leadSubmittedOverrideEnabled: true,
      }),
    ).toMatchObject({ label: "Ativar envio", confirmLabel: "Ativar envio" });
    // Sem a troca do Lead recebido ligada na API, nada muda na entrada.
    expect(
      activateRuleCopy({
        name: "X",
        eventName: "LeadSubmitted",
        leadSubmittedOverrideEnabled: false,
      }).label,
    ).toBe("Ativar envio");
  });
});

describe("envio desligado no servidor", () => {
  it("mostra o nome da variável e a ação exata (exceção aprovada)", () => {
    render(
      createElement(
        ConversionsScreen,
        props({
          eventName: "QualifiedLead",
          capabilities: { ...capabilities, conversionSendingOff: true },
        }),
      ),
    );
    const alert = screen
      .getAllByRole("alert")
      .find((node) => node.getAttribute("data-conversion-sending-off"));
    expect(alert?.textContent).toContain(conversionSendingOffCopy.title);
    expect(alert?.textContent).toContain(
      "No Dokploy, no serviço da API, troque INBOUND_CONVERSION_PRODUCTION_ENABLED=false por true (ou apague a linha), confira se INBOUND_CONVERSION_RULES_ENABLED=true e faça o deploy da API.",
    );
  });

  it("não aparece com o envio ligado", () => {
    const { container } = render(
      createElement(ConversionsScreen, props({ eventName: "QualifiedLead" })),
    );
    expect(container.querySelector("[data-conversion-sending-off]")).toBeNull();
  });
});
