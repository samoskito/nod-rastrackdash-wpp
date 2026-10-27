import "reflect-metadata";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  legacyConversionRuleListSchema,
  providerConversionRuleCapabilitiesSchema,
  providerConversionRuleCreateInputSchema,
  providerConversionRuleIdempotentCreateResultSchema,
  providerConversionRuleListSchema,
  providerConversionRuleUnifyCandidatesSchema,
  providerConversionRuleUnifyResultSchema,
  providerConversionRuleUpdateInputSchema,
  providerRuleCreateReceiptLookupResultSchema,
  type ProviderConversionRuleCreateInputDto,
} from "@wpptrack/shared";
import { describe, expect, it, vi } from "vitest";
import { ConversionRulesService } from "../../src/conversion-rules/conversion-rules.service";
import { ProviderConversionRulesService } from "../../src/conversion-rules/provider-conversion-rules.service";
import { PROVIDER_RULE_SCOPE_CHANNEL_LIMIT } from "../../src/conversion-rules/provider-rule-scope";
import { ConflictException } from "@nestjs/common";

const workspaceId = "workspace_1";
const now = new Date("2026-10-15T12:00:00.000Z");
const env = {
  NODE_ENV: "test",
  API_PUBLIC_URL: "https://api.wpptrack.test",
  INBOUND_WEBHOOKS_ENABLED: "true",
  INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
  INBOUND_CONVERSION_RULES_ENABLED: "true",
  INBOUND_CONVERSION_PRODUCTION_ENABLED: "true",
  INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
};
const requestKey = "attempt_0123456789abcdef";

type Row = Record<string, any>;

/** Minimal Prisma where-matcher for the shapes the rules service uses. */
function matches(
  object: Row | null | undefined,
  where: Row | undefined,
): boolean {
  if (!where) return true;
  if (!object) return false;
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (key === "AND") {
      if (!(condition as Row[]).every((item) => matches(object, item)))
        return false;
      continue;
    }
    if (key === "OR") {
      if (!(condition as Row[]).some((item) => matches(object, item)))
        return false;
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
      if (condition.not === null) {
        if (value === null || value === undefined) return false;
      } else if (value === condition.not) return false;
      continue;
    }
    if ("equals" in condition) {
      if (value !== condition.equals) return false;
      continue;
    }
    if ("some" in condition) {
      if (
        !Array.isArray(value) ||
        !value.some((item) => matches(item, condition.some))
      )
        return false;
      continue;
    }
    if ("is" in condition) {
      if (condition.is === null) {
        if (value !== null && value !== undefined) return false;
        continue;
      }
      if (!value || !matches(value, condition.is)) return false;
      continue;
    }
    if ("isNot" in condition) {
      if (condition.isNot === null) {
        if (value === null || value === undefined) return false;
        continue;
      }
    }
    if (!value || !matches(value, condition)) return false;
  }
  return true;
}

