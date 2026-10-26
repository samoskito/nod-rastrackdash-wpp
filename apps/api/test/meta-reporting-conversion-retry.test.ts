import { describe, expect, it, vi } from "vitest";
import { MetaReportingService } from "../src/reporting/meta-reporting.service";

type Row = Record<string, unknown>;

// Evaluate the Prisma operators used by audit filters against explicit fixtures.
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "AND")
      return (value as Row[]).every((clause) => matches(row, clause));
    if (key === "OR")
      return (value as Row[]).some((clause) => matches(row, clause));
    if (key === "NOT") return !matches(row, value as Row);
    // Prisma JSON path filter: { path: ["error", "code"], equals: 190 }.
    if (
      value &&
      typeof value === "object" &&
      Array.isArray((value as Row).path)
    ) {
      const found = ((value as Row).path as string[]).reduce<unknown>(
        (current, segment) =>
          current && typeof current === "object"
            ? (current as Row)[segment]
            : undefined,
        row[key],
      );
      return found === (value as Row).equals;
    }
    if (value && typeof value === "object" && !(value instanceof Date)) {
      return Object.entries(value).every(([operator, operand]) => {
        if (operator === "notIn")
          return !(operand as unknown[]).includes(row[key]);
        if (operator === "in") return (operand as unknown[]).includes(row[key]);
        if (operator === "startsWith")
          return String(row[key]).startsWith(String(operand));
        if (operator === "gte") return (row[key] as Date) >= (operand as Date);
        if (operator === "lte") return (row[key] as Date) <= (operand as Date);
        throw new Error(`Unsupported query operator: ${operator}`);
      });
    }
    return row[key] === value;
  });
}

function event(overrides: Row = {}) {
  return {
    id: "blocked",
    workspaceId: "workspace_1",
    eventName: "LeadSubmitted",
    status: "not_configured",
    errorCode: "MissingAccessToken",
    sourceTrigger: "external_mysql:students",
    ctwaClid: null,
    eventOccurredAt: new Date("2026-07-02T12:00:00.000Z"),
    sentAt: null,
    leadId: null,
    phoneHash: null,
    campaignId: null,
    adSetId: null,
    adId: null,
    pixelId: null,
    pageId: null,
    valueCents: null,
    valueSource: null,
    providerResponseSummary: null,
    providerRequestPayload: {},
    sourcePayload: {},
    ...overrides,
  };
}

function harness(events: Row[]) {
  const prisma = {
    conversionEventLog: {
      // "Reenviar bloqueados" button count of Meta login failures (#181).
      count: vi.fn(
        async ({ where }: { where: Row }) =>
          events.filter((row) => matches(row, where)).length,
      ),
      findMany: vi.fn(
        async ({
          where,
          take,
          skip = 0,
        }: {
          where: Row;
          take: number;
          skip?: number;
        }) =>
          events
            .filter((row) => matches(row, where))
            .sort(
              (a, b) =>
                (b.eventOccurredAt as Date).getTime() -
                  (a.eventOccurredAt as Date).getTime() ||
                String(b.id).localeCompare(String(a.id)),
            )
            .slice(skip, skip + take),
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Row }) =>
          events.find((row) => matches(row, where)) ?? null,
      ),
      groupBy: vi.fn(async () => []),
    },
    externalIngestionRecord: { findFirst: vi.fn(async () => null) },
  };
  const funnel = { getConfiguration: vi.fn(async () => ({ stages: [] })) };
  const service = new MetaReportingService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    funnel as never,
  );
  return { service, prisma };
}

const filters = {
  workspaceId: "workspace_1",
  since: "2026-07-01",
  until: "2026-07-02",
};

