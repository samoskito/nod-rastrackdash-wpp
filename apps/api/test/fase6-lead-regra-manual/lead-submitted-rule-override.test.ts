import { describe, expect, it, vi } from "vitest";
import {
  LEAD_SUBMITTED_RULE_OVERRIDE_FLAG,
  leadSubmittedRuleOverrideEnabled,
  resolveLeadSubmittedRuleOverride,
  type LeadSubmittedOverrideDeps,
  type LeadSubmittedOverrideDestination,
} from "../../src/conversion-rules/lead-submitted-rule-override";

/**
 * Porte do SaaS #155 (tarefa 20): an active PRODUCTION LeadSubmitted provider
 * rule covering the entry number makes the entry defer its LeadSubmitted to
 * the rule. Rules come through the real scope/precedence code
 * (provider-rule-scope.ts); only the Prisma reads are faked.
 *
 * nod: the flag is ON by default (produção direta) and the SaaS seat gate is
 * the usable license plus, for Uazapi BYO / WAHA bridge numbers, the WhatsApp
 * connection active. Fixtures are synthetic (no real data).
 */

const workspaceId = "workspace_1";
const env = {
  NODE_ENV: "test",
  API_PUBLIC_URL: "http://localhost:3333",
  INBOUND_WEBHOOKS_ENABLED: "true",
  INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
  INBOUND_CONVERSION_RULES_ENABLED: "true",
  INBOUND_CONVERSION_PRODUCTION_ENABLED: "true",
  INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 23).toString("base64"),
  [LEAD_SUBMITTED_RULE_OVERRIDE_FLAG]: "true",
};

const certifiedConnection = (id: string, provider = "uazapi") => ({
  id,
  provider,
  status: "production",
  removedAt: null,
  parserReleaseId: `parser_${provider}`,
  parserRelease: { provider, version: "v1", status: "certified" },
});

type Rule = ReturnType<typeof rule>;
function rule(input: {
  id: string;
  scope?: "specific_numbers" | "all_numbers";
  mode?: "observation" | "production";
  channels?: string[];
  triggerType?: string;
  connection?: ReturnType<typeof certifiedConnection> | null;
  productionActivatedAt?: Date | null;
}) {
  const mode = input.mode ?? "production";
  return {
    id: input.id,
    scope: input.scope ?? "specific_numbers",
    connectionId: input.connection?.id ?? null,
    removedAt: null,
    mode,
    productionActivatedAt:
      input.productionActivatedAt !== undefined
        ? input.productionActivatedAt
        : mode === "production"
          ? new Date("2026-10-01T00:00:00.000Z")
          : null,
    parserReleaseId: null,
    conversionRule: {
      triggerType: input.triggerType ?? "message_phrase",
      eventName: "LeadSubmitted",
      active: true,
      name: `Regra ${input.id}`,
    },
    parserRelease: null,
    connection: input.connection ?? null,
    channels: (input.channels ?? []).map((channelId) => ({ channelId })),
  };
}

type Channel = {
  id: string;
  connectionId: string;
  provider: string;
  phone: string | null;
  createdAt: Date;
  status?: string;
  conversionEngineMode?: string;
  productionActivatedAt?: Date | null;
  /** WhatsApp connection of a bridged (Uazapi BYO / WAHA) number. */
  instanceStatus?: string;
  connection?: ReturnType<typeof certifiedConnection>;
};

const channelA: Channel = {
  id: "channel_a",
  connectionId: "connection_a",
  provider: "uazapi",
  phone: "5511987654321",
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
};
const channelB: Channel = {
  id: "channel_b",
  connectionId: "connection_b",
  provider: "uazapi",
  phone: "5511912345678",
  createdAt: new Date("2026-09-02T00:00:00.000Z"),
};

