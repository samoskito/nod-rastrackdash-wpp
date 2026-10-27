import { describe, expect, it, vi } from "vitest";
import {
  observationDetailOf,
  observedReprocessMessage,
} from "../../src/conversion-rules/provider-conversion-observation-detail";
import { ProviderConversionObservationService } from "../../src/conversion-rules/provider-conversion-observation.service";
import { ProviderConversionOrchestrator } from "../../src/conversion-rules/provider-conversion-orchestrator.service";
import {
  providerRuleIsSalesPlatform,
  providerRuleNumberGateConnectionId,
} from "../../src/conversion-rules/provider-rule-scope";

/**
 * Fase 6.1b — porte do #171 do SaaS (`d4c6a419`): motivo de "em observação"
 * gravado com a execução e o número do lead na própria conexão (Payt).
 * Dados fictícios.
 */

const activatedAt = new Date("2026-10-20T12:00:00.000Z");
const receivedAt = new Date("2026-10-24T00:33:55.000Z");

type DispositionInput = {
  provider?: string;
  ruleMode?: "observation" | "production";
  frozenMode?: "observation" | "production";
  productionEnabled?: boolean;
  ruleActivatedAt?: Date | null;
  channelActivatedAt?: Date | null;
  engine?: "legacy" | "shadow" | "canonical";
  manualRecovery?: boolean;
};

const service = Object.create(
  ProviderConversionObservationService.prototype,
) as {
  disposition(input: unknown): {
    state: string;
    reasonCode: string;
    detail?: string;
  };
};

function disposition(input: DispositionInput = {}) {
  const provider = input.provider ?? "payt";
  const release = {
    provider,
    version: "automation-v1",
    status: "certified",
  };
  return service.disposition({
    config: { conversionProductionEnabled: input.productionEnabled ?? true },
    decision: {
      reasonCode: "automation_matched",
      rule: {
        mode: input.frozenMode ?? input.ruleMode ?? "production",
        triggerType: "provider_automation",
      },
    },
    rule: {
      id: "provider_rule_1",
      mode: input.ruleMode ?? "production",
      parserRelease: release,
      parserReleaseId: "release_1",
      productionActivatedAt:
        input.ruleActivatedAt === undefined ? activatedAt : input.ruleActivatedAt,
    },
    gateConnection: {
      status: "production",
      removedAt: null,
      parserRelease: release,
      parserReleaseId: "release_1",
    },
    channel: {
      id: "channel_lead",
      status: "active",
      conversionEngineMode: input.engine ?? "canonical",
      productionActivatedAt:
        input.channelActivatedAt === undefined
          ? activatedAt
          : input.channelActivatedAt,
    },
    deliveryReceivedAt: receivedAt,
    manualRecovery: input.manualRecovery ?? false,
  });
}

describe("disposição observada grava o motivo (porte do #171)", () => {
  it("envia quando a regra e o número do lead estão em produção", () => {
    expect(disposition()).toEqual({
      state: "eligible",
      reasonCode: "automation_matched",
    });
  });

  it("número do lead fora de produção na própria conexão: observado com o motivo", () => {
    expect(disposition({ channelActivatedAt: null })).toEqual({
      state: "observed",
      reasonCode: "before_production_activation",
      detail: "lead_number_not_production",
    });
  });

  it("Payt: o Reprocessar manual não enfileira um número que nunca foi ativado (o worker recusaria)", () => {
    expect(
      disposition({ channelActivatedAt: null, manualRecovery: true }),
    ).toMatchObject({
      state: "observed",
      detail: "lead_number_not_production",
    });
  });

  it("outras automações mantêm o Reprocessar manual de antes (sem o portão do número)", () => {
    expect(
      disposition({
        provider: "umbler",
        channelActivatedAt: null,
        manualRecovery: true,
      }),
    ).toMatchObject({ state: "eligible" });
  });

  it("recebido antes da ativação do número: motivo gravado; reprocessar envia", () => {
    const numberActivatedAt = new Date("2026-10-24T01:00:00.000Z");
    expect(
      disposition({ channelActivatedAt: numberActivatedAt }),
    ).toMatchObject({
      state: "observed",
      detail: "received_before_number_activation",
    });
    expect(
      disposition({
        channelActivatedAt: numberActivatedAt,
        manualRecovery: true,
      }),
    ).toMatchObject({ state: "eligible" });
  });

  it("recebido antes da ativação da regra: motivo gravado; reprocessar envia", () => {
    const ruleActivatedAt = new Date("2026-10-24T01:00:00.000Z");
    expect(disposition({ ruleActivatedAt })).toMatchObject({
      state: "observed",
      detail: "received_before_rule_activation",
    });
    expect(
      disposition({ ruleActivatedAt, manualRecovery: true }),
    ).toMatchObject({ state: "eligible" });
  });

  it("regra sem ativação registrada", () => {
    expect(disposition({ ruleActivatedAt: null })).toMatchObject({
      state: "observed",
      detail: "rule_not_activated",
    });
  });

  it("regra em observação quando chegou; o Reprocessar usa o modo atual", () => {
    expect(disposition({ frozenMode: "observation" })).toEqual({
      state: "observed",
      reasonCode: "automation_matched_observation",
      detail: "rule_observation_at_receipt",
    });
    expect(
      disposition({ frozenMode: "observation", manualRecovery: true }),
    ).toMatchObject({ state: "eligible" });
  });

  it("envio de conversões desligado no servidor", () => {
    expect(disposition({ productionEnabled: false })).toMatchObject({
      state: "observed",
      detail: "production_sending_disabled",
    });
  });

  it("número do lead no motor antigo (Payt)", () => {
    expect(disposition({ engine: "legacy" })).toEqual({
      state: "observed",
      reasonCode: "automation_matched_payt_observation",
      detail: "lead_number_legacy_engine",
    });
  });
});

