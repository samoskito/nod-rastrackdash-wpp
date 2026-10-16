import type {
  ConversionRuleDto,
  ProviderConversionDecisionRuleSnapshotDto,
} from "@wpptrack/shared";
import { describe, expect, it, vi } from "vitest";
import { ConversionEventsService } from "../../src/conversion-events/conversion-events.service";
import { buildMetaCapiPayload } from "../../src/conversion-events/meta-capi-payload.builder";
import { ProviderConversionLegacyDecisionEngine } from "../../src/conversion-rules/provider-conversion-legacy-decision.engine";
import { ProviderConversionDecisionEngine } from "../../src/conversion-rules/provider-conversion-decision.engine";
import type { ProviderConversionDecisionInput } from "../../src/conversion-rules/provider-conversion-decision.types";
import { PipedriveWebhookService } from "../../src/pipedrive/pipedrive-webhook.service";

/**
 * Moeda da conversão: venda (payload) -> regra (null = herdar) ->
 * "Moeda das conversões" do workspace -> BRL. CAPI sempre leva a moeda.
 */

function harness(workspaceCurrency: string | null) {
  const logs: Array<Record<string, unknown>> = [];
  const prisma = {
    workspace: {
      findUnique: vi.fn(async () =>
        workspaceCurrency ? { conversionCurrency: workspaceCurrency } : null,
      ),
    },
    funnelStageConfiguration: { findMany: vi.fn(async () => []) },
    conversionEventLog: {
      findUnique: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const log = { id: `log_${logs.length + 1}`, ...data };
        logs.push(log);
        return log;
      }),
    },
  };
  const service = new ConversionEventsService(
    prisma as never,
    { sendEvent: vi.fn() } as never,
    { decrypt: vi.fn() } as never,
    undefined,
    {
      getLockState: vi.fn(async () => ({ inert: true, locked: false })),
    } as never,
    {},
  );
  return { service, prisma, logs };
}

function rule(overrides: Partial<ConversionRuleDto> = {}): ConversionRuleDto {
  return {
    id: "rule_1",
    workspaceId: "workspace_1",
    name: "Compra",
    triggerType: "message_contains",
    triggerValue: "paguei",
    matchMode: "contains",
    eventName: "Purchase",
    pixelId: null,
    defaultValueCents: 10_000,
    defaultCurrency: null,
    active: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  } as ConversionRuleDto;
}

describe("conversion currency resolution", () => {
  it("rule conversions: payload, then rule, then workspace, then BRL", async () => {
    const usd = harness("USD");
    await usd.service.recordRuleMatches({
      workspaceId: "workspace_1",
      rules: [rule()],
      phoneHash: "hash_a",
    });
    await usd.service.recordRuleMatches({
      workspaceId: "workspace_1",
      rules: [rule({ id: "rule_2", defaultCurrency: "EUR" })],
      phoneHash: "hash_b",
    });
    await usd.service.recordRuleMatches({
      workspaceId: "workspace_1",
      rules: [rule({ id: "rule_3", defaultCurrency: "EUR" })],
      phoneHash: "hash_c",
      valueCents: 500,
      currency: "brl",
    });
    expect(usd.logs.map((log) => log.currency)).toEqual(["USD", "EUR", "BRL"]);

    // No workspace setting (or unreadable): BRL, the historical default.
    const legacy = harness(null);
    await legacy.service.recordRuleMatches({
      workspaceId: "workspace_1",
      rules: [rule()],
      phoneHash: "hash_a",
    });
    expect(legacy.logs[0]?.currency).toBe("BRL");
  });

  it("valueless rule events keep their historical currency (no workspace read)", async () => {
    const { service, logs, prisma } = harness("USD");
    await service.recordRuleMatches({
      workspaceId: "workspace_1",
      rules: [rule({ eventName: "QualifiedLead", defaultValueCents: null })],
      phoneHash: "hash_a",
    });
    expect(logs[0]?.currency).toBeNull();
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
  });

  it("external conversions with a value and no currency use the workspace currency", async () => {
    const { service, logs } = harness("EUR");
    const base = {
      workspaceId: "workspace_1",
      sourceTrigger: "inbound_webhook:payt",
      eventName: "Purchase" as const,
      phoneHash: "hash_a",
      businessSource: "organic" as const,
      eventOccurredAt: new Date("2026-10-14T12:00:00.000Z"),
    };
    await service.recordExternalConversion({
      ...base,
      sourceEventId: "s1",
      eventId: "e1",
      dedupeKey: "d1",
      valueCents: 19_700,
    });
    await service.recordExternalConversion({
      ...base,
      sourceEventId: "s2",
      eventId: "e2",
      dedupeKey: "d2",
      valueCents: 19_700,
      currency: "USD",
    });
    await service.recordExternalConversion({
      ...base,
      eventName: "LeadSubmitted",
      sourceEventId: "s3",
      eventId: "e3",
      dedupeKey: "d3",
    });
    expect(logs.map((log) => log.currency)).toEqual(["EUR", "USD", null]);
  });
});

