import "reflect-metadata";
import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ProviderConversionRulesService } from "../../src/conversion-rules/provider-conversion-rules.service";
import { GlobalRuleAutoActivationService } from "../../src/conversion-rules/provider-rule-global-auto-activation.service";
import {
  pendingNumberState,
  pendingReasonFromError,
} from "../../src/conversion-rules/provider-rule-global-activation";

// ---------------------------------------------------------------------------
// "Todos os números" x production gates (porte do SaaS #152 para o aluno):
// a global rule promotes its covered numbers, each in its own transaction,
// and reports the others as pending. The aluno has no seats nor charges: a
// QR number is promoted while its WhatsApp connection is active.
// Mock transaction oracle, not PostgreSQL (see global-rule-production.pg).
// ---------------------------------------------------------------------------

type GRow = Record<string, any>;

function gMatches(
  object: GRow | null | undefined,
  where: GRow | undefined,
): boolean {
  if (!where) return true;
  if (!object) return false;
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (key === "AND") {
      if (!(condition as GRow[]).every((item) => gMatches(object, item)))
        return false;
      continue;
    }
    if (key === "OR") {
      if (!(condition as GRow[]).some((item) => gMatches(object, item)))
        return false;
      continue;
    }
    const value = object[key];
    if (condition === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (condition instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== condition.getTime())
        return false;
      continue;
    }
    if (typeof condition !== "object") {
      if (value !== condition) return false;
      continue;
    }
    if ("in" in condition) {
      if (!condition.in.includes(value)) return false;
      continue;
    }
    if ("not" in condition) {
      if (condition.not === null) {
        if (value === null || value === undefined) return false;
      } else if (typeof condition.not === "object") {
        if (gMatches(value, condition.not)) return false;
      } else if (value === condition.not) return false;
      continue;
    }
    if ("gte" in condition || "lt" in condition || "gt" in condition) {
      if (condition.gte !== undefined && !(value >= condition.gte)) return false;
      if (condition.gt !== undefined && !(value > condition.gt)) return false;
      if (condition.lt !== undefined && !(value < condition.lt)) return false;
      continue;
    }
    if ("equals" in condition) {
      if (value !== condition.equals) return false;
      continue;
    }
    if ("some" in condition) {
      if (
        !Array.isArray(value) ||
        !value.some((item) => gMatches(item, condition.some))
      )
        return false;
      continue;
    }
    if ("is" in condition) {
      if (condition.is === null) {
        if (value !== null && value !== undefined) return false;
        continue;
      }
      if (!value || !gMatches(value, condition.is)) return false;
      continue;
    }
    if (!value || !gMatches(value, condition)) return false;
  }
  return true;
}