describe("a execução observada guarda o motivo em normalizedResult", () => {
  it("persistExecution grava observationDetail sem perder o resto", async () => {
    const orchestrator = Object.create(
      ProviderConversionOrchestrator.prototype,
    ) as { persistExecution(input: unknown, client: unknown): Promise<unknown> };
    const upsert = vi.fn(async () => ({ id: "execution_1", status: "observed" }));
    const client = {
      providerConversionRuleExecution: {
        findUnique: vi.fn(async () => null),
        upsert,
      },
    };
    await orchestrator.persistExecution(
      {
        persistedDecision: {
          id: "decision_1",
          workspaceId: "workspace_1",
          providerRuleId: "provider_rule_1",
          sourceDeliveryId: "delivery_1",
          channelId: "channel_lead",
          occurrenceKey: "occurrence_1",
          occurredAt: receivedAt,
          decisionVersion: 1,
          leadId: null,
          decision: {
            engineVersion: "v1",
            parserVersion: "automation-v1",
            reasonCode: "automation_matched",
            occurrence: { contactIdentityHash: "hash_1" },
            conversion: {
              items: [],
              valueCents: 5_000,
              currency: "BRL",
              matchedTriggerPhrase: null,
            },
          },
        },
        disposition: {
          state: "observed",
          reasonCode: "before_production_activation",
          detail: "lead_number_not_production",
        },
      },
      client,
    );
    const call = (upsert.mock.calls[0] as unknown as [any])[0];
    expect(call.create.normalizedResult).toMatchObject({
      decisionId: "decision_1",
      observationDetail: "lead_number_not_production",
    });
    expect(call.update.normalizedResult.observationDetail).toBe(
      "lead_number_not_production",
    );
  });
});

describe("observationDetailOf e a mensagem do Reprocessar", () => {
  it("lê o motivo gravado; cai nos códigos antigos quando não há", () => {
    expect(
      observationDetailOf({
        status: "observed",
        reasonCode: "before_production_activation",
        normalizedResult: { observationDetail: "lead_number_not_production" },
      }),
    ).toBe("lead_number_not_production");
    expect(
      observationDetailOf({
        status: "observed",
        reasonCode: "automation_matched_payt_observation",
        normalizedResult: {},
      }),
    ).toBe("lead_number_legacy_engine");
    expect(
      observationDetailOf({
        status: "observed",
        reasonCode: "automation_matched_observation",
        normalizedResult: null,
      }),
    ).toBe("rule_observation_at_receipt");
    // Antigo, sem motivo: regra ou número não dá para saber depois.
    expect(
      observationDetailOf({
        status: "observed",
        reasonCode: "before_production_activation",
        normalizedResult: { observationDetail: "inventado" },
      }),
    ).toBeNull();
    expect(
      observationDetailOf({
        status: "materialized",
        reasonCode: "automation_matched_observation",
        normalizedResult: { observationDetail: "rule_not_activated" },
      }),
    ).toBeNull();
  });

  it("a mensagem diz o que fazer, sem citar suporte nem vaga", () => {
    expect(observedReprocessMessage("lead_number_not_production")).toMatch(
      /ative o envio neste número/u,
    );
    // Fase 6.1c (produção direta): sem "observação" na tela do aluno, e o
    // envio desligado no servidor diz o que fazer, sem nome de variável (1.3.1).
    expect(observedReprocessMessage(null)).toBe(
      "A regra continua sem envio; retome o envio dela e reprocesse",
    );
    expect(observedReprocessMessage("production_sending_disabled")).toMatch(
      /religá-lo/u,
    );
    expect(observedReprocessMessage("production_sending_disabled")).not.toMatch(
      /INBOUND_|_ENABLED/u,
    );
    for (const detail of [
      "lead_number_legacy_engine",
      "lead_number_not_production",
      "production_sending_disabled",
      "rule_not_activated",
      "rule_observation_at_receipt",
    ] as const) {
      expect(observedReprocessMessage(detail)).not.toMatch(
        /suporte|vaga|observação/iu,
      );
    }
  });
});

describe("portão do número na própria conexão (Payt)", () => {
  const paytRule = {
    connectionId: "connection_payt",
    conversionRule: { triggerType: "provider_automation", triggerValue: "payt" },
    parserRelease: { provider: "payt" },
    connection: { provider: "payt" },
    scope: "all_numbers",
    crossConnectionScope: null,
  } as any;

  it("com a âncora em produção, a conexão do número (WAHA, Meta Cloud...) é o portão", () => {
    expect(providerRuleIsSalesPlatform(paytRule)).toBe(true);
    expect(
      providerRuleNumberGateConnectionId(
        paytRule,
        { connectionId: "connection_waha_bridge" },
        "production",
      ),
    ).toBe("connection_waha_bridge");
    // Âncora ainda em observação: ela é o portão.
    expect(
      providerRuleNumberGateConnectionId(
        paytRule,
        { connectionId: "connection_meta_cloud" },
        "observation",
      ),
    ).toBe("connection_payt");
  });

  it("as automações Umbler/Unnichat não mudam", () => {
    const umbler = {
      ...paytRule,
      connectionId: "connection_umbler",
      conversionRule: {
        triggerType: "provider_automation",
        triggerValue: "umbler",
      },
      parserRelease: { provider: "umbler" },
      connection: { provider: "umbler" },
      crossConnectionScope: false,
    };
    expect(providerRuleIsSalesPlatform(umbler)).toBe(false);
    expect(
      providerRuleNumberGateConnectionId(
        umbler,
        { connectionId: "connection_umbler" },
        "production",
      ),
    ).toBe("connection_umbler");
  });
});
