// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type {
  ProviderConversionAutomationAuditDto,
  ProviderConversionAutomationAuditItemDto,
} from "@wpptrack/shared";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReceivedEvents } from "../src/app/(app)/conversions/received-events";
import {
  executionReasonLabel,
  observationDetailCopy,
  observationDetailLabel,
} from "../src/app/(app)/settings/provider-conversion-labels";

afterEach(() => {
  cleanup();
});

/**
 * Porte do SaaS (#171, d4c6a419). Em "Eventos recebidos" todo evento parado aparecia
 * só como "Reconhecido em observação", sem dizer por quê.
 */
function item(
  overrides: Partial<ProviderConversionAutomationAuditItemDto> = {},
): ProviderConversionAutomationAuditItemDto {
  return {
    deliveryId: "delivery_1",
    executionId: "execution_1",
    receivedAt: "2026-10-24T00:33:55.000Z",
    lastReceivedAt: "2026-10-24T00:33:55.000Z",
    providerEventType: "lost_cart",
    eventName: "CartAbandoned",
    automation: "cart_abandoned",
    status: "observed",
    reasonCode: "before_production_activation",
    attemptCount: 1,
    executionAttemptCount: 0,
    channel: { id: "channel_1", name: "Comercial", connectedPhone: "5511900000000" },
    leadResolved: true,
    payloadAvailable: true,
    payloadExpiresAt: "2026-11-24T00:33:55.000Z",
    reprocessable: true,
    observationDetail: "lead_number_not_production",
    ...overrides,
  };
}

function audit(
  items: ProviderConversionAutomationAuditItemDto[],
): ProviderConversionAutomationAuditDto {
  return {
    providerRuleId: "provider_rule_payt",
    summary: {
      total: items.length,
      observed: items.length,
      blocked: 0,
      queued: 0,
      materialized: 0,
      failed: 0,
      invalid: 0,
      recoverable: items.length,
    },
    items,
  } as ProviderConversionAutomationAuditDto;
}

function renderEvents(
  items: ProviderConversionAutomationAuditItemDto[],
  mode: "observation" | "production" = "production",
) {
  const loadAction = vi.fn(async () => ({
    ok: true,
    message: "ok",
    automationAudit: audit(items),
  }));
  render(
    createElement(ReceivedEvents, {
      ruleId: "provider_rule_payt",
      mode,
      canManage: true,
      loadAction: loadAction as never,
      loadPayloadAction: vi.fn() as never,
      reprocessAction: vi.fn() as never,
    }),
  );
}

describe("Eventos recebidos: por que ficou em observação", () => {
  it("shows the recorded reason and what a reprocess does", async () => {
    renderEvents([item()]);

    expect(
      await screen.findByText(
        /Por que ficou em observação: Número do lead ainda em observação\./u,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/Ative o envio do número \(“Ativar envio neste número” na regra ou a conexão dele em Integrações\); depois reprocessar envia à Meta\./u),
    ).toBeTruthy();
  });

  it("legacy engine: says that reprocessing does not send", async () => {
    renderEvents([
      item({
        reasonCode: "automation_matched_payt_observation",
        observationDetail: "lead_number_legacy_engine",
      }),
    ]);

    expect(
      await screen.findByText(/Número do lead ainda no motor antigo de conversões\./u),
    ).toBeTruthy();
    expect(screen.getByText(/Reprocessar não envia enquanto o número estiver no motor antigo/u)).toBeTruthy();
  });

  it("rule in observation: no reprocess promise", async () => {
    renderEvents(
      [item({ observationDetail: "rule_observation_at_receipt" })],
      "observation",
    );

    expect(
      await screen.findByText(
        /Por que ficou em observação: A regra estava em observação quando o evento chegou\.$/u,
      ),
    ).toBeTruthy();
  });

  it("older events without a recorded reason show only the reason code label", async () => {
    renderEvents([item({ observationDetail: null })]);

    expect(
      await screen.findByText(/Recebido antes do envio ativo \(regra ou número do lead\)/u),
    ).toBeTruthy();
    expect(screen.queryByText(/Por que ficou em observação/u)).toBeNull();
  });
});

describe("observation reason labels", () => {
  it("no longer collapse every observed reason into the status text", () => {
    const labels = [
      "automation_matched_observation",
      "automation_matched_payt_observation",
      "before_production_activation",
    ].map(executionReasonLabel);
    expect(new Set(labels).size).toBe(3);
    expect(labels).not.toContain("Reconhecido em observação");
  });

  it("covers every observation detail", () => {
    for (const detail of Object.keys(observationDetailCopy)) {
      expect(observationDetailLabel(detail as never)?.label).toBeTruthy();
    }
    expect(observationDetailLabel(null)).toBeNull();
  });
});