const gNow = new Date("2026-10-22T12:00:00.000Z");
const gEnv = {
  NODE_ENV: "test",
  API_PUBLIC_URL: "https://api.wpptrack.test",
  INBOUND_WEBHOOKS_ENABLED: "true",
  INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
  INBOUND_CONVERSION_RULES_ENABLED: "true",
  INBOUND_CONVERSION_PRODUCTION_ENABLED: "true",
  INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

type GNumber = {
  key: string;
  provider: "uazapi" | "umbler" | "waha";
  connectionStatus?: "observation" | "production" | "paused";
  channelStatus?: "discovered" | "active" | "paused";
  validRoute?: boolean;
  replayInFlight?: boolean;
  /** UAZAPI WhatsApp connection status (default active). */
  instanceStatus?: "active" | "suspended" | "pending_payment";
};

function globalWorld(numbers: GNumber[]) {
  const releases: GRow[] = [
    { id: "release_umbler", provider: "umbler", version: "v1", status: "certified" },
    { id: "release_uazapi", provider: "uazapi", version: "v1", status: "certified" },
    { id: "release_waha", provider: "waha", version: "v2", status: "certified" },
  ];
  const state = {
    connections: [] as GRow[],
    channels: [] as GRow[],
    instances: [] as GRow[],
    conversionRules: [] as GRow[],
    providerRules: [] as GRow[],
    ruleChannels: [] as GRow[],
    audits: [] as GRow[],
    replays: [] as GRow[],
  };
  numbers.forEach((number, index) => {
    const connectionId = `connection_${number.key}`;
    const channelId = `channel_${number.key}`;
    const stamp = new Date(gNow.getTime() - 10_000 + index);
    state.connections.push({
      id: connectionId,
      workspaceId: "workspace_1",
      provider: number.provider,
      displayName: number.key,
      parserReleaseId: `release_${number.provider}`,
      status: number.connectionStatus ?? "observation",
      productionActivatedAt:
        number.connectionStatus === "production" ? stamp : null,
      removedAt: null,
      createdAt: stamp,
      updatedAt: stamp,
    });
    const instanceId =
      number.provider !== "umbler" ? `instance_${number.key}` : null;
    if (instanceId) {
      state.instances.push({
        id: instanceId,
        status: number.instanceStatus ?? "active",
      });
    }
    state.channels.push({
      id: channelId,
      workspaceId: "workspace_1",
      connectionId,
      organizationId: "org",
      providerChannelId: channelId,
      channelName: `Número ${number.key}`,
      connectedPhone: `55119999${String(index).padStart(2, "0")}0000`,
      whatsappInstanceId: instanceId,
      metaRoutingMode: "channel_override",
      status: number.channelStatus ?? "discovered",
      productionActivatedAt:
        number.channelStatus === "active" &&
        number.connectionStatus === "production"
          ? stamp
          : null,
      createdAt: stamp,
      updatedAt: stamp,
      routes:
        number.validRoute === false || number.provider !== "umbler"
          ? []
          : [
              {
                id: `route_${number.key}`,
                workspaceId: "workspace_1",
                active: true,
                validationStatus: "valid",
                metaBusinessConnectionId: "bm_1",
                metaReportingAccountId: "act_1",
                metaConversionDestinationId: "dataset_1",
                createdAt: stamp,
              },
            ],
    });
    if (number.replayInFlight) {
      state.replays.push({
        workspaceId: "workspace_1",
        connectionId,
        status: "processing",
      });
    }
  });
  let sequence = 0;
  const clock = { now: new Date(gNow) };
  const nextId = (prefix: string) => `${prefix}_${++sequence}`;
  const release = (id: string | null) =>
    releases.find((item) => item.id === id) ?? null;
  const hydrateConnection = (connection: GRow | undefined | null) =>
    connection
      ? { ...connection, parserRelease: release(connection.parserReleaseId) }
      : null;
  const hydrateChannel = (channel: GRow) => ({
    ...channel,
    connection: hydrateConnection(
      state.connections.find((item) => item.id === channel.connectionId),
    ),
    routes: channel.routes.filter((route: GRow) => route.active),
    whatsappInstance: channel.whatsappInstanceId
      ? (state.instances.find((item) => item.id === channel.whatsappInstanceId) ??
        null)
      : null,
  });
  const hydrateRule = (rule: GRow) => ({
    ...rule,
    conversionRule: state.conversionRules.find(
      (item) => item.id === rule.conversionRuleId,
    ),
    connection: hydrateConnection(
      state.connections.find((item) => item.id === rule.connectionId),
    ),
    parserRelease: release(rule.parserReleaseId),
    channels: state.ruleChannels.filter(
      (item) => item.providerRuleId === rule.id,
    ),
    endpoint: null,
    catalog: null,
    executions: [],
  });
  const updateRows = (rows: GRow[], where: GRow, data: GRow) => {
    const matched = rows.filter((item) => gMatches(item, where));
    matched.forEach((row) => Object.assign(row, data));
    return { count: matched.length };
  };

  const prisma: GRow = {
    $queryRaw: vi.fn(async () => []),
    inboundWebhookConnection: {
      findFirst: vi.fn(async ({ where }: GRow) =>
        hydrateConnection(
          state.connections.find((item) => gMatches(item, where)),
        ),
      ),
      updateMany: vi.fn(async ({ where, data }: GRow) =>
        updateRows(state.connections, where, data),
      ),
    },
    inboundWebhookChannel: {
      count: vi.fn(
        async ({ where }: GRow) =>
          state.channels
            .map(hydrateChannel)
            .filter((item) => gMatches(item, where)).length,
      ),
      findFirst: vi.fn(
        async ({ where }: GRow) =>
          state.channels
            .map(hydrateChannel)
            .find((item) => gMatches(item, where)) ?? null,
      ),
      findMany: vi.fn(async ({ where }: GRow) =>
        state.channels
          .map(hydrateChannel)
          .filter((item) => gMatches(item, where)),
      ),
      updateMany: vi.fn(async ({ where, data }: GRow) =>
        updateRows(state.channels, where, data),
      ),
    },
    inboundWebhookReplayBatch: {
      count: vi.fn(
        async ({ where }: GRow) =>
          state.replays.filter((item) => gMatches(item, where)).length,
      ),
    },
    inboundWebhookParserRelease: {
      findFirst: vi.fn(async () => null),
    },
    // Meta route eligibility of the Umbler routes (one valid BM/dataset).
    metaBusinessConnection: {
      findFirst: vi.fn(async ({ where }: GRow) =>
        where.id === "bm_1"
          ? {
              id: "bm_1",
              workspaceId: "workspace_1",
              status: "active",
              credential: { workspaceId: "workspace_1", status: "active" },
            }
          : null,
      ),
    },
    metaReportingAccount: {
      findMany: vi.fn(async () => [
        {
          id: "act_1",
          conversionDestinationId: "dataset_1",
          allowedDestinations: [],
        },
      ]),
    },
    metaConversionDestination: {
      findFirst: vi.fn(async () => ({ id: "dataset_1" })),
    },
    integrationEndpoint: {
      findFirst: vi.fn(async () => null),
    },
    conversionRule: {
      create: vi.fn(async ({ data }: GRow) => {
        const row = {
          id: nextId("conversion"),
          createdAt: gNow,
          updatedAt: gNow,
          pixelId: null,
          ...data,
          defaultItems:
            data.defaultItems &&
            typeof data.defaultItems === "object" &&
            !("_getName" in data.defaultItems)
              ? data.defaultItems
              : null,
        };
        state.conversionRules.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: GRow) => {
        const row = state.conversionRules.find(
          (item) => item.id === where.id,
        )!;
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: GRow) =>
        updateRows(state.conversionRules, where, data),
      ),
      findFirst: vi.fn(
        async ({ where }: GRow) =>
          state.conversionRules.find((item) => gMatches(item, where)) ?? null,
      ),
    },
    providerConversionRuleConfig: {
      create: vi.fn(async ({ data }: GRow) => {
        const row = {
          id: nextId("provider_rule"),
          createdAt: new Date(gNow.getTime() + sequence),
          updatedAt: gNow,
          removedAt: null,
          unifiedIntoProviderRuleId: null,
          scope: "specific_numbers",
          productFilterCodes: [],
          ...data,
        };
        state.providerRules.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: GRow) => {
        const row = state.providerRules.find((item) => item.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: GRow) =>
        updateRows(state.providerRules, where, data),
      ),
      findFirst: vi.fn(
        async ({ where }: GRow) =>
          state.providerRules
            .map(hydrateRule)
            .find((item) => gMatches(item, where)) ?? null,
      ),
      findMany: vi.fn(async ({ where }: GRow) =>
        state.providerRules
          .map(hydrateRule)
          .filter((item) => gMatches(item, where)),
      ),
    },
    providerConversionRuleChannel: {
      createMany: vi.fn(async ({ data }: GRow) => {
        for (const row of data)
          state.ruleChannels.push({ id: nextId("scope"), ...row });
        return { count: data.length };
      }),
      deleteMany: vi.fn(async ({ where }: GRow) => {
        const kept = state.ruleChannels.filter(
          (item) => !gMatches(item, where),
        );
        const count = state.ruleChannels.length - kept.length;
        state.ruleChannels.splice(0, state.ruleChannels.length, ...kept);
        return { count };
      }),
    },
    providerConversionRuleExecution: {
      count: vi.fn(async () => 0),
    },
    auditLog: {
      create: vi.fn(async ({ data }: GRow) => {
        const row = { createdAt: clock.now, ...data };
        state.audits.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where }: GRow) =>
        state.audits.filter((row) => gMatches(row, where)),
      ),
    },
  };
  // Rollback oracle: a throwing callback restores the rows it may have
  // touched, so a number whose activation fails leaves nothing half-promoted.
  prisma.$transaction = vi.fn(async (callback: (client: GRow) => unknown) => {
    const snapshot = structuredClone({
      connections: state.connections,
      channels: state.channels,
      audits: state.audits,
    });
    try {
      return await callback(prisma);
    } catch (error) {
      state.connections.splice(
        0,
        state.connections.length,
        ...snapshot.connections,
      );
      state.channels.splice(0, state.channels.length, ...snapshot.channels);
      state.audits.splice(0, state.audits.length, ...snapshot.audits);
      throw error;
    }
  });

  const service = new ProviderConversionRulesService(prisma as never, gEnv);
  const channel = (key: string) =>
    state.channels.find((item) => item.id === `channel_${key}`)!;
  const connection = (key: string) =>
    state.connections.find((item) => item.id === `connection_${key}`)!;
  return { service, prisma, state, channel, connection, clock };
}

function globalMessageInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Frase do QR code",
    triggerType: "message_phrase",
    triggerPhrases: ["pagamento confirmado"],
    messageAuthorScope: "team",
    eventName: "QualifiedLead",
    valueMode: "fixed",
    scope: "all_numbers",
    channelIds: [],
    mode: "production",
    ...overrides,
  } as never;
}