function client(rules: Rule[], channels: Channel[] = [channelA, channelB]) {
  const gate = (channel: Channel) => ({
    id: channel.id,
    status: channel.status ?? "active",
    conversionEngineMode: channel.conversionEngineMode ?? "canonical",
    productionActivatedAt:
      channel.productionActivatedAt !== undefined
        ? channel.productionActivatedAt
        : new Date("2026-09-15T00:00:00.000Z"),
    whatsappInstance: { status: channel.instanceStatus ?? "active" },
    connection:
      channel.connection ??
      certifiedConnection(channel.connectionId, channel.provider),
  });
  return {
    providerConversionRuleConfig: {
      findMany: vi.fn(async ({ where }: any) => {
        if (where.scope === "specific_numbers") {
          // Peer specific rules of sibling channels (same phone).
          const ids: string[] = where.channels.some.channelId.in;
          return rules.filter(
            (candidate) =>
              candidate.scope === "specific_numbers" &&
              candidate.channels.some((scope) => ids.includes(scope.channelId)),
          );
        }
        return rules;
      }),
    },
    inboundWebhookChannel: {
      findMany: vi.fn(async ({ where, select }: any) => {
        if (select.connectedPhone && where.connection) {
          // scanWorkspaceScopeChannels (one page)
          return channels.map((channel) => ({
            id: channel.id,
            connectionId: channel.connectionId,
            organizationId: null,
            providerChannelId: null,
            status: channel.status ?? "active",
            createdAt: channel.createdAt,
            lastSeenAt: null,
            connectedPhone: channel.phone ?? "",
            connection: { provider: channel.provider, status: "production" },
          }));
        }
        return channels
          .filter((channel) => where.id.in.includes(channel.id))
          .map(gate);
      }),
    },
  };
}

const entryOn = (
  channel: Channel,
  destination: LeadSubmittedOverrideDestination | null = {
    kind: "ad_route",
    adId: "ad_1",
  },
) => ({
  workspaceId,
  channel: {
    id: channel.id,
    connectionId: channel.connectionId,
    provider: channel.provider,
  },
  destination,
});

const resolvedRoute = {
  status: "resolved",
  reportingAccountId: "reporting_1",
  adAccountId: "act_1",
  businessConnectionId: "business_1",
  conversionDestinationId: "destination_1",
};

/** Default deps: license usable, ad route resolves. */
function resolveOverride(
  client: unknown,
  input: ReturnType<typeof entryOn>,
  overrideEnv: Record<string, string | undefined> = env,
  deps: Partial<LeadSubmittedOverrideDeps> = {},
) {
  return resolveLeadSubmittedRuleOverride(client as never, input, {
    env: overrideEnv,
    license: { getLockState: vi.fn(async () => ({ inert: false, locked: false })) },
    previewRoute: vi.fn(async () => resolvedRoute),
    ...deps,
  });
}

describe("LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED", () => {
  it("is ON by default in the nod (produção direta); explicit false/0/off/no disables", () => {
    expect(leadSubmittedRuleOverrideEnabled({})).toBe(true);
    expect(
      leadSubmittedRuleOverrideEnabled({ [LEAD_SUBMITTED_RULE_OVERRIDE_FLAG]: "" }),
    ).toBe(true);
    expect(
      leadSubmittedRuleOverrideEnabled({ [LEAD_SUBMITTED_RULE_OVERRIDE_FLAG]: " TRUE " }),
    ).toBe(true);
    expect(
      leadSubmittedRuleOverrideEnabled({ [LEAD_SUBMITTED_RULE_OVERRIDE_FLAG]: "1" }),
    ).toBe(true);
    for (const off of ["false", " FALSE ", "0", "off", "Off", "no"])
      expect(
        leadSubmittedRuleOverrideEnabled({ [LEAD_SUBMITTED_RULE_OVERRIDE_FLAG]: off }),
      ).toBe(false);
  });

  it("flag off: never suppresses and never queries", async () => {
    const fake = client([rule({ id: "specific", channels: ["channel_a"] })]);
    const flagOff = { ...env, [LEAD_SUBMITTED_RULE_OVERRIDE_FLAG]: "false" };
    await expect(
      resolveOverride(fake as never, entryOn(channelA), flagOff),
    ).resolves.toBeNull();
    expect(fake.providerConversionRuleConfig.findMany).not.toHaveBeenCalled();
  });

  it("conversion production off: entry keeps sending", async () => {
    const fake = client([rule({ id: "specific", channels: ["channel_a"] })]);
    await expect(
      resolveOverride(fake as never, entryOn(channelA), {
        ...env,
        INBOUND_CONVERSION_PRODUCTION_ENABLED: "false",
      }),
    ).resolves.toBeNull();
  });
});

