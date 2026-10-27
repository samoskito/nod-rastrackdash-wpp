import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ConversionEventNameDto,
  ProviderConversionDecisionDto,
} from "@wpptrack/shared";
import { describe, expect, it, vi } from "vitest";
import {
  hashPhoneIdentity,
  phoneIdentityKey,
} from "../../src/common/phone/phone-identity";
import { ConversionEventsService } from "../../src/conversion-events/conversion-events.service";
import {
  LEAD_CONVERTED_BY_ANOTHER_SOURCE,
  LEAD_CONVERTED_ON_ANOTHER_NUMBER,
} from "../../src/conversion-events/lead-lifetime-conversion-guard";
import { ProviderConversionDecisionEngine } from "../../src/conversion-rules/provider-conversion-decision.engine";
import { partitionAlreadyConverted } from "../../src/conversion-rules/provider-rule-blocked-reprocess";
import { paidLeadSubmittedEventWhere } from "../../src/leads/lead-cohort";
import { ProviderConversionProductionService } from "../../src/inbound-webhook-production/provider-conversion-production.service";
import { InboundWebhookParserRegistry } from "../../src/inbound-webhooks/providers/inbound-webhook-parser.registry";
import { ReportingMetricsEngine } from "../../src/reporting/reporting-metrics.engine";

/**
 * Once-per-lead conversions across numbers and pipelines.
 *
 * Stateful unit oracle, NOT proof of PostgreSQL behavior: leads, executions
 * and conversion logs live in memory; pg_advisory_xact_lock is modelled as a
 * per-key mutex held until the transaction callback settles. Decisions come
 * from the real decision engine (per-number scope keys really differ) and
 * logs are written by the real ConversionEventsService.recordExternalConversion
 * (the sink of provider rules AND of the three CTWA entry writers).
 */

const workspaceId = "workspace_pinho";
const engine = new ProviderConversionDecisionEngine();
const recent = (minutesAgo: number) =>
  new Date(Date.now() - minutesAgo * 60 * 1_000);

type LeadFixture = {
  id: string;
  phone: string;
  adId: string;
};
const leadA: LeadFixture = { id: "lead_a", phone: "5511987654321", adId: "ad_1" };
const leadB: LeadFixture = { id: "lead_b", phone: "5511912345678", adId: "ad_1" };
// Old duplicate row of lead A's line, without the 9th digit.
const leadAOld: LeadFixture = { id: "lead_a_old", phone: "551187654321", adId: "ad_1" };