describe("Payt/Braip decision currency (sales platforms)", () => {
  const ruleSnapshot = (
    defaultCurrency: string | null,
  ): ProviderConversionDecisionRuleSnapshotDto => ({
    providerRuleId: "provider_rule_1",
    conversionRuleId: "conversion_rule_1",
    version: "v1",
    triggerType: "provider_automation",
    eventName: "Purchase",
    mode: "production",
    active: true,
    authorScope: null,
    triggerPhrases: [],
    defaultValueCents: null,
    defaultCurrency,
    defaultContentName: null,
    valueMode: "fixed",
    exampleMessage: null,
  } as ProviderConversionDecisionRuleSnapshotDto);

  const decisionInput = (input: {
    observedCurrency?: "BRL" | "USD" | "EUR";
    fallbackCurrency?: "BRL" | "USD" | "EUR";
    ruleCurrency: string | null;
  }): ProviderConversionDecisionInput =>
    ({
      parserVersion: "automation-v1",
      rule: ruleSnapshot(input.ruleCurrency),
      catalog: null,
      leadResolution: {
        status: "resolved",
        lead: {
          id: "lead_1",
          phoneHash: "hash_1",
          customerIdentityKey: "hash_1",
          campaignId: "c",
          adSetId: "s",
          adId: "a",
          ctwaClid: "clid",
          ctwaClidSource: "lead",
          metaAccountId: "act_1",
        },
      },
      contactIdentityHash: "hash_1",
      occurrence: {
        source: "automation",
        provider: "payt",
        workspaceId: "workspace_1",
        connectionId: "connection_1",
        channelId: null,
        externalDeliveryId: "delivery_1",
        externalEventId: "order_1",
        externalMessageId: null,
        occurrenceKey: "order_1",
        purchaseKey: `purchase:${"a".repeat(64)}`,
        eventName: "Purchase",
        occurredAt: "2026-10-14T12:00:00.000Z",
        authorType: null,
        automation: "purchase_paid",
        observedValueCents: 19_700,
        ...(input.observedCurrency
          ? { observedCurrency: input.observedCurrency }
          : {}),
        ...(input.fallbackCurrency
          ? { fallbackCurrency: input.fallbackCurrency }
          : {}),
      },
    }) as unknown as ProviderConversionDecisionInput;

  const currencyOf = (decision: unknown) =>
    (decision as { conversion?: { currency?: string | null } } | null)
      ?.conversion?.currency;

  it("legacy engine: sale currency, then rule, then workspace, then BRL", () => {
    const engine = new ProviderConversionLegacyDecisionEngine();
    const evaluate = (input: Parameters<typeof decisionInput>[0]) =>
      currencyOf(engine.evaluate(decisionInput(input)));

    // Tonight's behavior (Payt sends no currency, BRL rule, BRL workspace).
    expect(evaluate({ ruleCurrency: "BRL" })).toBe("BRL");
    expect(evaluate({ ruleCurrency: null })).toBe("BRL");
    expect(evaluate({ observedCurrency: "USD", ruleCurrency: "BRL" })).toBe("USD");
    expect(evaluate({ ruleCurrency: "EUR", fallbackCurrency: "USD" })).toBe("EUR");
    expect(evaluate({ ruleCurrency: null, fallbackCurrency: "USD" })).toBe("USD");
  });

  it("legacy engine: rule without currency (null = inherit) still sends its average value", () => {
    const engine = new ProviderConversionLegacyDecisionEngine();
    const averageInput = (fallbackCurrency?: "USD" | "EUR") => {
      const input = decisionInput({ ruleCurrency: null, fallbackCurrency });
      return {
        ...input,
        rule: { ...input.rule, defaultValueCents: 25_000 },
        occurrence: {
          ...input.occurrence,
          provider: "umbler",
          observedValueCents: null,
        },
      } as unknown as ProviderConversionDecisionInput;
    };

    expect(currencyOf(engine.evaluate(averageInput()))).toBe("BRL");
    expect(currencyOf(engine.evaluate(averageInput("USD")))).toBe("USD");
  });

  it("decision engine: same order", () => {
    const engine = new ProviderConversionDecisionEngine();
    const evaluate = (input: Parameters<typeof decisionInput>[0]) =>
      currencyOf(engine.evaluate(decisionInput(input)));

    expect(evaluate({ ruleCurrency: "BRL" })).toBe("BRL");
    expect(evaluate({ observedCurrency: "EUR", ruleCurrency: "BRL" })).toBe("EUR");
    expect(evaluate({ ruleCurrency: null, fallbackCurrency: "USD" })).toBe("USD");
    expect(evaluate({ ruleCurrency: null })).toBe("BRL");
  });
});

