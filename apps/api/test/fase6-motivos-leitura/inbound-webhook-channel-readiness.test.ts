import { NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { InboundWebhookChannelRoutesService } from "../../src/inbound-webhooks/inbound-webhook-channel-routes.service";
import { InboundWebhookMetaRouteReaderService } from "../../src/inbound-webhooks/inbound-webhook-meta-route-reader.service";

/**
 * Fase 6.1b — porte do teste do SaaS (#165 `478f0f9a`, #103 `4787a8f3`,
 * #179 `a7ccdab3`): prontidão dos números por SQL agregado, ponte
 * Uazapi/WAHA contada pelos leads CTWA e "Bloqueado" sempre com motivo.
 * Adaptado ao nod: as rotas passam pela elegibilidade Meta do nod
 * (inboundMetaRouteEligible), então o harness simula BM/conta/destino ativos.
 * Dados fictícios.
 */
const now = Date.now();
const future = new Date(now + 72 * 60 * 60 * 1_000);
const soon = new Date(now + 24 * 60 * 60 * 1_000);
const expired = new Date(now - 60 * 60 * 1_000);
const timestamp = new Date("2026-07-18T12:00:00.000Z");

function route(id: string, validationStatus = "valid") {
  return {
    id,
    workspaceId: "workspace_current",
    channelId: "",
    routeKey: `route-key-${id}`,
    metaBusinessConnectionWorkspaceId: "workspace_current",
    metaBusinessConnectionId: `business-${id}`,
    metaReportingAccountWorkspaceId: "workspace_current",
    metaReportingAccountId: `account-${id}`,
    metaConversionDestinationWorkspaceId: "workspace_current",
    metaConversionDestinationId: `destination-${id}`,
    active: true,
    validationStatus,
    validationErrorCode:
      validationStatus === "valid" ? null : "route_validation_failed",
    lastValidatedAt: timestamp,
    createdByUserId: "user_current",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function channel(
  id: string,
  routes: ReturnType<typeof route>[],
  status: "active" | "paused" = "active",
) {
  return {
    id,
    workspaceId: "workspace_current",
    connectionId: "connection_current",
    organizationId: "organization_current",
    providerChannelId: `provider-${id}`,
    connectedPhone: `551190000${id.slice(-1)}`,
    channelName: `Canal ${id}`,
    status,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    connection: {
      id: "connection_current",
      workspaceId: "workspace_current",
      status: "observation",
      removedAt: null,
    },
    routes: routes.map((item) => ({ ...item, channelId: id })),
  };
}

function event(input: {
  id: string;
  channelId: string;
  classification:
    | "eligible_route_resolved"
    | "eligible_route_unresolved"
    | "ignored_untracked_lead";
  expiresAt?: Date;
  payloadAvailable?: boolean;
  replayStatus?:
    | "materialized"
    | "duplicate"
    | "failed"
    | "skipped"
    | "queued"
    | "processing"
    | null;
  workspaceId?: string;
  connectionId?: string;
}) {
  const payloadAvailable = input.payloadAvailable ?? true;

  return {
    id: input.id,
    deliveryId: `delivery_${input.id}`,
    workspaceId: input.workspaceId ?? "workspace_current",
    connectionId: input.connectionId ?? "connection_current",
    channelId: input.channelId,
    hasCtwa: true,
    classification: input.classification as string,
    classificationReason: null as string | null,
    occurredAt: timestamp,
    replayItem:
      input.replayStatus === null || input.replayStatus === undefined
        ? null
        : { status: input.replayStatus as string },
    productionItem: null as { status: string } | null,
    delivery: {
      payloadExpiresAt: input.expiresAt ?? future,
      encryptedPayload: payloadAvailable ? "encrypted-payload" : null,
      payloadIv: payloadAvailable ? "private-iv" : null,
      payloadTag: payloadAvailable ? "private-tag" : null,
      encryptionKeyVersion: payloadAvailable ? 1 : null,
    },
    rawPayload: {
      CTWaCLId: "must-never-be-returned",
      contactPhone: "+5511999999999",
      adId: "private-ad-id",
    },
  };
}

type SyntheticEvent = ReturnType<typeof event>;

/**
 * Reference semantics of the former in-memory readiness (every CTWA event
 * loaded, deliveries checked by id). Emulates the SQL aggregate the service
 * now runs, so the readiness expectations below keep proving the meaning is
 * unchanged.
 */
function aggregateLikeSql(
  events: readonly SyntheticEvent[],
  workspaceId: string,
  connectionId: string,
  channelIds: readonly string[],
  at: Date,
) {
  const done = (status?: string | null) =>
    status === "materialized" || status === "duplicate";
  const rows = new Map<string, Record<string, unknown>>();
  for (const item of events) {
    if (
      item.workspaceId !== workspaceId ||
      item.connectionId !== connectionId ||
      !channelIds.includes(item.channelId) ||
      item.hasCtwa !== true
    ) {
      continue;
    }
    const row = (rows.get(item.channelId) ?? {
      channelId: item.channelId,
      total: 0,
      routed: 0,
      unresolved: 0,
      alreadyMaterialized: 0,
      adUnavailableOpen: 0,
      retainedOpen: 0,
      retainedRoutedUntouched: 0,
      inProgressOpen: 0,
      sendFailedOpen: 0,
      notEligibleOpen: 0,
      nextPayloadExpiresAt: null,
    }) as Record<string, number | Date | null | string>;
    const isDone =
      done(item.replayItem?.status) || done(item.productionItem?.status);
    const available =
      item.delivery.payloadExpiresAt > at &&
      item.delivery.encryptedPayload !== null &&
      item.delivery.payloadIv !== null &&
      item.delivery.payloadTag !== null &&
      item.delivery.encryptionKeyVersion !== null;
    (row.total as number)++;
    if (item.classification === "eligible_route_resolved")
      (row.routed as number)++;
    if (item.classification === "eligible_route_unresolved")
      (row.unresolved as number)++;
    if (isDone) (row.alreadyMaterialized as number)++;
    if (!isDone && item.classificationReason === "route_ad_missing")
      (row.adUnavailableOpen as number)++;
    if (!isDone && available) {
      (row.retainedOpen as number)++;
      const current = row.nextPayloadExpiresAt as Date | null;
      if (!current || item.delivery.payloadExpiresAt < current)
        row.nextPayloadExpiresAt = item.delivery.payloadExpiresAt;
    }
    if (
      item.classification === "eligible_route_resolved" &&
      item.replayItem === null &&
      item.productionItem === null &&
      available
    ) {
      (row.retainedRoutedUntouched as number)++;
    }
    const inFlight = (status?: string | null) =>
      status === "queued" || status === "processing";
    const untouched = item.replayItem === null && item.productionItem === null;
    if (!isDone) {
      if (
        inFlight(item.replayItem?.status) ||
        inFlight(item.productionItem?.status)
      )
        (row.inProgressOpen as number)++;
      else if (!untouched) (row.sendFailedOpen as number)++;
      else if (
        item.classification !== "eligible_route_resolved" &&
        item.classification !== "eligible_route_unresolved"
      )
        (row.notEligibleOpen as number)++;
    }
    rows.set(item.channelId, row);
  }
  return [...rows.values()];
}

/** Mock of prisma.$queryRaw (tagged template) backed by synthetic events. */
function queryRawOver(source: () => readonly SyntheticEvent[]) {
  return vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const [workspaceId, connectionId, atIso] = values as [
      string,
      string,
      string,
    ];
    // "now" travels as an ISO string (cast to UTC timestamp in SQL).
    expect(typeof atIso).toBe("string");
    const at = new Date(atIso);
    const channelSql = values.find(
      (value): value is { values: string[] } =>
        typeof value === "object" &&
        value !== null &&
        !(value instanceof Date) &&
        Array.isArray((value as { values?: unknown }).values),
    );
    return aggregateLikeSql(
      source(),
      workspaceId,
      connectionId,
      channelSql?.values ?? [],
      at,
    );
  });
}

function createHarness() {
  const channels = [
    channel("channel_waiting", [route("waiting")]),
    channel("channel_blocked", []),
    channel("channel_partial", [route("partial")]),
    channel("channel_ready", [route("ready")]),
    channel("channel_complete", [route("complete")]),
  ];
  const events: SyntheticEvent[] = [
    event({
      id: "event_blocked",
      channelId: "channel_blocked",
      classification: "eligible_route_unresolved",
    }),
    event({
      id: "event_partial_ready",
      channelId: "channel_partial",
      classification: "eligible_route_resolved",
      expiresAt: soon,
    }),
    event({
      id: "event_partial_unresolved",
      channelId: "channel_partial",
      classification: "eligible_route_unresolved",
      expiresAt: soon,
    }),
    event({
      id: "event_partial_unavailable",
      channelId: "channel_partial",
      classification: "eligible_route_resolved",
      payloadAvailable: false,
    }),
    event({
      id: "event_ready",
      channelId: "channel_ready",
      classification: "eligible_route_resolved",
    }),
    event({
      id: "event_complete",
      channelId: "channel_complete",
      classification: "eligible_route_resolved",
      expiresAt: expired,
      payloadAvailable: false,
      replayStatus: "materialized",
    }),
    event({
      id: "event_foreign",
      channelId: "channel_foreign",
      classification: "eligible_route_resolved",
      workspaceId: "workspace_foreign",
      connectionId: "connection_foreign",
    }),
  ];
  const state = { events };
  const prisma = {
    inboundWebhookConnection: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === "connection_current" &&
        where.workspaceId === "workspace_current"
          ? { id: "connection_current" }
          : null,
      ),
    },
    inboundWebhookChannel: {
      findMany: vi.fn(async ({ where }) =>
        where.workspaceId === "workspace_current" &&
        where.connectionId === "connection_current"
          ? channels
          : [],
      ),
    },
    // Row-level loading must never happen on the listing path anymore.
    inboundWebhookEvent: {
      findMany: vi.fn(),
    },
    inboundWebhookDelivery: {
      findMany: vi.fn(),
    },
    $queryRaw: queryRawOver(() => state.events),
    metaBusinessConnection: {
      findFirst: vi.fn(async ({ where }: any) => ({
        id: where.id,
        workspaceId: where.workspaceId,
        status: "active",
        credential: { workspaceId: where.workspaceId, status: "active" },
      })),
    },
    metaReportingAccount: {
      findMany: vi.fn(async () => [
        {
          id: "account",
          conversionDestinationId: null,
          allowedDestinations: [
            "waiting",
            "partial",
            "ready",
            "complete",
          ].map((id) => ({ conversionDestinationId: `destination-${id}` })),
        },
      ]),
    },
    metaConversionDestination: {
      findFirst: vi.fn(async () => ({ id: "destination" })),
    },
  };
  const service = new InboundWebhookChannelRoutesService(
    prisma as unknown as PrismaService,
    {
      previewRoute: vi.fn(),
    } as unknown as InboundWebhookMetaRouteReaderService,
  );

  return { prisma, service, state };
}

