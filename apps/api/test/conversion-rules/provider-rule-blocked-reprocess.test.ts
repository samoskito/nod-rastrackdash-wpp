import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { ConversionRulesController } from "../../src/conversion-rules/conversion-rules.controller";
import { findReprocessableExecutions } from "../../src/conversion-rules/provider-rule-blocked-reprocess";
import { GlobalRuleAutoActivationService } from "../../src/conversion-rules/provider-rule-global-auto-activation.service";
import { ProviderRuleBlockedReprocessController } from "../../src/inbound-webhooks/provider-rule-blocked-reprocess.controller";
import { ProviderRuleBlockedReprocessService } from "../../src/inbound-webhooks/provider-rule-blocked-reprocess.service";
import { UazapiConversionBridgeService } from "../../src/inbound-webhooks/uazapi-conversion-bridge.service";

// Porte do SaaS #152: "Reprocessar bloqueadas", rotas e serviço de ativação
// automática. recoverDecision é simulado aqui (o caminho real roda no
// global-rule-production.pg.test.ts, com PostgreSQL).

type RRow = Record<string, any>;

const env = {
  NODE_ENV: "test",
  API_PUBLIC_URL: "https://api.wpptrack.test",
  INBOUND_WEBHOOKS_ENABLED: "true",
  INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
  INBOUND_CONVERSION_RULES_ENABLED: "true",
  INBOUND_CONVERSION_PRODUCTION_ENABLED: "true",
  INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
};

function rMatches(object: RRow | null | undefined, where: RRow | undefined): boolean {
  if (!where) return true;
  if (!object) return false;
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (key === "AND") {
      if (!(condition as RRow[]).every((item) => rMatches(object, item))) return false;
      continue;
    }
    if (key === "OR") {
      if (!(condition as RRow[]).some((item) => rMatches(object, item))) return false;
      continue;
    }
    const value = object[key];
    if (condition === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (typeof condition !== "object" || condition instanceof Date) {
      if (value !== condition) return false;
      continue;
    }
    if ("in" in condition) {
      if (!condition.in.includes(value)) return false;
      continue;
    }
    if ("not" in condition) {
      if (condition.not === null ? value == null : value === condition.not) return false;
      continue;
    }
    if ("gte" in condition || "lt" in condition) {
      const time = (value as Date).getTime();
      if ("gte" in condition && !(time >= condition.gte.getTime())) return false;
      if ("lt" in condition && !(time < condition.lt.getTime())) return false;
      continue;
    }
    if ("is" in condition) {
      if (!value || !rMatches(value, condition.is)) return false;
      continue;
    }
    if (!rMatches(value, condition)) return false;
  }
  return true;
}