function createWorld(options: { unnichat?: boolean } = {}) {
  const releases: Row[] = [
    { id: "release_umbler", provider: "umbler", version: "v1", status: "certified" },
    {
      id: "release_umbler_automation",
      provider: "umbler",
      version: "automation-v1",
      status: "certified",
    },
    { id: "release_uazapi", provider: "uazapi", version: "v1", status: "certified" },
    { id: "release_gupshup", provider: "gupshup", version: "v1", status: "certified" },
    {
      id: "release_payt_automation",
      provider: "payt",
      version: "automation-v1",
      status: "certified",
    },
    // Fase 6.5: Braip sale release (certified by migration: production direct).
    {
      id: "release_braip_automation",
      provider: "braip",
      version: "automation-v1",
      status: "certified",
    },
    // Fase 4b: Unnichat entry and automation releases (certified by migration).
    { id: "release_unnichat", provider: "unnichat", version: "v1", status: "certified" },
    {
      id: "release_unnichat_automation",
      provider: "unnichat",
      version: "automation-v1",
      status: "certified",
    },
  ];
  const connections: Row[] = [
    { id: "connection_umbler", provider: "umbler", parserReleaseId: "release_umbler" },
    { id: "connection_qr_a", provider: "uazapi", parserReleaseId: "release_uazapi" },
    { id: "connection_qr_b", provider: "uazapi", parserReleaseId: "release_uazapi" },
    { id: "connection_gupshup", provider: "gupshup", parserReleaseId: "release_gupshup" },
    { id: "connection_unnichat", provider: "unnichat", parserReleaseId: "release_unnichat" },
    // Fase 6.1a (#159): Unnichat creates one connection per number.
    ...(options.unnichat
      ? ["un_5159", "un_5520", "un_third"].map((id) => ({
          id: `connection_${id}`,
          provider: "unnichat",
          parserReleaseId: "release_unnichat",
        }))
      : []),
  ].map((connection) => ({
    workspaceId,
    status: "production",
    productionActivatedAt: now,
    removedAt: null,
    ...connection,
  }));
  const instances: Row[] = [
    { id: "instance_a", status: "active" },
    { id: "instance_b", status: "active" },
  ];
  const channels: Row[] = [
    { id: "channel_umbler", connectionId: "connection_umbler", whatsappInstanceId: null },
    { id: "channel_qr_a", connectionId: "connection_qr_a", whatsappInstanceId: "instance_a" },
    { id: "channel_qr_b", connectionId: "connection_qr_b", whatsappInstanceId: "instance_b" },
    { id: "channel_gupshup", connectionId: "connection_gupshup", whatsappInstanceId: null },
    { id: "channel_unnichat", connectionId: "connection_unnichat", whatsappInstanceId: null },
    ...(options.unnichat
      ? ["un_5159", "un_5520", "un_third"].map((id) => ({
          id: `channel_${id}`,
          connectionId: `connection_${id}`,
          whatsappInstanceId: null,
        }))
      : []),
  ].map((channel, index) => ({
    workspaceId,
    status: "active",
    productionActivatedAt: now,
    organizationId: `org_${index}`,
    providerChannelId: `provider_${index}`,
    connectedPhone: `55119999900${index}`,
    createdAt: new Date(now.getTime() + index),
    ...channel,
  }));
  const conversionRules: Row[] = [];
  const providerRules: Row[] = [];
  const ruleChannels: Row[] = [];
  const endpoints: Row[] = [];
  const claims: Row[] = [];
  const audits: Row[] = [];
  const integrationEndpoints: Row[] = [];
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}_${++sequence}`;

  const release = (id: string | null) =>
    releases.find((item) => item.id === id) ?? null;
  const hydrateConnection = (connection: Row | undefined | null) =>
    connection
      ? { ...connection, parserRelease: release(connection.parserReleaseId) }
      : null;
  const hydrateChannel = (channel: Row) => ({
    ...channel,
    connection: hydrateConnection(
      connections.find((item) => item.id === channel.connectionId),
    ),
    whatsappInstance:
      instances.find((item) => item.id === channel.whatsappInstanceId) ?? null,
  });
  const hydrateRule = (rule: Row) => ({
    ...rule,
    conversionRule: conversionRules.find(
      (item) => item.id === rule.conversionRuleId,
    ),
    connection: hydrateConnection(
      connections.find((item) => item.id === rule.connectionId),
    ),
    parserRelease: release(rule.parserReleaseId),
    channels: ruleChannels.filter((item) => item.providerRuleId === rule.id),
    endpoint: endpoints.find((item) => item.providerRuleId === rule.id) ?? null,
    catalog: null,
    executions: [],
  });

  const prisma: Row = {
    $queryRaw: vi.fn(async () => []),
    inboundWebhookConnection: {
      findFirst: vi.fn(async ({ where }: Row) =>
        hydrateConnection(connections.find((item) => matches(item, where))),
      ),
    },
    inboundWebhookChannel: {
      count: vi.fn(
        async ({ where }: Row) =>
          channels.map(hydrateChannel).filter((item) => matches(item, where))
            .length,
      ),
      findMany: vi.fn(async ({ where }: Row) =>
        channels.map(hydrateChannel).filter((item) => matches(item, where)),
      ),
    },
    inboundWebhookParserRelease: {
      findFirst: vi.fn(
        async ({ where }: Row) =>
          releases.find(
            (item) =>
              item.provider === where.provider &&
              item.version === where.version,
          ) ?? null,
      ),
    },
    conversionRule: {
      create: vi.fn(async ({ data }: Row) => {
        const row = {
          id: nextId("conversion"),
          createdAt: now,
          updatedAt: now,
          pixelId: null,
          ...data,
          defaultItems:
            data.defaultItems &&
            typeof data.defaultItems === "object" &&
            !("_getName" in data.defaultItems)
              ? data.defaultItems
              : null,
        };
        conversionRules.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: Row) => {
        const row = conversionRules.find((item) => item.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const rows = conversionRules.filter((item) => matches(item, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      }),
    },
    providerConversionRuleConfig: {
      create: vi.fn(async ({ data }: Row) => {
        const row = {
          id: nextId("provider_rule"),
          createdAt: new Date(now.getTime() + sequence),
          updatedAt: now,
          removedAt: null,
          unifiedIntoProviderRuleId: null,
          scope: "specific_numbers",
          ...data,
        };
        providerRules.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: Row) => {
        const row = providerRules.find((item) => item.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const rows = providerRules.filter((item) => matches(item, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      }),
      findFirst: vi.fn(
        async ({ where }: Row) =>
          providerRules.map(hydrateRule).find((item) => matches(item, where)) ??
          null,
      ),
      findMany: vi.fn(async ({ where }: Row) =>
        providerRules.map(hydrateRule).filter((item) => matches(item, where)),
      ),
      count: vi.fn(
        async ({ where }: Row) =>
          providerRules.filter((item) => matches(item, where)).length,
      ),
    },
    providerConversionRuleChannel: {
      createMany: vi.fn(async ({ data }: Row) => {
        for (const row of data)
          ruleChannels.push({ id: nextId("scope"), createdAt: now, ...row });
        return { count: data.length };
      }),
      deleteMany: vi.fn(async ({ where }: Row) => {
        const kept = ruleChannels.filter((item) => !matches(item, where));
        const count = ruleChannels.length - kept.length;
        ruleChannels.splice(0, ruleChannels.length, ...kept);
        return { count };
      }),
    },
    providerConversionRuleEndpoint: {
      create: vi.fn(async ({ data }: Row) => {
        const row = {
          id: nextId("endpoint"),
          secretVersion: 1,
          lastDeliveryAt: null,
          lastSuccessfulParseAt: null,
          rotatedAt: null,
          removedAt: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        endpoints.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: Row) => {
        const row = endpoints.find((item) => item.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const rows = endpoints.filter((item) => matches(item, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      }),
    },
    providerRuleCreateClaim: {
      findUnique: vi.fn(
        async ({ where }: Row) =>
          claims.find(
            (item) =>
              item.workspaceId === where.workspaceId_requestKey.workspaceId &&
              item.requestKey === where.workspaceId_requestKey.requestKey,
          ) ?? null,
      ),
      create: vi.fn(async ({ data }: Row) => {
        const row = { id: nextId("claim"), createdAt: now, ...data };
        claims.push(row);
        return row;
      }),
    },
    integrationEndpoint: {
      findFirst: vi.fn(
        async ({ where }: Row) =>
          integrationEndpoints.find((item) => matches(item, where)) ?? null,
      ),
    },
    auditLog: {
      create: vi.fn(async ({ data }: Row) => {
        audits.push(data);
        return data;
      }),
    },
  };
  prisma.$transaction = vi.fn(async (callback: (client: Row) => unknown) =>
    callback(prisma),
  );

  const service = new ProviderConversionRulesService(prisma as never, env);
  return {
    service,
    prisma,
    providerRules,
    ruleChannels,
    conversionRules,
    audits,
    channels,
    connections,
    instances,
    claims,
    endpoints,
    integrationEndpoints,
  };
}

function messageInput(
  input: Record<string, unknown>,
): ProviderConversionRuleCreateInputDto {
  return providerConversionRuleCreateInputSchema.parse({
    name: "Qualificado",
    triggerType: "message_phrase",
    triggerPhrases: ["vou te passar os valores"],
    messageAuthorScope: "team",
    eventName: "QualifiedLead",
    ...input,
  });
}

describe("provider rules API: workspace scope", () => {
  it("creates an unbound all-numbers message rule whose effective numbers are every compatible number", async () => {
    const world = createWorld();

    const { rule } = await world.service.createRule(
      workspaceId,
      messageInput({ scope: "all_numbers" }),
      "user_1",
    );

    expect(rule).toMatchObject({
      connectionId: null,
      parserReleaseId: null,
      scope: "all_numbers",
      origin: "message_phrase",
      channelIds: [],
      // Gupshup messages are not evaluated: not part of the scope.
      effectiveChannelIds: ["channel_umbler", "channel_qr_a", "channel_qr_b"],
      overriddenChannelIds: [],
      globalPrecedence: "specific_rule_replaces_global_on_number",
    });
    expect(providerConversionRuleListSchema.parse([rule])).toHaveLength(1);
    expect(world.ruleChannels).toEqual([]);
    expect(world.audits.at(-1)).toMatchObject({
      action: "provider_conversion_rule.created",
      afterSummary: { scope: "all_numbers", connectionId: null },
    });
  });

  it("limits a contact-author global phrase to Umbler numbers", async () => {
    const world = createWorld();

    const { rule } = await world.service.createRule(
      workspaceId,
      messageInput({ scope: "all_numbers", messageAuthorScope: "contact" }),
      "user_1",
    );

    expect(rule.effectiveChannelIds).toEqual(["channel_umbler"]);
  });

  it("includes a number connected after the global rule automatically", async () => {
    const world = createWorld();
    const { rule } = await world.service.createRule(
      workspaceId,
      messageInput({ scope: "all_numbers" }),
      "user_1",
    );
    world.channels.push({
      id: "channel_qr_new",
      workspaceId,
      connectionId: "connection_qr_b",
      whatsappInstanceId: null,
      status: "discovered",
      productionActivatedAt: null,
      organizationId: "org_new",
      providerChannelId: "provider_new",
      connectedPhone: "provider_new",
      createdAt: new Date(now.getTime() + 100),
    });

    const listed = await world.service.listRules(workspaceId);

    expect(listed.find((item) => item.id === rule.id)!.effectiveChannelIds).toEqual([
      "channel_umbler",
      "channel_qr_a",
      "channel_qr_b",
      "channel_qr_new",
    ]);
  });

  it("leaves numbers of deleted WhatsApp instances out of the global scope", async () => {
    const world = createWorld();
    world.instances.find((item) => item.id === "instance_a")!.status =
      "suspended";

    const { rule } = await world.service.createRule(
      workspaceId,
      messageInput({ scope: "all_numbers" }),
      "user_1",
    );

    expect(rule.effectiveChannelIds).toEqual(["channel_umbler", "channel_qr_b"]);
  });

  it("creates a specific rule over numbers of different connections (unbound, explicit channels)", async () => {
    const world = createWorld();

    const { rule } = await world.service.createRule(
      workspaceId,
      messageInput({
        connectionId: "connection_umbler",
        channelIds: ["channel_umbler", "channel_qr_a"],
      }),
      "user_1",
    );

    expect(rule).toMatchObject({
      connectionId: null,
      scope: "specific_numbers",
      channelIds: ["channel_umbler", "channel_qr_a"],
      effectiveChannelIds: ["channel_umbler", "channel_qr_a"],
    });
  });

  it("keeps the historical bound shape when every number is on the informed connection", async () => {
    const world = createWorld();

    const { rule } = await world.service.createRule(
      workspaceId,
      messageInput({
        connectionId: "connection_umbler",
        channelIds: ["channel_umbler"],
      }),
      "user_1",
    );

    expect(rule).toMatchObject({
      connectionId: "connection_umbler",
      parserReleaseId: "release_umbler",
      scope: "specific_numbers",
      channelIds: ["channel_umbler"],
      unifiedIntoRuleId: null,
    });
    // No workspace channel scan for specific rules.
    expect(world.prisma.inboundWebhookChannel.findMany).not.toHaveBeenCalled();
  });

  it("rejects numbers that do not support the origin and numbers of other workspaces", async () => {
    const world = createWorld();

    await expect(
      world.service.createRule(
        workspaceId,
        providerConversionRuleCreateInputSchema.parse({
          name: "Tag comprou",
          triggerType: "provider_automation",
          triggerLabels: [{ id: "3", name: "Comprou" }],
          eventName: "QualifiedLead",
          channelIds: ["channel_qr_a", "channel_gupshup"],
        }),
        "user_1",
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      world.service.createRule(
        workspaceId,
        messageInput({ channelIds: ["channel_umbler", "channel_gupshup"] }),
        "user_1",
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      world.service.createRule(
        workspaceId,
        messageInput({ channelIds: ["channel_of_another_workspace"] }),
        "user_1",
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(world.providerRules).toEqual([]);
  });

  it("stores a workspace-wide tag rule by label name only", async () => {
    const world = createWorld();

    const { rule } = await world.service.createRule(
      workspaceId,
      providerConversionRuleCreateInputSchema.parse({
        name: "Tag comprou",
        triggerType: "provider_automation",
        triggerLabels: [{ id: "551199:3", name: "Comprou" }],
        eventName: "QualifiedLead",
        scope: "all_numbers",
      }),
      "user_1",
    );

    expect(rule).toMatchObject({
      origin: "whatsapp_label",
      connectionId: null,
      effectiveChannelIds: ["channel_qr_a", "channel_qr_b"],
      triggerPhrases: ["Comprou"],
    });
    expect(world.conversionRules.at(-1)!.defaultItems).toEqual({
      uazapiLabels: [
        { id: "551199:3", labelId: "3", matchKeys: [], name: "Comprou" },
      ],
    });
  });

  it("requires the receiving connection for the Umbler automation and keeps it bound when global", async () => {
    const world = createWorld();
    const automation = {
      name: "Venda Umbler",
      triggerType: "provider_automation",
      eventName: "QualifiedLead",
      scope: "all_numbers",
    };

    // Without connection a provider automation can only be a label rule.
    await expect(
      world.service.createRule(
        workspaceId,
        providerConversionRuleCreateInputSchema.parse(automation),
        "user_1",
      ),
    ).rejects.toMatchObject({ status: 400 });

    const created = await world.service.createRule(
      workspaceId,
      providerConversionRuleCreateInputSchema.parse({
        ...automation,
        connectionId: "connection_umbler",
      }),
      "user_1",
    );
    expect(created.rule).toMatchObject({
      connectionId: "connection_umbler",
      parserReleaseId: "release_umbler_automation",
      scope: "all_numbers",
      origin: "automation_umbler",
      effectiveChannelIds: ["channel_umbler"],
    });
    expect(created.webhookUrl).toMatch(
      /^https:\/\/api\.wpptrack\.test\/webhooks\/inbound\/conversions\//,
    );
  });

  it("creates a Payt sale rule on its numbers' connection and reports origin automation_payt", async () => {
    const world = createWorld();
    const sale = {
      name: "Venda Payt",
      triggerType: "provider_automation",
      automationSource: "payt",
      eventName: "Purchase",
      scope: "specific_numbers",
      channelIds: ["channel_umbler", "channel_gupshup"],
    };

    // Same as the SaaS: the rule needs a WhatsApp connection (URL anchor).
    await expect(
      world.service.createRule(
        workspaceId,
        providerConversionRuleCreateInputSchema.parse(sale),
        "user_1",
      ),
    ).rejects.toMatchObject({ status: 400 });

    const created = await world.service.createRule(
      workspaceId,
      providerConversionRuleCreateInputSchema.parse({
        ...sale,
        connectionId: "connection_umbler",
      }),
      "user_1",
    );
    // Numbers of other connections are accepted (scope is not connection-bound).
    expect(created.rule).toMatchObject({
      connectionId: "connection_umbler",
      parserReleaseId: "release_payt_automation",
      origin: "automation_payt",
      automationSource: "payt",
      channelIds: ["channel_umbler", "channel_gupshup"],
    });
    expect(created.webhookUrl).toMatch(
      /^https:\/\/api\.wpptrack\.test\/webhooks\/inbound\/conversions\//,
    );
  });

  it("creates a Braip sale rule born in production, received only through the single URL (Fase 6.5)", async () => {
    const world = createWorld();
    const created = await world.service.createRule(
      workspaceId,
      providerConversionRuleCreateInputSchema.parse({
        name: "Venda Braip",
        triggerType: "provider_automation",
        automationSource: "braip",
        eventName: "Purchase",
        scope: "all_numbers",
        connectionId: "connection_umbler",
        channelIds: [],
        productFilterCodes: ["pro1abc"],
        // No perRuleUrl sent: the API keeps the Braip on the single URL.
      }),
      "user_1",
    );
    // Production direct: no mode sent, the API decides (certified reader).
    expect(created.rule).toMatchObject({
      connectionId: "connection_umbler",
      parserReleaseId: "release_braip_automation",
      origin: "automation_braip",
      automationSource: "braip",
      productFilterCodes: ["PRO1ABC"],
      mode: "production",
    });
    // Its own URL is born disabled: the Braip only posts to the single URL.
    expect(created.webhookUrl ?? null).toBeNull();
    // ...and it is never reopened nor rotated (no per-rule URL for Braip).
    await expect(
      world.service.updateRule(
        workspaceId,
        created.rule.id,
        providerConversionRuleUpdateInputSchema.parse({ publicUrlDisabled: false }),
        "user_1",
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      world.service.rotateEndpoint(workspaceId, created.rule.id, "user_1"),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a Braip rule with a non-sale event (same contract as Payt)", () => {
    expect(
      providerConversionRuleCreateInputSchema.safeParse({
        name: "Braip",
        triggerType: "provider_automation",
        automationSource: "braip",
        eventName: "QualifiedLead",
        scope: "all_numbers",
        connectionId: "connection_umbler",
      }).success,
    ).toBe(false);
  });

  it("creates an Unnichat automation rule on its connection with its own URL (Fase 4b)", async () => {
    const world = createWorld();
    const automation = {
      name: "Comprou no Unnichat",
      triggerType: "provider_automation",
      eventName: "Purchase",
      defaultValueCents: 15000,
      defaultCurrency: "BRL",
      scope: "all_numbers",
      channelIds: [],
    };

    // The automation is bound to the connection that receives the callback.
    await expect(
      world.service.createRule(
        workspaceId,
        providerConversionRuleCreateInputSchema.parse(automation),
        "user_1",
      ),
    ).rejects.toMatchObject({ status: 400 });

    const created = await world.service.createRule(
      workspaceId,
      providerConversionRuleCreateInputSchema.parse({
        ...automation,
        connectionId: "connection_unnichat",
      }),
      "user_1",
    );
    expect(created.rule).toMatchObject({
      connectionId: "connection_unnichat",
      parserReleaseId: "release_unnichat_automation",
      scope: "all_numbers",
      origin: "automation_unnichat",
      // "All numbers" of an Unnichat automation = numbers of its connection.
      effectiveChannelIds: ["channel_unnichat"],
      // Fase 6.1c (produção direta): Unnichat validado nasce enviando.
      mode: "production",
    });
    expect(created.webhookUrl).toMatch(
      /^https:\/\/api\.wpptrack\.test\/webhooks\/inbound\/conversions\//,
    );

    // A number of another provider cannot be scoped to the Unnichat automation.
    await expect(
      world.service.createRule(
        workspaceId,
        providerConversionRuleCreateInputSchema.parse({
          ...automation,
          scope: "specific_numbers",
          connectionId: "connection_unnichat",
          channelIds: ["channel_umbler"],
        }),
        "user_1",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("lets a Payt sale rule cover an Unnichat number (no-ad sale path, Fase 4b)", async () => {
    const world = createWorld();
    const created = await world.service.createRule(
      workspaceId,
      providerConversionRuleCreateInputSchema.parse({
        name: "Venda Payt no Unnichat",
        triggerType: "provider_automation",
        automationSource: "payt",
        eventName: "Purchase",
        scope: "specific_numbers",
        connectionId: "connection_unnichat",
        channelIds: ["channel_unnichat"],
      }),
      "user_1",
    );
    expect(created.rule).toMatchObject({
      connectionId: "connection_unnichat",
      parserReleaseId: "release_payt_automation",
      origin: "automation_payt",
      channelIds: ["channel_unnichat"],
    });
  });

  it("lists the numbers where a specific rule overrides the global one, and which rule wins", async () => {
    const world = createWorld();
    const { rule: global } = await world.service.createRule(
      workspaceId,
      messageInput({ scope: "all_numbers" }),
      "user_1",
    );
    const { rule: specific } = await world.service.createRule(
      workspaceId,
      messageInput({
        name: "Qualificado no QR A",
        triggerPhrases: ["orçamento enviado"],
        connectionId: "connection_qr_a",
        channelIds: ["channel_qr_a"],
      }),
      "user_1",
    );

    const listed = await world.service.listRules(workspaceId);
    const listedGlobal = listed.find((rule) => rule.id === global.id)!;
    const listedSpecific = listed.find((rule) => rule.id === specific.id)!;

    expect(listedGlobal).toMatchObject({
      effectiveChannelIds: ["channel_umbler", "channel_qr_b"],
      overriddenChannelIds: ["channel_qr_a"],
      overriddenBy: [{ channelId: "channel_qr_a", providerRuleIds: [specific.id] }],
    });
    expect(listedSpecific).toMatchObject({
      scope: "specific_numbers",
      effectiveChannelIds: ["channel_qr_a"],
      overriddenChannelIds: [],
    });
  });

  it("switches a bound rule to all numbers (unbinding it) and back to explicit numbers", async () => {
    const world = createWorld();
    const { rule } = await world.service.createRule(
      workspaceId,
      messageInput({
        connectionId: "connection_umbler",
        channelIds: ["channel_umbler"],
        // Escopo, não envio: com o envio desligado nada é promovido.
        mode: "observation",
      }),
      "user_1",
    );

    const global = await world.service.updateRule(
      workspaceId,
      rule.id,
      providerConversionRuleUpdateInputSchema.parse({ scope: "all_numbers" }),
      "user_1",
    );
    expect(global).toMatchObject({
      scope: "all_numbers",
      connectionId: null,
      parserReleaseId: null,
      channelIds: [],
    });

    await expect(
      world.service.updateRule(
        workspaceId,
        rule.id,
        providerConversionRuleUpdateInputSchema.parse({
          scope: "specific_numbers",
        }),
        "user_1",
      ),
    ).rejects.toMatchObject({ status: 400 });

    const specific = await world.service.updateRule(
      workspaceId,
      rule.id,
      providerConversionRuleUpdateInputSchema.parse({
        scope: "specific_numbers",
        channelIds: ["channel_qr_b", "channel_umbler"],
      }),
      "user_1",
    );
    expect(specific).toMatchObject({
      scope: "specific_numbers",
      connectionId: null,
      channelIds: ["channel_qr_b", "channel_umbler"],
    });
  });

  it("does not silently ignore channels sent to a global rule", async () => {
    const world = createWorld();
    const { rule } = await world.service.createRule(
      workspaceId,
      messageInput({ scope: "all_numbers" }),
      "user_1",
    );

    await expect(
      world.service.updateRule(
        workspaceId,
        rule.id,
        providerConversionRuleUpdateInputSchema.parse({
          channelIds: ["channel_umbler"],
        }),
        "user_1",
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(world.ruleChannels).toEqual([]);
    expect(
      providerConversionRuleUpdateInputSchema.safeParse({
        scope: "all_numbers",
        channelIds: ["channel_umbler"],
      }).success,
    ).toBe(false);
  });

  it("lists a global rule once per phone when a number is connected twice", async () => {
    const world = createWorld();
    // channel_qr_a is the same line as channel_umbler in another BR form
    // (reported by "Testar conexao" without the 9th digit).
    world.channels.find((row) => row.id === "channel_umbler")!.connectedPhone =
      "5511987654321";
    world.channels.find((row) => row.id === "channel_qr_a")!.connectedPhone =
      "1187654321";

    const { rule } = await world.service.createRule(
      workspaceId,
      messageInput({ scope: "all_numbers" }),
      "user_1",
    );

    expect(rule).toMatchObject({
      effectiveChannelIds: ["channel_umbler", "channel_qr_b"],
      duplicatePhoneChannelIds: ["channel_qr_a"],
      overriddenChannelIds: [],
    });
  });
});

describe("provider rules API: canonical channel of a phone", () => {
  it("warns when the canonical channel of a phone observes while another channel of it is in production", async () => {
    const world = createWorld();
    // Same line on Umbler (oldest, but its connection is in observation) and
    // on the Uazapi instance A (connection in production).
    world.channels.find((row) => row.id === "channel_umbler")!.connectedPhone =
      "5511987654321";
    world.channels.find((row) => row.id === "channel_qr_a")!.connectedPhone =
      "1187654321";
    world.connections.find((row) => row.id === "connection_umbler")!.status =
      "observation";

    const { rule } = await world.service.createRule(
      workspaceId,
      messageInput({ scope: "all_numbers" }),
      "user_1",
    );

    // Selection stays as in the SaaS (active channel first, then oldest)...
    expect(rule).toMatchObject({
      effectiveChannelIds: ["channel_umbler", "channel_qr_b"],
      duplicatePhoneChannelIds: ["channel_qr_a"],
      // ...and the UI gets what it needs to warn.
      observationCanonicalChannels: [
        {
          canonicalChannelId: "channel_umbler",
          productionChannelIds: ["channel_qr_a"],
        },
      ],
    });
    expect(providerConversionRuleListSchema.parse([rule])).toHaveLength(1);
  });

  it("reports nothing when the canonical channel is in production", async () => {
    const world = createWorld();
    world.channels.find((row) => row.id === "channel_umbler")!.connectedPhone =
      "5511987654321";
    world.channels.find((row) => row.id === "channel_qr_a")!.connectedPhone =
      "1187654321";

    const { rule } = await world.service.createRule(
      workspaceId,
      messageInput({ scope: "all_numbers" }),
      "user_1",
    );

    expect(rule.observationCanonicalChannels).toEqual([]);
  });
});

describe("provider rules API: idempotent create", () => {
  it("replays a committed create with the same key and refuses another body", async () => {
    const world = createWorld();
    const input = messageInput({ scope: "all_numbers" });

    const created = await world.service.createRule(
      workspaceId,
      input,
      "user_1",
      requestKey,
    );
    expect(providerConversionRuleIdempotentCreateResultSchema.parse(created))
      .toMatchObject({
        outcome: "created",
        receipt: { connectionId: null },
      });
    expect(world.claims).toHaveLength(1);
    expect(world.prisma.$queryRaw).toHaveBeenCalled();

    const replay = await world.service.createRule(
      workspaceId,
      messageInput({ scope: "all_numbers" }),
      "user_1",
      requestKey,
    );
    expect(replay).toEqual({
      outcome: "replayed",
      receipt: (created as { receipt: unknown }).receipt,
    });
    expect(world.providerRules).toHaveLength(1);

    await expect(
      world.service.createRule(
        workspaceId,
        messageInput({ scope: "all_numbers", name: "Outro nome" }),
        "user_1",
        requestKey,
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: "provider_rule_create_key_conflict" },
    });
    expect(world.providerRules).toHaveLength(1);
  });

  it("hashes an explicit specific_numbers scope like an omitted one", async () => {
    const world = createWorld();
    await world.service.createRule(
      workspaceId,
      messageInput({
        connectionId: "connection_umbler",
        channelIds: ["channel_umbler"],
      }),
      "user_1",
      requestKey,
    );

    const replay = await world.service.createRule(
      workspaceId,
      messageInput({
        connectionId: "connection_umbler",
        channelIds: ["channel_umbler"],
        scope: "specific_numbers",
      }),
      "user_1",
      requestKey,
    );
    expect(replay).toMatchObject({
      outcome: "replayed",
      receipt: { connectionId: "connection_umbler" },
    });
  });

  it("reconciles an unconfirmed create through the receipt lookup", async () => {
    const world = createWorld();
    await expect(
      world.service.lookupCreateReceipt(workspaceId, null, requestKey),
    ).resolves.toEqual({
      outcome: "absent",
      code: "provider_rule_create_receipt_absent",
    });

    await world.service.createRule(
      workspaceId,
      messageInput({ scope: "all_numbers" }),
      "user_1",
      requestKey,
    );

    const found = await world.service.lookupCreateReceipt(
      workspaceId,
      null,
      requestKey,
    );
    expect(providerRuleCreateReceiptLookupResultSchema.parse(found)).toMatchObject({
      outcome: "found",
      receipt: { ruleId: world.providerRules[0]!.id, connectionId: null },
    });
    // An unbound claim is found whatever connection the screen informs.
    await expect(
      world.service.lookupCreateReceipt(
        workspaceId,
        "connection_umbler",
        requestKey,
      ),
    ).resolves.toMatchObject({ outcome: "found" });
    await expect(
      world.service.lookupCreateReceipt(workspaceId, null, "short"),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("provider rules API: unify", () => {
  async function identicalRules(world: ReturnType<typeof createWorld>) {
    const first = await world.service.createRule(
      workspaceId,
      messageInput({
        name: "Qualificado Umbler",
        connectionId: "connection_umbler",
        channelIds: ["channel_umbler"],
      }),
      "user_1",
    );
    const second = await world.service.createRule(
      workspaceId,
      messageInput({
        name: "Qualificado QR",
        // Same phrase with other casing/spacing is still the same rule.
        triggerPhrases: ["  Vou te passar os valores "],
        connectionId: "connection_qr_a",
        channelIds: ["channel_qr_a"],
      }),
      "user_1",
    );
    return [first.rule.id, second.rule.id];
  }

  it("detects identical rules across numbers and reports what would change", async () => {
    const world = createWorld();
    const ruleIds = await identicalRules(world);
    // Not identical (another event): never grouped.
    await world.service.createRule(
      workspaceId,
      messageInput({
        eventName: "ViewContent",
        connectionId: "connection_qr_b",
        channelIds: ["channel_qr_b"],
      }),
      "user_1",
    );
    // Fase 6.1a (#159): Umbler/Unnichat automations of one event are now
    // their own group (one rule per provider + event; the old URLs keep
    // working). They never join the phrase group.
    for (let index = 0; index < 2; index += 1) {
      await world.service.createRule(
        workspaceId,
        providerConversionRuleCreateInputSchema.parse({
          name: "Automação Umbler",
          triggerType: "provider_automation",
          eventName: "QualifiedLead",
          connectionId: "connection_umbler",
          channelIds: ["channel_umbler"],
        }),
        "user_1",
      );
    }

    const candidates = await world.service.listUnifyCandidates(workspaceId);

    expect(providerConversionRuleUnifyCandidatesSchema.parse(candidates).groups)
      .toHaveLength(2);
    expect(
      candidates.groups.find((group) => group.origin === "automation_umbler"),
    ).toMatchObject({ eventName: "QualifiedLead", differences: [] });
    expect(
      candidates.groups.find((group) => group.origin === "message_phrase"),
    ).toMatchObject({
      origin: "message_phrase",
      eventName: "QualifiedLead",
      ruleIds,
      channelIds: ["channel_umbler", "channel_qr_a"],
      newlyCoveredChannelIds: ["channel_qr_b"],
      overriddenChannelIds: [],
      existingGlobalRuleId: null,
    });
  });

  it("refuses to unify with 409 when the workspace has more channels than the scope limit", async () => {
    const world = createWorld();
    const ruleIds = await identicalRules(world);
    for (let index = 0; index < PROVIDER_RULE_SCOPE_CHANNEL_LIMIT + 1; index += 1) {
      world.channels.push({
        id: `channel_bulk_${index}`,
        workspaceId,
        connectionId: "connection_qr_b",
        whatsappInstanceId: null,
        status: "discovered",
        productionActivatedAt: null,
        organizationId: "org_bulk",
        providerChannelId: `provider_bulk_${index}`,
        connectedPhone: `provider_bulk_${index}`,
        createdAt: new Date(now.getTime() + 1_000 + index),
      });
    }

    await expect(
      world.service.unifyRules(workspaceId, { ruleIds }, "user_1"),
    ).rejects.toBeInstanceOf(ConflictException);
    // Nothing was created or paused.
    expect(
      world.providerRules.every((rule) => rule.unifiedIntoProviderRuleId == null),
    ).toBe(true);
  });

  it("creates one all-numbers rule, pauses the originals with their history and is idempotent", async () => {
    const world = createWorld();
    const ruleIds = await identicalRules(world);

    const unified = await world.service.unifyRules(
      workspaceId,
      { ruleIds, name: "Qualificado (todos os números)" },
      "user_1",
    );

    expect(providerConversionRuleUnifyResultSchema.parse(unified)).toMatchObject({
      outcome: "created",
      deactivatedRuleIds: [...ruleIds].sort(),
      newlyCoveredChannelIds: ["channel_qr_b"],
      rule: {
        scope: "all_numbers",
        connectionId: null,
        channelIds: [],
        triggerPhrases: ["vou te passar os valores"],
        effectiveChannelIds: ["channel_umbler", "channel_qr_a", "channel_qr_b"],
      },
    });
    expect(unified.rule.conversionRule.name).toBe(
      "Qualificado (todos os números)",
    );
    for (const id of ruleIds) {
      const original = world.providerRules.find((rule) => rule.id === id)!;
      expect(original).toMatchObject({
        unifiedIntoProviderRuleId: unified.rule.id,
        removedAt: null,
        mode: "observation",
      });
      expect(
        world.conversionRules.find(
          (rule) => rule.id === original.conversionRuleId,
        )!.active,
      ).toBe(false);
      // Channel scope rows (history of the original) are kept.
      expect(
        world.ruleChannels.some((scope) => scope.providerRuleId === id),
      ).toBe(true);
    }
    expect(
      world.audits.filter(
        (audit) => audit.action === "provider_conversion_rule.unified",
      ),
    ).toHaveLength(1);
    expect(
      world.audits.filter(
        (audit) => audit.action === "provider_conversion_rule.unified_source",
      ),
    ).toHaveLength(2);
    // Workspace advisory lock taken inside the transaction.
    expect(world.prisma.$transaction).toHaveBeenCalled();
    expect(world.prisma.$queryRaw).toHaveBeenCalled();

    const replay = await world.service.unifyRules(
      workspaceId,
      { ruleIds: [...ruleIds].reverse() },
      "user_1",
    );
    expect(replay).toMatchObject({
      outcome: "replayed",
      rule: { id: unified.rule.id },
    });
    expect(
      world.providerRules.filter((rule) => rule.scope === "all_numbers"),
    ).toHaveLength(1);
    expect(
      (await world.service.listUnifyCandidates(workspaceId)).groups,
    ).toEqual([]);
  });

  it("reuses an identical global rule instead of creating a second one", async () => {
    const world = createWorld();
    const { rule: existing } = await world.service.createRule(
      workspaceId,
      messageInput({ scope: "all_numbers" }),
      "user_1",
    );
    const ruleIds = await identicalRules(world);

    const candidates = await world.service.listUnifyCandidates(workspaceId);
    expect(candidates.groups[0]!.existingGlobalRuleId).toBe(existing.id);

    const unified = await world.service.unifyRules(
      workspaceId,
      { ruleIds },
      "user_1",
    );
    expect(unified).toMatchObject({
      outcome: "reused_existing",
      rule: { id: existing.id },
    });
    expect(
      world.providerRules.filter((rule) => rule.scope === "all_numbers"),
    ).toHaveLength(1);
  });

  it("unifies tag rules of two instances into a name-only global tag rule", async () => {
    const world = createWorld();
    const ids: string[] = [];
    for (const [connectionId, channelId, labelId] of [
      ["connection_qr_a", "channel_qr_a", "3"],
      ["connection_qr_b", "channel_qr_b", "7"],
    ]) {
      const { rule } = await world.service.createRule(
        workspaceId,
        providerConversionRuleCreateInputSchema.parse({
          name: "Tag comprou",
          triggerType: "provider_automation",
          triggerLabels: [{ id: labelId, name: "Comprou" }],
          eventName: "QualifiedLead",
          connectionId,
          channelIds: [channelId],
        }),
        "user_1",
      );
      expect(rule.connectionId).toBe(connectionId);
      ids.push(rule.id);
    }

    const unified = await world.service.unifyRules(
      workspaceId,
      { ruleIds: ids },
      "user_1",
    );

    expect(unified.rule).toMatchObject({
      origin: "whatsapp_label",
      scope: "all_numbers",
      effectiveChannelIds: ["channel_qr_a", "channel_qr_b"],
    });
    expect(world.conversionRules.at(-1)!.defaultItems).toEqual({
      uazapiLabels: [{ id: "3", labelId: "3", matchKeys: [], name: "Comprou" }],
    });
  });

  it("refuses rules that are not identical and changes nothing", async () => {
    const world = createWorld();
    const [first] = await identicalRules(world);
    const { rule: different } = await world.service.createRule(
      workspaceId,
      messageInput({
        triggerPhrases: ["outra frase"],
        connectionId: "connection_qr_b",
        channelIds: ["channel_qr_b"],
      }),
      "user_1",
    );

    await expect(
      world.service.unifyRules(
        workspaceId,
        { ruleIds: [first!, different.id] },
        "user_1",
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      world.providerRules.filter((rule) => rule.scope === "all_numbers"),
    ).toHaveLength(0);
    expect(world.conversionRules.every((rule) => rule.active === true)).toBe(
      true,
    );
  });

  it("clears the unify link when an original rule is reactivated (it then overrides the global rule)", async () => {
    const world = createWorld();
    const [firstId, secondId] = await identicalRules(world);
    const unified = await world.service.unifyRules(
      workspaceId,
      { ruleIds: [firstId!, secondId!] },
      "user_1",
    );

    const reactivated = await world.service.updateRule(
      workspaceId,
      firstId!,
      providerConversionRuleUpdateInputSchema.parse({ active: true }),
      "user_1",
    );

    expect(reactivated).toMatchObject({
      unifiedIntoRuleId: null,
      conversionRule: { active: true },
    });
    const listed = await world.service.listRules(workspaceId);
    expect(listed.find((rule) => rule.id === unified.rule.id)).toMatchObject({
      overriddenChannelIds: ["channel_umbler"],
      globalPrecedence: "specific_rule_replaces_global_on_number",
    });
    expect(listed.find((rule) => rule.id === secondId)).toMatchObject({
      unifiedIntoRuleId: unified.rule.id,
      conversionRule: { active: false },
    });
  });

  it("lists, per unify candidate, the numbers whose phone already runs on another channel", async () => {
    const world = createWorld();
    world.channels.find((row) => row.id === "channel_umbler")!.connectedPhone =
      "5511987654321";
    world.channels.find((row) => row.id === "channel_qr_b")!.connectedPhone =
      "1187654321";
    await identicalRules(world);

    const { groups } = await world.service.listUnifyCandidates(workspaceId);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      channelIds: ["channel_umbler", "channel_qr_a"],
      newlyCoveredChannelIds: [],
      overriddenChannelIds: [],
      duplicatePhoneChannelIds: ["channel_qr_b"],
    });
  });
});

// Fase 6.1a: porte do SaaS (42ccbc7c, #159), adaptado ao mundo do nod.
describe("provider rules API: Unificar for Unnichat automations (one rule for every number)", () => {
  function unnichatRule(
    world: ReturnType<typeof createWorld>,
    number: "un_5159" | "un_5520" | "un_third",
    extra: Record<string, unknown> = {},
  ) {
    return world.service.createRule(
      workspaceId,
      providerConversionRuleCreateInputSchema.parse({
        name: "Lead Qualificado",
        triggerType: "provider_automation",
        eventName: "QualifiedLead",
        connectionId: `connection_${number}`,
        channelIds: [`channel_${number}`],
        ...extra,
      }),
      "user_1",
    );
  }

  it("covers every Unnichat number only with the explicit 'todas as conexões' option; a plain 'Todos os números' keeps its connection", async () => {
    const world = createWorld({ unnichat: true });
    const { rule } = await unnichatRule(world, "un_5159", {
      scope: "all_numbers",
      crossConnectionScope: true,
      channelIds: undefined,
    });
    expect(rule).toMatchObject({
      scope: "all_numbers",
      crossConnectionScope: true,
      origin: "automation_unnichat",
      connectionId: "connection_un_5159",
      // nod world: the base Unnichat number is one more connection.
      effectiveChannelIds: [
        "channel_unnichat",
        "channel_un_5159",
        "channel_un_5520",
        "channel_un_third",
      ],
      numberRemoved: false,
    });
    const { rule: legacy } = await unnichatRule(world, "un_5520", {
      scope: "all_numbers",
      channelIds: undefined,
    });
    expect(legacy).toMatchObject({
      crossConnectionScope: false,
      effectiveChannelIds: ["channel_un_5520"],
    });
    // "Ampliar para todas as conexões" (audited like any edit).
    const widened = await world.service.updateRule(
      workspaceId,
      legacy.id,
      { crossConnectionScope: true },
      "user_1",
    );
    expect(widened).toMatchObject({ crossConnectionScope: true });
    expect(widened.effectiveChannelIds?.length).toBeGreaterThan(1);
    // Never for other origins.
    await expect(
      world.service.createRule(
        workspaceId,
        providerConversionRuleCreateInputSchema.parse({
          name: "Payt",
          triggerType: "provider_automation",
          automationSource: "payt",
          eventName: "Purchase",
          connectionId: "connection_umbler",
          scope: "all_numbers",
          crossConnectionScope: true,
        }),
        "user_1",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("shows value/mode differences, which rule prevails, and requires confirmation", async () => {
    const world = createWorld({ unnichat: true });
    const first = await unnichatRule(world, "un_5159", { eventName: "Purchase", defaultValueCents: 10_000 });
    const second = await unnichatRule(world, "un_5520", { eventName: "Purchase", defaultValueCents: 25_000 });
    const { groups } = await world.service.listUnifyCandidates(workspaceId);
    expect(groups[0]).toMatchObject({
      targetRuleId: first.rule.id,
      differences: ["value"],
    });
    expect(groups[0]!.members?.map((member) => member.defaultValueCents).sort()).toEqual([10_000, 25_000]);
    await expect(
      world.service.unifyRules(workspaceId, { ruleIds: groups[0]!.ruleIds }, "user_1"),
    ).rejects.toMatchObject({ status: 409 });
    expect(world.providerRules.every((rule) => rule.unifiedIntoProviderRuleId === null)).toBe(true);
    const unified = await world.service.unifyRules(
      workspaceId,
      { ruleIds: groups[0]!.ruleIds, acknowledgeDifferences: true },
      "user_1",
    );
    // The target keeps ITS value.
    expect(unified.rule).toMatchObject({
      id: first.rule.id,
      crossConnectionScope: true,
      conversionRule: { defaultValueCents: 10_000 },
    });
    expect(unified.deactivatedRuleIds).toEqual([second.rule.id]);
  });

  it("offers Unificar for the per-connection rules (incl. the one whose number was removed) and promotes the oldest live one", async () => {
    const world = createWorld({ unnichat: true });
    const first = await unnichatRule(world, "un_5159");
    const second = await unnichatRule(world, "un_5520");
    const orphan = await unnichatRule(world, "un_third");
    // The customer deleted the 3rd number: its connection was removed.
    world.connections.find((c) => c.id === "connection_un_third")!.removedAt =
      new Date(now.getTime() - 86_400_000);

    const listed = await world.service.listRules(workspaceId);
    expect(listed.find((r) => r.id === orphan.rule.id)!.numberRemoved).toBe(true);
    expect(listed.find((r) => r.id === first.rule.id)!.numberRemoved).toBe(false);

    const { groups } = await world.service.listUnifyCandidates(workspaceId);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      origin: "automation_unnichat",
      eventName: "QualifiedLead",
      existingGlobalRuleId: null,
    });
    expect([...groups[0]!.ruleIds].sort()).toEqual(
      [first.rule.id, second.rule.id, orphan.rule.id].sort(),
    );

    const unified = await world.service.unifyRules(
      workspaceId,
      { ruleIds: groups[0]!.ruleIds },
      "user_1",
    );
    // The oldest rule with a live connection becomes the rule for all
    // numbers: same id, same connection and the same signed URL.
    expect(unified).toMatchObject({
      outcome: "created",
      rule: {
        id: first.rule.id,
        scope: "all_numbers",
        connectionId: "connection_un_5159",
        channelIds: [],
        effectiveChannelIds: [
          "channel_unnichat",
          "channel_un_5159",
          "channel_un_5520",
        ],
      },
    });
    expect(unified.rule.endpoint?.id).toBe(first.rule.endpoint?.id);
    expect([...unified.deactivatedRuleIds].sort()).toEqual(
      [second.rule.id, orphan.rule.id].sort(),
    );
    for (const id of [second.rule.id, orphan.rule.id]) {
      const paused = world.providerRules.find((rule) => rule.id === id)!;
      expect(paused).toMatchObject({
        unifiedIntoProviderRuleId: first.rule.id,
        removedAt: null,
      });
      // Nothing deleted: the paused rule keeps its URL and number rows.
      expect(world.endpoints.some((e) => e.providerRuleId === id)).toBe(true);
      expect(world.ruleChannels.some((scope) => scope.providerRuleId === id)).toBe(true);
    }
    const audit = world.audits.find(
      (entry) => entry.action === "provider_conversion_rule.unified",
    )!;
    expect(audit).toMatchObject({
      resultStatus: "promoted_member",
      afterSummary: { previousChannelIds: ["channel_un_5159"] },
    });

    // Idempotent: the same request again is a replay, nothing changes.
    const replay = await world.service.unifyRules(
      workspaceId,
      { ruleIds: groups[0]!.ruleIds },
      "user_1",
    );
    expect(replay).toMatchObject({ outcome: "replayed", rule: { id: first.rule.id } });
    expect((await world.service.listUnifyCandidates(workspaceId)).groups).toEqual([]);
  });

  it("folds a single per-connection rule into the existing rule for all numbers", async () => {
    const world = createWorld({ unnichat: true });
    const global = await unnichatRule(world, "un_5159", {
      scope: "all_numbers",
      crossConnectionScope: true,
      channelIds: undefined,
    });
    const specific = await unnichatRule(world, "un_5520");

    const { groups } = await world.service.listUnifyCandidates(workspaceId);
    expect(groups[0]).toMatchObject({
      ruleIds: [specific.rule.id],
      existingGlobalRuleId: global.rule.id,
    });
    const unified = await world.service.unifyRules(
      workspaceId,
      { ruleIds: [specific.rule.id] },
      "user_1",
    );
    expect(unified).toMatchObject({
      outcome: "reused_existing",
      rule: { id: global.rule.id },
      deactivatedRuleIds: [specific.rule.id],
    });
  });

  it("still asks for two rules of other origins", async () => {
    const world = createWorld();
    const { rule } = await world.service.createRule(
      workspaceId,
      messageInput({ connectionId: "connection_umbler", channelIds: ["channel_umbler"] }),
      "user_1",
    );
    await expect(
      world.service.unifyRules(workspaceId, { ruleIds: [rule.id] }, "user_1"),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("provider rules API: Conversões screen support", () => {
  it("reports the capability matrix without touching the database", () => {
    const world = createWorld();

    const capabilities = providerConversionRuleCapabilitiesSchema.parse(
      world.service.getCapabilities(),
    );

    expect(capabilities.workspaceScopeEnabled).toBe(true);
    // Porte do SaaS #155: "Lead recebido pela regra" is on by default in the nod.
    expect(capabilities.leadSubmittedRuleOverrideEnabled).toBe(true);
    expect(
      Object.fromEntries(
        capabilities.origins.map((origin) => [
          origin.origin,
          origin.channelProviders,
        ]),
      ),
    ).toEqual({
      message_phrase: ["umbler", "uazapi", "waha"],
      structured_catalog: ["umbler", "uazapi", "waha"],
      whatsapp_label: ["uazapi"],
      automation_umbler: ["umbler"],
      // Fase 4a: a Payt sale may belong to any WhatsApp number (Unnichat
      // numbers included since Fase 4b).
      automation_payt: [
        "umbler",
        "gupshup",
        "uazapi",
        "meta_cloud",
        "data_crazy",
        "unnichat",
        "waha",
      ],
      // Fase 4b: the Unnichat automation runs on its own connection number.
      automation_unnichat: ["unnichat"],
      // Fase 6.5: the Braip sale, same base as Payt (any WhatsApp number).
      automation_braip: [
        "umbler",
        "gupshup",
        "uazapi",
        "meta_cloud",
        "data_crazy",
        "unnichat",
        "waha",
      ],
    });
    expect(
      capabilities.origins.find((origin) => origin.origin === "message_phrase")
        ?.authorChannelProviders,
    ).toEqual({ team: ["umbler", "uazapi", "waha"], contact: ["umbler"] });
    expect(
      capabilities.origins.find((origin) => origin.origin === "automation_payt"),
    ).toMatchObject({
      eventNames: ["Purchase", "InitiateCheckout", "CartAbandoned"],
      betaEventNames: ["CartAbandoned"],
      unifiable: false,
      // Scope may use any WhatsApp number, but creation needs the connection
      // of its numbers (anchor of the signed URL), as the service enforces.
      connectionBound: false,
      requiresConnection: true,
    });
    expect(
      Object.fromEntries(
        capabilities.origins.map((origin) => [
          origin.origin,
          [origin.connectionBound, origin.requiresConnection],
        ]),
      ),
    ).toEqual({
      message_phrase: [false, false],
      structured_catalog: [false, false],
      whatsapp_label: [false, false],
      automation_umbler: [true, true],
      automation_payt: [false, true],
      automation_unnichat: [true, true],
      automation_braip: [false, true],
    });
    // Unnichat: any catalog event (the rule chooses it), never unified.
    expect(
      capabilities.origins.find(
        (origin) => origin.origin === "automation_unnichat",
      ),
    ).toMatchObject({ unifiable: false });
    expect(
      capabilities.origins.find(
        (origin) => origin.origin === "automation_unnichat",
      )?.eventNames,
    ).toBeUndefined();
    expect(capabilities.unsupportedWhatsappProviders).toEqual([
      "zapi",
      "nod_api",
    ]);
    expect(world.prisma.providerConversionRuleConfig.findMany).not.toHaveBeenCalled();
  });

  it("refuses the capabilities read when provider rules are disabled", () => {
    const service = new ProviderConversionRulesService({} as never, {
      ...env,
      INBOUND_CONVERSION_RULES_ENABLED: "false",
      INBOUND_CONVERSION_PRODUCTION_ENABLED: "false",
    });

    expect(() => service.getCapabilities()).toThrow(
      "Eventos de conversao por provedor ainda nao estao habilitados",
    );
  });
});

describe("old keyword/label rules (regras antigas)", () => {
  const legacyRow = (input: Row) => ({
    workspaceId,
    name: "Antiga",
    matchMode: "contains",
    pixelId: null,
    defaultValueCents: null,
    defaultCurrency: null,
    defaultContentName: null,
    defaultItems: null,
    active: true,
    createdAt: now,
    updatedAt: now,
    ...input,
  });

  it("lists rules without provider configuration and tells which can connect to numbers", async () => {
    const findMany = vi.fn(async () => [
      legacyRow({
        id: "keyword_purchase",
        triggerType: "keyword",
        triggerValue: "pix",
        eventName: "Purchase",
        defaultValueCents: 9_700,
        defaultCurrency: "BRL",
      }),
      legacyRow({
        id: "keyword_no_value",
        triggerType: "keyword",
        triggerValue: "pix",
        eventName: "Purchase",
      }),
      legacyRow({
        id: "label",
        triggerType: "whatsapp_label",
        triggerValue: "Comprou",
        eventName: "QualifiedLead",
      }),
    ]);
    const service = new ConversionRulesService({
      conversionRule: { findMany },
    } as never);

    const rules = legacyConversionRuleListSchema.parse(
      await service.listLegacyRules(workspaceId),
    );

    expect(findMany).toHaveBeenCalledWith({
      where: {
        workspaceId,
        providerConfig: { is: null },
        triggerType: { in: ["keyword", "whatsapp_label"] },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(
      rules.map((rule) => [rule.id, rule.adaptable, rule.adaptBlockedReason]),
    ).toEqual([
      ["keyword_purchase", true, null],
      ["keyword_no_value", false, "missing_value"],
      ["label", false, "not_keyword_purchase"],
    ]);
    expect(rules.every((rule) => rule.kind === "legacy")).toBe(true);
  });

  it("refuses to edit a provider-backed rule through the old endpoint (keeps the unify link consistent)", async () => {
    const update = vi.fn();
    const service = new ConversionRulesService({
      conversionRule: {
        findFirst: vi.fn(async () => ({ id: "conversion_1" })),
        update,
      },
      auditLog: { create: vi.fn() },
    } as never);

    await expect(
      service.updateRule(workspaceId, "conversion_1", { active: true }, "user_1"),
    ).rejects.toMatchObject({ status: 409 });
    expect(update).not.toHaveBeenCalled();
  });

  it("still pauses an old rule through the old endpoint", async () => {
    const update = vi.fn(async () =>
      legacyRow({
        id: "keyword_purchase",
        triggerType: "keyword",
        triggerValue: "pix",
        eventName: "Purchase",
        active: false,
      }),
    );
    const service = new ConversionRulesService({
      conversionRule: { findFirst: vi.fn(async () => null), update },
      auditLog: { create: vi.fn() },
    } as never);

    await expect(
      service.updateRule(
        workspaceId,
        "keyword_purchase",
        { active: false },
        "user_1",
      ),
    ).resolves.toMatchObject({ id: "keyword_purchase", active: false });
  });
});

describe("provider rule workspace scope migration (text check)", () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      "../../prisma/migrations/20261015140000_provider_rule_workspace_scope/migration.sql",
    ),
    "utf8",
  );
  const statements = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  it("defaults every existing rule to specific numbers and only relaxes NOT NULL", () => {
    expect(sql).toContain(
      `CREATE TYPE "ProviderConversionRuleScope" AS ENUM ('all_numbers', 'specific_numbers');`,
    );
    expect(sql).toContain(
      `ADD COLUMN "scope" "ProviderConversionRuleScope" NOT NULL DEFAULT 'specific_numbers'`,
    );
    expect(sql).toContain(`ALTER COLUMN "connectionId" DROP NOT NULL`);
    expect(sql).toContain(`ALTER COLUMN "parserReleaseId" DROP NOT NULL`);
    expect(sql).toContain(`CREATE TABLE "ProviderRuleCreateClaim"`);
  });

  it("checks existing data with a clear error before adding the CHECKs", () => {
    const precheck = statements.indexOf("RAISE EXCEPTION");
    expect(precheck).toBeGreaterThan(0);
    expect(precheck).toBeLessThan(
      statements.indexOf("ProviderConversionRuleConfig_binding_check"),
    );
    expect(precheck).toBeLessThan(
      statements.indexOf("ProviderConversionRuleConfig_unified_not_self_check"),
    );
    expect(statements).toContain(
      `CHECK (("connectionId" IS NULL) = ("parserReleaseId" IS NULL))`,
    );
  });

  it("is purely additive: no data rewrite, no drop of columns, tables or constraints", () => {
    expect(statements).not.toMatch(
      /\b(?:UPDATE\s+"|DELETE FROM|INSERT INTO|DROP TABLE|DROP COLUMN|DROP CONSTRAINT|DROP INDEX|TRUNCATE)\b/i,
    );
  });

  it("keeps the schema aligned with the migration", () => {
    const schema = readFileSync(
      resolve(__dirname, "../../prisma/schema.prisma"),
      "utf8",
    );
    expect(schema).toMatch(
      /enum ProviderConversionRuleScope \{\s+all_numbers\s+specific_numbers\s+\}/,
    );
    expect(schema).toMatch(
      /scope\s+ProviderConversionRuleScope\s+@default\(specific_numbers\)/,
    );
    expect(schema).toMatch(
      /connectionId\s+String\?\r?\n\s+parserReleaseId\s+String\?/,
    );
    expect(schema).toMatch(/model ProviderRuleCreateClaim \{/);
  });
});

describe("Fase 5.3: product filter, URL própria and 'Desativar URL antiga'", () => {
  const paytSale = {
    name: "Venda Payt",
    triggerType: "provider_automation",
    automationSource: "payt",
    eventName: "Purchase",
    scope: "all_numbers",
    channelIds: [],
    connectionId: "connection_umbler",
  };

  it("stores the product filter of a Payt rule in uppercase, without duplicates", async () => {
    const world = createWorld();
    const created = await world.service.createRule(
      workspaceId,
      providerConversionRuleCreateInputSchema.parse({
        ...paytSale,
        productFilterCodes: ["proda", "PRODA", "ofr-1"],
      }),
      "user_1",
    );
    expect(created.rule.productFilterCodes).toEqual(["PRODA", "OFR-1"]);
    const updated = await world.service.updateRule(
      workspaceId,
      created.rule.id,
      providerConversionRuleUpdateInputSchema.parse({ productFilterCodes: [] }),
      "user_1",
    );
    expect(updated.productFilterCodes).toEqual([]);
  });

  it("refuses a product filter outside a sales platform rule (schema and service)", async () => {
    const world = createWorld();
    expect(
      providerConversionRuleCreateInputSchema.safeParse({
        name: "Umbler",
        triggerType: "provider_automation",
        eventName: "QualifiedLead",
        connectionId: "connection_umbler",
        channelIds: ["channel_umbler"],
        productFilterCodes: ["PRODA"],
      }).success,
    ).toBe(false);
    const { rule } = await world.service.createRule(
      workspaceId,
      messageInput({ scope: "all_numbers", channelIds: [] }),
      "user_1",
    );
    await expect(
      world.service.updateRule(
        workspaceId,
        rule.id,
        providerConversionRuleUpdateInputSchema.parse({
          productFilterCodes: ["PRODA"],
        }),
        "user_1",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("creates a Payt checkout rule for the URL única with a product filter and no public per-rule URL (SaaS 22c6506)", async () => {
    const world = createWorld();
    const created = await world.service.createRule(
      workspaceId,
      providerConversionRuleCreateInputSchema.parse({
        ...paytSale,
        eventName: "InitiateCheckout",
        productFilterCodes: ["PROD1"],
        perRuleUrl: false,
      }),
      "user_1",
    );
    expect(created.rule.conversionRule.eventName).toBe("InitiateCheckout");
    expect(created.rule.productFilterCodes).toEqual(["PROD1"]);
    // Received only through the workspace URL: no per-rule URL is handed out.
    expect(created.webhookUrl).toBeNull();
    expect(created.rule.endpoint?.publicUrlDisabledAt).toEqual(
      expect.any(String),
    );
  });

  it("disables the old URL only with the confirmation in the PATCH, and reopens it (reversible, audited)", async () => {
    const world = createWorld();
    const created = await world.service.createRule(
      workspaceId,
      providerConversionRuleCreateInputSchema.parse(paytSale),
      "user_1",
    );
    expect(created.rule.endpoint?.publicUrlDisabledAt).toBeNull();
    // Contract: disabling needs confirmPublicUrlDisable: true.
    expect(
      providerConversionRuleUpdateInputSchema.safeParse({
        publicUrlDisabled: true,
      }).success,
    ).toBe(false);
    expect(
      providerConversionRuleUpdateInputSchema.safeParse({
        confirmPublicUrlDisable: true,
      }).success,
    ).toBe(false);
    expect(
      providerConversionRuleUpdateInputSchema.safeParse({
        publicUrlDisabled: false,
      }).success,
    ).toBe(true);

    // Without the URL única of the platform the old URL cannot be closed.
    const disable = providerConversionRuleUpdateInputSchema.parse({
      publicUrlDisabled: true,
      confirmPublicUrlDisable: true,
    });
    await expect(
      world.service.updateRule(workspaceId, created.rule.id, disable, "user_1"),
    ).rejects.toMatchObject({ status: 409 });
    expect(world.endpoints[0]?.publicUrlDisabledAt ?? null).toBeNull();
    world.integrationEndpoints.push({
      id: "integration_payt",
      workspaceId,
      provider: "payt",
      eventName: null,
      removedAt: null,
    });

    const disabled = await world.service.updateRule(
      workspaceId,
      created.rule.id,
      providerConversionRuleUpdateInputSchema.parse({
        publicUrlDisabled: true,
        confirmPublicUrlDisable: true,
      }),
      "user_1",
    );
    expect(disabled.endpoint?.publicUrlDisabledAt).toEqual(expect.any(String));
    // The rule itself is untouched: active, same mode, same endpoint.
    expect(disabled.conversionRule.active).toBe(true);
    expect(disabled.endpoint?.id).toBe(created.rule.endpoint?.id);

    const reopened = await world.service.updateRule(
      workspaceId,
      created.rule.id,
      providerConversionRuleUpdateInputSchema.parse({ publicUrlDisabled: false }),
      "user_1",
    );
    expect(reopened.endpoint?.publicUrlDisabledAt).toBeNull();
    expect(
      world.audits
        .map((audit) => audit.action)
        .filter((action: string) => action.includes("public_url")),
    ).toEqual([
      "provider_conversion_rule.public_url_disabled",
      "provider_conversion_rule.public_url_enabled",
    ]);
  });

  it("refuses the switch on a rule without its own URL (message rules)", async () => {
    const world = createWorld();
    const { rule } = await world.service.createRule(
      workspaceId,
      messageInput({ scope: "all_numbers", channelIds: [] }),
      "user_1",
    );
    await expect(
      world.service.updateRule(
        workspaceId,
        rule.id,
        providerConversionRuleUpdateInputSchema.parse({
          publicUrlDisabled: false,
        }),
        "user_1",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

// Fase 6.1a: porte do SaaS (0f6e010d, #161).
describe("provider rules API: excluir regras unificadas e em lote", () => {
  async function unifiedWorld() {
    const world = createWorld({ unnichat: true });
    const create = (number: "un_5159" | "un_5520" | "un_third") =>
      world.service.createRule(
        workspaceId,
        providerConversionRuleCreateInputSchema.parse({
          name: "Lead Qualificado",
          triggerType: "provider_automation",
          eventName: "QualifiedLead",
          connectionId: `connection_${number}`,
          channelIds: [`channel_${number}`],
        }),
        "user_1",
      );
    const target = await create("un_5159");
    const member = await create("un_5520");
    const orphan = await create("un_third");
    world.connections.find((c) => c.id === "connection_un_third")!.removedAt =
      new Date(now.getTime() - 86_400_000);
    const { groups } = await world.service.listUnifyCandidates(workspaceId);
    await world.service.unifyRules(
      workspaceId,
      { ruleIds: groups[0]!.ruleIds },
      "user_1",
    );
    return { world, target: target.rule, member: member.rule, orphan: orphan.rule };
  }

  it("deletes a unified member and a unified rule whose number was removed (used to answer 404)", async () => {
    const { world, member, orphan } = await unifiedWorld();

    await world.service.removeRule(workspaceId, member.id, "user_1");
    await world.service.removeRule(workspaceId, orphan.id, "user_1");

    for (const id of [member.id, orphan.id]) {
      const row = world.providerRules.find((rule) => rule.id === id)!;
      expect(row.removedAt).toBeInstanceOf(Date);
      expect(
        world.endpoints.find((endpoint) => endpoint.providerRuleId === id)!
          .removedAt,
      ).toBeInstanceOf(Date);
    }
    expect(
      world.audits.filter((a) => a.action === "provider_conversion_rule.removed"),
    ).toHaveLength(2);
    expect(
      (await world.service.listRules(workspaceId)).map((rule) => rule.id),
    ).not.toContain(orphan.id);
  });

  it("bulk: removes members and orphans, reports a missing rule and removes the target last", async () => {
    const { world, target, member, orphan } = await unifiedWorld();

    const result = await world.service.removeRules(
      workspaceId,
      { ruleIds: [target.id, member.id, "missing_rule", orphan.id] },
      "user_1",
    );
    // Members of the same batch go first, so the target has none left.
    expect(result.results.map((item) => [item.ruleId, item.status])).toEqual([
      [target.id, "removed"],
      [member.id, "removed"],
      ["missing_rule", "not_found"],
      [orphan.id, "removed"],
    ]);
    expect(result.removedCount).toBe(3);
  });

  it("bulk: a target that still has unified rules needs its own confirmation", async () => {
    const { world, target, member } = await unifiedWorld();

    const refused = await world.service.removeRules(
      workspaceId,
      { ruleIds: [target.id] },
      "user_1",
    );
    expect(refused.results[0]!.status).toBe("needs_target_confirmation");
    expect(
      world.providerRules.find((rule) => rule.id === target.id)!.removedAt,
    ).toBeNull();

    const confirmed = await world.service.removeRules(
      workspaceId,
      { ruleIds: [target.id], confirmTargetRuleIds: [target.id] },
      "user_1",
    );
    expect(confirmed.results[0]!.status).toBe("removed");
    expect(
      world.providerRules.find((rule) => rule.id === member.id)!.removedAt,
    ).toBeNull();
  });

  it("bulk: one failing deletion does not stop the others", async () => {
    const { world, member, orphan } = await unifiedWorld();
    const original = world.prisma.providerConversionRuleConfig.update;
    world.prisma.providerConversionRuleConfig.update = vi.fn(
      async (args: Row) => {
        if (args.where.id === member.id) throw new Error("db down");
        return original(args);
      },
    );

    const result = await world.service.removeRules(
      workspaceId,
      { ruleIds: [member.id, orphan.id] },
      "user_1",
    );
    expect(result.results.map((item) => item.status)).toEqual([
      "failed",
      "removed",
    ]);
    expect(result.removedCount).toBe(1);
  });
});

describe("Fase 6.1c: produção direta (regras nascem enviando)", () => {
  const payt = {
    name: "Venda Payt",
    triggerType: "provider_automation",
    automationSource: "payt",
    eventName: "Purchase",
    scope: "specific_numbers",
    connectionId: "connection_umbler",
    channelIds: ["channel_umbler"],
  };
  const umbler = {
    name: "Venda Umbler",
    triggerType: "provider_automation",
    eventName: "QualifiedLead",
    scope: "all_numbers",
    connectionId: "connection_umbler",
  };
  const unnichat = {
    name: "Comprou no Unnichat",
    triggerType: "provider_automation",
    eventName: "Purchase",
    defaultValueCents: 15000,
    defaultCurrency: "BRL",
    scope: "all_numbers",
    channelIds: [],
    connectionId: "connection_unnichat",
  };
  const label = {
    name: "Tag comprou",
    triggerType: "provider_automation",
    triggerLabels: [{ id: "551199:3", name: "Comprou" }],
    eventName: "QualifiedLead",
    scope: "all_numbers",
  };
  const catalog = {
    name: "Catálogo",
    triggerType: "structured_catalog",
    eventName: "Purchase",
    messageAuthorScope: "team",
    scope: "all_numbers",
    triggerPhrases: ["pedido confirmado"],
    catalog: {
      name: "Camas",
      productName: "Cama elástica",
      currency: "BRL",
      attributes: [{ key: "tamanho", label: "Tamanho" }],
      variants: [{ attributeValues: ["3,05"], aliases: [], valueCents: 199_000 }],
    },
  };

  it.each([
    ["frase da equipe (Uazapi/WAHA, todos os números)", () => messageInput({ scope: "all_numbers" })],
    [
      "frase num número específico (Uazapi)",
      () =>
        messageInput({
          channelIds: [
            createWorld().channels.find(
              (channel) => channel.whatsappInstanceId === "instance_a",
            )!.id,
          ],
        }),
    ],
    ["etiqueta Uazapi", () => providerConversionRuleCreateInputSchema.parse(label)],
    ["Payt", () => providerConversionRuleCreateInputSchema.parse(payt)],
    ["Umbler (automação)", () => providerConversionRuleCreateInputSchema.parse(umbler)],
    ["Unnichat (automação)", () => providerConversionRuleCreateInputSchema.parse(unnichat)],
  ])("%s: nasce em produção, sem modo pedido e sem clicar em Ativar envio", async (_name, input) => {
    const world = createWorld();
    const parsed = input();
    expect(parsed.mode).toBeUndefined();
    const { rule } = await world.service.createRule(workspaceId, parsed, "user_1");
    expect(rule.mode).toBe("production");
    expect(rule.productionActivatedAt).toEqual(expect.any(String));
    const created = world.audits.find(
      (audit) => audit.action === "provider_conversion_rule.created",
    );
    expect(created).toMatchObject({
      resultStatus: "production",
      afterSummary: expect.objectContaining({
        mode: "production",
        productionDirect: true,
      }),
    });
  });

  it("catálogo estruturado também nasce em produção", async () => {
    const world = createWorld();
    const parsed = providerConversionRuleCreateInputSchema.safeParse(catalog);
    // O contrato do catálogo é validado pelo schema; se mudar, o teste avisa.
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    Object.assign(world.prisma, {
      conversionCatalog: {
        create: vi.fn(async ({ data }: Row) => ({ id: "catalog_1", ...data })),
      },
      conversionCatalogAttribute: {
        createMany: vi.fn(async ({ data }: Row) => ({ count: data.length })),
      },
      conversionCatalogVariant: {
        createMany: vi.fn(async ({ data }: Row) => ({ count: data.length })),
      },
    });
    const { rule } = await world.service.createRule(
      workspaceId,
      parsed.data,
      "user_1",
    );
    expect(rule.mode).toBe("production");
  });

  it("um modo pedido explicitamente continua valendo (observação só por escolha)", async () => {
    const world = createWorld();
    const { rule } = await world.service.createRule(
      workspaceId,
      messageInput({ scope: "all_numbers", mode: "observation" }),
      "user_1",
    );
    expect(rule.mode).toBe("observation");
    expect(rule.productionActivatedAt).toBeNull();
  });

  it("com o envio de regras desligado no servidor (false explícito), nasce sem envio em vez de falhar", async () => {
    const world = createWorld();
    const service = new ProviderConversionRulesService(world.prisma as never, {
      ...env,
      INBOUND_CONVERSION_PRODUCTION_ENABLED: "false",
    });
    const { rule } = await service.createRule(
      workspaceId,
      messageInput({ scope: "all_numbers" }),
      "user_1",
    );
    expect(rule.mode).toBe("observation");
  });

  it("um leitor ainda não validado mantém a observação (a única que sobra)", async () => {
    const world = createWorld();
    const findRelease = world.prisma.inboundWebhookParserRelease.findFirst;
    world.prisma.inboundWebhookParserRelease.findFirst = vi.fn(
      async (args: Row) => {
        const release = await findRelease(args);
        return release && release.id === "release_umbler_automation"
          ? { ...release, status: "observation_only" }
          : release;
      },
    );
    const { rule } = await world.service.createRule(
      workspaceId,
      providerConversionRuleCreateInputSchema.parse(umbler),
      "user_1",
    );
    expect(rule.mode).toBe("observation");
    expect(rule.productionActivatedAt).toBeNull();
  });

  it("Retomar uma regra pausada volta enviando, sem passar por observação", async () => {
    const world = createWorld();
    const { rule } = await world.service.createRule(
      workspaceId,
      messageInput({ scope: "all_numbers" }),
      "user_1",
    );
    const paused = await world.service.updateRule(
      workspaceId,
      rule.id,
      providerConversionRuleUpdateInputSchema.parse({ active: false }),
      "user_1",
    );
    expect(paused.conversionRule.active).toBe(false);
    expect(paused.mode).toBe("observation");

    const resumed = await world.service.updateRule(
      workspaceId,
      rule.id,
      providerConversionRuleUpdateInputSchema.parse({ active: true }),
      "user_1",
    );
    expect(resumed.conversionRule.active).toBe(true);
    expect(resumed.mode).toBe("production");
    expect(resumed.productionActivatedAt).toEqual(expect.any(String));
  });
});
