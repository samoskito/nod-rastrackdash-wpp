import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ForbiddenException } from "@nestjs/common";
import { providerConversionRuleCreateInputSchema } from "@wpptrack/shared";
import { describe, expect, it, vi } from "vitest";
import {
  goHighLevelRoutingRuleGroups,
  pickRoutedRuleOutcome,
  routeGoHighLevelEvent,
  withCurrentGoHighLevelStageNames,
  type RoutingRule,
} from "../../src/inbound-webhooks/integration-endpoint-routing";
import { GoHighLevelPipelinesController } from "../../src/inbound-webhooks/gohighlevel-pipelines.controller";
import { parseGoHighLevelAutomationV1 } from "../../src/inbound-webhooks/providers/gohighlevel/gohighlevel-automation-v1.parser";
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
  stage: { pipelineId: string; stageName: string; stageId?: string } | null,
  crossConnectionScope = false,
): RoutingRule {
  return {
    id,
    scope: "all_numbers",
    crossConnectionScope,
    connectionId: "connection_ghl",
    removedAt: null,
    createdAt: new Date(createdAt),
    productFilterCodes: [],
    ghlPipelineId: stage?.pipelineId ?? null,
    ghlStageId: stage?.stageId ?? null,
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

/** Single-URL route with a mocked database: one GHL location, one channel. */
async function routeCall(
  rules: RoutingRule[],
  body: Record<string, unknown>,
  stageNames?: Parameters<typeof routeGoHighLevelEvent>[2]["stageNames"],
) {
  const payload = call(body);
  const parsed = parseGoHighLevelAutomationV1(payload, new Date());
  if (!parsed.ok) throw new Error("parse");
  const prisma = {
    providerConversionRuleConfig: { findMany: vi.fn(async () => rules) },
    inboundWebhookChannel: {
      findMany: vi.fn(async (args: { cursor?: unknown }) =>
        args.cursor
          ? []
          : [
              {
                id: "channel_ghl",
                connectionId: "connection_ghl",
                organizationId: null,
                providerChannelId: parsed.value.locationId,
                status: "active",
                createdAt: new Date("2026-10-01T00:00:00Z"),
                lastSeenAt: null,
                connectedPhone: "5511900000000",
                connection: { provider: "gohighlevel", status: "production" },
              },
            ],
      ),
    },
    conversionEventLog: {
      findMany: vi.fn(async () => [{ sourcePayload: { channelId: "channel_ghl" } }]),
    },
  } as any;
  return routeGoHighLevelEvent(prisma, { resolve: vi.fn() } as any, {
    workspaceId: "workspace_1",
    eventName: "Purchase",
    automation: parsed.value,
    stage: readGoHighLevelStageCall(payload),
    stageNames,
    receivedAt: new Date(),
  });
}

describe("1b. Etapa renomeada no GHL: o roteamento usa o nome atual pelo id salvo", () => {
  const renamed = () => ({
    warmStageNames: vi.fn(async () => {}),
    peekStageName: vi.fn((_c: string, _p: string, stageId: string) =>
      stageId === "STAGE_WON" ? "Fechado" : null,
    ),
  });
  const rules = () => [
    rule("rule_v1_old", "2026-10-01T00:00:00Z", null),
    rule("rule_v2", "2026-11-20T00:00:00Z", {
      pipelineId: "PIPELINE_A",
      stageName: "Ganho",
      stageId: "STAGE_WON",
    }),
  ];
  it("Ganho renomeada para Fechado: a chamada de Fechado vai para a v2", async () => {
    const source = renamed();
    expect(
      await routeCall(rules(), { pipeline_id: "PIPELINE_A", pipleline_stage: "Fechado" }, source),
    ).toMatchObject({ status: "routed", providerRuleId: "rule_v2" });
    expect(source.warmStageNames).toHaveBeenCalledWith("workspace_1", "connection_ghl");
    // Sem a fonte do nome atual, só o nome salvo: a v2 sai e a v1 recebe.
    expect(
      await routeCall(rules(), { pipeline_id: "PIPELINE_A", pipleline_stage: "Fechado" }),
    ).toMatchObject({ status: "routed", providerRuleId: "rule_v1_old" });
  });
  it("sem nome no cache (sem token ou API fora), vale o nome salvo", async () => {
    const source = {
      warmStageNames: vi.fn(async () => {
        throw new Error("GHL fora");
      }),
      peekStageName: vi.fn(() => null),
    };
    const out = await withCurrentGoHighLevelStageNames(rules(), "workspace_1", source);
    expect(out[1]!.ghlStageName).toBe("Ganho");
  });
});

describe("2b. Regras com etapa ambíguas: a chamada fica retida", () => {
  it("não cai para a regra sem filtro", async () => {
    const stage = { pipelineId: "PIPELINE_A", stageName: "Ganho" };
    const decision = await routeCall(
      [
        rule("rule_v1_old", "2026-10-01T00:00:00Z", null),
        rule("rule_v2_a", "2026-11-20T00:00:00Z", stage, true),
        rule("rule_v2_b", "2026-11-21T00:00:00Z", stage, true),
      ],
      { pipeline_id: "PIPELINE_A", pipleline_stage: "Ganho" },
    );
    expect(decision).toMatchObject({
      status: "unattributed",
      reasonCode: "multiple_rules_for_event",
    });
  });
});
