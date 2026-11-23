import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ForbiddenException } from "@nestjs/common";
import { providerConversionRuleCreateInputSchema } from "@wpptrack/shared";
import { describe, expect, it, vi } from "vitest";
import {
  goHighLevelRoutingRuleGroups,
  pickRoutedRuleOutcome,
  type RoutingRule,
} from "../../src/inbound-webhooks/integration-endpoint-routing";
import { GoHighLevelPipelinesController } from "../../src/inbound-webhooks/gohighlevel-pipelines.controller";
import {
  parseGoHighLevelAutomationV2,
  readGoHighLevelStageCall,
} from "../../src/inbound-webhooks/providers/gohighlevel/gohighlevel-automation-v2.parser";

/** Correções da revisão do #145 (dados fictícios). */

const envelope = JSON.parse(
  readFileSync(
    resolve(__dirname, "../fixtures/gohighlevel/opportunity-stage-changed.json"),
    "utf8",
  ),
) as [{ headers: unknown; body: Record<string, unknown> }];

function call(overrides: Record<string, unknown> = {}) {
  return [
    {
      headers: envelope[0].headers,
      body: { ...structuredClone(envelope[0].body), ...overrides },
    },
  ];
}

const channel = {
  id: "channel_ghl",
  connectionId: "connection_ghl",
  provider: "gohighlevel",
};

function rule(
  id: string,
  createdAt: string,
  stage: { pipelineId: string; stageName: string } | null,
): RoutingRule {
  return {
    id,
    scope: "all_numbers",
    crossConnectionScope: false,
    connectionId: "connection_ghl",
    removedAt: null,
    createdAt: new Date(createdAt),
    productFilterCodes: [],
    ghlPipelineId: stage?.pipelineId ?? null,
    ghlStageName: stage?.stageName ?? null,
    conversionRule: {
      triggerType: "provider_automation",
      eventName: "Purchase",
      active: true,
    },
    parserRelease: { provider: "gohighlevel" },
    connection: { provider: "gohighlevel" },
    channels: [],
  } as RoutingRule;
}

/** The rule the single URL picks for a call: first group that routes. */
function route(rules: RoutingRule[], body: Record<string, unknown>) {
  const groups = goHighLevelRoutingRuleGroups(
    rules,
    readGoHighLevelStageCall(call(body)),
  );
  for (const group of groups) {
    const outcome = pickRoutedRuleOutcome(group, channel, {
      productCodes: null,
    });
    if (outcome.status === "picked") return outcome.rule.id;
  }
  return null;
}

describe("1. URL única: a etapa da chamada escolhe a regra", () => {
  it("duas regras Purchase em pipelines A e B: a chamada do pipeline B vai para a regra B", () => {
    const rules = [
      rule("rule_a", "2026-11-01T00:00:00Z", {
        pipelineId: "PIPELINE_A",
        stageName: "Ganho",
      }),
      rule("rule_b", "2026-11-02T00:00:00Z", {
        pipelineId: "PIPELINE_B",
        stageName: "Ganho",
      }),
    ];
    expect(route(rules, { pipeline_id: "PIPELINE_B", pipleline_stage: "ganho " })).toBe("rule_b");
    expect(route(rules, { pipeline_id: "PIPELINE_A", pipleline_stage: "Ganho" })).toBe("rule_a");
    // Nenhuma etapa bate: nenhuma regra (não cai na mais antiga).
    expect(route(rules, { pipeline_id: "PIPELINE_C", pipleline_stage: "Ganho" })).toBeNull();
  });

  it("uma v1 mais antiga ao lado de uma v2: a etapa vai para a v2, as outras para a v1", () => {
    const rules = [
      rule("rule_v1_old", "2026-10-01T00:00:00Z", null),
      rule("rule_v2", "2026-11-20T00:00:00Z", {
        pipelineId: "PIPELINE_A",
        stageName: "Ganho",
      }),
    ];
    expect(route(rules, { pipeline_id: "PIPELINE_A", pipleline_stage: "Ganho" })).toBe("rule_v2");
    expect(route(rules, { pipeline_id: "PIPELINE_A", pipleline_stage: "Proposta" })).toBe("rule_v1_old");
    // Chamada de Workflow sem oportunidade: só a v1.
    expect(
      goHighLevelRoutingRuleGroups(rules, { pipelineId: null, pipelineStage: null }),
    ).toEqual([[rules[0]]]);
  });
});

describe("3. ghlOpportunityValue exige ghlStage", () => {
  const base = {
    name: "Etapa no GHL",
    triggerType: "provider_automation",
    scope: "all_numbers",
    connectionId: "connection_ghl",
    eventName: "Purchase",
  };
  it("recusa o valor da oportunidade sem pipeline e etapa", () => {
    const parsed = providerConversionRuleCreateInputSchema.safeParse({
      ...base,
      ghlOpportunityValue: true,
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain(
      "O valor da oportunidade exige o pipeline e a etapa",
    );
    expect(
      providerConversionRuleCreateInputSchema.safeParse({
        ...base,
        ghlOpportunityValue: true,
        ghlStage: {
          pipelineId: "PIPELINE_A",
          pipelineName: "Funil Exemplo",
          stageId: "STAGE_1",
          stageName: "Ganho",
        },
      }).success,
    ).toBe(true);
  });
});

describe("4. Lista de pipelines exige canManageIntegrations", () => {
  function controller(canManageIntegrations: boolean) {
    const service = { listPipelines: vi.fn(async () => ({ tokenConfigured: true, pipelines: [] })) };
    const instance = new GoHighLevelPipelinesController(
      { getSession: vi.fn(async () => ({ user: { id: "user_1" } })) } as any,
      {
        getCurrentWorkspace: vi.fn(async () => ({
          id: "workspace_1",
          permissions: { canManageIntegrations },
        })),
      } as any,
      service as any,
    );
    return { instance, service };
  }
  it("recusa com 403 sem a permissão e lista com ela", async () => {
    const denied = controller(false);
    await expect(
      denied.instance.listPipelines("token", "connection_ghl"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(denied.service.listPipelines).not.toHaveBeenCalled();
    const allowed = controller(true);
    await expect(
      allowed.instance.listPipelines("token", "connection_ghl"),
    ).resolves.toMatchObject({ tokenConfigured: true });
  });
});

describe("5. Dedupe pelo nome normalizado da etapa", () => {
  it("a mesma oportunidade numa etapa renomeada (caixa, acento, espaço) não reenvia", () => {
    const key = (stage: string) => {
      const parsed = parseGoHighLevelAutomationV2(
        call({ pipleline_stage: stage }),
        new Date("2026-11-20T12:00:00.000Z"),
        { eventName: "Purchase" },
      );
      return parsed.ok ? parsed.value.externalExecutionKey : parsed.errorCode;
    };
    const same = key("Proposta enviada");
    expect(key("PROPOSTA  ENVIADA ")).toBe(same);
    expect(key("Próposta enviada")).toBe(same);
    expect(key("Fechado")).not.toBe(same);
  });
});