describe("ProviderRuleBlockedReprocessService (Reprocessar bloqueadas)", () => {
  const now = new Date("2026-10-22T15:00:00.000Z");
  const daysAgo = (days: number) =>
    new Date(now.getTime() - days * 24 * 60 * 60 * 1_000);
  const channels: Record<string, RRow> = {
    channel_live: {
      connectionId: "conn_live",
      status: "active",
      connection: { provider: "uazapi", status: "production", removedAt: null },
    },
    channel_dead: {
      connectionId: "conn_dead",
      status: "discovered",
      connection: { provider: "uazapi", status: "observation", removedAt: null },
    },
    channel_umbler: {
      connectionId: "conn_umbler",
      status: "active",
      connection: { provider: "umbler", status: "production", removedAt: null },
    },
  };

  function execution(id: string, input: Partial<RRow> & { channelId: string }): RRow {
    return {
      id,
      workspaceId: "workspace_1",
      providerRuleId: "provider_rule_1",
      status: "blocked",
      reasonCode: "connection_not_production",
      occurredAt: daysAgo(1),
      providerDecisionId: `decision_${id}`,
      ...input,
      get channel() {
        return channels[this.channelId];
      },
    };
  }

  function reprocessWorld(options: { rule?: Partial<RRow>; executions?: RRow[] } = {}) {
    const executions: RRow[] = options.executions ?? [
      // Blocked while the bridged connection had never been promoted.
      execution("execution_live", { channelId: "channel_live" }),
      // Observed only because the number had not been activated yet.
      execution("execution_before_activation", {
        channelId: "channel_live",
        status: "observed",
        reasonCode: "before_production_activation",
        occurredAt: daysAgo(2),
      }),
      // Its number is still not active: left untouched.
      execution("execution_still_blocked", {
        channelId: "channel_dead",
        reasonCode: "channel_not_active",
        occurredAt: daysAgo(3),
      }),
      // Older than the Meta window: expired, never retried.
      execution("execution_expired", { channelId: "channel_live", occurredAt: daysAgo(8) }),
      // Not part of the reprocess at all.
      execution("execution_rule_was_observing", {
        channelId: "channel_live",
        status: "observed",
        reasonCode: "message_matched_observation",
      }),
      execution("execution_sent", {
        channelId: "channel_live",
        status: "materialized",
        reasonCode: "message_matched",
      }),
      // Another workspace: never seen.
      {
        ...execution("execution_other_workspace", { channelId: "channel_live" }),
        workspaceId: "workspace_2",
      },
    ];
    const audits: RRow[] = [];
    let lock: Promise<unknown> = Promise.resolve();
    const prisma: RRow = {
      $queryRaw: vi.fn(async () => []),
      providerConversionRuleConfig: {
        findFirst: vi.fn(async ({ where }: RRow) =>
          where.workspaceId === "workspace_1" && where.id === "provider_rule_1"
            ? {
                id: "provider_rule_1",
                mode: "production",
                removedAt: null,
                unifiedIntoProviderRuleId: null,
                connectionId: null,
                connection: null,
                conversionRule: { active: true },
                ...options.rule,
              }
            : null,
        ),
      },
      providerConversionRuleExecution: {
        count: vi.fn(
          async ({ where }: RRow) => executions.filter((row) => rMatches(row, where)).length,
        ),
        findMany: vi.fn(async ({ where, take, cursor }: RRow) => {
          const rows = executions
            .filter((row) => rMatches(row, where))
            .sort(
              (left, right) =>
                left.occurredAt - right.occurredAt || (left.id < right.id ? -1 : 1),
            );
          const start = cursor ? rows.findIndex((row) => row.id === cursor.id) + 1 : 0;
          return rows.slice(start, start + take);
        }),
      },
      auditLog: {
        findFirst: vi.fn(
          async ({ where }: RRow) =>
            [...audits]
              .reverse()
              .find(
                (row) =>
                  row.action === where.action &&
                  row.targetId === where.targetId &&
                  row.createdAt >= where.createdAt.gte,
              ) ?? null,
        ),
        findMany: vi.fn(async ({ where }: RRow) =>
          audits.filter(
            (row) =>
              rMatches(row, { ...where, createdAt: undefined }) &&
              row.createdAt < where.createdAt.lt,
          ),
        ),
        create: vi.fn(async ({ data }: RRow) => {
          const row = { ...data, createdAt: now };
          audits.push(row);
          return row;
        }),
      },
    };
    // Advisory-lock oracle: transactions run one at a time.
    prisma.$transaction = vi.fn(async (callback: (client: RRow) => unknown) => {
      const run = lock.then(() => callback(prisma));
      lock = run.catch(() => undefined);
      return run;
    });
    // recoverDecision: dry run says eligible when the number is live now;
    // execute flips the execution and enqueues it (job id = execution id).
    const productionQueue = { enqueueProviderConversion: vi.fn() };
    const uazapi = {
      recoverDecision: vi.fn(async ({ decisionId, workspaceId, execute }: RRow) => {
        const row = executions.find(
          (item) => item.providerDecisionId === decisionId && item.workspaceId === workspaceId,
        );
        if (!row) throw new Error(`Provider conversion decision not found: ${decisionId}`);
        const live =
          row.channel.status === "active" && row.channel.connection.status === "production";
        const disposition = { state: live ? "eligible" : "blocked" };
        if (!execute) return { disposition, eligibleExecutionId: null };
        if (["materialized", "duplicate"].includes(row.status)) {
          return { disposition, eligibleExecutionId: null };
        }
        row.status = disposition.state;
        if (live) {
          productionQueue.enqueueProviderConversion({
            providerConversionExecutionId: row.id,
            workspaceId,
          });
        }
        return { disposition, eligibleExecutionId: live ? row.id : null };
      }),
    };
    const reprocess = new ProviderRuleBlockedReprocessService(
      prisma as never,
      env as never,
      uazapi as never,
    );
    return { reprocess, prisma, executions, audits, uazapi, productionQueue };
  }

  const finished = (audits: RRow[]) =>
    audits.filter((row) => row.action === "provider_conversion_rule.blocked_reprocessed");

  it("reenvia só o que tem número ativo agora, dentro dos 7 dias, e conta o resto", async () => {
    const world = reprocessWorld();

    const result = await world.reprocess.reprocess(
      "workspace_1",
      "provider_rule_1",
      "user_1",
      now,
    );

    expect(result).toEqual({
      windowDays: 7,
      reprocessed: 2,
      stillBlocked: 1,
      expired: 1,
      skipped: 0,
      failed: 0,
      remaining: 0,
    });
    expect(world.productionQueue.enqueueProviderConversion.mock.calls).toEqual([
      [{ providerConversionExecutionId: "execution_before_activation", workspaceId: "workspace_1" }],
      [{ providerConversionExecutionId: "execution_live", workspaceId: "workspace_1" }],
    ]);
    const touched = world.uazapi.recoverDecision.mock.calls.map(([call]) => call.decisionId);
    expect([...new Set(touched)].sort()).toEqual([
      "decision_execution_before_activation",
      "decision_execution_live",
    ]);
    expect(world.audits.map((row) => row.action)).toEqual([
      "provider_conversion_rule.blocked_reprocess_started",
      "provider_conversion_rule.blocked_reprocessed",
    ]);
    expect(finished(world.audits)[0]).toMatchObject({
      targetId: "provider_rule_1",
      actorUserId: "user_1",
      resultStatus: "reprocessed",
      afterSummary: expect.objectContaining({
        reprocessed: 2,
        expired: 1,
        reprocessedExecutionIds: ["execution_before_activation", "execution_live"],
      }),
    });
    expect(world.prisma.$queryRaw).toHaveBeenCalled();
  });

  it("fica restrito ao workspace: a regra de outro workspace não é encontrada", async () => {
    const world = reprocessWorld();
    await expect(
      world.reprocess.reprocess("workspace_2", "provider_rule_1", "user_1", now),
    ).rejects.toMatchObject({ status: 404 });
    expect(world.uazapi.recoverDecision).not.toHaveBeenCalled();
    expect(world.audits).toEqual([]);
  });

  it("recusa reenviar qualquer coisa com a regra pausada, unificada ou em observação", async () => {
    for (const rule of [
      { conversionRule: { active: false } },
      { unifiedIntoProviderRuleId: "global_rule" },
      { mode: "observation" },
    ]) {
      const world = reprocessWorld({ rule });
      await expect(
        world.reprocess.reprocess("workspace_1", "provider_rule_1", "user_1", now),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: "provider_rule_reprocess_rule_inactive" },
      });
      expect(world.uazapi.recoverDecision).not.toHaveBeenCalled();
      expect(world.audits).toEqual([]);
    }
  });

  it("nunca reenvia conversas do período em que o operador pausou a conexão ou o canal", async () => {
    const world = reprocessWorld({
      executions: [
        // Connection had been live before: paused/back to observation later.
        execution("execution_after_promotion", { channelId: "channel_live", occurredAt: daysAgo(2) }),
        // Channel paused on purpose before this conversation.
        execution("execution_channel_paused", {
          channelId: "channel_live",
          reasonCode: "channel_not_active",
          occurredAt: daysAgo(2),
        }),
        // Before any decision: the incident case, recovered.
        execution("execution_never_live", { channelId: "channel_live", occurredAt: daysAgo(6) }),
      ],
    });
    world.audits.push(
      {
        action: "inbound_webhook.connection_promoted",
        targetType: "InboundWebhookConnection",
        targetId: "conn_live",
        workspaceId: "workspace_1",
        createdAt: daysAgo(4),
      },
      {
        action: "inbound_webhook.channel_paused",
        targetType: "InboundWebhookChannel",
        targetId: "channel_live",
        workspaceId: "workspace_1",
        createdAt: daysAgo(3),
      },
    );

    const result = await world.reprocess.reprocess("workspace_1", "provider_rule_1", "user_1", now);

    expect(result).toMatchObject({ reprocessed: 1, stillBlocked: 2 });
    expect(world.productionQueue.enqueueProviderConversion).toHaveBeenCalledTimes(1);
    expect(world.productionQueue.enqueueProviderConversion).toHaveBeenCalledWith({
      providerConversionExecutionId: "execution_never_live",
      workspaceId: "workspace_1",
    });
  });

  it("uma pausa de conexão que nunca esteve em produção também é respeitada", async () => {
    const world = reprocessWorld({
      executions: [
        execution("execution_while_paused", { channelId: "channel_live", occurredAt: daysAgo(2) }),
      ],
    });
    world.audits.push({
      action: "inbound_webhook.connection_paused",
      targetType: "InboundWebhookConnection",
      targetId: "conn_live",
      workspaceId: "workspace_1",
      createdAt: daysAgo(3),
    });

    const result = await world.reprocess.reprocess("workspace_1", "provider_rule_1", "user_1", now);

    expect(result).toMatchObject({ reprocessed: 0, stillBlocked: 1 });
    expect(world.uazapi.recoverDecision).not.toHaveBeenCalled();
  });

  it("não trava com 60 linhas antigas que nunca podem ser reenviadas", async () => {
    const stuck = Array.from({ length: 60 }, (_, index) =>
      execution(`stuck_${String(index).padStart(2, "0")}`, {
        channelId: index % 3 === 0 ? "channel_umbler" : "channel_dead",
        occurredAt: new Date(daysAgo(6).getTime() + index * 1_000),
        providerDecisionId: index % 5 === 0 ? null : `decision_stuck_${index}`,
      }),
    );
    const world = reprocessWorld({
      executions: [...stuck, execution("execution_recent", { channelId: "channel_live" })],
    });

    const result = await world.reprocess.reprocess("workspace_1", "provider_rule_1", "user_1", now);

    expect(result).toMatchObject({ reprocessed: 1, stillBlocked: 60, remaining: 0 });
    expect(world.productionQueue.enqueueProviderConversion).toHaveBeenCalledWith({
      providerConversionExecutionId: "execution_recent",
      workspaceId: "workspace_1",
    });
  });

  it("serializa cliques simultâneos: o segundo é recusado e nada é processado duas vezes", async () => {
    const world = reprocessWorld();

    const results = await Promise.allSettled([
      world.reprocess.reprocess("workspace_1", "provider_rule_1", "user_1", now),
      world.reprocess.reprocess("workspace_1", "provider_rule_1", "user_2", now),
    ]);

    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((item) => item.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    // In progress (409) or inside the cooldown (429): refused either way.
    expect([409, 429]).toContain(refused?.reason?.status);
    expect(world.productionQueue.enqueueProviderConversion).toHaveBeenCalledTimes(2);
  });

  it("uma rodada em andamento (iniciada e sem fim) recusa outra", async () => {
    const world = reprocessWorld();
    world.audits.push({
      action: "provider_conversion_rule.blocked_reprocess_started",
      targetType: "ProviderConversionRuleConfig",
      targetId: "provider_rule_1",
      workspaceId: "workspace_1",
      createdAt: new Date(now.getTime() - 60_000),
    });

    await expect(
      world.reprocess.reprocess("workspace_1", "provider_rule_1", "user_1", now),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: "provider_rule_reprocess_in_progress" },
    });
    expect(world.uazapi.recoverDecision).not.toHaveBeenCalled();
  });

  it("tem intervalo mínimo por regra e é idempotente numa rodada seguinte", async () => {
    const world = reprocessWorld();
    await world.reprocess.reprocess("workspace_1", "provider_rule_1", "user_1", now);

    await expect(
      world.reprocess.reprocess("workspace_1", "provider_rule_1", "user_1", now),
    ).rejects.toMatchObject({ status: 429 });

    world.productionQueue.enqueueProviderConversion.mockClear();
    const later = await world.reprocess.reprocess(
      "workspace_1",
      "provider_rule_1",
      "user_1",
      new Date(now.getTime() + 60_000),
    );
    expect(later).toMatchObject({ reprocessed: 0, stillBlocked: 1, expired: 1 });
    expect(world.productionQueue.enqueueProviderConversion).not.toHaveBeenCalled();
  });

  it("conta como expirada a conversa mais antiga que a janela, sem chamar recoverDecision", async () => {
    const world = reprocessWorld({
      executions: [execution("execution_expired", { channelId: "channel_live", occurredAt: daysAgo(8) })],
    });

    const result = await world.reprocess.reprocess("workspace_1", "provider_rule_1", "user_1", now);

    expect(result).toMatchObject({ reprocessed: 0, stillBlocked: 0, expired: 1 });
    expect(world.uazapi.recoverDecision).not.toHaveBeenCalled();
  });

  it("o contador do botão ignora números que não são QR e linhas sem decisão congelada", async () => {
    const world = reprocessWorld({
      executions: [
        execution("execution_umbler", { channelId: "channel_umbler" }),
        execution("execution_no_decision", { channelId: "channel_live", providerDecisionId: null }),
        execution("execution_ok", { channelId: "channel_live" }),
      ],
    });
    const rule = {
      id: "provider_rule_1",
      mode: "production",
      removedAt: null,
      unifiedIntoProviderRuleId: null,
      connectionId: null,
      connection: null,
      conversionRule: { active: true },
    };

    const ready = await findReprocessableExecutions(world.prisma as never, {
      workspaceId: "workspace_1",
      rule,
      cutoff: daysAgo(7),
      limit: 500,
    });

    expect(ready.map((row) => row.id)).toEqual(["execution_ok"]);
    await expect(
      findReprocessableExecutions(world.prisma as never, {
        workspaceId: "workspace_1",
        rule: { ...rule, conversionRule: { active: false } },
        cutoff: daysAgo(7),
        limit: 500,
      }),
    ).resolves.toEqual([]);
  });
});