describe("Meta reporting conversion retries", () => {
  it.each([
    ["error", "MetaCapiNetworkError", true],
    ["not_configured", "MissingAccessToken", true],
    ["not_configured", "MissingMetaDestination", true],
    ["not_configured", null, true],
    ["not_configured", "OtherError", false],
    ["error", "MetaCapiRejected", false],
    ["pending_meta_context", "MissingMetaDestination", false],
    ["pending_value", null, false],
    ["not_eligible", null, false],
    ["sent", null, false],
    ["skipped", null, false],
    ["queued", null, false],
    // 7ac17df7: refused before the dispatch claim, retryable.
    ["ready_to_send", "CtwaSendSkipped", true],
  ])(
    "exposes consistent overview and detail canRetry for %s / %s",
    async (status, errorCode, canRetry) => {
      const { service } = harness([event({ status, errorCode })]);
      const overview = await service.getConversionEventAudit({
        ...filters,
        rangeLabel: "period",
        page: 1,
        pageSize: 25,
      });
      const detail = await service.getConversionEventAuditDetail({
        workspaceId: "workspace_1",
        eventId: "blocked",
      });
      expect(overview.events[0]).toMatchObject({ id: "blocked", canRetry });
      expect(detail).toMatchObject({ id: "blocked", canRetry });
    },
  );

  it("selects only allowed configuration errors in the workspace and audit period", async () => {
    const { service, prisma } = harness([
      event({ id: "token" }),
      event({ id: "destination", errorCode: "MissingMetaDestination" }),
      event({ id: "legacy", errorCode: null }),
      event({ id: "foreign", workspaceId: "workspace_2" }),
      event({
        id: "old",
        eventOccurredAt: new Date("2026-06-01T12:00:00.000Z"),
      }),
      event({
        id: "later",
        eventOccurredAt: new Date("2026-07-03T12:00:00.000Z"),
      }),
      event({
        id: "network",
        status: "error",
        errorCode: "MetaCapiNetworkError",
      }),
      event({ id: "unknown", errorCode: "OtherError" }),
      event({ id: "pending", status: "pending_meta_context" }),
      event({ id: "no_click", sourceTrigger: "auto_lead" }),
    ]);
    expect(await service.getBlockedConversionEventRetryIds(filters)).toEqual([
      "token",
      "legacy",
      "destination",
    ]);
    expect(prisma.conversionEventLog.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        take: 500,
        select: { id: true },
        orderBy: [{ eventOccurredAt: "desc" }, { id: "desc" }],
      }),
    );
  });

  it("shares the audit filters for event name, delivery state and source", async () => {
    const { service, prisma } = harness([
      event({ id: "external" }),
      event({ id: "purchase", eventName: "Purchase" }),
      event({ id: "keyword", sourceTrigger: "keyword" }),
      event({ id: "inbound", sourceTrigger: "inbound_webhook:data_crazy" }),
      event({ id: "system", sourceTrigger: "auto_lead", ctwaClid: "click" }),
      event({ id: "manual", sourceTrigger: "manual_test" }),
    ]);
    const input = {
      ...filters,
      eventName: "LeadSubmitted",
      deliveryState: "blocked" as const,
      source: "external_integration" as const,
    };
    await service.getConversionEventAudit({
      ...input,
      rangeLabel: "period",
      page: 1,
      pageSize: 25,
    });
    const overviewWhere =
      prisma.conversionEventLog.findMany.mock.calls[0][0].where;
    expect(await service.getBlockedConversionEventRetryIds(input)).toEqual([
      "external",
    ]);
    expect(
      prisma.conversionEventLog.findMany.mock.lastCall?.[0].where.AND,
    ).toContainEqual(overviewWhere);
    expect(
      await service.getBlockedConversionEventRetryIds({
        ...input,
        eventName: "Purchase",
      }),
    ).toEqual(["purchase"]);
    expect(
      await service.getBlockedConversionEventRetryIds({
        ...input,
        deliveryState: "sent",
      }),
    ).toEqual([]);
    expect(
      await service.getBlockedConversionEventRetryIds({
        ...input,
        eventName: "NoMatch",
      }),
    ).toEqual([]);
    expect(
      await service.getBlockedConversionEventRetryIds({
        ...filters,
        source: "whatsapp_automation",
      }),
    ).toEqual(["keyword", "inbound"]);
    expect(
      await service.getBlockedConversionEventRetryIds({
        ...filters,
        source: "system",
      }),
    ).toEqual(["system"]);
    expect(
      await service.getBlockedConversionEventRetryIds({
        ...filters,
        source: "manual_test",
      }),
    ).toEqual(["manual"]);
  });

  it("caps candidates at 500 across event names with newest events first", async () => {
    const events = Array.from({ length: 501 }, (_, index) =>
      event({
        id: `blocked_${String(index).padStart(3, "0")}`,
        eventName: index % 2 ? "Purchase" : "LeadSubmitted",
        errorCode: null,
      }),
    );
    const { service } = harness(events);
    const ids = await service.getBlockedConversionEventRetryIds(filters);
    expect(ids).toHaveLength(500);
    expect(ids[0]).toBe("blocked_500");
    expect(ids).not.toContain("blocked_000");
  });

  it("adds Meta login failures (190/102 in the stored response) to the retry list and the button count (#181)", async () => {
    const day = 86_400_000;
    const now = Date.now();
    const rejected = (id: string, code: unknown, overrides: Row = {}) =>
      event({
        id,
        eventName: "Purchase",
        status: "error",
        errorCode: "MetaCapiRejected",
        sourceTrigger: "keyword",
        ctwaClid: "clid",
        eventOccurredAt: new Date(now - 2 * day),
        createdAt: new Date(now - 2 * day),
        // nod stores only the numeric Graph code of a rejection.
        providerResponseSummary: { httpStatus: 400, error: { code } },
        ...overrides,
      });
    const { service } = harness([
      rejected("auth_190", 190),
      rejected("auth_102", 102, { eventOccurredAt: new Date(now - 3 * day) }),
      rejected("auth_string", "190", { eventOccurredAt: new Date(now - 4 * day) }),
      rejected("expired", 190, { eventOccurredAt: new Date(now - 8 * day) }),
      rejected("invalid_param", 100),
      // Rejected before this version: only the HTTP status was stored.
      rejected("old_row", 190, { providerResponseSummary: { httpStatus: 400 } }),
      rejected("sent", 190, { status: "sent", errorCode: null, sentAt: new Date() }),
      rejected("foreign", 190, { workspaceId: "workspace_2" }),
      rejected("kommo", 190, { sourceTrigger: "kommo_stage" }),
      rejected("pipedrive", 190, { sourceTrigger: "pipedrive_stage" }),
      event({ id: "blocked", eventOccurredAt: new Date(now - 5 * day) }),
    ]);
    const range = { workspaceId: "workspace_1" };

    // Expired ones stay in the list so the bulk retry reports them as skipped.
    const ids = await service.getBlockedConversionEventRetryIds(range);
    expect([...ids].sort()).toEqual(
      ["auth_102", "auth_190", "auth_string", "blocked", "expired"].sort(),
    );

    const audit = await service.getConversionEventAudit({
      ...range,
      rangeLabel: "tudo",
      page: 1,
      pageSize: 25,
    });
    expect(audit.summary).toMatchObject({ metaAuthRetryable: 3 });
    const rows = new Map(audit.events.map((row) => [row.id, row]));
    expect(rows.get("auth_190")).toMatchObject({
      canRetry: true,
      errorCode: "MetaCapiRejected",
      errorMessage:
        "A Meta recusou por falha de login da conexão; reconecte a Meta e reenvie",
    });
    expect(rows.get("auth_102")?.canRetry).toBe(true);
    expect(rows.get("expired")?.canRetry).toBe(false);
    expect(rows.get("invalid_param")?.canRetry).toBe(false);
    expect(rows.get("old_row")?.canRetry).toBe(false);
    expect(rows.get("kommo")?.canRetry).toBe(false);
    expect(rows.has("foreign")).toBe(false);
  });

  it("lets a ready_to_send stuck for more than 10 minutes be retried (7ac17df7)", async () => {
    const now = Date.now();
    const { service } = harness([
      event({
        id: "stalled",
        status: "ready_to_send",
        errorCode: null,
        createdAt: new Date(now - 11 * 60_000),
      }),
      event({
        id: "fresh",
        status: "ready_to_send",
        errorCode: null,
        createdAt: new Date(now - 60_000),
      }),
    ]);
    for (const [eventId, canRetry] of [
      ["stalled", true],
      ["fresh", false],
    ] as const) {
      const detail = await service.getConversionEventAuditDetail({
        workspaceId: "workspace_1",
        eventId,
      });
      expect(detail).toMatchObject({ id: eventId, canRetry });
    }
  });
});