async function createGlobal(
  world: ReturnType<typeof globalWorld>,
  overrides: Record<string, unknown> = {},
) {
  const result = (await world.service.createRule(
    "workspace_1",
    globalMessageInput(overrides),
    "user_1",
  )) as { rule: GRow };
  return result.rule;
}

describe("Todos os números: a regra global ativa os números (sem vaga nem cobrança)", () => {
  it("1 número QR: criar a regra global em produção ativa o número na hora", async () => {
    const world = globalWorld([{ key: "qr", provider: "uazapi" }]);

    const rule = await createGlobal(world);

    expect(world.connection("qr").status).toBe("production");
    expect(world.connection("qr").productionActivatedAt).toBeInstanceOf(Date);
    expect(world.channel("qr").status).toBe("active");
    expect(world.channel("qr").productionActivatedAt).toBeInstanceOf(Date);
    expect(rule.scope).toBe("all_numbers");
    expect(rule.pendingNumbers).toEqual([]);
    expect(world.state.audits.map((audit) => audit.action)).toEqual(
      expect.arrayContaining([
        "provider_conversion_rule.created",
        "inbound_webhook.channel_activated",
        "inbound_webhook.connection_promoted",
        "provider_conversion_rule.global_numbers_activated",
      ]),
    );
    // A human save keeps the human actor on every activation audit.
    expect(
      world.state.audits.find(
        (audit) => audit.action === "inbound_webhook.connection_promoted",
      ),
    ).toMatchObject({ actorType: "user", actorUserId: "user_1" });
  });

  it("N números (QR e Umbler com rota): todos passam a enviar; conexão WhatsApp não ativa e Umbler sem rota ficam pendentes", async () => {
    const world = globalWorld([
      { key: "qr_a", provider: "uazapi" },
      { key: "qr_b", provider: "uazapi" },
      { key: "qr_c", provider: "uazapi" },
      { key: "qr_off", provider: "uazapi", instanceStatus: "pending_payment" },
      { key: "umbler", provider: "umbler" },
      { key: "umbler_no_route", provider: "umbler", validRoute: false },
    ]);

    const rule = await createGlobal(world);

    for (const key of ["qr_a", "qr_b", "qr_c", "umbler"]) {
      expect(world.connection(key).status).toBe("production");
      expect(world.channel(key).status).toBe("active");
    }
    expect(world.connection("qr_off").status).toBe("observation");
    expect(world.connection("umbler_no_route").status).toBe("observation");
    expect(world.channel("umbler_no_route").status).toBe("discovered");
    expect(
      rule.pendingNumbers.map((number: GRow) => [
        number.channelId,
        number.reason,
        number.activatable,
      ]),
    ).toEqual([
      ["channel_qr_off", "whatsapp_connection_inactive", false],
      ["channel_umbler_no_route", "meta_route_missing", false],
    ]);
    expect(world.state.providerRules).toHaveLength(1);
  });

  it("conexão WhatsApp suspensa em Integrações fica fora da regra; o health check não bloqueia", async () => {
    const world = globalWorld([
      { key: "qr_suspended", provider: "uazapi", instanceStatus: "suspended" },
      { key: "qr_health_down", provider: "uazapi" },
    ]);
    // A stale health check saying "disconnected" never blocks the activation.
    world.state.instances.find((row) => row.id === "instance_qr_health_down")!.lastHealthStatus =
      "disconnected";

    const rule = await createGlobal(world);

    expect(world.connection("qr_suspended").status).toBe("observation");
    expect(world.connection("qr_health_down").status).toBe("production");
    expect(rule.effectiveChannelIds).toEqual(["channel_qr_health_down"]);
    expect(rule.pendingNumbers).toEqual([]);
  });

  it("um número que falha no meio é revertido sozinho e continua pendente", async () => {
    const world = globalWorld([
      { key: "qr_ok", provider: "uazapi" },
      { key: "qr_replaying", provider: "uazapi", replayInFlight: true },
    ]);

    const rule = await createGlobal(world);

    expect(world.connection("qr_ok").status).toBe("production");
    expect(world.channel("qr_replaying").status).toBe("discovered");
    expect(world.connection("qr_replaying").status).toBe("observation");
    expect(rule.pendingNumbers).toEqual([
      expect.objectContaining({
        channelId: "channel_qr_replaying",
        reason: "channel_not_active",
        activatable: true,
      }),
    ]);
    const summary = world.state.audits.find(
      (audit) =>
        audit.action === "provider_conversion_rule.global_numbers_activated",
    );
    expect(summary?.afterSummary.pending).toEqual([
      expect.objectContaining({
        channelId: "channel_qr_replaying",
        errorCode: "conflict",
      }),
    ]);
  });

  it("regra criada em observação não ativa nada, mas já lista o que vai ficar pendente", async () => {
    const world = globalWorld([
      { key: "qr", provider: "uazapi" },
      { key: "qr_off", provider: "uazapi", instanceStatus: "pending_payment" },
    ]);

    const rule = await createGlobal(world, { mode: "observation" });

    expect(world.connection("qr").status).toBe("observation");
    expect(
      rule.pendingNumbers.map((number: GRow) => [number.channelId, number.reason]),
    ).toEqual([
      ["channel_qr", "channel_not_active"],
      ["channel_qr_off", "whatsapp_connection_inactive"],
    ]);
  });

  it("ligar o Envio ativo (observação → produção) ativa os números", async () => {
    const world = globalWorld([
      { key: "qr", provider: "uazapi" },
      { key: "qr_off", provider: "uazapi", instanceStatus: "pending_payment" },
    ]);
    const rule = await createGlobal(world, { mode: "observation" });

    const updated = await world.service.updateRule(
      "workspace_1",
      rule.id,
      { mode: "production" } as never,
      "user_1",
    );

    expect(world.connection("qr").status).toBe("production");
    expect(world.channel("qr").status).toBe("active");
    expect(world.connection("qr_off").status).toBe("observation");
    expect(updated.pendingNumbers).toEqual([
      expect.objectContaining({
        channelId: "channel_qr_off",
        reason: "whatsapp_connection_inactive",
      }),
    ]);
  });

  it("específica: editar uma regra específica em produção para todos os números ativa os novos números", async () => {
    const world = globalWorld([
      {
        key: "live",
        provider: "uazapi",
        connectionStatus: "production",
        channelStatus: "active",
      },
      { key: "qr_new", provider: "uazapi" },
    ]);
    const rule = await createGlobal(world, {
      scope: "specific_numbers",
      channelIds: ["channel_live"],
    });
    expect(rule.pendingNumbers).toBeUndefined();
    expect(world.connection("qr_new").status).toBe("observation");

    const updated = await world.service.updateRule(
      "workspace_1",
      rule.id,
      { scope: "all_numbers" } as never,
      "user_1",
    );

    expect(updated.scope).toBe("all_numbers");
    expect(world.connection("qr_new").status).toBe("production");
    expect(updated.pendingNumbers).toEqual([]);
  });

  it("específica em produção continua ativando só os números dela", async () => {
    const world = globalWorld([
      { key: "qr_a", provider: "uazapi" },
      { key: "qr_b", provider: "uazapi" },
    ]);

    await createGlobal(world, {
      scope: "specific_numbers",
      channelIds: ["channel_qr_a"],
    });

    expect(world.connection("qr_a").status).toBe("production");
    expect(world.connection("qr_b").status).toBe("observation");
  });

  it("global + específica no mesmo número: o número fica com a específica e não aparece pendente na global", async () => {
    const world = globalWorld([
      { key: "qr_a", provider: "uazapi" },
      { key: "qr_b", provider: "uazapi" },
    ]);
    await createGlobal(world, {
      scope: "specific_numbers",
      channelIds: ["channel_qr_a"],
    });

    const global = await createGlobal(world);

    expect(world.connection("qr_a").status).toBe("production");
    expect(world.connection("qr_b").status).toBe("production");
    expect(global.effectiveChannelIds).toEqual(["channel_qr_b"]);
    expect(global.overriddenChannelIds).toEqual(["channel_qr_a"]);
    expect(global.pendingNumbers).toEqual([]);
    // Each number was promoted exactly once.
    expect(
      world.state.audits.filter(
        (audit) =>
          audit.action === "inbound_webhook.connection_promoted" &&
          audit.targetId === "connection_qr_a",
      ),
    ).toHaveLength(1);
  });

  it("Unificar numa regra para todos os números em produção ativa os números cobertos", async () => {
    const world = globalWorld([
      {
        key: "live_a",
        provider: "uazapi",
        connectionStatus: "production",
        channelStatus: "active",
      },
      {
        key: "live_b",
        provider: "uazapi",
        connectionStatus: "production",
        channelStatus: "active",
      },
      { key: "qr_new", provider: "uazapi" },
      { key: "qr_off", provider: "uazapi", instanceStatus: "pending_payment" },
    ]);
    const first = await createGlobal(world, {
      scope: "specific_numbers",
      channelIds: ["channel_live_a"],
    });
    const second = await createGlobal(world, {
      scope: "specific_numbers",
      channelIds: ["channel_live_b"],
    });

    const unified = await world.service.unifyRules(
      "workspace_1",
      { ruleIds: [first.id, second.id] },
      "user_1",
    );

    expect(unified.outcome).toBe("created");
    expect(unified.rule.mode).toBe("production");
    expect(world.connection("qr_new").status).toBe("production");
    expect(world.connection("qr_off").status).toBe("observation");
    expect(unified.rule.pendingNumbers).toEqual([
      expect.objectContaining({
        channelId: "channel_qr_off",
        reason: "whatsapp_connection_inactive",
      }),
    ]);
  });

  it("Umbler: um irmão ativo sem rota na mesma conexão mantém o número pendente (a promoção exigiria rota para todos)", async () => {
    const world = globalWorld([{ key: "umbler", provider: "umbler" }]);
    world.state.channels.push({
      ...structuredClone(world.channel("umbler")),
      id: "channel_umbler_sibling",
      channelName: "Irmão sem rota",
      connectedPhone: "5511988887777",
      status: "active",
      routes: [],
    });

    const rule = await createGlobal(world);

    expect(world.connection("umbler").status).toBe("observation");
    expect(rule.pendingNumbers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channelId: "channel_umbler",
          reason: "meta_route_missing",
        }),
      ]),
    );
  });

  it("canal pausado pelo operador continua pausado; “Ativar envio neste número” o retoma por clique explícito", async () => {
    const world = globalWorld([
      { key: "qr_paused", provider: "uazapi", channelStatus: "paused" },
      { key: "qr_off", provider: "uazapi", instanceStatus: "pending_payment" },
    ]);
    const rule = await createGlobal(world);
    // The automatic cascade never resumes a channel an operator paused.
    expect(world.channel("qr_paused").status).toBe("paused");
    expect(world.connection("qr_paused").status).toBe("observation");

    const activated = await world.service.activateGlobalRuleNumber(
      "workspace_1",
      rule.id,
      "channel_qr_paused",
      "user_1",
    );
    expect(activated.outcome).toBe("promoted");
    expect(world.channel("qr_paused").status).toBe("active");
    expect(world.connection("qr_paused").status).toBe("production");

    const refused = await world.service.activateGlobalRuleNumber(
      "workspace_1",
      rule.id,
      "channel_qr_off",
      "user_1",
    );
    expect(refused).toMatchObject({
      outcome: "pending",
      reason: "whatsapp_connection_inactive",
    });
    expect(world.connection("qr_off").status).toBe("observation");
    expect(world.state.audits.at(-1)).toMatchObject({
      action: "provider_conversion_rule.number_activation",
      resultStatus: "pending",
    });

    await expect(
      world.service.activateGlobalRuleNumber(
        "workspace_1",
        rule.id,
        "channel_other",
        "user_1",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("conexão pausada pelo operador nunca é retomada pela regra nem pelo botão", async () => {
    const world = globalWorld([
      {
        key: "umbler",
        provider: "umbler",
        connectionStatus: "paused",
        channelStatus: "active",
      },
    ]);
    world.state.channels.push({
      ...structuredClone(world.channel("umbler")),
      id: "channel_umbler_other",
      channelName: "Outro número da conexão",
      connectedPhone: "5511977776666",
      status: "active",
    });
    const rule = await createGlobal(world);
    expect(rule.pendingNumbers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channelId: "channel_umbler",
          reason: "connection_paused",
          activatable: false,
        }),
      ]),
    );

    const result = await world.service.activateGlobalRuleNumber(
      "workspace_1",
      rule.id,
      "channel_umbler",
      "user_1",
    );

    expect(result).toMatchObject({ outcome: "pending", reason: "connection_paused" });
    expect(world.connection("umbler").status).toBe("paused");
  });

  it("“Ativar envio neste número” exige a regra em produção", async () => {
    const world = globalWorld([{ key: "qr", provider: "uazapi" }]);
    const rule = await createGlobal(world, { mode: "observation" });

    await expect(
      world.service.activateGlobalRuleNumber(
        "workspace_1",
        rule.id,
        "channel_qr",
        "user_1",
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(world.connection("qr").status).toBe("observation");
  });

  it("uma repetição idempotente da criação roda a ativação que a primeira tentativa não terminou", async () => {
    const world = globalWorld([
      { key: "qr", provider: "uazapi", instanceStatus: "suspended" },
    ]);
    const claims: GRow[] = [];
    world.prisma.providerRuleCreateClaim = {
      findUnique: vi.fn(
        async ({ where }: GRow) =>
          claims.find(
            (claim) =>
              claim.requestKey === where.workspaceId_requestKey.requestKey,
          ) ?? null,
      ),
      create: vi.fn(async ({ data }: GRow) => {
        const claim = { id: "claim_1", createdAt: gNow, ...data };
        claims.push(claim);
        return claim;
      }),
    };
    const key = "prc_0123456789abcdef0123456789abcdef";

    const first = (await world.service.createRule(
      "workspace_1",
      globalMessageInput(),
      "user_1",
      key,
    )) as GRow;
    expect(first.outcome).toBe("created");
    expect(world.connection("qr").status).toBe("observation");

    // The WhatsApp connection was reactivated in Integrações: the replay of
    // the same request finishes it.
    world.state.instances[0]!.status = "active";
    const replay = (await world.service.createRule(
      "workspace_1",
      globalMessageInput(),
      "user_1",
      key,
    )) as GRow;

    expect(replay.outcome).toBe("replayed");
    expect(world.state.providerRules).toHaveLength(1);
    expect(world.connection("qr").status).toBe("production");
    expect(world.channel("qr").status).toBe("active");
  });
});

