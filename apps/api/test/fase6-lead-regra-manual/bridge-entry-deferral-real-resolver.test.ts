import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";

/**
 * Fase 6.2a (nod): the WAHA / Uazapi BYO bridge entry asks the REAL
 * "Lead recebido pela regra" resolver (scope, precedence, production gates,
 * license, WhatsApp connection and the lead's ad route). Only Prisma and the
 * Meta route reader are faked. Synthetic data only.
 */
const previewRoute = vi.hoisted(() =>
  vi.fn(async (): Promise<Record<string, unknown>> => ({
    status: "resolved",
    reason: "route_resolved",
    reportingAccountId: "reporting_1",
    adAccountId: "act_1",
    businessConnectionId: "business_1",
    conversionDestinationId: "destination_1",
  })),
);
vi.mock(
  "../../src/inbound-webhooks/inbound-webhook-meta-route-reader.service",
  () => ({
    InboundWebhookMetaRouteReaderService: class {
      previewRoute = previewRoute;
    },
  }),
);

import { ProviderConversionRulesService } from "../../src/conversion-rules/provider-conversion-rules.service";
import { WebhooksController } from "../../src/webhooks/webhooks.controller";

const env = {
  NODE_ENV: "test",
  API_PUBLIC_URL: "http://localhost:3333",
  INBOUND_WEBHOOKS_ENABLED: "true",
  INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
  INBOUND_CONVERSION_RULES_ENABLED: "true",
  INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 41).toString("base64"),
};

function world(options: {
  provider?: "uazapi" | "waha";
  ruleMode?: "production" | "observation";
  instanceStatus?: string;
  locked?: boolean;
  env?: Record<string, string>;
} = {}) {
  const provider = options.provider ?? "waha";
  const connection = {
    id: "connection_bridge",
    provider,
    status: "production",
    removedAt: null,
    parserReleaseId: `release_${provider}`,
    parserRelease: {
      provider,
      version: provider === "waha" ? "v2" : "v1",
      status: "certified",
    },
  };
  const rule = {
    id: "rule_lead",
    scope: "specific_numbers",
    crossConnectionScope: null,
    connectionId: null,
    removedAt: null,
    mode: options.ruleMode ?? "production",
    productionActivatedAt:
      (options.ruleMode ?? "production") === "production"
        ? new Date("2026-10-01T00:00:00.000Z")
        : null,
    parserReleaseId: null,
    conversionRule: {
      triggerType: "message_phrase",
      eventName: "LeadSubmitted",
      active: true,
      name: "Lead pela frase",
    },
    parserRelease: null,
    connection: null,
    channels: [{ channelId: "channel_bridge" }],
  };
  const prisma = {
    providerConversionRuleConfig: { findMany: vi.fn(async () => [rule]) },
    inboundWebhookChannel: {
      findUnique: vi.fn(async () => ({
        id: "channel_bridge",
        workspaceId: "ws",
        connectionId: connection.id,
        connection: { provider },
      })),
      findMany: vi.fn(async () => [
        {
          id: "channel_bridge",
          status: "active",
          conversionEngineMode: "canonical",
          productionActivatedAt: new Date("2026-10-02T00:00:00.000Z"),
          whatsappInstance: { status: options.instanceStatus ?? "active" },
          connection,
        },
      ]),
    },
  };
  const license = {
    getLockState: vi.fn(async () => ({ inert: false, locked: options.locked ?? false })),
  };
  const controller = new WebhooksController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    prisma as never,
    undefined,
    license as never,
    { ...env, ...options.env },
  ) as any;
  const ask = () =>
    controller.bridgedLeadSubmittedOverride(
      provider,
      { workspaceId: "ws", whatsappInstanceId: "instance_sintetica" },
      "ad_1",
    );
  return { ask, prisma, license };
}

describe("bridge entry with the real resolver", () => {
  for (const provider of ["waha", "uazapi"] as const)
    it(`${provider}: default env (flag unset) defers to the sending phrase rule`, async () => {
      await expect(world({ provider }).ask()).resolves.toEqual({
        ruleIds: ["rule_lead"],
        provider,
        channelId: "channel_bridge",
        connectionId: "connection_bridge",
      });
    });

  it("explicit LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED=false: the entry keeps sending", async () => {
    const w = world({ env: { LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED: "false" } });
    await expect(w.ask()).resolves.toBeNull();
    expect(w.prisma.providerConversionRuleConfig.findMany).not.toHaveBeenCalled();
  });

  it("rule not sending, license blocked, connection suspended or route unresolved: never defers", async () => {
    await expect(world({ ruleMode: "observation" }).ask()).resolves.toBeNull();
    await expect(world({ locked: true }).ask()).resolves.toBeNull();
    await expect(world({ instanceStatus: "suspended" }).ask()).resolves.toBeNull();
    previewRoute.mockResolvedValueOnce({ status: "unresolved", reason: "ad_not_found" });
    await expect(world().ask()).resolves.toBeNull();
  });
});

describe("'N leads aguardando a regra' (Execuções da regra)", () => {
  const leadRule = {
    id: "rule_lead",
    conversionRule: { eventName: "LeadSubmitted" },
  };

  function service(rows: {
    deferred: Array<{ leadId: string }>;
    sent: Array<{ leadId: string }>;
  }, extraEnv: Record<string, string> = {}) {
    const findMany = vi.fn(async ({ where }: any) =>
      where.errorCode === "lead_submitted_deferred_to_rule" ? rows.deferred : rows.sent,
    );
    const instance = new ProviderConversionRulesService(
      { conversionEventLog: { findMany } } as never,
      { ...env, ...extraEnv },
    ) as any;
    return { instance, findMany };
  }

  it("counts deferred leads that no rule (nor a manual conversion) sent yet; read-only", async () => {
    const { instance, findMany } = service({
      deferred: [{ leadId: "lead_waiting" }, { leadId: "lead_sent" }, { leadId: "lead_manual" }],
      sent: [{ leadId: "lead_sent" }, { leadId: "lead_manual" }],
    });
    await expect(instance.leadsAwaitingRuleSummary("ws", leadRule)).resolves.toEqual({
      count: 1,
      olderThanDays: 3,
      capped: false,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourcePayload: {
            path: ["leadSubmittedDeferredToRuleIds"],
            array_contains: ["rule_lead"],
          },
        }),
      }),
    );
    // A manual Lead recebido also means "not waiting anymore".
    const sentQuery = findMany.mock.calls[1]![0] as any;
    expect(sentQuery.where.OR).toContainEqual({ sourceTrigger: "manual_conversion" });
  });

  it("explicit false or another event: no summary and no query", async () => {
    const off = service({ deferred: [], sent: [] }, { LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED: "false" });
    await expect(off.instance.leadsAwaitingRuleSummary("ws", leadRule)).resolves.toBeUndefined();
    const other = service({ deferred: [], sent: [] });
    await expect(
      other.instance.leadsAwaitingRuleSummary("ws", {
        ...leadRule,
        conversionRule: { eventName: "QualifiedLead" },
      }),
    ).resolves.toBeUndefined();
    expect(off.findMany).not.toHaveBeenCalled();
    expect(other.findMany).not.toHaveBeenCalled();
  });
});