describe("Rotas de Todos os números: mesma permissão de gerenciar regras", () => {
  function harness(role: string) {
    const auth = { getSession: vi.fn(async () => ({ user: { id: "actor_1" } })) };
    const workspaces = {
      getCurrentWorkspace: vi.fn(() => ({
        id: "workspace_current",
        permissions: { canManageIntegrations: ["owner", "admin"].includes(role) },
      })),
    };
    const rules = {
      activateGlobalRuleNumber: vi.fn(async () => ({
        outcome: "promoted",
        reason: null,
        rule: { id: "rule_1" },
      })),
    };
    const reprocess = {
      reprocess: vi.fn(async () => ({
        windowDays: 7,
        reprocessed: 1,
        stillBlocked: 0,
        expired: 0,
        skipped: 0,
        failed: 0,
        remaining: 0,
      })),
    };
    const rulesController = new ConversionRulesController(
      auth as never,
      workspaces as never,
      {} as never,
      {} as never,
      rules as never,
      {} as never,
    );
    const reprocessController = new ProviderRuleBlockedReprocessController(
      auth as never,
      workspaces as never,
      reprocess as never,
    );
    return { rulesController, reprocessController, rules, reprocess };
  }

  it.each(["owner", "admin"])(
    "%s ativa um número coberto e reprocessa no workspace atual",
    async (role) => {
      const h = harness(role);

      await h.rulesController.activateProviderRuleNumber("session", "rule_1", " channel_1 ");
      expect(h.rules.activateGlobalRuleNumber).toHaveBeenCalledWith(
        "workspace_current",
        "rule_1",
        "channel_1",
        "actor_1",
      );

      await h.reprocessController.reprocessBlocked("session", "rule_1");
      expect(h.reprocess.reprocess).toHaveBeenCalledWith(
        "workspace_current",
        "rule_1",
        "actor_1",
      );
    },
  );

  it.each(["member", "viewer"])("recusa as duas rotas para %s antes de tocar em qualquer serviço", async (role) => {
    const h = harness(role);

    await expect(
      h.rulesController.activateProviderRuleNumber("session", "rule_1", "channel_1"),
    ).rejects.toMatchObject({ status: 403 });
    await expect(h.reprocessController.reprocessBlocked("session", "rule_1")).rejects.toMatchObject({
      status: 403,
    });
    expect(h.rules.activateGlobalRuleNumber).not.toHaveBeenCalled();
    expect(h.reprocess.reprocess).not.toHaveBeenCalled();
  });

  it("recusa um id de número inválido", async () => {
    const h = harness("owner");
    await expect(
      h.rulesController.activateProviderRuleNumber("session", "rule_1", "x".repeat(300)),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.rules.activateGlobalRuleNumber).not.toHaveBeenCalled();
  });
});