describe("Todos os números: ativação automática de números conectados depois (ator sistema)", () => {
  function withAuto(
    world: ReturnType<typeof globalWorld>,
    license?: { locked: boolean },
  ) {
    world.prisma.$queryRaw = vi.fn(async () => [{ locked: true }]);
    world.prisma.providerConversionRuleConfig.groupBy = vi.fn(
      async ({ where, take }: GRow) => {
        const { workspaceId: cursor, ...rest } = where;
        const ids = [
          ...new Set(
            world.state.providerRules
              .map(
                (rule): GRow => ({
                  ...rule,
                  conversionRule: world.state.conversionRules.find(
                    (item) => item.id === rule.conversionRuleId,
                  ),
                }),
              )
              .filter((rule) => gMatches(rule, rest))
              .map((rule: GRow) => rule.workspaceId as string),
          ),
        ]
          .filter((id) => !cursor || id > cursor.gt)
          .sort();
        return ids.slice(0, take).map((workspaceId) => ({ workspaceId }));
      },
    );
    world.prisma.auditLog.findFirst = vi.fn(
      async ({ where }: GRow) =>
        [...world.state.audits]
          .reverse()
          .find(
            (row) =>
              (typeof where.action === "string"
                ? row.action === where.action
                : (where.action?.in ?? []).includes(row.action)) &&
              (where.workspaceId === undefined ||
                (row.workspaceId ?? null) === where.workspaceId) &&
              (row.createdAt ?? gNow) >= where.createdAt.gte,
          ) ?? null,
    );
    const licenseClient = license
      ? {
          getLockState: vi.fn(async () => ({
            inert: false,
            locked: license.locked,
            reason: license.locked ? "expired" : null,
            state: {},
          })),
        }
      : undefined;
    const auto = new GlobalRuleAutoActivationService(
      world.prisma as never,
      gEnv,
      world.service,
      licenseClient as never,
    );
    return { auto, licenseClient };
  }

  /** Detaches numbers so they can be "connected" after the rule exists. */
  function detach(world: ReturnType<typeof globalWorld>, keys: string[]) {
    const channels = world.state.channels.filter((row) =>
      keys.some((key) => row.id === `channel_${key}`),
    );
    const connections = world.state.connections.filter((row) =>
      keys.some((key) => row.id === `connection_${key}`),
    );
    world.state.channels.splice(
      0,
      world.state.channels.length,
      ...world.state.channels.filter((row) => !channels.includes(row)),
    );
    world.state.connections.splice(
      0,
      world.state.connections.length,
      ...world.state.connections.filter((row) => !connections.includes(row)),
    );
    return () => {
      world.state.connections.push(...connections);
      world.state.channels.push(...channels);
    };
  }

  function bridgeEvent(world: ReturnType<typeof globalWorld>, key: string, at: Date) {
    world.state.audits.push({
      workspaceId: "workspace_1",
      actorType: "system",
      action: "inbound_webhook.uazapi_bridge_provisioned",
      targetType: "InboundWebhookChannel",
      targetId: `channel_${key}`,
      createdAt: at,
    });
  }

  it("dois QR conectados depois da regra passam a enviar sozinhos, sem clique", async () => {
    const world = globalWorld([
      {
        key: "first",
        provider: "uazapi",
        connectionStatus: "production",
        channelStatus: "active",
      },
      { key: "qr_new_a", provider: "uazapi" },
      { key: "qr_new_b", provider: "uazapi" },
    ]);
    const connectLater = detach(world, ["qr_new_a", "qr_new_b"]);
    const rule = await createGlobal(world);
    expect(rule.pendingNumbers).toEqual([]);
    const { auto } = withAuto(world);
    await auto.tick(gNow); // boot reconciliation: nothing to do yet

    connectLater();
    bridgeEvent(world, "qr_new_a", gNow);
    bridgeEvent(world, "qr_new_b", gNow);
    const handled = await auto.tick(new Date(gNow.getTime() + 2 * 60_000));

    expect(handled).toEqual(["workspace_1"]);
    for (const key of ["qr_new_a", "qr_new_b"]) {
      expect(world.connection(key).status).toBe("production");
      expect(world.channel(key).status).toBe("active");
    }
    const autoAudits = world.state.audits.filter(
      (row) =>
        row.action === "provider_conversion_rule.global_number_auto_activated",
    );
    expect(autoAudits).toEqual([
      expect.objectContaining({
        actorType: "system",
        actorUserId: null,
        targetId: "channel_qr_new_a",
        resultStatus: "promoted",
        afterSummary: expect.objectContaining({
          ruleIds: [rule.id],
          trigger: "bridge_created",
        }),
      }),
      expect.objectContaining({
        targetId: "channel_qr_new_b",
        resultStatus: "promoted",
      }),
    ]);
    // The channel/connection activation audits are system ones too.
    expect(
      world.state.audits.find(
        (row) =>
          row.action === "inbound_webhook.connection_promoted" &&
          row.targetId === "connection_qr_new_a",
      ),
    ).toMatchObject({ actorType: "system", actorUserId: null });

    // Idempotent: another tick is a no-op (nothing pending any more).
    const before = world.state.audits.length;
    await auto.tick(new Date(gNow.getTime() + 4 * 60_000));
    expect(world.state.audits.length).toBe(before);
  });

  it("a conferência de hora em hora ativa um número sem evento (ex.: conexão WhatsApp reativada em Integrações)", async () => {
    const world = globalWorld([
      { key: "qr", provider: "uazapi", instanceStatus: "suspended" },
    ]);
    await createGlobal(world);
    expect(world.connection("qr").status).toBe("observation");
    const { auto } = withAuto(world);
    await auto.tick(gNow);
    expect(world.connection("qr").status).toBe("observation");

    world.state.instances[0]!.status = "active";
    await auto.tick(new Date(gNow.getTime() + 10 * 60_000));
    expect(world.connection("qr").status).toBe("observation"); // no event, no sweep yet
    await auto.tick(new Date(gNow.getTime() + 61 * 60_000));
    expect(world.connection("qr").status).toBe("production");
  });

  it("licença bloqueada: a ativação automática não roda (como o 423 das escritas)", async () => {
    const world = globalWorld([{ key: "qr", provider: "uazapi" }]);
    const connectLater = detach(world, ["qr"]);
    await createGlobal(world);
    connectLater();
    bridgeEvent(world, "qr", gNow);
    const license = { locked: true };
    const { auto } = withAuto(world, license);

    expect(await auto.tick(gNow)).toEqual([]);
    expect(world.connection("qr").status).toBe("observation");

    license.locked = false;
    expect(await auto.tick(new Date(gNow.getTime() + 60_000))).toEqual([
      "workspace_1",
    ]);
    expect(world.connection("qr").status).toBe("production");
  });

  it("nunca ativa com a regra pausada, nunca retoma número pausado; falhas ficam pendentes", async () => {
    const world = globalWorld([
      { key: "qr_paused", provider: "uazapi", channelStatus: "paused" },
      { key: "qr_off", provider: "uazapi", instanceStatus: "pending_payment" },
      { key: "umbler_no_route", provider: "umbler", validRoute: false },
    ]);
    await createGlobal(world);
    const { auto } = withAuto(world);

    expect(
      await world.service.autoActivateGlobalNumbers("workspace_1", "reconcile"),
    ).toEqual({ attempted: 0, promoted: 0 });
    expect(world.channel("qr_paused").status).toBe("paused");
    expect(world.connection("qr_off").status).toBe("observation");
    expect(world.connection("umbler_no_route").status).toBe("observation");

    // Paused rule: nothing at all, even with an activatable number waiting.
    world.channel("qr_paused").status = "discovered";
    world.state.conversionRules.find(
      (row) => row.id === world.state.providerRules[0]!.conversionRuleId,
    )!.active = false;
    expect(
      await world.service.autoActivateGlobalNumbers("workspace_1", "reconcile"),
    ).toEqual({ attempted: 0, promoted: 0 });
    expect(world.connection("qr_paused").status).toBe("observation");
    expect(await auto.tick(gNow)).toEqual([]);
  });

  it("nunca reativa um número que o operador devolveu para observação (nem na conferência de hora em hora)", async () => {
    const world = globalWorld([{ key: "qr", provider: "uazapi" }]);
    const rule = await createGlobal(world);
    expect(world.connection("qr").status).toBe("production");

    // "Voltar para observação" in Integrações.
    Object.assign(world.connection("qr"), {
      status: "observation",
      productionActivatedAt: null,
    });
    world.state.audits.push({
      workspaceId: "workspace_1",
      action: "inbound_webhook.connection_observation",
      targetType: "InboundWebhookConnection",
      targetId: "connection_qr",
      createdAt: gNow,
    });
    const { auto } = withAuto(world);

    await auto.tick(gNow);
    await auto.tick(new Date(gNow.getTime() + 61 * 60_000));

    expect(world.connection("qr").status).toBe("observation");
    expect(
      world.state.audits.filter(
        (row) =>
          row.action === "provider_conversion_rule.global_number_auto_activated",
      ),
    ).toEqual([]);
    // The human path keeps working: the button still promotes it.
    const result = await world.service.activateGlobalRuleNumber(
      "workspace_1",
      rule.id,
      "channel_qr",
      "user_1",
    );
    expect(result.outcome).toBe("promoted");
  });

  it("mais de 50 números sempre falhando não travam um número bom nem gravam auditoria a cada rodada", async () => {
    const failing = Array.from({ length: 55 }, (_, index) => ({
      key: `bad_${String(index).padStart(2, "0")}`,
      provider: "uazapi" as const,
      replayInFlight: true,
    }));
    const world = globalWorld([...failing, { key: "zz_good", provider: "uazapi" }]);
    const connectLater = detach(world, [
      ...failing.map((item) => item.key),
      "zz_good",
    ]);
    await createGlobal(world);
    connectLater();
    const { auto } = withAuto(world);
    const autoAudits = () =>
      world.state.audits.filter(
        (row) =>
          row.action === "provider_conversion_rule.global_number_auto_activated",
      );

    world.clock.now = gNow;
    await auto.tick(gNow); // reconcile: 50 attempts, all fail
    expect(autoAudits()).toHaveLength(50);
    expect(world.connection("zz_good").status).toBe("observation");

    const later = new Date(gNow.getTime() + 61 * 60_000);
    world.clock.now = later;
    await auto.tick(later); // failed ones in backoff, the rest is tried
    expect(world.connection("zz_good").status).toBe("production");
    expect(autoAudits()).toHaveLength(56);

    const activate = vi.spyOn(world.service as never as { activateCoveredNumber: () => unknown }, "activateCoveredNumber");
    const muchLater = new Date(gNow.getTime() + 8 * 60 * 60_000);
    world.clock.now = muchLater;
    await auto.tick(muchLater); // retried after the backoff, not re-audited
    expect(autoAudits()).toHaveLength(56);
    const channelsOf = () =>
      activate.mock.calls.map((call) => ((call as unknown[])[0] as GRow).channelId as string);
    const retried = channelsOf();
    expect(retried).toHaveLength(50); // bounded per run

    // The backoff follows that latest (unaudited) attempt, not the first
    // audit: one hour later nothing that just failed is tried again.
    activate.mockClear();
    const nextSweep = new Date(muchLater.getTime() + 61 * 60_000);
    world.clock.now = nextSweep;
    await auto.tick(nextSweep);
    // Only the 5 that did not fit in the previous run are tried now.
    expect(channelsOf()).toHaveLength(5);
    expect(channelsOf().filter((id) => retried.includes(id))).toEqual([]);
    expect(autoAudits()).toHaveLength(56);
  });

  it("o limite de tempo para no meio de um workspace", async () => {
    const world = globalWorld([
      { key: "a", provider: "uazapi" },
      { key: "b", provider: "uazapi" },
      { key: "c", provider: "uazapi" },
    ]);
    const connectLater = detach(world, ["a", "b", "c"]);
    await createGlobal(world);
    connectLater();
    let calls = 0;
    const result = await world.service.autoActivateGlobalNumbers("workspace_1", "reconcile", {
      now: gNow,
      shouldStop: () => calls++ >= 1,
    });
    expect(result).toEqual({ attempted: 1, promoted: 1 });
    expect(
      ["a", "b", "c"].filter((key) => world.connection(key).status === "production"),
    ).toHaveLength(1);
  });
});

