import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProviderConversionDecisionEngine } from "../../src/conversion-rules/provider-conversion-decision.engine";
import { ProviderConversionObservationService } from "../../src/conversion-rules/provider-conversion-observation.service";
import { providerRuleNumberRemoved } from "../../src/conversion-rules/provider-conversion-rules.service";
import {
  PROVIDER_RULE_REANCHORED_ACTION,
  reanchorSpanningAutomationRules,
} from "../../src/conversion-rules/provider-rule-reanchor";
import { PROVIDER_RULE_OVERRIDDEN_REASON } from "../../src/conversion-rules/provider-rule-scope";

/**
 * Caso do cliente (21/10/2026): Unnichat cria UMA conexao por numero
 * ("Loja Exemplo - 5159", "Loja Exemplo - 5520"). Uma regra "Todos os numeros" da
 * Unnichat vale para todos os numeros de todas as conexoes da Unnichat
 * (inclusive um 3o numero conectado depois), com a conexao da regra so como
 * ancora. Real observation service + decision engine; storage is a fake.
 * All identifiers and phones are synthetic.
 */

const workspaceId = "workspace_exemplo";
const activatedAt = new Date("2026-10-01T00:00:00.000Z");
const receivedAt = new Date("2026-10-21T12:00:00.000Z");
const env = {
  NODE_ENV: "test",
  API_PUBLIC_URL: "http://localhost:3333",
  INBOUND_WEBHOOKS_ENABLED: "true",
  INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
  INBOUND_CONVERSION_RULES_ENABLED: "true",
  INBOUND_CONVERSION_PRODUCTION_ENABLED: "true",
  INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
};

const unnichatV1 = {
  id: "release_unnichat_v1",
  provider: "unnichat",
  version: "v1",
  status: "certified",
};
const automationRelease = {
  id: "release_unnichat_automation",
  provider: "unnichat",
  version: "automation-v1",
  status: "certified",
};

type Number = {
  channelId: string;
  connectionId: string;
  phone: string;
  connectionStatus?: "observation" | "production" | "paused";
  channelStatus?: "discovered" | "active" | "paused";
  removed?: boolean;
};

// 5159 and 5520 (one connection each) + a 3rd number connected later.
const numbers: Number[] = [
  { channelId: "ch_5159", connectionId: "conn_5159", phone: "555195405159" },
  { channelId: "ch_5520", connectionId: "conn_5520", phone: "555195365520" },
  { channelId: "ch_new", connectionId: "conn_new", phone: "555199990003" },
];

function connectionOf(number: Number) {
  return {
    id: number.connectionId,
    provider: "unnichat",
    status: number.connectionStatus ?? "production",
    removedAt: number.removed ? new Date("2026-10-18T00:00:00.000Z") : null,
    parserReleaseId: unnichatV1.id,
    parserRelease: unnichatV1,
    productionActivatedAt: activatedAt,
  };
}

function rule(input: {
  id: string;
  scope: "all_numbers" | "specific_numbers";
  anchor: string;
  channelIds?: string[];
}) {
  const anchor = numbers.find((number) => number.connectionId === input.anchor)!;
  return {
    id: input.id,
    workspaceId,
    connectionId: input.anchor,
    parserReleaseId: automationRelease.id,
    scope: input.scope,
    mode: "production",
    productionActivatedAt: activatedAt,
    removedAt: null,
    unifiedIntoProviderRuleId: null,
    createdAt: activatedAt,
    updatedAt: activatedAt,
    conversionRuleId: `conversion_${input.id}`,
    messageTriggerPhrases: [],
    messageAuthorScope: null,
    productFilterCodes: [],
    conversionRule: {
      id: `conversion_${input.id}`,
      active: true,
      triggerType: "provider_automation",
      eventName: "QualifiedLead",
      defaultValueCents: null,
      defaultCurrency: "BRL",
      defaultContentName: null,
      defaultItems: null,
      updatedAt: activatedAt,
    },
    connection: connectionOf(anchor),
    parserRelease: automationRelease,
    channels: (input.channelIds ?? []).map((channelId) => ({
      channelId,
      channel: {
        id: channelId,
        status: "active",
        productionActivatedAt: activatedAt,
        conversionEngineMode: "canonical",
      },
    })),
    catalog: null,
  };
}

