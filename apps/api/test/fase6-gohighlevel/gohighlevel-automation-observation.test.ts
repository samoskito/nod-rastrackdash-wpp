import { describe, expect, it, vi } from "vitest";
import { ProviderConversionDecisionEngine } from "../../src/conversion-rules/provider-conversion-decision.engine";
import { ProviderConversionObservationService } from "../../src/conversion-rules/provider-conversion-observation.service";

/**
 * GoHighLevel automation (Workflow → ação Webhook) in the real observation
 * service + decision engine (storage is a fake). Same model as the Unnichat
 * automation, with one extra guarantee: the number is the Workflow
 * location's, never another location's. Synthetic identifiers only.
 */

const workspaceId = "workspace_ghl";
const activatedAt = new Date("2026-10-01T00:00:00.000Z");
const receivedAt = new Date("2026-10-26T12:00:00.000Z");
const env = {
  NODE_ENV: "test",
  API_PUBLIC_URL: "http://localhost:3333",
  INBOUND_WEBHOOKS_ENABLED: "true",
  INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
  INBOUND_CONVERSION_RULES_ENABLED: "true",
  INBOUND_CONVERSION_PRODUCTION_ENABLED: "true",
  INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
};

const ghlV1 = { id: "release_ghl_v1", provider: "gohighlevel", version: "v1", status: "certified" };
const automationRelease = {
  id: "release_ghl_automation",
  provider: "gohighlevel",
  version: "automation-v1",
  status: "certified",
};

type Location = { channelId: string; connectionId: string; locationId: string };
const locA: Location = { channelId: "ch_loc_a", connectionId: "conn_loc_a", locationId: "loc_a" };
const locB: Location = { channelId: "ch_loc_b", connectionId: "conn_loc_b", locationId: "loc_b" };
const locations = [locA, locB];

function connectionOf(location: Location) {
  return {
    id: location.connectionId,
    provider: "gohighlevel",
    status: "production",
    removedAt: null,
    parserReleaseId: ghlV1.id,
    parserRelease: ghlV1,
    productionActivatedAt: activatedAt,
  };
}

const rule = {
  id: "ghl_qualified_all",
  workspaceId,
  connectionId: locA.connectionId,
  parserReleaseId: automationRelease.id,
  scope: "all_numbers",
  crossConnectionScope: true,
  mode: "production",
  productionActivatedAt: activatedAt,
  removedAt: null,
  unifiedIntoProviderRuleId: null,
  createdAt: activatedAt,
  updatedAt: activatedAt,
  conversionRuleId: "conversion_ghl",
  messageTriggerPhrases: [],
  messageAuthorScope: null,
  productFilterCodes: [],
  conversionRule: {
    id: "conversion_ghl",
    active: true,
    triggerType: "provider_automation",
    eventName: "QualifiedLead",
    defaultValueCents: null,
    defaultCurrency: "BRL",
    defaultContentName: null,
    defaultItems: null,
    updatedAt: activatedAt,
  },
  connection: connectionOf(locA),
  parserRelease: automationRelease,
  channels: [],
  catalog: null,
};