function createStore(
  options: {
    destinationByAd?: Record<string, string>;
    /**
     * Porte do SaaS #155: LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED on the
     * services. nod: undefined = the default (ON); false = explicit "false".
     */
    overrideFlag?: boolean;
  } = {},
) {
  const executions = new Map<string, any>();
  const logs: any[] = [];
  const leads = new Map<string, any>();
  const lockTails = new Map<string, Promise<void>>();
  let sequence = 0;

  const addLead = (lead: LeadFixture) =>
    leads.set(lead.id, {
      id: lead.id,
      phoneHash: hashPhoneIdentity(lead.phone)!,
      phoneDisplay: `+${lead.phone}`,
    });
  for (const lead of [leadA, leadB]) addLead(lead);

  const inWindow = (record: any, range: any) =>
    !range ||
    (record.occurredAt.getTime() > range.gt.getTime() &&
      record.occurredAt.getTime() < range.lt.getTime());

  function client(held: Array<() => void> | null): any {
    return {
      $queryRaw: vi.fn(async (_parts: TemplateStringsArray, ...values: any[]) => {
        if (!held) return [{ lockAcquired: "" }];
        const key = values.join(":");
        const previous = lockTails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const next = new Promise<void>((resolveLock) => {
          release = resolveLock;
        });
        lockTails.set(
          key,
          previous.then(() => next),
        );
        await previous;
        held.push(release);
        return [{ lockAcquired: "" }];
      }),
      lead: {
        findFirst: vi.fn(async ({ where }: any) => leads.get(where.id) ?? null),
        findMany: vi.fn(async ({ where }: any) =>
          [...leads.values()].filter((lead) =>
            where.id?.in
              ? where.id.in.includes(lead.id)
              : where.phoneHash.in.includes(lead.phoneHash),
          ),
        ),
      },
      providerConversionRuleExecution: {
        findFirst: vi.fn(async ({ where }: any) => {
          if (typeof where.id === "string") {
            const record = executions.get(where.id);
            return record ? { ...record } : null;
          }
          // Historical per-number check (duplicateWhere, #84). nod: the OR
          // also carries the pre-#84 workspace-wide key (upgrade bridge).
          const scopeKeys: string[] = (where.OR ?? [])
            .map((clause: any) => clause.providerDecision?.is?.businessDedupeScopeKey)
            .filter(Boolean);
          const match = [...executions.values()].find(
            (record) =>
              record.id !== where.id.not &&
              record.status === "materialized" &&
              record.channelId === where.channelId &&
              record.leadId === where.leadId &&
              record.sourceDelivery?.connectionId ===
                where.sourceDelivery?.connectionId &&
              scopeKeys.includes(record.providerDecision?.businessDedupeScopeKey) &&
              inWindow(record, where.occurredAt),
          );
          return match ? { id: match.id } : null;
        }),
        update: vi.fn(async ({ where, data }: any) => apply(where.id, data)),
      },
      conversionEventLog: {
        findUnique: vi.fn(
          async ({ where }: any) =>
            logs.find((log) => log.dedupeKey === where.dedupeKey) ?? null,
        ),
        findFirst: vi.fn(
          async ({ where }: any) =>
            logs.find((log) => log.id === where.id) ?? null,
        ),
        count: vi.fn(async () => 0),
        update: vi.fn(async ({ where, data }: any) => {
          const log = logs.find((row) => row.id === where.id);
          return Object.assign(log, data);
        }),
        findMany: vi.fn(async ({ where }: any) =>
          logs.filter(
            (log) =>
              log.workspaceId === where.workspaceId &&
              where.leadId.in.includes(log.leadId) &&
              (where.eventName.in
                ? where.eventName.in.includes(log.eventName)
                : log.eventName === where.eventName) &&
              // coveredConvertingLogWhere: entry/rule logs (+ "auto_lead"
              // sending statuses with the tarefa 20 flag).
              (where.OR ?? [where]).some((condition: any) =>
                (typeof condition.sourceTrigger === "string"
                  ? log.sourceTrigger === condition.sourceTrigger
                  : log.sourceTrigger.startsWith(
                      condition.sourceTrigger.startsWith,
                    )) &&
                (condition.status.in
                  ? condition.status.in.includes(log.status)
                  : !condition.status.notIn.includes(log.status)),
              ),
          ),
        ),
        create: vi.fn(async ({ data }: any) => {
          // Widen the race window between the dedupe read and the write.
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
          if (logs.some((log) => log.dedupeKey === data.dedupeKey)) {
            throw new Error("unique dedupeKey");
          }
          const log = { id: `log_${++sequence}`, ...data };
          logs.push(log);
          return log;
        }),
      },
      purchaseReview: { update: vi.fn(async () => ({})) },
    };
  }

  function apply(id: string, data: any) {
    const record = executions.get(id);
    if (!record) throw new Error(`unknown execution ${id}`);
    if (data.attemptCount?.increment) record.attemptCount += 1;
    for (const field of [
      "status",
      "reasonCode",
      "leadId",
      "conversionEventLogId",
      "normalizedResult",
      "processedAt",
    ]) {
      if (data[field] !== undefined) record[field] = data[field];
    }
    return record;
  }

  const prisma: any = {
    ...client(null),
    providerConversionRuleExecution: {
      findFirst: vi.fn(async ({ where }: any) => {
        const record = executions.get(where.id);
        return record ? structuredClone(record) : null;
      }),
      update: vi.fn(async ({ where, data }: any) => apply(where.id, data)),
      updateMany: vi.fn(async ({ where, data }: any) => {
        apply(where.id, data);
        return { count: 1 };
      }),
    },
    providerConversionDecisionAudit: {
      findMany: vi.fn(async ({ where }: any) =>
        [...executions.values()]
          .filter((execution) =>
            where.id.in.includes(execution.providerDecisionId),
          )
          .map((execution) => ({
            id: execution.providerDecisionId,
            decisionJson: execution.providerDecision.decisionJson,
          })),
      ),
    },
    purchaseReview: { updateMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: vi.fn(async (operation: any) => {
      const held: Array<() => void> = [];
      try {
        return await operation(client(held));
      } finally {
        for (const release of held) release();
      }
    }),
  };

  // nod: the constructor also takes the connection resolver and the license
  // client (only Kommo/Pipedrive records consult the license here).
  const overrideEnv: Record<string, string> =
    options.overrideFlag === false
      ? { LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED: "false" }
      : options.overrideFlag === true
        ? { LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED: "true" }
        : {};
  const conversions = new ConversionEventsService(
    prisma,
    {} as never,
    {} as never,
    undefined,
    {} as never,
    overrideEnv,
  );
  const record = vi.spyOn(conversions, "recordExternalConversion");
  const enqueueSend = vi.fn(async () => ({ status: "queued" }));
  const previewRoute = vi.fn(async ({ adId }: { adId: string }) => ({
    status: "resolved",
    reason: "route_resolved",
    reportingAccountId: "reporting_1",
    adAccountId: "act_1",
    businessConnectionId: "business_1",
    conversionDestinationId:
      options.destinationByAd?.[adId] ?? "destination_pixel_a",
  }));

  const service = new ProviderConversionProductionService(
    prisma as never,
    { decrypt: vi.fn() } as never,
    new InboundWebhookParserRegistry(),
    { matchRuleMessage: vi.fn() } as never,
    { previewRoute } as never,
    conversions,
    { enqueueSend } as never,
    {
      NODE_ENV: "test",
      API_PUBLIC_URL: "http://localhost:3333",
      INBOUND_WEBHOOKS_ENABLED: "true",
      INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
      INBOUND_CONVERSION_RULES_ENABLED: "true",
      INBOUND_CONVERSION_PRODUCTION_ENABLED: "true",
      INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 23).toString("base64"),
      ...overrideEnv,
    },
  );

  /** One UAZAPI "Frase na conversa" occurrence, decided by the real engine. */
  function receivePhrase(input: {
    id: string;
    channelId: string;
    providerRuleId?: string;
    lead: LeadFixture;
    eventName?: ConversionEventNameDto;
    occurredAt?: Date;
    /** nod: bridged WhatsApp providers (Uazapi QR and WAHA GoWS). */
    provider?: "uazapi" | "waha";
  }) {
    const provider = input.provider ?? "uazapi";
    const eventName = input.eventName ?? "QualifiedLead";
    const occurredAt = input.occurredAt ?? recent(30);
    const connectionId = `connection_${input.channelId}`;
    const providerRuleId = input.providerRuleId ?? "rule_all_numbers";
    const occurrenceKey = `${provider}:${input.channelId}:${input.id}`;
    const phoneHash = hashPhoneIdentity(input.lead.phone)!;
    const valueless = ["QualifiedLead", "LeadSubmitted"].includes(eventName);
    const decision = engine.evaluate({
      parserVersion: provider === "waha" ? "waha-v2" : "uazapi-v1",
      rule: {
        providerRuleId,
        conversionRuleId: `conversion_${providerRuleId}`,
        version: "rule-v1:frozen",
        triggerType: "message_phrase",
        eventName,
        mode: "production",
        active: true,
        authorScope: "team",
        triggerPhrases: ["Lead qualificado"],
        defaultValueCents: valueless ? null : 10_000,
        defaultCurrency: valueless ? null : "BRL",
        defaultContentName: null,
        valueMode: "fixed",
        exampleMessage: null,
      },
      catalog: null,
      leadResolution: {
        status: "resolved",
        reasonCode: "paid_lead_resolved",
        lead: {
          id: input.lead.id,
          phoneHash,
          campaignId: "campaign_1",
          adSetId: "adset_1",
          adId: input.lead.adId,
          ctwaClid: `ctwa_${input.lead.id}`,
        },
      },
      contactIdentityHash: phoneHash,
      occurrence: {
        source: "message",
        provider,
        workspaceId,
        connectionId,
        channelId: input.channelId,
        externalDeliveryId: null,
        externalEventId: input.id,
        externalMessageId: input.id,
        occurrenceKey,
        eventName,
        occurredAt: occurredAt.toISOString(),
        authorType: "organization_member",
        messageText: "Lead qualificado, obrigado!",
      },
    }) as ProviderConversionDecisionDto;
    if (decision?.decisionCode !== "eligible") {
      throw new Error("fixture decision must be eligible");
    }
    const decisionId = `decision_${input.id}`;
    executions.set(input.id, {
      id: input.id,
      workspaceId,
      providerRuleId,
      sourceDeliveryId: `delivery_${input.id}`,
      channelId: input.channelId,
      externalExecutionKey: occurrenceKey,
      occurredAt,
      contactIdentityHash: phoneHash,
      status: "eligible",
      reasonCode: "average_value_message_matched",
      normalizedResult: null,
      leadId: input.lead.id,
      conversionEventLogId: null,
      attemptCount: 0,
      providerDecisionWorkspaceId: workspaceId,
      providerDecisionId: decisionId,
      providerDecision: {
        id: decisionId,
        workspaceId,
        providerRuleId,
        sourceDeliveryId: `delivery_${input.id}`,
        decisionCode: "eligible",
        eventName,
        occurredAt,
        occurrenceKey,
        decisionVersion: 1,
        leadId: input.lead.id,
        businessDedupeScopeKey:
          decision.occurrence.businessDedupePolicy?.scopeKey ?? null,
        decisionJson: decision,
      },
      providerRule: {
        id: providerRuleId,
        conversionRule: { triggerType: "message_phrase", eventName },
      },
      sourceDelivery: { id: `delivery_${input.id}`, connectionId },
      channel: {
        id: input.channelId,
        connectionId,
        connection: { provider },
      },
      purchaseReview: null,
    });
  }

  const process = (id: string) =>
    service.processExecution({ providerConversionExecutionId: id, workspaceId });

  /**
   * A CTWA entry LeadSubmitted exactly as the three entry writers record it
   * (inbound-webhook-production.service, inbound-webhook-replay.service and
   * ctwa-entry-materialization): per-connection dedupe key, two-part source
   * trigger and the once-per-lead guard.
   */
  const recordEntry = (input: {
    eventKey: string;
    channelId: string;
    lead: LeadFixture;
    destinationId?: string;
    /** nod: the Meta Cloud (WABA) CTWA entry uses the same writer. */
    provider?: "uazapi" | "meta_cloud" | "unnichat" | "roichat";
    /** Porte do SaaS #155: what resolveLeadSubmittedRuleOverride answered. */
    deferToProviderRule?: { ruleIds: string[] } | null;
    occurredAt?: Date;
  }) =>
    conversions.recordExternalConversion({
      deferToProviderRule: input.deferToProviderRule ?? null,
      workspaceId,
      externalConnectorId: null,
      sourceEventId: input.eventKey,
      sourceTrigger: `inbound_webhook:${input.provider ?? "uazapi"}`,
      eventName: "LeadSubmitted",
      eventId: `entry_${input.eventKey}`,
      dedupeKey: `inbound-webhook:connection_${input.channelId}:${input.eventKey}`,
      leadId: input.lead.id,
      phoneHash: hashPhoneIdentity(input.lead.phone)!,
      businessSource: "paid",
      metaAccountId: "act_1",
      metaBusinessConnectionId: "business_1",
      metaConversionDestinationId: input.destinationId ?? "destination_pixel_a",
      campaignId: "campaign_1",
      adSetId: "adset_1",
      adId: input.lead.adId,
      ctwaClid: `ctwa_${input.lead.id}`,
      eventOccurredAt: input.occurredAt ?? recent(60),
      sourcePayload: {
        provider: input.provider ?? "uazapi",
        connectionId: `connection_${input.channelId}`,
        channelId: input.channelId,
        hasCtwa: true,
      },
      leadLifetimeGuard: { channelId: input.channelId, pipeline: "ctwa_entry", inTransaction: false },
    });

  /** A sales-platform purchase log (Payt), which carries no number. */
  const recordPaytPurchase = (lead: LeadFixture) =>
    conversions.recordExternalConversion(
      {
        workspaceId,
        externalConnectorId: null,
        sourceEventId: "payt_order_1",
        sourceTrigger: "inbound_webhook:payt:provider_automation",
        eventName: "Purchase",
        eventId: "conversion_purchase_payt_order_1",
        dedupeKey: "purchase:payt_order_1",
        leadId: lead.id,
        phoneHash: hashPhoneIdentity(lead.phone)!,
        businessSource: "paid",
        metaAccountId: "act_1",
        metaBusinessConnectionId: "business_1",
        metaConversionDestinationId: "destination_pixel_a",
        adId: lead.adId,
        ctwaClid: `ctwa_${lead.id}`,
        valueCents: 19_900,
        currency: "BRL",
        eventOccurredAt: recent(20),
        sourcePayload: { provider: "payt", channelId: null },
      },
      prisma,
    );

  return {
    addLead,
    conversions,
    executions,
    logs,
    process,
    receivePhrase,
    recordEntry,
    recordPaytPurchase,
    record,
    enqueueSend,
    prisma,
    previewRoute,
  };
}