describe("Todos os números: motivos (Umbler/Unnichat)", () => {
  const baseChannel = (overrides: GRow = {}) =>
    ({
      id: "channel_x",
      connectionId: "connection_x",
      status: "discovered",
      channelName: "Número X",
      connectedPhone: "5511999990000",
      whatsappInstanceId: null,
      connection: {
        id: "connection_x",
        provider: "unnichat",
        status: "observation",
        removedAt: null,
      },
      routes: [],
      whatsappInstance: null,
      ...overrides,
    }) as never;

  it("Unnichat sem rota salva não é bloqueado na lista (a política do workspace decide na ativação)", () => {
    const state = pendingNumberState({
      channel: baseChannel(),
      gate: { id: "connection_x", provider: "unnichat", status: "observation" },
      siblings: [],
    });
    expect(state).toMatchObject({
      reason: "channel_not_active",
      activatable: true,
      provider: "unnichat",
    });
  });

  it("a recusa de rota Meta da ativação (Umbler/Unnichat) vira meta_route_missing", () => {
    expect(
      pendingReasonFromError(
        new ConflictException(
          "Configure a Meta deste número (página e pixel do workspace ou rotas próprias) antes de ativar o canal",
        ),
        "channel_not_active",
      ),
    ).toBe("meta_route_missing");
    expect(
      pendingReasonFromError(
        new ConflictException("Todo canal ativo precisa de uma rota Meta valida"),
        "connection_not_production",
      ),
    ).toBe("meta_route_missing");
    expect(
      pendingReasonFromError(
        new ConflictException("Finalize o replay em andamento antes de ativar a produção"),
        "connection_not_production",
      ),
    ).toBe("connection_not_production");
  });

  it("QR sem telefone real não mostra o id da instância como telefone", () => {
    const state = pendingNumberState({
      channel: baseChannel({
        connectedPhone: "inst_abc123",
        whatsappInstanceId: "inst_abc123",
        whatsappInstance: { status: "active" },
        connection: {
          id: "connection_x",
          provider: "uazapi",
          status: "observation",
          removedAt: null,
        },
      }),
      gate: { id: "connection_x", provider: "uazapi", status: "observation" },
      siblings: [],
    });
    expect(state).toMatchObject({ phone: null, reason: "channel_not_active" });
  });
});