describe("GlobalRuleAutoActivationService", () => {
  const now = new Date("2026-10-22T12:00:00.000Z");
  const minutes = (value: number) => new Date(now.getTime() + value * 60_000);

  function harness(
    options: {
      workspaces?: number;
      locked?: boolean;
      bridgeEvents?: RRow[];
      licenseLocked?: boolean;
    } = {},
  ) {
    const ids = Array.from(
      { length: options.workspaces ?? 3 },
      (_, index) => `ws_${String(index).padStart(4, "0")}`,
    );
    const bridgeEvents = options.bridgeEvents ?? [];
    const tx = { $queryRaw: vi.fn(async () => [{ locked: options.locked ?? true }]) };
    const prisma: RRow = {
      $transaction: vi.fn(async (callback: (client: RRow) => unknown, settings: RRow) => {
        prisma.lastTransactionSettings = settings;
        return callback(tx);
      }),
      providerConversionRuleConfig: {
        groupBy: vi.fn(async ({ where, take }: RRow) =>
          ids
            .filter((id) => !where.workspaceId || id > where.workspaceId.gt)
            .slice(0, take)
            .map((workspaceId) => ({ workspaceId })),
        ),
      },
      auditLog: {
        findFirst: vi.fn(
          async ({ where }: RRow) =>
            bridgeEvents
              .filter(
                (row) =>
                  row.workspaceId === where.workspaceId && row.createdAt >= where.createdAt.gte,
              )
              .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null,
        ),
        create: vi.fn(),
      },
    };
    const rules = {
      autoActivateGlobalNumbers: vi.fn(async () => ({ attempted: 0, promoted: 0 })),
    };
    const license = {
      getLockState: vi.fn(async () => ({ locked: options.licenseLocked ?? false })),
    };
    const service = new GlobalRuleAutoActivationService(
      prisma as never,
      env,
      rules as never,
      license as never,
    );
    return { service, prisma, rules, tx, license };
  }

  it("só roda segurando o lock, sem gravar auditoria de lease", async () => {
    const free = harness();
    expect(await free.service.tick(now)).toEqual(["ws_0000", "ws_0001", "ws_0002"]);
    expect(free.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(free.prisma.auditLog.create).not.toHaveBeenCalled();
    expect(free.prisma.lastTransactionSettings.timeout).toBeGreaterThan(40_000);

    const busy = harness({ locked: false });
    expect(await busy.service.tick(now)).toEqual([]);
    expect(busy.rules.autoActivateGlobalNumbers).not.toHaveBeenCalled();
  });

  it("confere todos na primeira rodada e depois de hora em hora; no meio, só quem teve evento de ponte", async () => {
    const h = harness({
      bridgeEvents: [
        { workspaceId: "ws_0001", createdAt: minutes(1) },
        { workspaceId: "ws_0002", createdAt: minutes(-30) },
      ],
    });

    await h.service.tick(now);
    expect(h.rules.autoActivateGlobalNumbers).toHaveBeenCalledTimes(3);
    expect(h.rules.autoActivateGlobalNumbers).toHaveBeenCalledWith(
      "ws_0000",
      "reconcile",
      expect.objectContaining({ eventAt: null, now, shouldStop: expect.any(Function) }),
    );

    h.rules.autoActivateGlobalNumbers.mockClear();
    expect(await h.service.tick(minutes(2))).toEqual(["ws_0001"]);
    expect(h.rules.autoActivateGlobalNumbers).toHaveBeenCalledWith(
      "ws_0001",
      "bridge_created",
      expect.objectContaining({ eventAt: minutes(1), now: minutes(2) }),
    );

    h.rules.autoActivateGlobalNumbers.mockClear();
    expect(await h.service.tick(minutes(20))).toEqual([]);
    expect(await h.service.tick(minutes(61))).toEqual(["ws_0000", "ws_0001", "ws_0002"]);
  });

  it("percorre mais de 200 workspaces em rodadas, dentro do orçamento de tempo", async () => {
    const h = harness({ workspaces: 450 });
    let fakeTime = 0;
    const clock = () => (fakeTime += 1_000);

    const seen: string[] = [];
    for (let run = 0; run < 40 && seen.length < 450; run += 1) {
      seen.push(...(await h.service.tick(now, clock)));
    }

    expect(seen).toHaveLength(450);
    expect(new Set(seen).size).toBe(450);
    expect(seen.at(-1)).toBe("ws_0449");
  });

  it("o limite de tempo também vale dentro de um workspace (antes do timeout do lock)", async () => {
    const h = harness({ workspaces: 1 });
    let fakeTime = 0;
    const clock = () => fakeTime;
    const stops: boolean[] = [];
    h.rules.autoActivateGlobalNumbers.mockImplementationOnce((async (_ws: string, _t: string, options: RRow) => {
      stops.push(options.shouldStop());
      fakeTime = 40_000 + 29_000; // still inside the hard stop
      stops.push(options.shouldStop());
      fakeTime = 40_000 + 30_000; // reached it: stop before the next number
      stops.push(options.shouldStop());
      return { attempted: 0, promoted: 0 };
    }) as never);
    await h.service.tick(now, clock);
    expect(stops).toEqual([false, false, true]);
    // Lock timeout (budget + 45 s) is above the hard stop (budget + 30 s).
    expect(h.prisma.lastTransactionSettings.timeout).toBeGreaterThan(70_000);
  });

  it("com a licença bloqueada não roda nada (fail-closed)", async () => {
    const h = harness({ licenseLocked: true });
    expect(await h.service.tick(now)).toEqual([]);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.rules.autoActivateGlobalNumbers).not.toHaveBeenCalled();

    h.license.getLockState.mockRejectedValueOnce(new Error("offline"));
    expect(await h.service.tick(now)).toEqual([]);
    expect(h.rules.autoActivateGlobalNumbers).not.toHaveBeenCalled();
  });
});