/** Logs that go (or went) to Meta: kept receipts (not_eligible) excluded. */
const sentLogs = (store: ReturnType<typeof createStore>, eventName: string) =>
  store.logs.filter(
    (log) => log.eventName === eventName && log.status !== "not_eligible",
  );

describe("once-per-lead conversions across numbers (provider rules)", () => {
  it("sends once when the same lead sends the phrase to two numbers (all_numbers rule)", async () => {
    const store = createStore();
    store.receivePhrase({ id: "exec_n1", channelId: "channel_n1", lead: leadA });
    store.receivePhrase({ id: "exec_n2", channelId: "channel_n2", lead: leadA, occurredAt: recent(10) });

    await expect(store.process("exec_n1")).resolves.toEqual({ status: "materialized" });
    await expect(store.process("exec_n2")).resolves.toEqual({ status: "duplicate" });

    expect(sentLogs(store, "QualifiedLead")).toHaveLength(1);
    expect(store.enqueueSend).toHaveBeenCalledOnce();
    expect(store.executions.get("exec_n2")).toMatchObject({
      status: "duplicate",
      reasonCode: LEAD_CONVERTED_ON_ANOTHER_NUMBER,
      conversionEventLogId: null,
    });
  });

  it("sends once when three numbers receive the phrase at the same second", async () => {
    const store = createStore();
    const at = recent(5);
    for (const n of [1, 2, 3])
      store.receivePhrase({ id: `race_${n}`, channelId: `channel_n${n}`, lead: leadA, occurredAt: at });

    const results = await Promise.all([1, 2, 3].map((n) => store.process(`race_${n}`)));

    expect(results.filter((r) => r.status === "materialized")).toHaveLength(1);
    expect(results.filter((r) => r.status === "duplicate")).toHaveLength(2);
    expect(sentLogs(store, "QualifiedLead")).toHaveLength(1);
  });

  it("sends both for different leads", async () => {
    const store = createStore();
    store.receivePhrase({ id: "a_n1", channelId: "channel_n1", lead: leadA });
    store.receivePhrase({ id: "b_n2", channelId: "channel_n2", lead: leadB });
    await Promise.all([store.process("a_n1"), store.process("b_n2")]);
    expect(sentLogs(store, "QualifiedLead")).toHaveLength(2);
  });

  it("sends once with sibling specific-number rules mapped to the same event", async () => {
    const store = createStore();
    store.receivePhrase({ id: "s_1", channelId: "channel_n1", providerRuleId: "rule_n1", lead: leadA });
    store.receivePhrase({ id: "s_2", channelId: "channel_n2", providerRuleId: "rule_n2", lead: leadA });
    await store.process("s_1");
    await store.process("s_2");
    expect(sentLogs(store, "QualifiedLead")).toHaveLength(1);
    expect(store.executions.get("s_2")!.reasonCode).toBe(LEAD_CONVERTED_ON_ANOTHER_NUMBER);
  });

  it("treats two OLD Lead rows of the same line (with/without the 9th digit) as one lead", async () => {
    const store = createStore();
    store.addLead(leadAOld);
    expect(phoneIdentityKey(leadA.phone)).toBe(phoneIdentityKey(leadAOld.phone));
    store.receivePhrase({ id: "with_9", channelId: "channel_n1", lead: leadA });
    store.receivePhrase({ id: "without_9", channelId: "channel_n2", lead: leadAOld });

    await store.process("with_9");
    await expect(store.process("without_9")).resolves.toEqual({ status: "duplicate" });
    expect(sentLogs(store, "QualifiedLead")).toHaveLength(1);
  });

  it("serializes the two old Lead rows on the same lock (concurrent arrival)", async () => {
    const store = createStore();
    store.addLead(leadAOld);
    store.receivePhrase({ id: "c_with_9", channelId: "channel_n1", lead: leadA });
    store.receivePhrase({ id: "c_without_9", channelId: "channel_n2", lead: leadAOld });
    await Promise.all([store.process("c_with_9"), store.process("c_without_9")]);
    expect(sentLogs(store, "QualifiedLead")).toHaveLength(1);
  });

  it("sends once per pixel: the same lead routed to two Meta destinations gets two", async () => {
    const store = createStore({
      destinationByAd: { ad_1: "destination_pixel_a", ad_2: "destination_pixel_b" },
    });
    store.receivePhrase({ id: "pixel_a", channelId: "channel_n1", lead: leadA });
    await store.process("pixel_a");
    store.receivePhrase({ id: "pixel_b", channelId: "channel_n2", lead: { ...leadA, adId: "ad_2" } });
    await expect(store.process("pixel_b")).resolves.toEqual({ status: "materialized" });
    expect(sentLogs(store, "QualifiedLead").map((log) => log.metaConversionDestinationId)).toEqual([
      "destination_pixel_a",
      "destination_pixel_b",
    ]);
  });

  it("does NOT dedupe purchases or other 24h events across numbers", async () => {
    const store = createStore();
    store.receivePhrase({ id: "buy_n1", channelId: "channel_n1", lead: leadA, eventName: "Purchase" });
    store.receivePhrase({ id: "buy_n2", channelId: "channel_n2", lead: leadA, eventName: "Purchase" });
    store.receivePhrase({ id: "cart_n1", channelId: "channel_n1", lead: leadA, eventName: "AddToCart" });
    store.receivePhrase({ id: "cart_n2", channelId: "channel_n2", lead: leadA, eventName: "AddToCart" });
    await Promise.all(["buy_n1", "buy_n2", "cart_n1", "cart_n2"].map(store.process));
    expect(sentLogs(store, "Purchase")).toHaveLength(2);
    expect(sentLogs(store, "AddToCart")).toHaveLength(2);
  });

  it("nod upgrade bridge: a decision frozen before #84 (workspace-wide key) still blocks a repeat on the same number", async () => {
    for (const eventName of ["QualifiedLead", "Purchase"] as const) {
      const store = createStore();
      store.receivePhrase({ id: "old", channelId: "channel_n1", lead: leadA, eventName });
      const old = store.executions.get("old")!;
      // Materialized by the previous version: old key, no log in this store.
      Object.assign(old, { status: "materialized" });
      old.providerDecision.businessDedupeScopeKey = [eventName, workspaceId, leadA.id].join(":");
      store.receivePhrase({ id: "again", channelId: "channel_n1", lead: leadA, eventName, occurredAt: recent(10) });
      await expect(store.process("again")).resolves.toEqual({ status: "duplicate" });
      // Another number with the same old key is NOT the same number.
      store.receivePhrase({ id: "other", channelId: "channel_n2", lead: leadA, eventName, occurredAt: recent(5) });
      await expect(store.process("other")).resolves.toEqual({ status: "materialized" });
    }
  });

  it("keeps a Payt purchase and a phrase purchase on another number independent (both orders)", async () => {
    const payFirst = createStore();
    await payFirst.recordPaytPurchase(leadA);
    payFirst.receivePhrase({ id: "phrase_buy", channelId: "channel_n2", lead: leadA, eventName: "Purchase" });
    await expect(payFirst.process("phrase_buy")).resolves.toEqual({ status: "materialized" });
    expect(sentLogs(payFirst, "Purchase")).toHaveLength(2);

    // Reverse order: the Payt order path keeps its order identity and never
    // consults the once-per-lead guard (Purchase is not a lifetime event).
    const phraseFirst = createStore();
    phraseFirst.receivePhrase({ id: "phrase_buy", channelId: "channel_n1", lead: leadA, eventName: "Purchase" });
    await phraseFirst.process("phrase_buy");
    await expect(phraseFirst.recordPaytPurchase(leadA)).resolves.toMatchObject({ status: "created" });
    expect(sentLogs(phraseFirst, "Purchase")).toHaveLength(2);
  });

  it("sends both when the numbers produce different events", async () => {
    const store = createStore();
    store.receivePhrase({ id: "q_n1", channelId: "channel_n1", lead: leadA, eventName: "QualifiedLead" });
    store.receivePhrase({ id: "l_n2", channelId: "channel_n2", lead: leadA, eventName: "LeadSubmitted" });
    await Promise.all([store.process("q_n1"), store.process("l_n2")]);
    expect(store.logs).toHaveLength(2);
  });

  it("keeps the historical same-number reason for a repeat on the same number", async () => {
    const store = createStore();
    store.receivePhrase({ id: "same_1", channelId: "channel_n1", lead: leadA });
    store.receivePhrase({ id: "same_2", channelId: "channel_n1", lead: leadA, occurredAt: recent(1) });
    await store.process("same_1");
    await store.process("same_2");
    expect(store.executions.get("same_2")).toMatchObject({
      status: "duplicate",
      reasonCode: "qualified_lead_already_materialized",
    });
  });

  it("does not resend when a failed execution is retried after another number converted", async () => {
    const store = createStore();
    store.receivePhrase({ id: "retry_n2", channelId: "channel_n2", lead: leadA });
    store.receivePhrase({ id: "sent_n1", channelId: "channel_n1", lead: leadA });
    Object.assign(store.executions.get("retry_n2")!, {
      status: "failed",
      normalizedResult: { technicalDelivery: { state: "failed_retryable", retryable: true } },
    });
    await store.process("sent_n1");
    await expect(store.process("retry_n2")).resolves.toEqual({ status: "duplicate" });
    await expect(store.process("retry_n2")).resolves.toEqual({ status: "unchanged" });
    expect(sentLogs(store, "QualifiedLead")).toHaveLength(1);
  });

  it("gives once-per-lead events a deterministic neutral event_id per workspace + lead line + event", async () => {
    const first = createStore();
    first.receivePhrase({ id: "id_n1", channelId: "channel_n1", lead: leadA });
    await first.process("id_n1");
    const second = createStore();
    second.addLead(leadAOld);
    second.receivePhrase({ id: "id_n2", channelId: "channel_n2", lead: leadAOld });
    await second.process("id_n2");

    const identity = `phone:${createHash("sha256").update(phoneIdentityKey(leadA.phone)!).digest("hex")}`;
    const digest = createHash("sha256")
      .update(JSON.stringify(["provider-lead-conversion-v1", workspaceId, identity, "QualifiedLead"]))
      .digest("hex");
    expect(first.logs[0].eventId).toBe(`lead_qualified_${digest}`);
    expect(second.logs[0].eventId).toBe(first.logs[0].eventId);
  });

  it("keeps a per-execution event_id for 24h events", async () => {
    const store = createStore();
    store.receivePhrase({ id: "roll_1", channelId: "channel_n1", lead: leadA, eventName: "AddToCart", occurredAt: recent(60 * 30) });
    store.receivePhrase({ id: "roll_2", channelId: "channel_n1", lead: leadA, eventName: "AddToCart", occurredAt: recent(10) });
    await store.process("roll_1");
    await store.process("roll_2");
    const [first, second] = store.logs.map((log) => log.eventId);
    expect(first).toMatch(/^umbler_add_to_cart_[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
  });
});

describe("once-per-lead conversions: CTWA entry LeadSubmitted", () => {
  it("records the entry once when the lead enters by ad on number A then on number B", async () => {
    const store = createStore();
    await expect(
      store.recordEntry({ eventKey: "msg_a", channelId: "channel_n1", lead: leadA }),
    ).resolves.toMatchObject({ status: "created", deliveryStatus: "ready_to_send" });
    const second = await store.recordEntry({ eventKey: "msg_b", channelId: "channel_n2", lead: leadA });
    // Number B keeps its OWN receipt (proof of origin and its conversation
    // in the reports) with the full attribution, never sent to Meta.
    expect(second).toMatchObject({
      status: "duplicate",
      deliveryStatus: "not_eligible",
      duplicateReasonCode: LEAD_CONVERTED_ON_ANOTHER_NUMBER,
      conversionEventLogId: store.logs[1].id,
    });
    expect(store.logs[1]).toMatchObject({
      eventName: "LeadSubmitted",
      status: "not_eligible",
      errorCode: LEAD_CONVERTED_ON_ANOTHER_NUMBER,
      adId: "ad_1",
      campaignId: "campaign_1",
      ctwaClid: "ctwa_lead_a",
      metaConversionDestinationId: "destination_pixel_a",
      sourcePayload: expect.objectContaining({ channelId: "channel_n2" }),
    });
    expect(sentLogs(store, "LeadSubmitted")).toHaveLength(1);
    // Reports count B's conversation: paid LeadSubmitted excludes only
    // "skipped" (lead-cohort.ts / reporting-metrics.engine.ts).
    expect(paidLeadSubmittedEventWhere.status).toEqual({ not: "skipped" });
    // Redelivery of B is idempotent: same receipt, nothing new.
    await expect(
      store.recordEntry({ eventKey: "msg_b", channelId: "channel_n2", lead: leadA }),
    ).resolves.toMatchObject({
      status: "duplicate",
      conversionEventLogId: store.logs[1].id,
      deliveryStatus: "not_eligible",
    });
    expect(store.logs).toHaveLength(2);
  });

  it("keeps the historical per-connection entry semantics on the same number", async () => {
    const store = createStore();
    await store.recordEntry({ eventKey: "msg_a", channelId: "channel_n1", lead: leadA });
    // Same event replayed: the same receipt (idempotent), never a second.
    await expect(
      store.recordEntry({ eventKey: "msg_a", channelId: "channel_n1", lead: leadA }),
    ).resolves.toMatchObject({ conversionEventLogId: store.logs[0].id });
    // A new entry event on the same number is decided as before (sent).
    await expect(
      store.recordEntry({ eventKey: "msg_a2", channelId: "channel_n1", lead: leadA }),
    ).resolves.toMatchObject({ status: "created" });
  });

  it("records the entry once under concurrent arrival on two numbers", async () => {
    const store = createStore();
    const results = await Promise.all([
      store.recordEntry({ eventKey: "msg_a", channelId: "channel_n1", lead: leadA }),
      store.recordEntry({ eventKey: "msg_b", channelId: "channel_n2", lead: leadA }),
    ]);
    expect(results.filter((r) => r.status === "created")).toHaveLength(1);
    expect(sentLogs(store, "LeadSubmitted")).toHaveLength(1);
  });

  it("phrase LeadSubmitted after the CTWA entry LeadSubmitted is not sent again (same or other number)", async () => {
    const store = createStore();
    await store.recordEntry({ eventKey: "msg_a", channelId: "channel_n1", lead: leadA });
    store.receivePhrase({ id: "phrase_same", channelId: "channel_n1", lead: leadA, eventName: "LeadSubmitted" });
    store.receivePhrase({ id: "phrase_other", channelId: "channel_n2", lead: leadA, eventName: "LeadSubmitted" });

    await expect(store.process("phrase_same")).resolves.toEqual({ status: "duplicate" });
    await expect(store.process("phrase_other")).resolves.toEqual({ status: "duplicate" });
    expect(store.executions.get("phrase_same")!.reasonCode).toBe(LEAD_CONVERTED_BY_ANOTHER_SOURCE);
    expect(store.executions.get("phrase_other")!.reasonCode).toBe(LEAD_CONVERTED_ON_ANOTHER_NUMBER);
    expect(sentLogs(store, "LeadSubmitted")).toHaveLength(1);
  });

  it("CTWA entry after a phrase LeadSubmitted is not sent again", async () => {
    const store = createStore();
    store.receivePhrase({ id: "phrase_first", channelId: "channel_n1", lead: leadA, eventName: "LeadSubmitted" });
    await store.process("phrase_first");
    await expect(
      store.recordEntry({ eventKey: "msg_later", channelId: "channel_n1", lead: leadA }),
    ).resolves.toMatchObject({ status: "duplicate", duplicateReasonCode: LEAD_CONVERTED_BY_ANOTHER_SOURCE });
    expect(sentLogs(store, "LeadSubmitted")).toHaveLength(1);
  });

  it("an old 9th-digit Lead row entering on another number is the same lead", async () => {
    const store = createStore();
    store.addLead(leadAOld);
    await store.recordEntry({ eventKey: "msg_a", channelId: "channel_n1", lead: leadA });
    await expect(
      store.recordEntry({ eventKey: "msg_old", channelId: "channel_n2", lead: leadAOld }),
    ).resolves.toMatchObject({ status: "duplicate" });
  });

  it("still records the entry for another Meta destination (per pixel)", async () => {
    const store = createStore();
    await store.recordEntry({ eventKey: "msg_a", channelId: "channel_n1", lead: leadA });
    await expect(
      store.recordEntry({ eventKey: "msg_b", channelId: "channel_n2", lead: leadA, destinationId: "destination_pixel_b" }),
    ).resolves.toMatchObject({ status: "created" });
  });
});

describe("Reprocessar bloqueadas: would-be duplicates are not counted as resent", () => {
  it("is batched: no query without once-per-lead candidates, a fixed number of queries otherwise", async () => {
    const store = createStore();
    const purchases = Array.from({ length: 200 }, (_, index) => ({
      id: `buy_${index}`,
      providerDecisionId: `decision_buy_${index}`,
      channelId: "channel_n2",
      eventName: "Purchase",
    }));
    const audits = store.prisma.providerConversionDecisionAudit.findMany;
    await partitionAlreadyConverted(store.prisma, {
      workspaceId,
      executions: purchases,
      previewRoute: store.previewRoute,
    });
    expect(audits).not.toHaveBeenCalled();

    for (let index = 0; index < 120; index += 1)
      store.receivePhrase({ id: `q_${index}`, channelId: "channel_n2", lead: index % 2 ? leadA : leadB });
    const qualified = [...store.executions.values()].map((execution) => ({
      id: execution.id,
      providerDecisionId: execution.providerDecisionId,
      channelId: execution.channelId,
      eventName: execution.providerDecision.eventName,
    }));
    await partitionAlreadyConverted(store.prisma, {
      workspaceId,
      executions: qualified,
      previewRoute: store.previewRoute,
    });
    expect(audits).toHaveBeenCalledTimes(1);
    expect(store.prisma.conversionEventLog.findMany).toHaveBeenCalledTimes(1);
    expect(store.prisma.lead.findMany).toHaveBeenCalledTimes(2);
    expect(store.previewRoute).toHaveBeenCalledTimes(1); // one distinct ad
  });

  it("splits lead-already-converted executions out of the ready ones", async () => {
    const store = createStore();
    store.receivePhrase({ id: "sent_n1", channelId: "channel_n1", lead: leadA });
    await store.process("sent_n1");
    store.receivePhrase({ id: "blocked_a_n2", channelId: "channel_n2", lead: leadA });
    store.receivePhrase({ id: "blocked_b_n2", channelId: "channel_n2", lead: leadB });
    store.receivePhrase({ id: "blocked_buy_n2", channelId: "channel_n2", lead: leadA, eventName: "Purchase" });
    const executions = ["blocked_a_n2", "blocked_b_n2", "blocked_buy_n2"].map((id) => ({
      id,
      providerDecisionId: `decision_${id}`,
      channelId: "channel_n2",
      eventName: store.executions.get(id)!.providerDecision.eventName,
    }));

    const split = await partitionAlreadyConverted(store.prisma, {
      workspaceId,
      executions,
      previewRoute: store.previewRoute,
    });

    expect(split.alreadyConverted.map((e) => e.id)).toEqual(["blocked_a_n2"]);
    expect(split.ready.map((e) => e.id)).toEqual(["blocked_b_n2", "blocked_buy_n2"]);
  });
});

describe("nod: WAHA bridge and Meta Cloud entry under the once-per-lead rule", () => {
  it("sends once when the same lead sends the phrase to a WAHA number and a Uazapi number", async () => {
    const store = createStore();
    store.receivePhrase({ id: "waha_n1", channelId: "channel_waha", lead: leadA, provider: "waha" });
    store.receivePhrase({ id: "uazapi_n2", channelId: "channel_uazapi", lead: leadA, occurredAt: recent(10) });

    await expect(store.process("waha_n1")).resolves.toEqual({ status: "materialized" });
    await expect(store.process("uazapi_n2")).resolves.toEqual({ status: "duplicate" });
    expect(sentLogs(store, "QualifiedLead")).toHaveLength(1);
    expect(sentLogs(store, "QualifiedLead")[0]!.sourceTrigger).toBe(
      "inbound_webhook:waha:message_phrase",
    );
    expect(store.executions.get("uazapi_n2")!.reasonCode).toBe(
      LEAD_CONVERTED_ON_ANOTHER_NUMBER,
    );
  });

  it("sends once when a WAHA and a Uazapi number receive the phrase at the same second", async () => {
    const store = createStore();
    store.receivePhrase({ id: "waha_c", channelId: "channel_waha", lead: leadA, provider: "waha" });
    store.receivePhrase({ id: "uazapi_c", channelId: "channel_uazapi", lead: leadA });
    const results = await Promise.all([store.process("waha_c"), store.process("uazapi_c")]);
    expect(results.map((result) => result.status).sort()).toEqual(["duplicate", "materialized"]);
    expect(sentLogs(store, "QualifiedLead")).toHaveLength(1);
  });

  it("a WAHA phrase LeadSubmitted after the Meta Cloud CTWA entry is not sent again", async () => {
    const store = createStore();
    await expect(
      store.recordEntry({ eventKey: "wamid_1", channelId: "channel_meta_cloud", lead: leadA, provider: "meta_cloud" }),
    ).resolves.toMatchObject({ status: "created" });
    store.receivePhrase({ id: "waha_lead", channelId: "channel_waha", lead: leadA, eventName: "LeadSubmitted", provider: "waha" });

    await expect(store.process("waha_lead")).resolves.toEqual({ status: "duplicate" });
    expect(store.executions.get("waha_lead")!.reasonCode).toBe(LEAD_CONVERTED_ON_ANOTHER_NUMBER);
    expect(sentLogs(store, "LeadSubmitted")).toHaveLength(1);
    expect(sentLogs(store, "LeadSubmitted")[0]!.sourceTrigger).toBe("inbound_webhook:meta_cloud");
  });

  it("the Meta Cloud CTWA entry after a phrase LeadSubmitted keeps its receipt but is not sent", async () => {
    const store = createStore();
    store.receivePhrase({ id: "phrase_first", channelId: "channel_waha", lead: leadA, eventName: "LeadSubmitted", provider: "waha" });
    await store.process("phrase_first");

    await expect(
      store.recordEntry({ eventKey: "wamid_2", channelId: "channel_meta_cloud", lead: leadA, provider: "meta_cloud" }),
    ).resolves.toMatchObject({
      status: "duplicate",
      duplicateReasonCode: LEAD_CONVERTED_ON_ANOTHER_NUMBER,
    });
    const receipt = store.logs.find((log) => log.sourceTrigger === "inbound_webhook:meta_cloud");
    expect(receipt).toMatchObject({
      status: "not_eligible",
      errorCode: LEAD_CONVERTED_ON_ANOTHER_NUMBER,
    });
    expect(sentLogs(store, "LeadSubmitted")).toHaveLength(1);
  });

  it("the Meta Cloud entry and a phrase on the SAME channel are the other pipeline", async () => {
    const store = createStore();
    await store.recordEntry({ eventKey: "wamid_3", channelId: "channel_shared", lead: leadA, provider: "meta_cloud" });
    store.receivePhrase({ id: "same_channel", channelId: "channel_shared", lead: leadA, eventName: "LeadSubmitted", provider: "waha" });
    await expect(store.process("same_channel")).resolves.toEqual({ status: "duplicate" });
    expect(store.executions.get("same_channel")!.reasonCode).toBe(LEAD_CONVERTED_BY_ANOTHER_SOURCE);
  });

  it("a QualifiedLead phrase is not blocked by the Meta Cloud entry (different events)", async () => {
    const store = createStore();
    await store.recordEntry({ eventKey: "wamid_4", channelId: "channel_meta_cloud", lead: leadA, provider: "meta_cloud" });
    store.receivePhrase({ id: "qualified", channelId: "channel_waha", lead: leadA, provider: "waha" });
    await expect(store.process("qualified")).resolves.toEqual({ status: "materialized" });
  });

  it("the same entry written twice at once (live + replay) is one record, the second a duplicate", async () => {
    const store = createStore();
    const results = await Promise.all([
      store.recordEntry({ eventKey: "wamid_race", channelId: "channel_meta_cloud", lead: leadA, provider: "meta_cloud" }),
      store.recordEntry({ eventKey: "wamid_race", channelId: "channel_meta_cloud", lead: leadA, provider: "meta_cloud" }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["created", "duplicate"]);
    expect(new Set(results.map((result) => result.conversionEventLogId)).size).toBe(1);
    expect(store.logs).toHaveLength(1);
  });

  it("the real CTWA entry writers pass the once-per-lead guard (source contract)", () => {
    const source = (path: string) =>
      readFileSync(resolve(__dirname, "../../src", path), "utf8");
    const guardCall =
      /leadLifetimeGuard: \{\s*channelId: event\.channelId,\s*pipeline: "ctwa_entry",\s*inTransaction: (true|false),/g;
    const guardCalls = (text: string) => text.match(guardCall) ?? [];
    // Unnichat (in the caller transaction) + generic path (Meta Cloud and the
    // other inbound providers, own transaction).
    expect(
      guardCalls(source("inbound-webhook-production/inbound-webhook-production.service.ts")),
    ).toHaveLength(2);
    expect(
      guardCalls(source("inbound-webhook-replay/inbound-webhook-replay.service.ts")),
    ).toHaveLength(1);
    expect(
      source("inbound-webhook-production/ctwa-entry-materialization.ts"),
    ).toMatch(
      /leadLifetimeGuard: \{\s*channelId: event\.channelId,\s*pipeline: "ctwa_entry",\s*inTransaction: true,/,
    );
  });
});

// Oracle of the once-per-lead guard with the ROI Chat entry's source trigger
// (inbound_webhook:roichat). The real ROI Chat entry goes through the generic
// CTWA writer of inbound-webhook-production.service.ts, whose guard call is
// pinned for every provider by the source-contract test above.
describe("Fase 6.8: ROI Chat entry and a WAHA number of the same lead (once per lead and pixel)", () => {
  it("a WAHA phrase LeadSubmitted after the ROI Chat CTWA entry is not sent again", async () => {
    const store = createStore();
    await expect(
      store.recordEntry({ eventKey: "roichat_ctwa_1", channelId: "channel_roichat", lead: leadA, provider: "roichat" }),
    ).resolves.toMatchObject({ status: "created" });
    store.receivePhrase({ id: "waha_after_roichat", channelId: "channel_waha", lead: leadA, eventName: "LeadSubmitted", provider: "waha" });

    await expect(store.process("waha_after_roichat")).resolves.toEqual({ status: "duplicate" });
    expect(store.executions.get("waha_after_roichat")!.reasonCode).toBe(
      LEAD_CONVERTED_ON_ANOTHER_NUMBER,
    );
    expect(sentLogs(store, "LeadSubmitted")).toHaveLength(1);
    expect(sentLogs(store, "LeadSubmitted")[0]!.sourceTrigger).toBe("inbound_webhook:roichat");
  });

  it("the ROI Chat CTWA entry after a WAHA phrase LeadSubmitted keeps its receipt but is not sent", async () => {
    const store = createStore();
    store.receivePhrase({ id: "waha_first", channelId: "channel_waha", lead: leadA, eventName: "LeadSubmitted", provider: "waha" });
    await expect(store.process("waha_first")).resolves.toEqual({ status: "materialized" });

    await expect(
      store.recordEntry({ eventKey: "roichat_ctwa_2", channelId: "channel_roichat", lead: leadA, provider: "roichat" }),
    ).resolves.toMatchObject({
      status: "duplicate",
      duplicateReasonCode: LEAD_CONVERTED_ON_ANOTHER_NUMBER,
    });
    expect(
      store.logs.find((log) => log.sourceTrigger === "inbound_webhook:roichat"),
    ).toMatchObject({ status: "not_eligible", errorCode: LEAD_CONVERTED_ON_ANOTHER_NUMBER });
    expect(sentLogs(store, "LeadSubmitted")).toHaveLength(1);
  });

  it("an old 9th-digit row of the lead on the WAHA number is the same lead as the ROI Chat entry", async () => {
    const store = createStore();
    store.addLead(leadAOld);
    await store.recordEntry({ eventKey: "roichat_ctwa_3", channelId: "channel_roichat", lead: leadA, provider: "roichat" });
    store.receivePhrase({ id: "waha_old_row", channelId: "channel_waha", lead: leadAOld, eventName: "LeadSubmitted", provider: "waha" });
    await expect(store.process("waha_old_row")).resolves.toEqual({ status: "duplicate" });
    expect(sentLogs(store, "LeadSubmitted")).toHaveLength(1);
  });

  it("still sends for another lead, another pixel or another event", async () => {
    const store = createStore();
    await store.recordEntry({ eventKey: "roichat_ctwa_4", channelId: "channel_roichat", lead: leadA, provider: "roichat" });
    // Another lead on the WAHA number.
    store.receivePhrase({ id: "waha_lead_b", channelId: "channel_waha", lead: leadB, eventName: "LeadSubmitted", provider: "waha" });
    await expect(store.process("waha_lead_b")).resolves.toEqual({ status: "materialized" });
    // Same lead, another event (QualifiedLead) on the WAHA number.
    store.receivePhrase({ id: "waha_qualified", channelId: "channel_waha", lead: leadA, provider: "waha" });
    await expect(store.process("waha_qualified")).resolves.toEqual({ status: "materialized" });
    // Same lead, ROI Chat entry for another Meta destination (per pixel).
    await expect(
      store.recordEntry({
        eventKey: "roichat_ctwa_5",
        channelId: "channel_roichat_2",
        lead: leadA,
        provider: "roichat",
        destinationId: "destination_pixel_b",
      }),
    ).resolves.toMatchObject({ status: "created" });
  });
});

describe("porte do SaaS #155: LeadSubmitted sent by the provider rule instead of the entry", () => {
  const deferred = { ruleIds: ["rule_all_numbers"] };

  it("defers the entry (receipt kept, never queued) and the rule sends it once with the entry attribution", async () => {
    const store = createStore();
    const entry = await store.recordEntry({
      eventKey: "msg_a",
      channelId: "channel_n1",
      lead: leadA,
      deferToProviderRule: deferred,
    });
    expect(entry).toMatchObject({ status: "created", deliveryStatus: "not_eligible" });
    expect(store.logs[0]).toMatchObject({
      sourceTrigger: "inbound_webhook:uazapi",
      status: "not_eligible",
      errorCode: "lead_submitted_deferred_to_rule",
      errorMessage:
        "Lead recebido será enviado pela regra de conversão (não enviado na entrada)",
      adId: "ad_1",
      campaignId: "campaign_1",
      ctwaClid: "ctwa_lead_a",
      metaConversionDestinationId: "destination_pixel_a",
      sourcePayload: expect.objectContaining({
        channelId: "channel_n1",
        leadSubmittedDeferredToRuleIds: ["rule_all_numbers"],
      }),
    });
    expect(sentLogs(store, "LeadSubmitted")).toHaveLength(0);

    const triggeredAt = recent(5);
    store.receivePhrase({
      id: "rule_fires",
      channelId: "channel_n1",
      lead: leadA,
      eventName: "LeadSubmitted",
      occurredAt: triggeredAt,
    });
    await expect(store.process("rule_fires")).resolves.toEqual({ status: "materialized" });
    const sent = sentLogs(store, "LeadSubmitted");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      sourceTrigger: "inbound_webhook:uazapi:message_phrase",
      ctwaClid: "ctwa_lead_a",
      adId: "ad_1",
      metaConversionDestinationId: "destination_pixel_a",
    });
    // event_time is the trigger's, not the entry's.
    expect(new Date(sent[0].eventOccurredAt).getTime()).toBe(triggeredAt.getTime());
    expect(store.enqueueSend).toHaveBeenCalledOnce();

    // A second trigger (same or other number) never sends again.
    store.receivePhrase({ id: "rule_again", channelId: "channel_n2", lead: leadA, eventName: "LeadSubmitted", occurredAt: recent(1) });
    await expect(store.process("rule_again")).resolves.toEqual({ status: "duplicate" });
    expect(sentLogs(store, "LeadSubmitted")).toHaveLength(1);
  });

  it("redelivery of a deferred entry is idempotent (stays deferred, no second row)", async () => {
    const store = createStore();
    await store.recordEntry({ eventKey: "msg_a", channelId: "channel_n1", lead: leadA, deferToProviderRule: deferred });
    // Even if the rule was paused in between (no deferral now): same receipt,
    // still not_eligible, no retroactive send (decision B).
    await expect(
      store.recordEntry({ eventKey: "msg_a", channelId: "channel_n1", lead: leadA }),
    ).resolves.toMatchObject({ status: "duplicate", deliveryStatus: "not_eligible" });
    expect(store.logs).toHaveLength(1);
    expect(sentLogs(store, "LeadSubmitted")).toHaveLength(0);
  });

  it("rule created after the entry was sent: the rule never sends a second time", async () => {
    const store = createStore();
    await store.recordEntry({ eventKey: "msg_a", channelId: "channel_n1", lead: leadA });
    store.receivePhrase({ id: "late_rule", channelId: "channel_n1", lead: leadA, eventName: "LeadSubmitted" });
    await expect(store.process("late_rule")).resolves.toEqual({ status: "duplicate" });
    expect(store.executions.get("late_rule")!.reasonCode).toBe(LEAD_CONVERTED_BY_ANOTHER_SOURCE);
    expect(sentLogs(store, "LeadSubmitted")).toHaveLength(1);
  });

  it("uncovered number B sends on entry; the rule on covered A is then deduped", async () => {
    const store = createStore();
    await store.recordEntry({ eventKey: "msg_a", channelId: "channel_n1", lead: leadA, deferToProviderRule: deferred });
    await expect(
      store.recordEntry({ eventKey: "msg_b", channelId: "channel_n2", lead: leadA }),
    ).resolves.toMatchObject({ status: "created", deliveryStatus: "ready_to_send" });
    store.receivePhrase({ id: "rule_a", channelId: "channel_n1", lead: leadA, eventName: "LeadSubmitted", occurredAt: recent(2) });
    await expect(store.process("rule_a")).resolves.toEqual({ status: "duplicate" });
    expect(store.executions.get("rule_a")!.reasonCode).toBe(LEAD_CONVERTED_ON_ANOTHER_NUMBER);
    expect(sentLogs(store, "LeadSubmitted").map((log) => log.sourceTrigger)).toEqual([
      "inbound_webhook:uazapi",
    ]);
  });

  it("returning lead already converted (decision C): entry deferred, rule deduped", async () => {
    const store = createStore();
    await store.recordEntry({ eventKey: "msg_old", channelId: "channel_n1", lead: leadA, occurredAt: recent(60 * 24 * 3) });
    // Lifetime duplicate wins over the deferral: same not_eligible receipt.
    await expect(
      store.recordEntry({ eventKey: "msg_new", channelId: "channel_n2", lead: leadA, deferToProviderRule: deferred }),
    ).resolves.toMatchObject({ status: "duplicate", duplicateReasonCode: LEAD_CONVERTED_ON_ANOTHER_NUMBER });
    store.receivePhrase({ id: "rule_c", channelId: "channel_n2", lead: leadA, eventName: "LeadSubmitted" });
    await expect(store.process("rule_c")).resolves.toEqual({ status: "duplicate" });
    expect(sentLogs(store, "LeadSubmitted")).toHaveLength(1);
  });

  // Uazapi BYO / WAHA bridge entry ("auto_lead"), connected by server URL + token.
  const recordBridgeEntry = (store: ReturnType<typeof createStore>, adId?: string) =>
    store.conversions.recordAutomaticLeadSubmitted({
      workspaceId,
      leadId: leadA.id,
      phoneHash: hashPhoneIdentity(leadA.phone)!,
      ...(adId ? { campaignId: "campaign_1", adSetId: "adset_1", adId } : {}),
      ...(adId ? { ctwaClid: "ctwa_lead_a" } : {}),
    });

  it("flag on (nod default): bridge entry (auto_lead) sent: the provider rule is deduped as 'pela entrada' (D)", async () => {
    const store = createStore();
    await recordBridgeEntry(store, "ad_1");
    store.logs[0].status = "sent"; // the bridge entry went to Meta
    store.receivePhrase({ id: "rule_bridge", channelId: "channel_n1", lead: leadA, eventName: "LeadSubmitted" });
    await expect(store.process("rule_bridge")).resolves.toEqual({ status: "duplicate" });
    // The bridge entry is the entry, never "outro número".
    expect(store.executions.get("rule_bridge")!.reasonCode).toBe(LEAD_CONVERTED_BY_ANOTHER_SOURCE);
    expect(sentLogs(store, "LeadSubmitted")).toHaveLength(1);
  });

  it("flag on: bridge entry with a known destination blocks only that pixel", async () => {
    const store = createStore({ overrideFlag: true });
    await recordBridgeEntry(store, "ad_1");
    Object.assign(store.logs[0], { status: "sent", metaConversionDestinationId: "destination_pixel_b" });
    store.receivePhrase({ id: "rule_bridge", channelId: "channel_n1", lead: leadA, eventName: "LeadSubmitted" });
    await expect(store.process("rule_bridge")).resolves.toEqual({ status: "materialized" });
  });

  it("flag on: an organic bridge message (pending_meta_context) never blocks a later ad conversion", async () => {
    const store = createStore({ overrideFlag: true });
    await recordBridgeEntry(store); // no ad, no click: stays pending forever
    expect(store.logs[0]).toMatchObject({ sourceTrigger: "auto_lead", status: "pending_meta_context" });
    store.receivePhrase({ id: "rule_after_ad", channelId: "channel_n1", lead: leadA, eventName: "LeadSubmitted" });
    await expect(store.process("rule_after_ad")).resolves.toEqual({ status: "materialized" });
    expect(sentLogs(store, "LeadSubmitted").map((log) => log.sourceTrigger)).toContain(
      "inbound_webhook:uazapi:message_phrase",
    );
  });

  it("flag on: a bridge entry only about to send (ready_to_send, unknown pixel) does not block", async () => {
    const store = createStore({ overrideFlag: true });
    await recordBridgeEntry(store, "ad_1");
    expect(store.logs[0]).toMatchObject({ status: "ready_to_send" });
    store.receivePhrase({ id: "rule_bridge", channelId: "channel_n1", lead: leadA, eventName: "LeadSubmitted" });
    await expect(store.process("rule_bridge")).resolves.toEqual({ status: "materialized" });
  });

  it("explicit flag off (LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED=false): the bridge entry is not looked at", async () => {
    const store = createStore({ overrideFlag: false });
    await recordBridgeEntry(store, "ad_1");
    store.logs[0].status = "sent";
    store.receivePhrase({ id: "rule_bridge", channelId: "channel_n1", lead: leadA, eventName: "LeadSubmitted" });
    await expect(store.process("rule_bridge")).resolves.toEqual({ status: "materialized" });
  });

  for (const provider of ["uazapi", "waha"] as const)
    it(`${provider} bridge entry deferred: receipt not_eligible and the rule sends it`, async () => {
      const store = createStore();
      await store.conversions.recordAutomaticLeadSubmitted({
        workspaceId,
        leadId: leadA.id,
        phoneHash: hashPhoneIdentity(leadA.phone)!,
        adId: "ad_1",
        ctwaClid: "ctwa_lead_a",
        deferToProviderRule: {
          ruleIds: ["rule_all_numbers"],
          provider,
          channelId: "channel_n1",
          connectionId: "connection_channel_n1",
        },
      });
      expect(store.logs[0]).toMatchObject({
        sourceTrigger: "auto_lead",
        status: "not_eligible",
        errorCode: "lead_submitted_deferred_to_rule",
        sourcePayload: expect.objectContaining({
          provider,
          leadSubmittedDeferredToRuleIds: ["rule_all_numbers"],
        }),
      });
      store.receivePhrase({ id: "rule_bridge", channelId: "channel_n1", lead: leadA, eventName: "LeadSubmitted" });
      await expect(store.process("rule_bridge")).resolves.toEqual({ status: "materialized" });
      expect(sentLogs(store, "LeadSubmitted")).toHaveLength(1);
    });

  it("reports count ONE conversation (the entry receipt), never the rule's LeadSubmitted", async () => {
    const store = createStore();
    await store.recordEntry({ eventKey: "msg_a", channelId: "channel_n1", lead: leadA, deferToProviderRule: deferred });
    store.receivePhrase({ id: "rule_fires", channelId: "channel_n1", lead: leadA, eventName: "LeadSubmitted", occurredAt: recent(5) });
    await store.process("rule_fires");
    expect(store.logs).toHaveLength(2);
    const result = new ReportingMetricsEngine().calculate({
      events: store.logs.map((log) => ({ ...log, eventOccurredAt: new Date(log.eventOccurredAt) })),
      insight: { spendCents: 0, metaConversationsStarted: 1 },
      leads: [],
      scope: {},
    });
    expect(result.adConversationEvents).toBe(1);
    expect(result.repeatConversationLeads).toBe(0);
  });

  it("no deferral answered (deferToProviderRule null): the entry sends", async () => {
    const store = createStore();
    await expect(
      store.recordEntry({ eventKey: "msg_a", channelId: "channel_n1", lead: leadA, deferToProviderRule: null }),
    ).resolves.toMatchObject({ status: "created", deliveryStatus: "ready_to_send" });
    store.receivePhrase({ id: "rule", channelId: "channel_n1", lead: leadA, eventName: "LeadSubmitted" });
    await expect(store.process("rule")).resolves.toEqual({ status: "duplicate" });
    expect(sentLogs(store, "LeadSubmitted").map((log) => log.sourceTrigger)).toEqual([
      "inbound_webhook:uazapi",
    ]);
  });
});