// ---------------------------------------------------------------------------
// Porte do SaaS #66 (3f59e2f7), #85 (ff28d8a1) e #86 (71e69a95): ligar o
// "Envio ativo" de uma regra específica não trava com número órfão (conexão
// removida, inclusive a ponte WAHA/Uazapi), nem com canal ativo sem carimbo,
// nem com o número redescoberto com outra identidade na mesma conexão.
// ---------------------------------------------------------------------------
describe("Envio ativo: número órfão ou duplicado não trava a regra (#66/#85/#86)", () => {
  it("#66 regra ligada a uma conexão: o número que saiu da conexão é tirado da regra e o resto ativa", async () => {
    const world = globalWorld([
      { key: "umbler", provider: "umbler" },
      { key: "gone", provider: "umbler" },
    ]);
    // A second number on the rule's connection...
    world.state.channels.push({
      ...structuredClone(world.channel("umbler")),
      id: "channel_umbler_2",
      connectedPhone: "5511977776666",
    });
    const rule = await createGlobal(world, {
      scope: "specific_numbers",
      connectionId: "connection_umbler",
      channelIds: ["channel_umbler", "channel_umbler_2"],
      mode: "observation",
    });
    expect(rule.connectionId).toBe("connection_umbler");
    // ...that was later moved to a connection that is now removed.
    world.state.channels.find(
      (item) => item.id === "channel_umbler_2",
    )!.connectionId = "connection_gone";
    world.connection("gone").removedAt = new Date(gNow);

    const updated = (await world.service.updateRule(
      "workspace_1",
      rule.id,
      { mode: "production" } as never,
      "user_1",
    )) as GRow;

    expect(updated.mode).toBe("production");
    expect(updated.channelIds).toEqual(["channel_umbler"]);
    expect(world.connection("umbler").status).toBe("production");
    expect(world.channel("umbler").status).toBe("active");
    expect(world.state.audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "provider_conversion_rule.channel_scope_pruned",
          targetId: rule.id,
          afterSummary: expect.objectContaining({
            connectionId: "connection_umbler",
            prunedChannelIds: ["channel_umbler_2"],
            remainingChannelIds: ["channel_umbler"],
          }),
        }),
      ]),
    );
  });

  it("#66 sem nenhum número válido: recusa com uma mensagem clara (e não 404 do webhook)", async () => {
    const world = globalWorld([
      { key: "umbler", provider: "umbler" },
      { key: "gone", provider: "umbler" },
    ]);
    const rule = await createGlobal(world, {
      scope: "specific_numbers",
      connectionId: "connection_umbler",
      channelIds: ["channel_umbler"],
      mode: "observation",
    });
    world.channel("umbler").connectionId = "connection_gone";
    world.connection("gone").removedAt = new Date(gNow);

    await expect(
      world.service.updateRule(
        "workspace_1",
        rule.id,
        { mode: "production" } as never,
        "user_1",
      ),
    ).rejects.toThrow(/Nenhum número válido na conexão da regra/);
  });

  it("#66 nod (ponte WAHA): regra com números de várias conexões ativa mesmo com a ponte WAHA removida", async () => {
    const world = globalWorld([
      { key: "waha", provider: "waha" },
      { key: "qr", provider: "uazapi" },
    ]);
    const rule = await createGlobal(world, {
      scope: "specific_numbers",
      connectionId: "connection_waha",
      channelIds: ["channel_waha", "channel_qr"],
      mode: "observation",
    });
    // Unbound: the numbers sit on two connections.
    expect(rule.connectionId).toBeNull();
    // The WAHA bridge connection is removed in Integrations.
    world.connection("waha").removedAt = new Date(gNow);

    const updated = (await world.service.updateRule(
      "workspace_1",
      rule.id,
      { mode: "production" } as never,
      "user_1",
    )) as GRow;

    expect(updated.mode).toBe("production");
    expect(updated.channelIds).toEqual(["channel_qr"]);
    expect(world.connection("qr").status).toBe("production");
    expect(world.connection("waha").status).toBe("observation");
    expect(world.state.audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "provider_conversion_rule.channel_scope_pruned",
          afterSummary: expect.objectContaining({
            connectionId: null,
            prunedChannelIds: ["channel_waha"],
            remainingChannelIds: ["channel_qr"],
          }),
        }),
      ]),
    );
  });

  it("#66 nod (ponte WAHA): sem nenhuma conexão viva, recusa com mensagem clara", async () => {
    const world = globalWorld([
      { key: "waha", provider: "waha" },
      { key: "qr", provider: "uazapi" },
    ]);
    const rule = await createGlobal(world, {
      scope: "specific_numbers",
      connectionId: "connection_waha",
      channelIds: ["channel_waha", "channel_qr"],
      mode: "observation",
    });
    world.connection("waha").removedAt = new Date(gNow);
    world.connection("qr").removedAt = new Date(gNow);

    await expect(
      world.service.updateRule(
        "workspace_1",
        rule.id,
        { mode: "production" } as never,
        "user_1",
      ),
    ).rejects.toThrow(/Nenhum numero valido na regra/);
  });

  it("#66 nod (ponte WAHA): a regra ligada à ponte WAHA ativa a ponte sem rota Meta salva", async () => {
    const world = globalWorld([{ key: "waha", provider: "waha" }]);

    const rule = await createGlobal(world, {
      scope: "specific_numbers",
      connectionId: "connection_waha",
      channelIds: ["channel_waha"],
    });

    expect(rule.mode).toBe("production");
    expect(world.connection("waha").status).toBe("production");
    expect(world.channel("waha").status).toBe("active");
  });

  it("#85 canal já ativo numa conexão em produção sem carimbo nem rota: a segunda regra ativa sem reescrever o canal", async () => {
    const world = globalWorld([
      {
        key: "umbler",
        provider: "umbler",
        connectionStatus: "production",
        channelStatus: "active",
      },
    ]);
    // Legacy live channel: no productionActivatedAt and no saved route.
    world.channel("umbler").productionActivatedAt = null;
    world.channel("umbler").routes = [];

    const rule = await createGlobal(world, {
      scope: "specific_numbers",
      connectionId: "connection_umbler",
      channelIds: ["channel_umbler"],
    });

    expect(rule.mode).toBe("production");
    expect(world.channel("umbler").status).toBe("active");
    expect(world.prisma.inboundWebhookChannel.updateMany).not.toHaveBeenCalled();
  });

  it("#86 número redescoberto com outra identidade: a regra fica no irmão ativo, sem pedir uma segunda rota", async () => {
    const world = globalWorld([
      {
        key: "umbler",
        provider: "umbler",
        connectionStatus: "production",
        channelStatus: "discovered",
        validRoute: false,
      },
    ]);
    world.state.channels.push({
      ...structuredClone(world.channel("umbler")),
      id: "channel_umbler_live",
      providerChannelId: "provider_live",
      status: "active",
      productionActivatedAt: null,
      routes: [],
    });

    const rule = await createGlobal(world, {
      scope: "specific_numbers",
      connectionId: "connection_umbler",
      channelIds: ["channel_umbler"],
    });

    expect(rule.channelIds).toEqual(["channel_umbler_live"]);
    expect(world.state.ruleChannels.map((scope) => scope.channelId)).toEqual([
      "channel_umbler_live",
    ]);
    expect(world.channel("umbler").status).toBe("discovered");
    expect(
      world.state.channels.find((item) => item.id === "channel_umbler_live"),
    ).toMatchObject({ status: "active" });
    expect(world.prisma.inboundWebhookChannel.updateMany).not.toHaveBeenCalled();
    expect(world.state.audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "provider_conversion_rule.channel_scope_remapped",
          afterSummary: expect.objectContaining({
            remappedChannels: [
              {
                fromChannelId: "channel_umbler",
                toChannelId: "channel_umbler_live",
              },
            ],
          }),
        }),
      ]),
    );
  });
});

