import { describe, expect, it } from "vitest";
import {
  createHarness,
  input,
  paytBody,
  paytFixture,
} from "../fase4-payt/payt-ingestion-harness";

/**
 * Fase 6.1b — porte do #171 do SaaS (`d4c6a419`): "Eventos recebidos" mostra
 * por que o evento ficou em observação, e o Reprocessar de uma venda que
 * continua observada diz o motivo (também quando a reivindicação de
 * observação devolve a própria execução como purchase_duplicate).
 * Dados fictícios.
 */

const paid = () => paytFixture("order-paid.sanitized.json");

function observedExecution(deliveryId: string) {
  return {
    id: "execution_observed",
    workspaceId: "workspace_safe",
    providerRuleId: "provider_rule_1",
    sourceDeliveryId: deliveryId,
    externalExecutionKey: "occurrence_observed",
    channelId: "channel_1",
    status: "observed",
    reasonCode: "before_production_activation",
    normalizedResult: { observationDetail: "lead_number_not_production" },
    attemptCount: 0,
    leadId: null,
    createdAt: new Date("2026-07-22T17:10:00.000Z"),
    updatedAt: new Date("2026-07-22T17:10:00.000Z"),
  };
}

describe("Payt observada: motivo na lista e no Reprocessar (porte do #171)", () => {
  async function observedCallback() {
    const harness = createHarness({
      eventName: "Purchase",
      production: true,
      payt: true,
    });
    harness.conversionObservation.observeAutomation.mockResolvedValueOnce({
      decisionId: "decision_1",
      decisionCode: "eligible",
      reasonCode: "before_production_activation",
      disposition: "observed",
      executionId: "execution_observed",
      eligibleExecutionId: null,
      reviewId: null,
      channelId: "channel_1",
      leadResolved: true,
      observationDetail: "lead_number_not_production",
    });
    const callback = await harness.service.ingest(input(paytBody(paid())));
    harness.executions.set(
      "occurrence_observed",
      observedExecution(callback.deliveryId),
    );
    return { harness, callback };
  }

  it("a lista de eventos recebidos traz o motivo gravado", async () => {
    const { harness } = await observedCallback();
    const audit = await harness.service.listAutomationCallbacks(
      "workspace_safe",
      "provider_rule_1",
    );
    expect(audit.items[0]).toMatchObject({
      status: "observed",
      reasonCode: "before_production_activation",
      observationDetail: "lead_number_not_production",
    });
  });

  it("Reprocessar ainda observado: a mensagem diz o motivo", async () => {
    const { harness, callback } = await observedCallback();
    harness.conversionObservation.observeAutomation.mockResolvedValueOnce({
      decisionId: "decision_1",
      decisionCode: "eligible",
      reasonCode: "before_production_activation",
      disposition: "observed",
      executionId: "execution_observed",
      eligibleExecutionId: null,
      reviewId: null,
      channelId: "channel_1",
      leadResolved: true,
      observationDetail: "lead_number_not_production",
    });
    const replay = await harness.service.reprocessSelectedCallbacks(
      "workspace_safe",
      "provider_rule_1",
      [callback.deliveryId],
      "manager_1",
    );
    expect(replay.queued).toBe(0);
    expect(replay.items[0]?.message).toMatch(
      /ainda não está em produção na própria conexão; ative o envio neste número/u,
    );
  });

  it("purchase_duplicate da própria execução observada não vira “não exige envio”", async () => {
    const { harness, callback } = await observedCallback();
    harness.conversionObservation.observeAutomation.mockResolvedValueOnce({
      decisionId: "decision_1",
      decisionCode: "eligible",
      reasonCode: "purchase_duplicate",
      disposition: "ignored",
      executionId: "execution_observed",
      eligibleExecutionId: null,
      reviewId: null,
      channelId: "channel_1",
      leadResolved: true,
      observationDetail: null,
    });
    const replay = await harness.service.reprocessSelectedCallbacks(
      "workspace_safe",
      "provider_rule_1",
      [callback.deliveryId],
      "manager_1",
    );
    expect(replay.items[0]).toMatchObject({
      executionId: "execution_observed",
      status: "skipped",
      reasonCode: "before_production_activation",
    });
    expect(replay.items[0]?.message).toMatch(/ative o envio neste número/u);
    expect(replay.items[0]?.message).not.toMatch(/não exige envio/u);
  });
});