describe("resolveLeadSubmittedRuleOverride", () => {
  it("a specific production rule covers its number only", async () => {
    const fake = client([rule({ id: "specific", channels: ["channel_a"] })]);
    await expect(
      resolveOverride(fake as never, entryOn(channelA), env),
    ).resolves.toEqual({ ruleIds: ["specific"], ruleNames: ["Regra specific"] });
    await expect(
      resolveOverride(fake as never, entryOn(channelB), env),
    ).resolves.toBeNull();
  });

  it("a global (all numbers) production rule covers every capable number", async () => {
    const fake = client([rule({ id: "global", scope: "all_numbers" })]);
    for (const channel of [channelA, channelB]) {
      await expect(
        resolveOverride(fake as never, entryOn(channel), env),
      ).resolves.toMatchObject({ ruleIds: ["global"] });
    }
    // Message rules do not run on Gupshup numbers: the entry keeps sending.
    const gupshup: Channel = {
      ...channelB,
      id: "channel_g",
      connectionId: "connection_g",
      provider: "gupshup",
    };
    await expect(
      resolveOverride(
        client([rule({ id: "global", scope: "all_numbers" })], [gupshup]) as never,
        entryOn(gupshup),
        env,
      ),
    ).resolves.toBeNull();
  });

  it("observation rules never suppress (decision A)", async () => {
    const fake = client([
      rule({ id: "obs", mode: "observation", channels: ["channel_a"] }),
      rule({ id: "obs_global", mode: "observation", scope: "all_numbers" }),
    ]);
    await expect(
      resolveOverride(fake as never, entryOn(channelA), env),
    ).resolves.toBeNull();
  });

  it("a specific observation rule replaces the production global on its number", async () => {
    const fake = client([
      rule({ id: "global", scope: "all_numbers" }),
      rule({ id: "obs_a", mode: "observation", channels: ["channel_a"] }),
    ]);
    await expect(
      resolveOverride(fake as never, entryOn(channelA), env),
    ).resolves.toBeNull();
    await expect(
      resolveOverride(fake as never, entryOn(channelB), env),
    ).resolves.toMatchObject({ ruleIds: ["global"] });
  });

  it("production without activation time does not suppress", async () => {
    const fake = client([
      rule({ id: "half", channels: ["channel_a"], productionActivatedAt: null }),
    ]);
    await expect(
      resolveOverride(fake as never, entryOn(channelA), env),
    ).resolves.toBeNull();
  });

  it("same phone on two channels: the global rule runs on the canonical one", async () => {
    // channel_a2 is a newer channel of the SAME phone as channel_a.
    const channelA2: Channel = {
      ...channelA,
      id: "channel_a2",
      connectionId: "connection_a2",
      createdAt: new Date("2026-09-20T00:00:00.000Z"),
    };
    const rules = [rule({ id: "global", scope: "all_numbers" })];
    await expect(
      resolveOverride(
        client(rules, [channelA, channelA2]) as never,
        entryOn(channelA2),
        env,
      ),
    ).resolves.toMatchObject({ ruleIds: ["global"] });
    // The canonical channel cannot send (legacy engine): the entry keeps sending.
    await expect(
      resolveOverride(
        client(rules, [{ ...channelA, conversionEngineMode: "legacy" }, channelA2]) as never,
        entryOn(channelA2),
        env,
      ),
    ).resolves.toBeNull();
  });

  it("uncertified or non-production connection: entry keeps sending", async () => {
    const uncertified: Channel = {
      ...channelA,
      connection: {
        ...certifiedConnection("connection_a"),
        parserRelease: { provider: "uazapi", version: "v1", status: "observation_only" },
      },
    };
    const observing: Channel = {
      ...channelA,
      connection: { ...certifiedConnection("connection_a"), status: "observation" },
    };
    const rules = [rule({ id: "specific", channels: ["channel_a"] })];
    for (const channel of [uncertified, observing]) {
      await expect(
        resolveOverride(
          client(rules, [channel, channelB]) as never,
          entryOn(channel),
          env,
        ),
      ).resolves.toBeNull();
    }
  });

  it("connection-bound automation: needs its own connection in production", async () => {
    const unnichat: Channel = {
      ...channelA,
      id: "channel_u",
      connectionId: "connection_u",
      provider: "unnichat",
    };
    const bound = (connection: ReturnType<typeof certifiedConnection>) =>
      rule({
        id: "automation",
        triggerType: "provider_automation",
        scope: "all_numbers",
        connection,
      });
    await expect(
      resolveOverride(
        client([bound(certifiedConnection("connection_u", "unnichat"))], [unnichat]) as never,
        entryOn(unnichat),
        env,
      ),
    ).resolves.toMatchObject({ ruleIds: ["automation"] });
    await expect(
      resolveOverride(
        client(
          [
            bound({
              ...certifiedConnection("connection_u", "unnichat"),
              parserRelease: { provider: "unnichat", version: "v1", status: "observation_only" },
            }),
          ],
          [unnichat],
        ) as never,
        entryOn(unnichat),
        env,
      ),
    ).resolves.toBeNull();
  });

  it("legacy or shadow engine number: entry keeps sending", async () => {
    const legacy: Channel = { ...channelA, conversionEngineMode: "shadow" };
    await expect(
      resolveOverride(
        client([rule({ id: "specific", channels: ["channel_a"] })], [legacy]) as never,
        entryOn(legacy),
        env,
      ),
    ).resolves.toBeNull();
  });

  it("queries only active, live, not unified LeadSubmitted rules of the number", async () => {
    const fake = client([]);
    await resolveOverride(fake as never, entryOn(channelA), env);
    expect(fake.providerConversionRuleConfig.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId,
          removedAt: null,
          unifiedIntoProviderRuleId: null,
          conversionRule: { active: true, eventName: "LeadSubmitted" },
        }),
      }),
    );
  });
});

