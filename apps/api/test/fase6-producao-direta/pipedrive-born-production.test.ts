import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  productionEnv,
  productionHarness,
} from "../support/pipedrive-production-harness";
import { observationHarness, ruleInput } from "../support/pipedrive-observation-harness";
import { actor } from "../support/pipedrive-harness";

/**
 * Fase 6.1c — produção direta no Pipedrive (validado no SaaS): sem modo
 * pedido, a regra nasce enviando quando a conexão já tem o que o envio exige.
 * Sem isso ela nasce com o envio desligado em vez de falhar; "Ativar envio"
 * continua dizendo o que falta. Dados e armazenamento fictícios.
 */
beforeEach(productionEnv);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const { mode: _mode, ...withoutMode } = ruleInput;

describe("Pipedrive: regra nasce enviando (Fase 6.1c)", () => {
  it("sem modo pedido, nasce em produção com a data de ativação", async () => {
    const h = await productionHarness();
    const rule = await h.webhooks.createRule(
      "workspace-a",
      h.c.id,
      actor,
      withoutMode,
    );
    expect(rule).toMatchObject({ mode: "production" });
    expect(h.state.pipedriveConversionRule![0]).toMatchObject({
      mode: "production",
      productionActivatedAt: expect.any(Date),
    });
  });

  it("sem o que o envio exige, nasce com o envio desligado em vez de falhar", async () => {
    const h = observationHarness();
    const c = await h.seed();
    const rule = await h.webhooks.createRule(
      "workspace-a",
      c.id,
      actor,
      withoutMode,
    );
    expect(rule).toMatchObject({ mode: "observation" });
    expect(h.state.pipedriveConversionRule![0]).toMatchObject({
      mode: "observation",
      productionActivatedAt: null,
    });
  });

  it("um modo pedido explicitamente continua valendo", async () => {
    const h = await productionHarness();
    const rule = await h.webhooks.createRule(
      "workspace-a",
      h.c.id,
      actor,
      ruleInput,
    );
    expect(rule).toMatchObject({ mode: "observation" });
  });
});