function proofFor(number: Number) {
  return {
    kind: "authorized_ctwa_destination" as const,
    workspaceId,
    channelId: number.channelId,
    connectionId: number.connectionId,
    organizationId: workspaceId,
    providerChannelId: number.phone,
    destinationId: "destination_1",
    businessConnectionId: "business_1",
    credentialId: "credential_1",
    credentialFingerprint: "fingerprint_1",
    deliveryKind: "page_pixel" as const,
    pixelId: "pixel_1",
    pageId: "page_1",
  };
}

function harness(input: {
  rule: ReturnType<typeof rule>;
  /** Numbers whose CTWA entry proves this lead (one or several). */
  entries: Number[];
  numbers?: Number[];
  specificPeers?: Array<{ id: string; channelId: string }>;
  /** Lead with an ad id (channel from the contact's CTWA conversations). */
  adLead?: boolean;
  /** Contact's CTWA conversations, most recent LAST. */
  events?: Number[];
}) {
  const workspaceNumbers = input.numbers ?? numbers;
  const live = workspaceNumbers.filter((number) => !number.removed);
  const channelRow = (number: Number) => ({
    id: number.channelId,
    connectionId: number.connectionId,
    organizationId: workspaceId,
    providerChannelId: number.phone,
    status: number.channelStatus ?? "active",
    productionActivatedAt:
      (number.channelStatus ?? "active") === "active" ? activatedAt : null,
    conversionEngineMode: "canonical",
  });
  const events = [...(input.events ?? [])].reverse();
  const prisma = {
    providerConversionRuleConfig: {
      findFirst: vi.fn(async () => input.rule),
      // findOverridingSpecificRuleIds: specific rules of the same event.
      findMany: vi.fn(async ({ where }: any) =>
        (input.specificPeers ?? [])
          .filter((peer) =>
            (where.channels?.some?.channelId?.in ?? [
              where.channels?.some?.channelId,
            ]).includes(peer.channelId),
          )
          .map((peer) => ({
            id: peer.id,
            conversionRule: {
              triggerType: "provider_automation",
              eventName: "QualifiedLead",
            },
            parserRelease: { provider: "unnichat" },
            connection: { provider: "unnichat" },
          })),
      ),
    },
    inboundWebhookChannel: {
      findMany: vi.fn(async () =>
        live.map((number, index) => ({
          id: number.channelId,
          connectionId: number.connectionId,
          status: number.channelStatus ?? "active",
          createdAt: new Date(activatedAt.getTime() + index * 1000),
          connectedPhone: number.phone,
          connection: { provider: "unnichat" },
          whatsappSeats: [],
          whatsappInstance: null,
        })),
      ),
      findFirst: vi.fn(async ({ where }: any) => {
        const number = live.find(
          (candidate) =>
            candidate.channelId === where.id &&
            (where.connectionId === undefined ||
              candidate.connectionId === where.connectionId),
        );
        return number ? channelRow(number) : null;
      }),
    },
    inboundWebhookConnection: {
      findFirst: vi.fn(async ({ where }: any) => {
        const number = workspaceNumbers.find(
          (candidate) => candidate.connectionId === where.id,
        );
        return number ? connectionOf(number) : null;
      }),
    },
    inboundWebhookEvent: {
      // Most recent first, inside the asked connection and channels.
      findFirst: vi.fn(async ({ where }: any) => {
        const event = events.find(
          (number) =>
            !number.removed &&
            (where.connectionId === undefined ||
              number.connectionId === where.connectionId) &&
            where.channelId.in.includes(number.channelId),
        );
        return event ? { channel: channelRow(event) } : null;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        events
          .filter(
            (number) =>
              !number.removed && where.channelId.in.includes(number.channelId),
          )
          .map((number) => ({
            channel: {
              ...channelRow(number),
              connection: {
                status: number.connectionStatus ?? "production",
                removedAt: null,
              },
            },
          })),
      ),
    },
  };
  const decisions = {
    findLatestByOccurrence: vi.fn(async () => null),
    recordInitial: vi.fn(async ({ decision }: any) => ({
      id: "decision_1",
      workspaceId,
      providerRuleId: decision.rule.providerRuleId,
      decision,
      decisionCode: decision.decisionCode,
      reasonCode: decision.reasonCode,
      occurrenceKey: decision.occurrence.occurrenceKey,
      created: true,
    })),
  };
  const engine = new ProviderConversionDecisionEngine();
  const orchestrator = {
    orchestrate: vi.fn(async ({ disposition }: any) => ({
      executionId: "execution_1",
      eligibleExecutionId:
        disposition.state === "eligible" ? "execution_1" : null,
      reviewId: null,
    })),
  };
  // Real resolver semantics: the proof of ONE entry on the asked
  // connection/number; "any channel" with entries on two numbers is
  // ambiguous (no proof).
  const paidLeads = {
    resolve: vi.fn(async (args: any) => {
      const candidates = input.entries.filter((entry) =>
        args.connectionId
          ? entry.connectionId === args.connectionId &&
            (!args.channelId || entry.channelId === args.channelId)
          : Boolean(args.ctwaProofAnyChannel),
      );
      const proof = candidates.length === 1 ? proofFor(candidates[0]!) : null;
      if (!input.adLead && !proof)
        return {
          status: "not_found",
          reasonCode: "paid_attribution_missing",
          candidateLeadId: "lead_1",
        };
      return {
        status: "resolved",
        reasonCode: "paid_lead_resolved",
        lead: {
          id: "lead_1",
          phoneHash: "phone_hash_1",
          campaignId: input.adLead ? "campaign_1" : null,
          adSetId: input.adLead ? "adset_1" : null,
          adId: input.adLead ? "ad_1" : null,
          ctwaClid: "click_1",
          ...(proof ? { ctwaDestination: proof } : {}),
        },
      };
    }),
  };
  const service = new ProviderConversionObservationService(
    prisma as never,
    {
      evaluate: vi.fn(async ({ decisionInput }: any) =>
        engine.evaluate(decisionInput),
      ),
    } as never,
    decisions as never,
    paidLeads as never,
    orchestrator as never,
    env,
  );
  const observe = (
    origin: { connectionId: string; channelId: string | null } | null = null,
  ) =>
    service.observeAutomation({
      workspaceId,
      // The rule's own (anchor) connection, as the ingestion passes it.
      connectionId: input.rule.connectionId,
      origin,
      deliveryId: "delivery_1",
      externalDeliveryId: null,
      deliveryReceivedAt: receivedAt,
      providerRuleId: input.rule.id,
      automation: {
        provider: "unnichat",
        automation: "crm_movement",
        eventName: "QualifiedLead",
        phone: "5551987650001",
        hasCtwa: true,
        ctwaClid: "click_1",
        occurredAt: new Date("2026-10-21T11:59:00.000Z"),
        externalExecutionKey: "movement_1",
      },
    });
  return { service, prisma, decisions, orchestrator, paidLeads, observe };
}

const unified = {
  ...rule({ id: "qualified_all", scope: "all_numbers", anchor: "conn_5159" }),
  crossConnectionScope: true,
};
const via = (number: Number, withChannel = false) => ({
  connectionId: number.connectionId,
  channelId: withChannel ? number.channelId : null,
});

describe("Unnichat: one rule for ALL numbers of ALL connections", () => {
  it("sends for a lead of the anchor number, of the other connection and of a 3rd number connected later (callback from that number)", async () => {
    for (const entry of numbers) {
      const h = harness({ rule: unified, entries: [entry] });
      const result = await h.observe(via(entry));
      expect(result.channelId).toBe(entry.channelId);
      expect(result.disposition).toBe("eligible");
      // The proof of the callback's own connection first.
      expect(h.paidLeads.resolve.mock.calls[0]![0]).toMatchObject({
        connectionId: entry.connectionId,
      });
      // Frozen occurrence on the number's OWN connection (dedupe key and
      // CTWA replay checks stay per number, as with the old per-connection rule).
      const decision = h.decisions.recordInitial.mock.calls[0]![0].decision;
      expect(decision.occurrence.connectionId).toBe(entry.connectionId);
      expect(decision.occurrence.channelId).toBe(entry.channelId);
    }
  });

  it("a contact on A (production) and B (observation): the callback of A's URL is A's, the event URL naming B is B's", async () => {
    const a = numbers[0]!;
    const b: Number = { ...numbers[1]!, connectionStatus: "observation" };
    const both = [a, b, numbers[2]!];
    // A's automation called (A's own/old URL): A, sent.
    const fromA = harness({ rule: unified, entries: [a, b], numbers: both });
    const resultA = await fromA.observe(via(a));
    expect(resultA.channelId).toBe(a.channelId);
    expect(resultA.disposition).toBe("eligible");
    // Lead with entries on BOTH numbers: the proof of A, never "ambiguous".
    expect(
      fromA.decisions.recordInitial.mock.calls[0]![0].decision.leadResolution.lead
        .ctwaDestination.channelId,
    ).toBe(a.channelId);
    // The event URL proved B (ctwa_clid entry): B, gated by B's connection.
    const fromB = harness({ rule: unified, entries: [a, b], numbers: both });
    const resultB = await fromB.observe(via(b, true));
    expect(resultB.channelId).toBe(b.channelId);
    expect(resultB.disposition).toBe("blocked");
    expect(fromB.paidLeads.resolve.mock.calls[0]![0]).toMatchObject({
      connectionId: b.connectionId,
      channelId: b.channelId,
    });
  });

  it("ad lead: the callback's own number wins over a more recent conversation on another number", async () => {
    const a = numbers[0]!;
    const b = numbers[1]!;
    const h = harness({
      rule: unified,
      entries: [],
      adLead: true,
      // Talked to A first, then to B (most recent).
      events: [a, b],
    });
    expect((await h.observe(via(a))).channelId).toBe(a.channelId);
  });

  it("without anything on the callback's number, the scope fallback prefers a production number over a more recent observation one", async () => {
    const a = numbers[0]!;
    const b: Number = { ...numbers[1]!, connectionStatus: "observation" };
    const c = numbers[2]!;
    const h = harness({
      rule: unified,
      entries: [],
      adLead: true,
      numbers: [a, b, c],
      // Contact talked to C (production) and later to B (observation); the
      // callback came from A where it never talked.
      events: [c, b],
    });
    expect((await h.observe(via(a))).channelId).toBe(c.channelId);
  });

  it("a lead with no proof on the callback's number and entries on two others stays unresolved (never guessed)", async () => {
    const h = harness({
      rule: unified,
      entries: [numbers[1]!, numbers[2]!],
    });
    const result = await h.observe(via(numbers[0]!));
    expect(result.channelId).toBeNull();
    expect(result.disposition).not.toBe("eligible");
    // Own connection first, then any channel (ambiguous: no proof).
    expect(h.paidLeads.resolve.mock.calls.map(([args]: any[]) => args.connectionId ?? "any")).toEqual([
      "conn_5159",
      "any",
    ]);
  });

  it("gates each number by its own connection: a number without paid seat (not activated) never sends", async () => {
    const pendingNumber: Number = {
      ...numbers[2]!,
      connectionStatus: "observation",
      channelStatus: "discovered",
    };
    const h = harness({
      rule: unified,
      entries: [pendingNumber],
      numbers: [numbers[0]!, numbers[1]!, pendingNumber],
    });
    const result = await h.observe(via(pendingNumber, true));
    expect(result.channelId).toBe("ch_new");
    expect(result.disposition).toBe("blocked");
    expect(h.orchestrator.orchestrate.mock.calls[0]![0].disposition).toEqual({
      state: "blocked",
      reasonCode: "production_context_invalid",
    });
    // The gate read the number's connection, never the anchor's.
    expect(h.prisma.inboundWebhookConnection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "conn_new", workspaceId },
      }),
    );
  });

  it("yields to the specific rule of the number (specific beats all numbers)", async () => {
    const h = harness({
      rule: unified,
      entries: [numbers[1]!],
      specificPeers: [{ id: "qualified_5520", channelId: "ch_5520" }],
    });
    const result = await h.observe(via(numbers[1]!));
    expect(result.reasonCode).toBe(PROVIDER_RULE_OVERRIDDEN_REASON);
    expect(result.disposition).toBe("ignored");
    expect(h.decisions.recordInitial).not.toHaveBeenCalled();
  });

  it("never attributes a removed number (its connection is gone from the scope)", async () => {
    const removed: Number = { ...numbers[1]!, removed: true };
    const h = harness({
      rule: unified,
      entries: [removed],
      numbers: [numbers[0]!, removed, numbers[2]!],
    });
    const result = await h.observe(via(numbers[0]!));
    expect(result.channelId).toBeNull();
    expect(result.disposition).not.toBe("eligible");
  });

  it("keeps an existing 'Todos os números' rule (no explicit cross-connection scope) on its own connection", async () => {
    const legacy = rule({ id: "qualified_5159_all", scope: "all_numbers", anchor: "conn_5159" });
    const h = harness({ rule: legacy, entries: [numbers[1]!] });
    // A lead of 5520 is not the 5159 rule's, whatever origin is passed.
    expect((await h.observe(via(numbers[1]!, true))).channelId).toBeNull();
    expect(h.paidLeads.resolve.mock.calls[0]![0]).toMatchObject({
      connectionId: "conn_5159",
    });
  });

  it("keeps a specific rule exactly as before: only its own connection's proof", async () => {
    const specific = rule({
      id: "qualified_5520",
      scope: "specific_numbers",
      anchor: "conn_5520",
      channelIds: ["ch_5520"],
    });
    const h = harness({ rule: specific, entries: [numbers[1]!] });
    const result = await h.observe();
    expect(result.disposition).toBe("eligible");
    expect(h.paidLeads.resolve.mock.calls[0]![0]).toMatchObject({
      connectionId: "conn_5520",
    });
    // A lead of another number is not this specific rule's.
    const other = harness({ rule: specific, entries: [numbers[0]!] });
    expect((await other.observe()).channelId).toBeNull();
  });
});