describe("Envio ativo: número Uazapi/WAHA excluído em Integrações (revisão da 6.1a)", () => {
  it("regra com números de várias conexões ativa sem tocar na ponte WAHA cuja conexão WhatsApp foi excluída, e mantém o número na regra", async () => {
    const world = globalWorld([
      { key: "waha", provider: "waha" },
      { key: "qr", provider: "uazapi" },
    ]);
    const rule = await createGlobal(world, {
      scope: "specific_numbers",
      connectionId: "connection_waha",
      channelIds: ["channel_waha", "channel_qr"],
      mode: "observation",
    });
    // "Excluir" a conexão WAHA em Integrações só suspende a WhatsappInstance.
    world.state.instances.find((item) => item.id === "instance_waha")!.status =
      "suspended";

    const updated = (await world.service.updateRule(
      "workspace_1",
      rule.id,
      { mode: "production" } as never,
      "user_1",
    )) as GRow;

    expect(updated.mode).toBe("production");
    expect(world.connection("qr").status).toBe("production");
    expect(world.connection("waha").status).toBe("observation");
    expect(world.channel("waha").status).toBe("discovered");
    // Reconectar a mesma conexão WhatsApp traz o número de volta.
    expect(world.state.ruleChannels.map((scope) => scope.channelId)).toEqual(
      expect.arrayContaining(["channel_waha", "channel_qr"]),
    );
  });

  it("regra ligada só à ponte WAHA excluída recusa com mensagem clara", async () => {
    const world = globalWorld([{ key: "waha", provider: "waha" }]);
    const rule = await createGlobal(world, {
      scope: "specific_numbers",
      connectionId: "connection_waha",
      channelIds: ["channel_waha"],
      mode: "observation",
    });
    world.state.instances.find((item) => item.id === "instance_waha")!.status =
      "suspended";

    await expect(
      world.service.updateRule(
        "workspace_1",
        rule.id,
        { mode: "production" } as never,
        "user_1",
      ),
    ).rejects.toThrow(/Nenhum número válido na conexão da regra/);
    expect(world.connection("waha").status).toBe("observation");
  });

  it("“Pausar” funciona numa regra cujo número (conexão) foi removido", async () => {
    const world = globalWorld([{ key: "umbler", provider: "umbler" }]);
    const rule = await createGlobal(world, {
      scope: "specific_numbers",
      connectionId: "connection_umbler",
      channelIds: ["channel_umbler"],
      mode: "observation",
    });
    world.connection("umbler").removedAt = new Date(gNow);

    const paused = (await world.service.updateRule(
      "workspace_1",
      rule.id,
      { active: false } as never,
      "user_1",
    )) as GRow;
    expect(paused.conversionRule.active).toBe(false);
    // Any other edit still treats the rule as gone.
    await expect(
      world.service.updateRule(
        "workspace_1",
        rule.id,
        { mode: "production" } as never,
        "user_1",
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