describe("Meta CAPI payload currency", () => {
  const base = {
    eventName: "Purchase" as const,
    eventTime: new Date("2026-10-14T12:00:00.000Z"),
    eventId: "event_1",
    phoneHash: "hash",
    ctwaClid: "clid",
    pageId: "page",
    adId: "123",
  };

  it("always sends the currency together with the value", () => {
    expect(
      buildMetaCapiPayload({ ...base, valueCents: 1999, currency: "USD" }).data[0]
        ?.custom_data,
    ).toMatchObject({ value: 19.99, currency: "USD" });
    expect(
      buildMetaCapiPayload({ ...base, valueCents: 1999, currency: "eur" }).data[0]
        ?.custom_data,
    ).toMatchObject({ value: 19.99, currency: "EUR" });
    // Old events stored a value without currency only when it was BRL.
    expect(
      buildMetaCapiPayload({ ...base, valueCents: 1999, currency: null }).data[0]
        ?.custom_data,
    ).toMatchObject({ value: 19.99, currency: "BRL" });
    expect(
      buildMetaCapiPayload({ ...base, eventName: "LeadSubmitted" }).data[0]
        ?.custom_data,
    ).not.toHaveProperty("currency");
  });
});

describe("Pipedrive deal currency (aluno: igual ao SaaS)", () => {
  const service = new PipedriveWebhookService(
    {} as never,
    {} as never,
    {} as never,
  );
  const valueFor = (
    rule: Record<string, unknown>,
    event: Record<string, unknown>,
  ) =>
    (
      service as unknown as {
        valueFor: (rule: unknown, event: unknown) => unknown;
      }
    ).valueFor(
      {
        name: "Ganho",
        trigger: "deal_won",
        pipelineId: "1",
        stageId: null,
        eventName: "Purchase",
        mode: "production",
        valueMode: "deal",
        fixedValueCents: null,
        currency: null,
        contentName: null,
        active: true,
        ...rule,
      },
      { valueCents: 19_700, valuePresent: true, currency: null, ...event },
    );

  it("uses the deal currency when the rule names none", () => {
    expect(valueFor({}, { currency: "USD" })).toEqual({
      cents: 19_700,
      currency: "USD",
    });
  });

  it("checks the deal currency against the rule currency", () => {
    expect(valueFor({ currency: "EUR" }, { currency: "EUR" })).toEqual({
      cents: 19_700,
      currency: "EUR",
    });
    expect(valueFor({ currency: "BRL" }, { currency: "USD" })).toEqual({
      error: "event_currency_mismatch",
    });
    expect(valueFor({ currency: "USD" }, { currency: null })).toEqual({
      cents: 19_700,
      currency: "USD",
    });
  });

  it("never sends a deal value without a currency", () => {
    expect(valueFor({}, { currency: null })).toEqual({
      error: "event_currency_not_configured",
    });
  });
});

describe("duplicate external conversion (aluno)", () => {
  function reconcileHarness(existing: Record<string, unknown>) {
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...existing,
      ...data,
    }));
    const prisma = {
      workspace: {
        findUnique: vi.fn(async () => ({ conversionCurrency: "EUR" })),
      },
      conversionEventLog: {
        findUnique: vi.fn(async () => existing),
        update,
      },
    };
    const service = new ConversionEventsService(
      prisma as never,
      { sendEvent: vi.fn() } as never,
      { decrypt: vi.fn() } as never,
      undefined,
      {
        getLockState: vi.fn(async () => ({ inert: true, locked: false })),
      } as never,
      {},
    );
    const record = () =>
      service.recordExternalConversion({
        workspaceId: "workspace_1",
        sourceTrigger: "inbound_webhook:payt",
        eventName: "Purchase",
        phoneHash: "hash_a",
        businessSource: "organic",
        eventOccurredAt: new Date("2026-10-16T12:00:00.000Z"),
        sourceEventId: "s1",
        eventId: "e1",
        dedupeKey: "d1",
        valueCents: 19_700,
      });
    return { record, update };
  }

  const base = {
    id: "log_1",
    workspaceId: "workspace_1",
    status: "ready_to_send",
    businessSource: "organic",
    attributionStatus: "organic_or_unattributed",
  };

  it("a value arriving on a valueless event gets the workspace currency", async () => {
    const { record, update } = reconcileHarness({
      ...base,
      valueCents: null,
      currency: null,
    });
    await record();
    expect(update.mock.calls[0]?.[0].data).toMatchObject({
      valueCents: 19_700,
      currency: "EUR",
    });
  });

  it("an older event that already had a value keeps its currency", async () => {
    const { record, update } = reconcileHarness({
      ...base,
      valueCents: 10_000,
      currency: null,
    });
    await record();
    expect(update.mock.calls[0]?.[0].data).toMatchObject({
      valueCents: 10_000,
      currency: null,
    });
  });
});
