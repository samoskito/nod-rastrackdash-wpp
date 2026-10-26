// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProviderRuleRows } from "../src/app/(app)/conversions/conversion-rules-view";
import {
  ConversionsScreen,
  type ConversionsScreenProps,
} from "../src/app/(app)/conversions/conversions-screen";
import {
  leadSubmittedOverrideCopy,
  leadsAwaitingRuleLabel,
  replacesEntryLeadSubmitted,
} from "../src/app/(app)/conversions/lead-submitted-override";
import { NewRuleFlow } from "../src/app/(app)/conversions/new-rule-flow";
import { RuleExecutions } from "../src/app/(app)/conversions/rule-executions";
import { auditReasonLabel } from "../src/app/(app)/events/event-audit-details";
import {
  overviewLeadsCopy,
  overviewLeadsHints,
} from "../src/app/(app)/overview/overview-leads-block";
import { executionReasonLabel } from "../src/app/(app)/settings/provider-conversion-labels";
import { capabilities, connections, numbers, providerRule } from "./conversions-fixtures";
import { setupUser } from "./user-shim";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.body.style.overflow = "";
});

/**
 * Porte do SaaS #155 ("Lead recebido pela regra"): aviso no formulário, selo
 * na lista e textos do painel. No nod a variável vem ligada por padrão
 * (produção direta) e a API informa isso em capabilities; com "false"
 * explícito (capabilities sem a flag) a tela fica como antes.
 */

const capabilitiesOn = { ...capabilities, leadSubmittedRuleOverrideEnabled: true };
const capabilitiesOff = { ...capabilities, leadSubmittedRuleOverrideEnabled: false };

const leadRule = providerRule({
  id: "rule_lead",
  name: "Lead pela frase",
  origin: "message_phrase",
  eventName: "LeadSubmitted",
  mode: "production",
  channelIds: ["ch_01"],
});
const pausedLeadRule = providerRule({
  id: "rule_lead_paused",
  name: "Lead pausado",
  origin: "message_phrase",
  eventName: "LeadSubmitted",
  mode: "production",
  active: false,
  channelIds: ["ch_01"],
});
const qualifiedRule = providerRule({
  id: "rule_qualified",
  name: "Qualificado",
  origin: "message_phrase",
  eventName: "QualifiedLead",
  mode: "production",
  channelIds: ["ch_01"],
});

const ok = vi.fn(async () => ({ ok: true, message: "ok" }));

function screenProps(
  caps: ConversionsScreenProps["capabilities"],
): ConversionsScreenProps {
  const providerRules = [leadRule, pausedLeadRule, qualifiedRule];
  return {
    rows: buildProviderRuleRows(providerRules, numbers, connections, caps),
    numbers,
    connections,
    offeredOrigins: ["message_phrase"],
    capabilities: caps,
    unifyGroups: [],
    canManage: true,
    rulesState: "real",
    numbersPartial: false,
    crmVisible: true,
    crmError: false,
    createAction: vi.fn(),
    confirmCreateAction: vi.fn(),
    unifyAction: vi.fn(),
    updateRuleAction: ok as never,
    loadExecutionsAction: vi.fn(async () => ({ ok: false, message: "x" })),
    providerRules,
    legacyRules: [],
    legacyRulesState: "real",
    ruleActions: {
      remove: ok as never,
      rotateEndpoint: ok as never,
      loadReceivedEvents: ok as never,
      loadReceivedPayload: ok as never,
      reprocessReceived: ok as never,
      testCatalog: ok as never,
    } as never,
  } as ConversionsScreenProps;
}

function renderFlow(caps: typeof capabilities) {
  return render(
    createElement(NewRuleFlow, {
      offeredOrigins: ["message_phrase"],
      numbers,
      connections,
      capabilities: caps,
      comingSoonNumbers: [],
      licenseLocked: false,
      createAction: vi.fn(),
      confirmAction: vi.fn(),
      onFinished: () => undefined,
    } as never),
  );
}

describe("selo 'Substitui envio na entrada' na lista de regras", () => {
  it("aparece só na regra Lead recebido ativa e enviando, com a variável ligada", () => {
    render(createElement(ConversionsScreen, screenProps(capabilitiesOn)));
    const badges = screen.getAllByText(leadSubmittedOverrideCopy.badge);
    expect(badges).toHaveLength(1);
    expect(badges[0]!.closest("article")!.getAttribute("aria-label")).toBe(
      "Lead pela frase",
    );
  });

  it("não aparece com a variável desligada (false explícito)", () => {
    render(createElement(ConversionsScreen, screenProps(capabilitiesOff)));
    expect(screen.queryByText(leadSubmittedOverrideCopy.badge)).toBeNull();
  });

  it("regra pausada, sem envio ou de CRM não substitui", () => {
    expect(
      replacesEntryLeadSubmitted({ eventName: "LeadSubmitted", active: false, mode: "production" }),
    ).toBe(false);
    expect(
      replacesEntryLeadSubmitted({ eventName: "LeadSubmitted", active: true, mode: "observation" }),
    ).toBe(false);
    expect(
      replacesEntryLeadSubmitted({
        kind: "crm",
        eventName: "LeadSubmitted",
        active: true,
        mode: "production",
      }),
    ).toBe(false);
  });
});