function proofFor(location: Location) {
  return {
    kind: "authorized_ctwa_destination" as const,
    workspaceId,
    channelId: location.channelId,
    connectionId: location.connectionId,
    organizationId: workspaceId,
    providerChannelId: location.locationId,
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
  /** Locations whose CTWA entry proves this lead (page/pixel, no ad). */
  entries: Location[];
  /** Lead with an ad id (channel from the contact's CTWA conversations). */
  adLead?: boolean;
  /** Contact's CTWA conversations, most recent LAST. */
  events?: Location[];
  /** Parser release of the rule (default: automation-v1). */
  release?: typeof automationRelease;
}) {
  const channelRow = (location: Location) => ({
    id: location.channelId,
    connectionId: location.connectionId,
    organizationId: workspaceId,
    providerChannelId: location.locationId,
    status: "active",
    productionActivatedAt: activatedAt,
    conversionEngineMode: "canonical",
  });
  const events = [...(input.events ?? [])].reverse();
  const upserts: any[] = [];
  const prisma = {
    providerConversionRuleConfig: {
      findFirst: vi.fn(async () =>
        input.release
          ? { ...rule, parserReleaseId: input.release.id, parserRelease: input.release }
          : rule,
      ),
      findMany: vi.fn(async () => []),
    },
    providerConversionRuleExecution: {
      upsert: vi.fn(async (args: any) => {
        upserts.push(args);
        return { id: "execution_missing" };
      }),
    },
    inboundWebhookChannel: {
      findMany: vi.fn(async () =>
        locations.map((location, index) => ({
          id: location.channelId,
          connectionId: location.connectionId,
          status: "active",
          createdAt: new Date(activatedAt.getTime() + index * 1000),
          connectedPhone: `55119000000${index}`,
          connection: { provider: "gohighlevel" },
          whatsappSeats: [],
          whatsappInstance: null,
        })),
      ),
      findFirst: vi.fn(async ({ where }: any) => {
        const location = locations.find(
          (candidate) =>
            candidate.channelId === where.id &&
            (where.connectionId === undefined ||
              candidate.connectionId === where.connectionId),
        );
        return location ? channelRow(location) : null;
      }),
    },
    inboundWebhookConnection: {
      findFirst: vi.fn(async ({ where }: any) => {
        const location = locations.find((candidate) => candidate.connectionId === where.id);
        return location ? connectionOf(location) : null;
      }),
    },
    inboundWebhookEvent: {
      findFirst: vi.fn(async ({ where }: any) => {
        const event = events.find(
          (location) =>
            (where.connectionId === undefined ||
              location.connectionId === where.connectionId) &&
            where.channelId.in.includes(location.channelId),
        );
        return event ? { channel: channelRow(event) } : null;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        events
          .filter((location) => where.channelId.in.includes(location.channelId))
          .map((location) => ({
            channel: {
              ...channelRow(location),
              connection: { status: "production", removedAt: null },
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
      eligibleExecutionId: disposition.state === "eligible" ? "execution_1" : null,
      reviewId: null,
    })),
  };
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
        return { status: "not_found", reasonCode: "paid_attribution_missing", candidateLeadId: "lead_1" };
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
    { evaluate: vi.fn(async ({ decisionInput }: any) => engine.evaluate(decisionInput)) } as never,
    decisions as never,
    paidLeads as never,
    orchestrator as never,
    env,
  );
  const observe = (origin: Location, hasCtwa = true) =>
    service.observeAutomation({
      workspaceId,
      connectionId: rule.connectionId,
      // The number the router proved from the Workflow's location.id.
      origin: { connectionId: origin.connectionId, channelId: origin.channelId },
      deliveryId: "delivery_1",
      externalDeliveryId: null,
      deliveryReceivedAt: receivedAt,
      providerRuleId: rule.id,
      automation: {
        provider: "gohighlevel",
        automation: "crm_movement",
        eventName: "QualifiedLead",
        phone: "+5511987650001",
        hasCtwa,
        ctwaClid: hasCtwa ? "click_1" : null,
        adId: null,
        contactId: "contact_1",
        locationId: origin.locationId,
        workflowId: "wf_1",
        workflowName: "Workflow Exemplo",
        triggerId: null,
        occurredAt: receivedAt,
        externalExecutionKey: "gohighlevel-automation:key_1",
      },
    } as never);
  return { service, prisma, decisions, paidLeads, observe, upserts };
}

describe("GoHighLevel automation: the Workflow location is the number", () => {
  it("no-ad lead (page/pixel entry) of the location: eligible on that location's number", async () => {
    const h = harness({ entries: [locA] });
    const result = await h.observe(locA);
    expect(result.channelId).toBe(locA.channelId);
    expect(result.disposition).toBe("eligible");
    expect(h.paidLeads.resolve.mock.calls[0]![0]).toMatchObject({
      connectionId: locA.connectionId,
      channelId: locA.channelId,
    });
    const decision = h.decisions.recordInitial.mock.calls[0]![0].decision;
    expect(decision.occurrence.provider).toBe("gohighlevel");
    expect(decision.occurrence.channelId).toBe(locA.channelId);
    expect(decision.leadResolution.lead.ctwaDestination.channelId).toBe(locA.channelId);
  });

  it("never borrows the entry proof of another location (no 'any channel' widening)", async () => {
    const h = harness({ entries: [locB] });
    const result = await h.observe(locA);
    expect(result.channelId).toBeNull();
    expect(result.disposition).not.toBe("eligible");
    expect(h.paidLeads.resolve).toHaveBeenCalledTimes(1);
    expect(h.paidLeads.resolve.mock.calls[0]![0]).toMatchObject({
      connectionId: locA.connectionId,
    });
  });

  it("ad lead whose conversation was only on another location: no scope-wide fallback", async () => {
    const h = harness({ entries: [], adLead: true, events: [locB] });
    expect((await h.observe(locA)).channelId).toBeNull();
    const own = harness({ entries: [], adLead: true, events: [locB, locA] });
    expect((await own.observe(locA)).channelId).toBe(locA.channelId);
  });

  it("records a contact without ctwa_clid as blocked ctwa_missing (like Unnichat)", async () => {
    const h = harness({ entries: [locA] });
    const result = await h.observe(locA, false);
    expect(result).toMatchObject({ reasonCode: "ctwa_missing", disposition: "blocked" });
    expect(h.upserts[0].create).toMatchObject({ status: "blocked", reasonCode: "ctwa_missing" });
    expect(h.paidLeads.resolve).not.toHaveBeenCalled();
  });
});

describe("GoHighLevel automation-v2: only a paid lead counts (porte do SaaS #277)", () => {
  const v2 = { ...automationRelease, id: "release_ghl_automation_v2", version: "automation-v2", status: "certified" };

  it("a contact without ctwa_clid is ignored and leaves no mark (no execution, no key)", async () => {
    const h = harness({ entries: [locA], release: v2 });
    const result = await h.observe(locA, false);
    expect(result).toMatchObject({
      reasonCode: "contact_not_paid_lead",
      disposition: "ignored",
      executionId: null,
    });
    expect(h.upserts).toHaveLength(0);
    expect(h.paidLeads.resolve).not.toHaveBeenCalled();
    expect(h.decisions.recordInitial).not.toHaveBeenCalled();
  });

  it("the same contact calling again WITH the click is a first call, evaluated normally", async () => {
    const h = harness({ entries: [locA], release: v2 });
    await h.observe(locA, false);
    const second = await h.observe(locA, true);
    expect(second.reasonCode).not.toBe("contact_not_paid_lead");
    expect(second.channelId).toBe(locA.channelId);
    expect(h.paidLeads.resolve).toHaveBeenCalled();
  });

  it("v1 keeps recording ctwa_missing exactly as before", async () => {
    const h = harness({ entries: [locA] });
    expect(await h.observe(locA, false)).toMatchObject({ reasonCode: "ctwa_missing" });
    expect(h.upserts).toHaveLength(1);
  });
});