describe("inbound webhook channel readiness", () => {
  it("summarizes route and retained CTWA readiness without sensitive data", async () => {
    const { prisma, service } = createHarness();

    const channels = await service.listChannels(
      "workspace_current",
      "connection_current",
    );
    const byId = new Map(channels.map((item) => [item.id, item]));

    expect(byId.get("channel_waiting")?.readiness).toMatchObject({
      state: "waiting",
      blockers: ["ctwa_not_observed"],
      validRouteCount: 1,
      totalCtwa: 0,
    });
    expect(byId.get("channel_blocked")?.readiness).toMatchObject({
      state: "blocked",
      blockers: ["route_not_configured", "ctwa_unresolved"],
      retainedCtwa: 1,
      retainedRoutedCtwa: 0,
    });
    expect(byId.get("channel_partial")?.readiness).toMatchObject({
      state: "partial",
      blockers: [
        "ctwa_unresolved",
        "payload_unavailable",
        "payload_expiring_soon",
      ],
      routedCtwa: 2,
      unresolvedCtwa: 1,
      retainedCtwa: 2,
      retainedRoutedCtwa: 1,
      payloadUnavailableCtwa: 1,
    });
    expect(byId.get("channel_ready")?.readiness).toMatchObject({
      state: "ready",
      blockers: [],
      retainedRoutedCtwa: 1,
    });
    expect(byId.get("channel_complete")?.readiness).toMatchObject({
      state: "complete",
      alreadyMaterializedCtwa: 1,
      payloadUnavailableCtwa: 0,
    });
    expect(byId.get("channel_partial")?.readiness.nextPayloadExpiresAt).toBe(
      soon.toISOString(),
    );

    // One aggregate query, scoped to this workspace/connection/channels.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = prisma.$queryRaw.mock.calls[0]!;
    const sql = strings.join("?");
    expect(sql).toContain('FROM "InboundWebhookEvent" e');
    expect(sql).toContain('e."hasCtwa" = true');
    expect(sql).toContain('GROUP BY s."channelId"');
    for (const predicate of [
      'd."encryptedPayload" IS NOT NULL',
      'd."payloadIv" IS NOT NULL',
      'd."payloadTag" IS NOT NULL',
      'd."encryptionKeyVersion" IS NOT NULL',
      'd."payloadExpiresAt" >',
    ]) {
      expect(sql).toContain(predicate);
    }
    expect(values.slice(0, 2)).toEqual([
      "workspace_current",
      "connection_current",
    ]);
    expect(
      values.find(
        (value): value is { values: string[] } =>
          typeof value === "object" &&
          value !== null &&
          Array.isArray((value as { values?: unknown }).values),
      )?.values,
    ).toEqual([
      "channel_waiting",
      "channel_blocked",
      "channel_partial",
      "channel_ready",
      "channel_complete",
    ]);
    expect(prisma.inboundWebhookEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.inboundWebhookDelivery.findMany).not.toHaveBeenCalled();

    const serialized = JSON.stringify(channels);
    for (const forbidden of [
      "workspace_foreign",
      "must-never-be-returned",
      "+5511999999999",
      "private-ad-id",
      "encrypted-payload",
      "private-iv",
      "private-tag",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("does not query channel events for a foreign or missing connection", async () => {
    const { prisma, service } = createHarness();

    await expect(
      service.listChannels("workspace_foreign", "connection_current"),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.listChannels("workspace_current", "connection_missing"),
    ).rejects.toMatchObject({
      message: "Recurso de webhook não encontrado",
    });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.inboundWebhookEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.inboundWebhookDelivery.findMany).not.toHaveBeenCalled();
  });

  it("does not leave a UAZAPI channel waiting when its bridged instance has materialized CTWA leads", async () => {
    const uazapiChannel = {
      ...channel("channel_uazapi", []),
      whatsappInstanceId: "instance_a",
      connection: {
        id: "connection_current",
        workspaceId: "workspace_current",
        provider: "uazapi",
        status: "observation",
        removedAt: null,
      },
    };
    const prisma = {
      inboundWebhookConnection: {
        findFirst: vi.fn(async () => ({ id: "connection_current" })),
      },
      inboundWebhookChannel: {
        findMany: vi.fn(async () => [uazapiChannel]),
      },
      inboundWebhookEvent: {
        findMany: vi.fn(),
      },
      inboundWebhookDelivery: {
        findMany: vi.fn(),
      },
      lead: {
        groupBy: vi.fn(async () => [
          { whatsappInstanceId: "instance_a", _count: { _all: 3 } },
        ]),
      },
      $queryRaw: vi.fn(),
    };
    const service = new InboundWebhookChannelRoutesService(
      prisma as unknown as PrismaService,
      {
        previewRoute: vi.fn(),
      } as unknown as InboundWebhookMetaRouteReaderService,
    );

    const [result] = await service.listChannels(
      "workspace_current",
      "connection_current",
    );

    expect(result.readiness).toMatchObject({
      state: "complete",
      totalCtwa: 3,
      routedCtwa: 3,
      alreadyMaterializedCtwa: 3,
    });
    expect(result.readiness.blockers).not.toContain("ctwa_not_observed");
    expect(prisma.lead.groupBy).toHaveBeenCalledWith({
      by: ["whatsappInstanceId"],
      where: {
        workspaceId: "workspace_current",
        whatsappInstanceId: { in: ["instance_a"] },
        source: "uazapi",
        ctwaClid: { not: null },
      },
      _count: { _all: true },
    });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.inboundWebhookEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.inboundWebhookDelivery.findMany).not.toHaveBeenCalled();
  });

  it("keeps memory and query count constant for a connection with a huge CTWA history", async () => {
    const { prisma, service, state } = createHarness();
    // ~3 months of daily CTWA traffic on one number, mostly already
    // materialized, a few recent ones still retained.
    const volume = 250_000;
    const history: SyntheticEvent[] = [];
    for (let index = 0; index < volume; index += 1) {
      const recent = index >= volume - 3;
      history.push(
        event({
          id: `bulk_${index}`,
          channelId: "channel_ready",
          classification: "eligible_route_resolved",
          expiresAt: recent ? future : expired,
          payloadAvailable: recent,
          replayStatus: recent ? null : "materialized",
        }),
      );
    }
    state.events = history;

    const channels = await service.listChannels(
      "workspace_current",
      "connection_current",
    );
    const ready = channels.find((item) => item.id === "channel_ready");

    // A single aggregate round trip; the rows never cross into Node.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.inboundWebhookEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.inboundWebhookDelivery.findMany).not.toHaveBeenCalled();
    const returned = await prisma.$queryRaw.mock.results[0]!.value;
    expect(returned).toHaveLength(1);
    // No bind parameter grows with the event volume (the former second query
    // sent every delivery id back in an IN list).
    const params = prisma.$queryRaw.mock.calls[0]!.slice(1);
    expect(params.length).toBeLessThan(10);
    expect(JSON.stringify(params)).not.toContain("delivery_bulk_");
    expect(ready?.readiness).toMatchObject({
      state: "ready",
      totalCtwa: volume,
      routedCtwa: volume,
      alreadyMaterializedCtwa: volume - 3,
      retainedCtwa: 3,
      retainedRoutedCtwa: 3,
      payloadUnavailableCtwa: 0,
      nextPayloadExpiresAt: future.toISOString(),
    });
  });

  it("falls back to a bounded recent read when the aggregate SQL fails", async () => {
    const { prisma, service, state } = createHarness();
    prisma.$queryRaw.mockRejectedValueOnce(
      Object.assign(new Error("column does not exist +5511999999999"), {
        code: "P2010",
      }),
    );
    // Emulate Prisma for the bounded path over the same synthetic events.
    prisma.inboundWebhookEvent.findMany.mockImplementation(
      async ({ where, take }: any) =>
        state.events
          .filter(
            (item) =>
              item.workspaceId === where.workspaceId &&
              item.connectionId === where.connectionId &&
              where.channelId.in.includes(item.channelId) &&
              item.hasCtwa === where.hasCtwa &&
              item.occurredAt >= where.occurredAt.gte,
          )
          .slice(0, take),
    );
    prisma.inboundWebhookDelivery.findMany.mockImplementation(
      async ({ where }: any) =>
        state.events
          .filter(
            (item) =>
              where.id.in.includes(item.deliveryId) &&
              item.delivery.payloadExpiresAt > where.payloadExpiresAt.gt &&
              item.delivery.encryptedPayload !== null &&
              item.delivery.payloadIv !== null &&
              item.delivery.payloadTag !== null &&
              item.delivery.encryptionKeyVersion !== null,
          )
          .map((item) => ({ id: item.deliveryId })),
    );
    // Recent synthetic timestamps so the 90-day window includes them.
    state.events = state.events.map((item) => ({
      ...item,
      occurredAt: new Date(now - 60 * 60 * 1_000),
    }));
    const errorLog = vi
      .spyOn(
        (service as unknown as { logger: { error: (line: string) => void } })
          .logger,
        "error",
      )
      .mockImplementation(() => undefined);

    const channels = await service.listChannels(
      "workspace_current",
      "connection_current",
    );

    expect(channels).toHaveLength(5);
    expect(
      channels.find((item) => item.id === "channel_partial")?.readiness,
    ).toMatchObject({
      state: "partial",
      routedCtwa: 2,
      unresolvedCtwa: 1,
      retainedCtwa: 2,
      retainedRoutedCtwa: 1,
      payloadUnavailableCtwa: 1,
    });
    const query = prisma.inboundWebhookEvent.findMany.mock.calls[0]![0];
    expect(query.take).toBe(5_000);
    expect(query.where.occurredAt.gte).toBeInstanceOf(Date);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(JSON.parse(errorLog.mock.calls[0]![0])).toMatchObject({
      event: "inbound_webhook.channels_readiness_sql_failed",
      connectionId: "connection_current",
      errorCode: "P2010",
    });
    expect(errorLog.mock.calls[0]![0]).not.toContain("+5511999999999");
  });

  it("propagates a failure of the fallback too, logging it without PII", async () => {
    const { prisma, service } = createHarness();
    const failure = Object.assign(
      new Error("canceling statement due to statement timeout +5511999999999"),
      {
        code: "P2010",
      },
    );
    prisma.$queryRaw.mockRejectedValueOnce(failure);
    prisma.inboundWebhookEvent.findMany.mockRejectedValueOnce(failure);
    const errorLog = vi
      .spyOn(
        (service as unknown as { logger: { error: (line: string) => void } })
          .logger,
        "error",
      )
      .mockImplementation(() => undefined);

    await expect(
      service.listChannels("workspace_current", "connection_current"),
    ).rejects.toBe(failure);
    expect(errorLog).toHaveBeenCalledTimes(2);
    const line = JSON.parse(errorLog.mock.calls[1]![0]);
    expect(line).toMatchObject({
      event: "inbound_webhook.channels_list_failed",
      connectionId: "connection_current",
      channelCount: 5,
      errorName: "Error",
      errorCode: "P2010",
    });
    expect(typeof line.durationMs).toBe("number");
    expect(errorLog.mock.calls[0]![0]).not.toContain("+5511999999999");
  });

  it("logs the listing duration with the connection id only", async () => {
    const { service } = createHarness();
    const logger = (
      service as unknown as {
        logger: { log: (line: string) => void; warn: (line: string) => void };
      }
    ).logger;
    const log = vi.spyOn(logger, "log").mockImplementation(() => undefined);
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    await service.listChannels("workspace_current", "connection_current");

    const line = JSON.parse(log.mock.calls.at(-1)![0]);
    expect(Object.keys(line).sort()).toEqual([
      "channelCount",
      "connectionId",
      "durationMs",
      "event",
      "readinessMs",
    ]);
    expect(line).toMatchObject({
      event: "inbound_webhook.channels_listed",
      connectionId: "connection_current",
      channelCount: 5,
    });
  });
});

it("reports missing ad evidence separately from routes and excludes completed events", async () => {
  const { service, state } = createHarness();
  state.events = [
    {
      ...event({
        id: "no_ad",
        channelId: "channel_blocked",
        classification: "eligible_route_unresolved",
      }),
      classificationReason: "route_ad_missing",
    },
    {
      ...event({
        id: "done",
        channelId: "channel_complete",
        classification: "eligible_route_unresolved",
        replayStatus: "materialized",
      }),
      classificationReason: "route_ad_missing",
    },
  ];
  const channels = await service.listChannels(
    "workspace_current",
    "connection_current",
  );
  expect(
    channels.find((c) => c.id === "channel_blocked")?.readiness.blockers,
  ).toEqual(
    expect.arrayContaining(["route_not_configured", "ctwa_ad_unavailable"]),
  );
  expect(
    channels.find((c) => c.id === "channel_complete")?.readiness.blockers,
  ).not.toContain("ctwa_ad_unavailable");
  expect(
    channels.find((c) => c.id === "channel_blocked")?.readiness
      .adUnavailableCtwa,
  ).toBe(1);
});

describe("channel readiness never reports a block without a reason", () => {
  async function readinessOf(events: SyntheticEvent[]) {
    const { service, state } = createHarness();
    state.events = events;
    const channels = await service.listChannels(
      "workspace_current",
      "connection_current",
    );
    return channels.find((item) => item.id === "channel_ready")!.readiness;
  }

  it("blocks with an actionable reason when every routed CTWA already failed", async () => {
    const readiness = await readinessOf([
      event({
        id: "failed_1",
        channelId: "channel_ready",
        classification: "eligible_route_resolved",
        replayStatus: "failed",
      }),
      event({
        id: "skipped_1",
        channelId: "channel_ready",
        classification: "eligible_route_resolved",
        replayStatus: "skipped",
      }),
    ]);

    expect(readiness).toMatchObject({
      state: "blocked",
      blockers: ["ctwa_send_failed"],
      retainedRoutedCtwa: 0,
      sendFailedCtwa: 2,
      inProgressCtwa: 0,
      notEligibleCtwa: 0,
    });
  });

  it("is partial, not blocked, while the only open CTWA are being processed", async () => {
    const readiness = await readinessOf([
      event({
        id: "queued_1",
        channelId: "channel_ready",
        classification: "eligible_route_resolved",
        replayStatus: "queued",
      }),
      event({
        id: "processing_1",
        channelId: "channel_ready",
        classification: "eligible_route_resolved",
        replayStatus: "processing",
      }),
    ]);

    expect(readiness).toMatchObject({
      state: "partial",
      blockers: ["ctwa_in_progress"],
      retainedRoutedCtwa: 0,
      inProgressCtwa: 2,
    });
  });

  it("is partial, not blocked, when the only open CTWA were ignored by triage", async () => {
    const readiness = await readinessOf([
      event({
        id: "ignored_1",
        channelId: "channel_ready",
        classification: "ignored_untracked_lead",
      }),
    ]);

    expect(readiness).toMatchObject({
      state: "partial",
      blockers: ["ctwa_not_eligible"],
      retainedRoutedCtwa: 0,
      notEligibleCtwa: 1,
    });
  });

  it("keeps a sendable channel ready when other CTWA are only in progress", async () => {
    const readiness = await readinessOf([
      event({
        id: "sendable",
        channelId: "channel_ready",
        classification: "eligible_route_resolved",
      }),
      event({
        id: "queued_2",
        channelId: "channel_ready",
        classification: "eligible_route_resolved",
        replayStatus: "queued",
      }),
    ]);

    expect(readiness).toMatchObject({
      state: "ready",
      blockers: ["ctwa_in_progress"],
      retainedRoutedCtwa: 1,
    });
  });

  it("holds for every combination of open CTWA kinds", async () => {
    const kinds = [
      { classification: "eligible_route_resolved", replayStatus: null },
      {
        classification: "eligible_route_resolved",
        replayStatus: null,
        payloadAvailable: false,
      },
      { classification: "eligible_route_unresolved", replayStatus: null },
      { classification: "eligible_route_resolved", replayStatus: "failed" },
      { classification: "eligible_route_resolved", replayStatus: "skipped" },
      { classification: "eligible_route_resolved", replayStatus: "queued" },
      { classification: "eligible_route_resolved", replayStatus: "processing" },
      { classification: "ignored_untracked_lead", replayStatus: null },
      {
        classification: "eligible_route_resolved",
        replayStatus: "materialized",
      },
    ] as const;
    const actionable: string[] = [
      "route_not_configured",
      "route_not_valid",
      "ctwa_unresolved",
      "ctwa_ad_unavailable",
      "payload_unavailable",
      "ctwa_send_failed",
    ];

    for (let mask = 1; mask < 1 << kinds.length; mask += 1) {
      const events = kinds
        .map((kind, index) =>
          mask & (1 << index)
            ? event({
                id: `combo_${mask}_${index}`,
                channelId: "channel_ready",
                ...kind,
              })
            : null,
        )
        .filter((item): item is SyntheticEvent => item !== null);
      const readiness = await readinessOf(events);

      if (readiness.state === "blocked") {
        expect(
          readiness.blockers.some((blocker) => actionable.includes(blocker)),
          `mask ${mask}`,
        ).toBe(true);
      }
      if (readiness.state === "partial") {
        expect(readiness.blockers.length, `mask ${mask}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("adaptação nod: ponte WAHA e Meta Cloud", () => {
  function bridgeWorld(provider: string) {
    const bridged = {
      ...channel("channel_bridge", []),
      whatsappInstanceId: "instance_waha",
      connection: {
        id: "connection_current",
        workspaceId: "workspace_current",
        provider,
        status: "observation",
        removedAt: null,
      },
    };
    const prisma = {
      inboundWebhookConnection: {
        findFirst: vi.fn(async () => ({ id: "connection_current" })),
      },
      inboundWebhookChannel: {
        findMany: vi.fn(async () => [bridged]),
      },
      inboundWebhookEvent: { findMany: vi.fn() },
      inboundWebhookDelivery: { findMany: vi.fn() },
      lead: {
        groupBy: vi.fn(async () => [
          { whatsappInstanceId: "instance_waha", _count: { _all: 2 } },
        ]),
      },
      $queryRaw: vi.fn(async () => []),
    };
    const service = new InboundWebhookChannelRoutesService(
      prisma as unknown as PrismaService,
      { previewRoute: vi.fn() } as unknown as InboundWebhookMetaRouteReaderService,
    );
    return { prisma, service };
  }

  it("a ponte WAHA conta os leads CTWA da instância (source waha), sem ler eventos", async () => {
    const { prisma, service } = bridgeWorld("waha");
    const [result] = await service.listChannels(
      "workspace_current",
      "connection_current",
    );

    expect(result!.readiness).toMatchObject({
      state: "complete",
      totalCtwa: 2,
      alreadyMaterializedCtwa: 2,
    });
    // A ponte não guarda rota no canal: "rota não configurada" não se aplica.
    expect(result!.readiness.blockers).not.toContain("route_not_configured");
    expect(prisma.lead.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          source: "waha",
          whatsappInstanceId: { in: ["instance_waha"] },
        }),
      }),
    );
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("Meta Cloud grava InboundWebhookEvent: usa o agregado SQL, nunca os leads", async () => {
    const { prisma, service } = bridgeWorld("meta_cloud");
    await service.listChannels("workspace_current", "connection_current");

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.lead.groupBy).not.toHaveBeenCalled();
    expect(prisma.inboundWebhookEvent.findMany).not.toHaveBeenCalled();
  });
});