describe("UazapiConversionBridgeService: evento durável da ponte", () => {
  it("grava inbound_webhook.uazapi_bridge_provisioned na mesma transação da ponte", async () => {
    const auditCreate = vi.fn().mockResolvedValue({});
    const prisma: RRow = {
      inboundWebhookChannel: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (fn: (tx: RRow) => unknown) =>
        fn({
          inboundWebhookChannel: {
            findUnique: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: "channel_new" }),
          },
          inboundWebhookParserRelease: {
            upsert: vi.fn().mockResolvedValue({ id: "release_uazapi" }),
          },
          inboundWebhookConnection: {
            create: vi.fn().mockResolvedValue({ id: "connection_new" }),
          },
          auditLog: { create: auditCreate },
        }),
      ),
    };
    const bridge = new UazapiConversionBridgeService(prisma as never);

    await expect(
      bridge.ensureBridge({
        id: "instance_1",
        workspaceId: "workspace_1",
        name: "QR novo",
        providerInstanceId: "provider_1",
        connectedPhone: "5511999990000",
      }),
    ).resolves.toEqual({ connectionId: "connection_new", channelId: "channel_new" });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace_1",
        actorType: "system",
        action: "inbound_webhook.uazapi_bridge_provisioned",
        targetId: "channel_new",
      }),
    });
  });
});

describe("migration 20261022120000_provider_rule_blocked_reprocess_index (texto, sem PostgreSQL)", () => {
  it("é uma única instrução CREATE INDEX CONCURRENTLY IF NOT EXISTS (o Prisma a roda fora de transação)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const migrationsDir = resolve(__dirname, "../../prisma/migrations");
    const sql = readFileSync(
      resolve(migrationsDir, "20261022120000_provider_rule_blocked_reprocess_index/migration.sql"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const statements = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean);
    expect(statements).toEqual([
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "ProviderConversionRuleExecution_rule_status_occurredAt_idx" ON "ProviderConversionRuleExecution"("workspaceId", "providerRuleId", "status", "occurredAt")',
    ]);
    // Same pattern as the earlier concurrent index migration.
    const precedent = readFileSync(
      resolve(migrationsDir, "20260709233000_lead_ctwa_index_concurrently/migration.sql"),
      "utf8",
    );
    expect(precedent).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
    const schema = readFileSync(resolve(__dirname, "../../prisma/schema.prisma"), "utf8");
    expect(schema).toContain(
      'map: "ProviderConversionRuleExecution_rule_status_occurredAt_idx"',
    );
  });
});