describe("aviso no formulário de regra", () => {
  async function openEventStep(caps: typeof capabilities) {
    const user = setupUser();
    renderFlow(caps);
    await user.click(screen.getByRole("radio", { name: /Frase na conversa/ }));
    await user.click(screen.getByRole("button", { name: /Continuar/ }));
    return user;
  }

  it("Nova regra: Lead recebido mostra o aviso, sem ressalva (a regra já nasce enviando)", async () => {
    const user = await openEventStep(capabilitiesOn);
    await user.selectOptions(screen.getByLabelText("Evento"), "QualifiedLead");
    expect(screen.queryByText(/deixa de ser enviado na entrada/u)).toBeNull();
    await user.selectOptions(screen.getByLabelText("Evento"), "LeadSubmitted");
    const callout = screen.getByRole("note");
    expect(callout.className).toBe("feedback-banner warn");
    expect(callout.textContent).toBe(
      `${leadSubmittedOverrideCopy.title}${leadSubmittedOverrideCopy.notice}`,
    );
    expect(callout.textContent).toContain(
      "o Lead recebido (LeadSubmitted na Meta) deixa de ser enviado na entrada",
    );
    // Produção direta: nenhum texto novo fala em observação.
    expect(callout.textContent).not.toMatch(/observa[cç][aã]o/iu);
  });

  it("Nova regra com a variável desligada: sem aviso", async () => {
    const user = await openEventStep(capabilitiesOff);
    await user.selectOptions(screen.getByLabelText("Evento"), "LeadSubmitted");
    expect(screen.queryByText(/deixa de ser enviado na entrada/u)).toBeNull();
  });

  it("Gerenciar: regra enviando mostra o aviso sem a ressalva", async () => {
    const user = setupUser();
    render(createElement(ConversionsScreen, screenProps(capabilitiesOn)));
    await user.click(screen.getByRole("button", { name: "Gerenciar Lead pela frase" }));
    const dialog = screen.getByRole("dialog", { name: "Gerenciar “Lead pela frase”" });
    expect(within(dialog).getByText(leadSubmittedOverrideCopy.notice)).toBeTruthy();
    expect(within(dialog).queryByText(leadSubmittedOverrideCopy.notSending)).toBeNull();
  });
});

describe("textos do motivo e do painel", () => {
  it("nomeia o recibo adiado em Execuções e na auditoria de eventos", () => {
    expect(executionReasonLabel("lead_submitted_deferred_to_rule")).toBe(
      "Lead recebido adiado: será enviado pela regra",
    );
    expect(
      auditReasonLabel("lead_submitted_deferred_to_rule", "Falha no processamento do evento"),
    ).toBe("Lead recebido adiado: será enviado pela regra");
    expect(auditReasonLabel("MissingAdId", "Anúncio não identificado")).toBe(
      "Anúncio não identificado",
    );
  });

  it("Visão Geral: desligada mantém os textos; ligada explica conversas x leads novos", () => {
    expect(overviewLeadsCopy(false)).toEqual({
      ...overviewLeadsHints,
      newCaption: "1º contato no período",
    });
    const on = overviewLeadsCopy(true);
    expect(on.conversations).toMatch(/^Conversas iniciadas: toda conversa que entrou\./u);
    expect(on.new).toMatch(
      /^Leads novos: quando o Lead recebido foi enviado à Meta — na entrada ou pela sua regra\./u,
    );
    expect(on.newCaption).toBe("Lead recebido enviado no período");
    expect(on.returning).toBe(overviewLeadsHints.returning);
  });

  it("Execuções: recibo adiado mostra 'Adiado para a regra' e os leads aguardando", async () => {
    const audit = {
      providerRuleId: "rule_lead",
      eventName: "LeadSubmitted",
      summary: { total: 1, observed: 0, eligible: 1, materialized: 0, duplicate: 0, blocked: 0, failed: 0 },
      items: [
        {
          executionId: "exec_1",
          sourceDeliveryId: "delivery_1",
          occurredAt: "2026-10-11T15:00:00.000Z",
          status: "eligible",
          reasonCode: "lead_submitted_deferred_to_rule",
          matchedTriggerPhrase: null,
          channel: null,
          leadId: null,
          leadName: null,
          phoneDisplay: null,
          valueCents: null,
          currency: null,
          conversionEventLogId: null,
          purchaseReviewId: null,
          attemptCount: 0,
          processedAt: null,
          technicalDelivery: null,
          lastProductionFailure: null,
        },
      ],
      pagination: { page: 1, pageSize: 50, totalItems: 1, totalPages: 1 },
      leadsAwaitingRule: { count: 4, olderThanDays: 3, capped: false },
    };
    render(
      createElement(RuleExecutions, {
        ruleId: "rule_lead",
        loadAction: vi.fn(async () => ({
          ok: true,
          message: "ok",
          executionAudit: audit as never,
        })),
      } as never),
    );
    expect(await screen.findByText("Adiado para a regra")).toBeTruthy();
    expect(screen.queryByText("Na fila de envio")).toBeNull();
    expect(screen.getByText("4 leads aguardando a regra há mais de 3 dias")).toBeTruthy();
  });

  it("rótulo de leads aguardando: some com zero, singular e limite", () => {
    expect(leadsAwaitingRuleLabel({ count: 0, olderThanDays: 3, capped: false })).toBeNull();
    expect(leadsAwaitingRuleLabel({ count: 1, olderThanDays: 3, capped: false })).toBe(
      "1 lead aguardando a regra há mais de 3 dias",
    );
    expect(leadsAwaitingRuleLabel({ count: 1000, olderThanDays: 3, capped: true })).toBe(
      "Mais de 1000 leads aguardando a regra há mais de 3 dias",
    );
  });
});
