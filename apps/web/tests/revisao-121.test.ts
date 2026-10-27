// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MetaLeadFormConnectionDto } from "@wpptrack/shared";
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
vi.mock("../src/app/(app)/integrations/meta-lead-form-actions", () => ({
  createMetaLeadFormConnectionAction: vi.fn(),
  deleteMetaLeadFormConnectionAction: vi.fn(),
  setMetaLeadFormConnectionActiveAction: vi.fn(),
  subscribeMetaLeadFormPageAction: vi.fn(),
  updateMetaLeadFormConnectionAction: vi.fn(),
}));

import { MetaLeadFormsPanel } from "../src/app/(app)/integrations/meta-lead-forms-panel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.body.style.overflow = "";
});

/**
 * Revisão do #121: D1 (a regra "Lead recebido" em observação não é ligada
 * pela atualização; o aluno liga com "Ligar esta regra"), aviso de envio
 * desligado no servidor e aviso de reconexão nos Formulários Meta.
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
  it("avisa em linguagem simples, sem nome de variável", () => {
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
    expect(alert?.textContent).not.toContain("INBOUND_");
  });

  it("não aparece com o envio ligado", () => {
    const { container } = render(
      createElement(ConversionsScreen, props({ eventName: "QualifiedLead" })),
    );
    expect(container.querySelector("[data-conversion-sending-off]")).toBeNull();
  });
});

describe("Formulários Meta: aviso quando a leitura do lead falha de vez", () => {
  const connection: MetaLeadFormConnectionDto = {
    id: "conexao_1",
    label: "Página Exemplo",
    pageId: "100000000000001",
    formIds: [],
    crmDatasetId: null,
    qualifiedEventName: "LeadQualificado",
    graphTokenLast4: "abcd",
    capiTokenLast4: null,
    active: true,
    pageSubscribedAt: "2026-10-20T12:00:00.000Z",
    webhookUrl: "https://api.exemplo.test/webhooks/meta",
    submissionCount: 3,
    lastSubmissionAt: "2026-10-26T12:00:00.000Z",
    createdAt: "2026-10-20T12:00:00.000Z",
    updatedAt: "2026-10-26T12:00:00.000Z",
  };
  const html = (fetchProblem: MetaLeadFormConnectionDto["fetchProblem"]) =>
    renderToStaticMarkup(
      createElement(MetaLeadFormsPanel, {
        connections: [{ ...connection, fetchProblem }],
        canManage: true,
        licenseLocked: false,
        loadFailed: false,
      }),
    );

  it("token recusado: “Reconecte a Página”", () => {
    expect(html("reconnect")).toContain("Reconecte a Página");
  });

  it("falta de permissão: “Falta permissão”", () => {
    expect(html("permission")).toContain("Falta permissão");
  });

  it("sem problema, sem aviso", () => {
    expect(html(null)).not.toContain("data-lead-form-fetch-problem");
  });
});