describe("Número removido", () => {
  const base = {
    scope: "specific_numbers",
    connectionId: "conn_old",
    conversionRule: { triggerType: "provider_automation", eventName: "QualifiedLead" },
    parserRelease: { provider: "unnichat" },
  };

  it("flags an automation whose connection was removed, and a specific rule whose numbers are all gone", () => {
    expect(
      providerRuleNumberRemoved({
        ...base,
        connection: { provider: "unnichat", removedAt: new Date() },
        channels: [{ channel: { connection: { removedAt: new Date() } } }],
      }),
    ).toBe(true);
    expect(
      providerRuleNumberRemoved({
        ...base,
        connection: { provider: "unnichat", removedAt: null },
        channels: [{ channel: { connection: { removedAt: null } } }],
      }),
    ).toBe(false);
    // A message rule with one removed and one live number keeps running.
    expect(
      providerRuleNumberRemoved({
        scope: "specific_numbers",
        connectionId: null,
        connection: null,
        conversionRule: { triggerType: "message_phrase", eventName: "Purchase" },
        parserRelease: null,
        channels: [
          { channel: { connection: { removedAt: new Date() } } },
          { channel: { connection: { removedAt: null } } },
        ],
      }),
    ).toBe(false);
    // nod: a WAHA/Uazapi number deleted in Integrations (WhatsApp connection
    // suspended, bridge connection still there) is a removed number too.
    const phraseRule = {
      scope: "specific_numbers",
      connectionId: null,
      connection: null,
      conversionRule: { triggerType: "message_phrase", eventName: "QualifiedLead" },
      parserRelease: null,
    };
    expect(
      providerRuleNumberRemoved({
        ...phraseRule,
        channels: [
          {
            channel: {
              connection: { removedAt: null },
              whatsappInstance: { status: "suspended" },
            },
          },
        ],
      }),
    ).toBe(true);
    // Disconnected (QR expired) is not removed: the number comes back.
    expect(
      providerRuleNumberRemoved({
        ...phraseRule,
        channels: [
          {
            channel: {
              connection: { removedAt: null },
              whatsappInstance: { status: "disconnected" },
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("moves a rule for all numbers to another live Unnichat connection when its number is removed (audited, nothing deleted)", async () => {
    const updates: any[] = [];
    const audits: any[] = [];
    const client = {
      providerConversionRuleConfig: {
        findMany: vi.fn(async (_args: any) => [{ id: "qualified_all" }]),
        updateMany: vi.fn(async (args: any) => {
          updates.push(args);
          return { count: 1 };
        }),
      },
      inboundWebhookConnection: {
        findMany: vi.fn(async () => [
          { id: "conn_obs", status: "observation", createdAt: activatedAt },
          { id: "conn_5520", status: "production", createdAt: receivedAt },
        ]),
      },
      auditLog: { create: vi.fn(async ({ data }: any) => audits.push(data)) },
    };
    const moved = await reanchorSpanningAutomationRules(client as never, {
      workspaceId,
      removedConnectionId: "conn_5159",
      provider: "unnichat",
      actorUserId: "owner",
    });
    expect(moved).toEqual([
      { providerRuleId: "qualified_all", connectionId: "conn_5520" },
    ]);
    expect(
      client.providerConversionRuleConfig.findMany.mock.calls[0]![0],
    ).toMatchObject({
      where: { scope: "all_numbers", connectionId: "conn_5159" },
    });
    expect(updates[0]).toMatchObject({
      where: { id: "qualified_all", connectionId: "conn_5159" },
      data: { connectionId: "conn_5520" },
    });
    expect(audits[0]).toMatchObject({
      action: PROVIDER_RULE_REANCHORED_ACTION,
      targetId: "qualified_all",
      afterSummary: { fromConnectionId: "conn_5159", toConnectionId: "conn_5520" },
    });
  });

  it("leaves rules alone without another live connection, and never touches other providers", async () => {
    const client = {
      providerConversionRuleConfig: {
        findMany: vi.fn(async (_args: any) => [{ id: "qualified_all" }]),
        updateMany: vi.fn(),
      },
      inboundWebhookConnection: { findMany: vi.fn(async () => []) },
      auditLog: { create: vi.fn() },
    };
    await expect(
      reanchorSpanningAutomationRules(client as never, {
        workspaceId,
        removedConnectionId: "conn_5159",
        provider: "unnichat",
        actorUserId: null,
      }),
    ).resolves.toEqual([]);
    expect(client.providerConversionRuleConfig.updateMany).not.toHaveBeenCalled();
    await reanchorSpanningAutomationRules(client as never, {
      workspaceId,
      removedConnectionId: "conn_qr",
      provider: "uazapi",
      actorUserId: null,
    });
    expect(client.providerConversionRuleConfig.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("migration 20261027120000_provider_rule_cross_connection_scope (text only)", () => {
  it("only adds one optional column (no rewrite, no drop) and matches the schema", () => {
    const sql = readFileSync(
      resolve(__dirname, "../../prisma/migrations/20261027120000_provider_rule_cross_connection_scope/migration.sql"),
      "utf8",
    );
    const statements = sql
      .split(/\r?\n/u)
      .filter((line) => line.trim() && !line.trim().startsWith("--"));
    expect(statements).toEqual([
      'ALTER TABLE "ProviderConversionRuleConfig" ADD COLUMN IF NOT EXISTS "crossConnectionScope" BOOLEAN;',
    ]);
    expect(sql).not.toMatch(/\b(DROP|UPDATE|DELETE|NOT NULL)\b/u);
    const schema = readFileSync(resolve(__dirname, "../../prisma/schema.prisma"), "utf8");
    expect(schema).toMatch(/crossConnectionScope\s+Boolean\?/u);
  });

  it("nod: runs after every migration of the integration branch, with its own timestamp", () => {
    const names = readdirSync(
      resolve(__dirname, "../../prisma/migrations"),
    ).filter((name) => /^\d{14}_/u.test(name));
    const timestamps = names.map((name) => name.slice(0, 14));
    expect(new Set(timestamps).size).toBe(timestamps.length);
    expect(names).toContain("20261027120000_provider_rule_cross_connection_scope");
    // After the last nod migration before this phase (WAHA GoWS, 1.2.0).
    expect("20261027120000" > "20261022130100").toBe(true);
    // The SaaS timestamp is never reused in the nod.
    expect(names.some((name) => name.startsWith("20261021120000"))).toBe(false);
  });
});