describe("what the rule send will need (no zero-LeadSubmitted lead)", () => {
  const specific = () => client([rule({ id: "specific", channels: ["channel_a"] })]);

  it("license blocked: entry keeps sending (nod, in place of the SaaS seat)", async () => {
    const getLockState = vi.fn(async () => ({ inert: false, locked: true }));
    await expect(
      resolveOverride(specific(), entryOn(channelA), env, {
        license: { getLockState },
      }),
    ).resolves.toBeNull();
    expect(getLockState).toHaveBeenCalled();
    // Licensing inert (no license server configured): may defer.
    await expect(
      resolveOverride(specific(), entryOn(channelA), env, {
        license: { getLockState: async () => ({ inert: true, locked: false }) },
      }),
    ).resolves.toMatchObject({ ruleIds: ["specific"] });
    // License read failing: fail closed.
    await expect(
      resolveOverride(specific(), entryOn(channelA), env, {
        license: {
          getLockState: async () => {
            throw new Error("db");
          },
        },
      }),
    ).resolves.toBeNull();
  });

  it("bridged number with the WhatsApp connection suspended: entry keeps sending", async () => {
    for (const provider of ["uazapi", "waha"]) {
      const suspended: Channel = { ...channelA, provider, instanceStatus: "suspended" };
      await expect(
        resolveOverride(
          client([rule({ id: "specific", channels: ["channel_a"] })], [suspended]) as never,
          entryOn(suspended),
          env,
        ),
      ).resolves.toBeNull();
    }
    // A webhook provider has no WhatsApp connection of its own: not gated.
    const umbler: Channel = { ...channelA, provider: "umbler", instanceStatus: "suspended" };
    await expect(
      resolveOverride(
        client([rule({ id: "specific", channels: ["channel_a"] })], [umbler]) as never,
        entryOn(umbler),
        env,
      ),
    ).resolves.toMatchObject({ ruleIds: ["specific"] });
  });

  it("WAHA bridge number: a production phrase rule defers its entry like Uazapi", async () => {
    const waha: Channel = { ...channelA, id: "channel_w", connectionId: "connection_w", provider: "waha" };
    await expect(
      resolveOverride(
        client([rule({ id: "waha_rule", channels: ["channel_w"] })], [waha]) as never,
        entryOn(waha),
        env,
      ),
    ).resolves.toMatchObject({ ruleIds: ["waha_rule"] });
  });

  it("without the license gate available it never defers (fail closed)", async () => {
    await expect(
      resolveOverride(specific(), entryOn(channelA), env, { license: null }),
    ).resolves.toBeNull();
  });

  it("the lead's ad route must resolve completely", async () => {
    for (const route of [
      { status: "unresolved", reason: "ad_not_found" },
      { ...resolvedRoute, conversionDestinationId: null },
    ]) {
      await expect(
        resolveOverride(specific(), entryOn(channelA), env, {
          previewRoute: vi.fn(async () => route),
        }),
      ).resolves.toBeNull();
    }
    await expect(
      resolveOverride(specific(), entryOn(channelA), env, {
        previewRoute: vi.fn(async () => {
          throw new Error("db");
        }),
      }),
    ).resolves.toBeNull();
  });

  it("unknown destination: entry keeps sending; CTWA destination is enough", async () => {
    await expect(
      resolveOverride(specific(), entryOn(channelA, null), env),
    ).resolves.toBeNull();
    const previewRoute = vi.fn(async () => resolvedRoute);
    await expect(
      resolveOverride(
        specific(),
        entryOn(channelA, { kind: "ctwa_destination", destinationId: "destination_1" }),
        env,
        { previewRoute },
      ),
    ).resolves.toMatchObject({ ruleIds: ["specific"] });
    expect(previewRoute).not.toHaveBeenCalled();
  });
});
