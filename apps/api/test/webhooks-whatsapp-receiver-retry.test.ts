import "reflect-metadata";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticsService } from "../src/diagnostics/diagnostics.service";
import { WebhooksController } from "../src/webhooks/webhooks.controller";

type Instance = {
  id: string;
  workspaceId: string;
  provider: string;
  providerInstanceId: string | null;
  webhookTokenHash: string | null;
  status: "active" | "suspended";
};

const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const wahaInstance: Instance = {
  id: "connection-waha",
  workspaceId: "workspace-a",
  provider: "waha",
  providerInstanceId: "session-1",
  webhookTokenHash: hash("valid-token"),
  status: "active",
};

const ctwaFixture = { ad_id: "ad-123", clid: "clid-123" };

function wahaMessagePayload(overrides: Record<string, unknown> = {}) {
  return {
    event: "message",
    session: "session-1",
    payload: {
      from: "5511999999999@c.us",
      to: "5511888888888@c.us",
      id: "waha-msg-1",
      timestamp: 1_700_000_000,
      fromMe: false,
      type: "chat",
      body: "Ola",
      ctwa: ctwaFixture,
      ...overrides,
    },
  };
}

type DownstreamServices = {
  conversionRulesService: { evaluateTriggers: ReturnType<typeof vi.fn> };
  conversionEventsService: {
    recordAutomaticLeadSubmitted: ReturnType<typeof vi.fn>;
    recordRuleMatches: ReturnType<typeof vi.fn>;
    listReadyLogIds: ReturnType<typeof vi.fn>;
  };
  conversionEventsQueueService: { enqueueSend: ReturnType<typeof vi.fn> };
  leadsService: { upsertFromWhatsappWebhook: ReturnType<typeof vi.fn> };
};

function downstreamServices(): DownstreamServices {
  return {
    conversionRulesService: {
      evaluateTriggers: vi.fn(async () => []),
    },
    conversionEventsService: {
      recordAutomaticLeadSubmitted: vi.fn(async () => ({
        created: ["conversion-log-1"],
        duplicates: [],
      })),
      recordRuleMatches: vi.fn(async () => ({ created: [], duplicates: [] })),
      listReadyLogIds: vi.fn(async () => ["conversion-log-1"]),
    },
    conversionEventsQueueService: {
      enqueueSend: vi.fn(async () => ({ queued: true })),
    },
    leadsService: {
      upsertFromWhatsappWebhook: vi.fn(async () => ({ id: "lead-1" })),
    },
  };
}

function diagnosticsMock() {
  return {
    recordWebhookLog: vi.fn(async () => ({
      webhookLogId: "webhook-log-1",
      diagnosticEventId: "diagnostic-event-1",
      status: "received",
    })),
    markWebhookLogProcessed: vi.fn(async () => true),
    markWebhookLogFailed: vi.fn(async () => true),
  };
}

function controllerWith(
  diagnostics: ReturnType<typeof diagnosticsMock>,
  services: DownstreamServices,
  metaAdFindFirst: ReturnType<typeof vi.fn> = vi.fn(async () => null),
) {
  const prisma = {
    whatsappInstance: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === wahaInstance.id ? wahaInstance : null,
      ),
    },
    metaAd: { findFirst: metaAdFindFirst },
  };

  return new WebhooksController(
    diagnostics as never,
    services.conversionRulesService as never,
    services.conversionEventsService as never,
    services.conversionEventsQueueService as never,
    services.leadsService as never,
    {} as never,
    prisma as never,
  );
}

function deliver(controller: WebhooksController, body: unknown) {
  return controller.recordWhatsappConnection(
    wahaInstance.id,
    body as Record<string, unknown>,
    "valid-token",
  );
}

describe("WAHA/Z-API receiver failure accounting", () => {
  // Every downstream step runs while the request holds the WebhookLog
  // claim. Whichever one throws, the delivery must settle as "failed" -
  // that is the only thing that keeps the provider's retry reprocessable.
  const stages: Array<{
    name: string;
    fail: (services: DownstreamServices, error: Error) => void;
  }> = [
    {
      name: "conversion rule evaluation",
      fail: (services, error) => {
        services.conversionRulesService.evaluateTriggers.mockRejectedValueOnce(
          error,
        );
      },
    },
    {
      name: "lead upsert",
      fail: (services, error) => {
        services.leadsService.upsertFromWhatsappWebhook.mockRejectedValueOnce(
          error,
        );
      },
    },
    {
      name: "automatic lead_submitted conversion",
      fail: (services, error) => {
        services.conversionEventsService.recordAutomaticLeadSubmitted.mockRejectedValueOnce(
          error,
        );
      },
    },
    {
      name: "rule match conversion",
      fail: (services, error) => {
        services.conversionEventsService.recordRuleMatches.mockRejectedValueOnce(
          error,
        );
      },
    },
    {
      name: "ready conversion log lookup",
      fail: (services, error) => {
        services.conversionEventsService.listReadyLogIds.mockRejectedValueOnce(
          error,
        );
      },
    },
    {
      name: "conversion send enqueue",
      fail: (services, error) => {
        services.conversionEventsQueueService.enqueueSend.mockRejectedValueOnce(
          error,
        );
      },
    },
  ];

  for (const stage of stages) {
    it(`marks the delivery failed and propagates when ${stage.name} throws`, async () => {
      const diagnostics = diagnosticsMock();
      const services = downstreamServices();
      const failure = new Error("downstream indisponivel");
      stage.fail(services, failure);
      const controller = controllerWith(diagnostics, services);

      await expect(deliver(controller, wahaMessagePayload())).rejects.toBe(
        failure,
      );

      expect(diagnostics.markWebhookLogFailed).toHaveBeenCalledWith(
        "webhook-log-1",
        failure,
      );
      expect(diagnostics.markWebhookLogProcessed).not.toHaveBeenCalled();
    });
  }

  it("marks the delivery failed when Meta attribution lookup throws", async () => {
    const diagnostics = diagnosticsMock();
    const services = downstreamServices();
    const failure = new Error("meta ad lookup indisponivel");
    const controller = controllerWith(
      diagnostics,
      services,
      vi.fn(async () => {
        throw failure;
      }),
    );

    await expect(deliver(controller, wahaMessagePayload())).rejects.toBe(
      failure,
    );

    expect(diagnostics.markWebhookLogFailed).toHaveBeenCalledWith(
      "webhook-log-1",
      failure,
    );
    expect(
      services.leadsService.upsertFromWhatsappWebhook,
    ).not.toHaveBeenCalled();
    expect(diagnostics.markWebhookLogProcessed).not.toHaveBeenCalled();
  });

  it("settles a fully processed delivery as processed", async () => {
    const diagnostics = diagnosticsMock();
    const services = downstreamServices();
    const controller = controllerWith(diagnostics, services);

    await expect(
      deliver(controller, wahaMessagePayload()),
    ).resolves.toMatchObject({ webhookLogId: "webhook-log-1" });

    expect(diagnostics.markWebhookLogProcessed).toHaveBeenCalledWith(
      "webhook-log-1",
    );
    expect(diagnostics.markWebhookLogFailed).not.toHaveBeenCalled();
  });

  it("settles an organic delivery as processed even though it creates no lead", async () => {
    const diagnostics = diagnosticsMock();
    const services = downstreamServices();
    const controller = controllerWith(diagnostics, services);

    await deliver(controller, wahaMessagePayload({ ctwa: undefined }));

    expect(
      services.leadsService.upsertFromWhatsappWebhook,
    ).not.toHaveBeenCalled();
    expect(diagnostics.markWebhookLogProcessed).toHaveBeenCalledWith(
      "webhook-log-1",
    );
    expect(diagnostics.markWebhookLogFailed).not.toHaveBeenCalled();
  });

  it("never settles a delivery it does not hold (duplicate/conflict)", async () => {
    for (const status of ["duplicate", "conflict"]) {
      const diagnostics = diagnosticsMock();
      diagnostics.recordWebhookLog = vi.fn(async () => ({
        webhookLogId: "webhook-log-existing",
        diagnosticEventId: "diagnostic-event-existing",
        status,
      }));
      const services = downstreamServices();
      const controller = controllerWith(diagnostics, services);

      await expect(
        deliver(controller, wahaMessagePayload()),
      ).resolves.toMatchObject({ status });

      expect(diagnostics.markWebhookLogProcessed).not.toHaveBeenCalled();
      expect(diagnostics.markWebhookLogFailed).not.toHaveBeenCalled();
      expect(
        services.leadsService.upsertFromWhatsappWebhook,
      ).not.toHaveBeenCalled();
    }
  });

  it("propagates the downstream error even when the failure cannot be recorded, without leaking the payload", async () => {
    const diagnostics = diagnosticsMock();
    diagnostics.markWebhookLogFailed = vi.fn(async () => {
      throw new Error("banco indisponivel");
    });
    const services = downstreamServices();
    const failure = new Error("falha com telefone 5511999999999 e token secreto");
    services.leadsService.upsertFromWhatsappWebhook.mockRejectedValueOnce(
      failure,
    );
    const controller = controllerWith(diagnostics, services);
    const logged: string[] = [];
    const logger = vi
      .spyOn(
        (controller as unknown as { logger: { error: (m: string) => void } })
          .logger,
        "error",
      )
      .mockImplementation((message: string) => {
        logged.push(message);
      });

    await expect(deliver(controller, wahaMessagePayload())).rejects.toBe(
      failure,
    );

    expect(logger).toHaveBeenCalledTimes(1);
    expect(logged[0]).toContain("whatsapp_receiver_failure_not_recorded");
    expect(logged[0]).not.toContain("5511999999999");
    expect(logged[0]).not.toMatch(/token|secreto|valid-token/i);
  });
});

/**
 * In-memory stand-in for the WebhookLog table. Reads and writes inside a
 * single operation are not interleaved, which is what a real conditional
 * UPDATE gives us: the database serializes row access, so a status-scoped
 * update either still matches or reports zero rows. That is the property
 * the claim/retry logic depends on, so the fake has to model it.
 */
function makeWebhookLogPrisma(instance: Instance) {
  type Row = Record<string, unknown> & { id: string };
  const rows = new Map<string, Row>();
  const events: Array<Record<string, unknown>> = [];
  let sequence = 0;

  const matchesStatus = (row: Row, status: unknown): boolean => {
    if (status === undefined) return true;
    if (typeof status === "string") return row.status === status;
    const values = (status as { in?: string[] }).in ?? [];
    return values.includes(row.status as string);
  };

  const prisma = {
    webhookLog: {
      create: async ({ data }: { data: Row }) => {
        if (
          data.idempotencyKey &&
          [...rows.values()].some(
            (row) => row.idempotencyKey === data.idempotencyKey,
          )
        ) {
          throw new Prisma.PrismaClientKnownRequestError("unique constraint", {
            code: "P2002",
            clientVersion: "test",
            meta: { target: ["idempotencyKey"] },
          });
        }

        sequence += 1;
        const row: Row = {
          processedAt: null,
          errorCode: null,
          errorMessage: null,
          ...data,
          id: `webhook-log-${sequence}`,
        };
        rows.set(row.id, row);
        return row;
      },
      findUnique: async ({
        where,
      }: {
        where: { id?: string; idempotencyKey?: string };
      }) => {
        if (where.id) return rows.get(where.id) ?? null;
        return (
          [...rows.values()].find(
            (row) => row.idempotencyKey === where.idempotencyKey,
          ) ?? null
        );
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status?: unknown };
        data: Record<string, unknown>;
      }) => {
        const row = rows.get(where.id);

        if (!row || !matchesStatus(row, where.status)) {
          return { count: 0 };
        }

        Object.assign(row, data);
        return { count: 1 };
      },
    },
    diagnosticEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        sequence += 1;
        const event = {
          ...data,
          id: `diagnostic-event-${sequence}`,
          occurredAt: new Date(),
        };
        events.push(event);
        return event;
      },
      findMany: async ({ where }: { where: { webhookLogId: string } }) =>
        events.filter((event) => event.webhookLogId === where.webhookLogId),
    },
    whatsappInstance: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        where.id === instance.id ? instance : null,
    },
    metaAd: { findFirst: async () => null },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };

  return { prisma, rows };
}

function realStackController(services: DownstreamServices) {
  const { prisma, rows } = makeWebhookLogPrisma(wahaInstance);
  const diagnostics = new DiagnosticsService(prisma as never);
  const controller = new WebhooksController(
    diagnostics as never,
    services.conversionRulesService as never,
    services.conversionEventsService as never,
    services.conversionEventsQueueService as never,
    services.leadsService as never,
    {} as never,
    prisma as never,
  );

  return { controller, rows };
}

describe("WAHA/Z-API receiver bounded retry (controller + DiagnosticsService)", () => {
  it("processes a new delivery and records it as processed", async () => {
    const services = downstreamServices();
    const { controller, rows } = realStackController(services);

    await deliver(controller, wahaMessagePayload());

    const [row] = [...rows.values()];
    expect(row.status).toBe("processed");
    expect(row.processedAt).toBeInstanceOf(Date);
    expect(row.errorCode).toBeNull();
    expect(
      services.leadsService.upsertFromWhatsappWebhook,
    ).toHaveBeenCalledTimes(1);
  });

  it("answers a replay of a completed delivery as duplicate without reprocessing", async () => {
    const services = downstreamServices();
    const { controller, rows } = realStackController(services);

    await deliver(controller, wahaMessagePayload());
    await expect(
      deliver(controller, wahaMessagePayload()),
    ).resolves.toMatchObject({ status: "duplicate" });

    expect(rows.size).toBe(1);
    expect(
      services.leadsService.upsertFromWhatsappWebhook,
    ).toHaveBeenCalledTimes(1);
  });

  it("records a downstream failure as failed and lets the retry reprocess instead of discarding it as duplicate", async () => {
    const services = downstreamServices();
    const failure = new Error("provider indisponivel");
    services.leadsService.upsertFromWhatsappWebhook.mockRejectedValueOnce(
      failure,
    );
    const { controller, rows } = realStackController(services);

    await expect(deliver(controller, wahaMessagePayload())).rejects.toBe(
      failure,
    );

    const [failed] = [...rows.values()];
    expect(failed.status).toBe("failed");
    expect(failed.processedAt).toBeNull();
    expect(failed.errorCode).toBe("receiver_processing_failed");

    // The binary objective: the provider's retry carries the same
    // idempotencyKey and must be reprocessed, not answered as a duplicate.
    await expect(
      deliver(controller, wahaMessagePayload()),
    ).resolves.toMatchObject({ status: "received" });

    expect(rows.size).toBe(1);
    const [reprocessed] = [...rows.values()];
    expect(reprocessed.status).toBe("processed");
    expect(reprocessed.errorCode).toBeNull();
    expect(reprocessed.errorMessage).toBeNull();
    expect(
      services.leadsService.upsertFromWhatsappWebhook,
    ).toHaveBeenCalledTimes(2);
  });

  it("lets only one of two concurrent retries reprocess a failed delivery", async () => {
    const services = downstreamServices();
    services.leadsService.upsertFromWhatsappWebhook.mockRejectedValueOnce(
      new Error("provider indisponivel"),
    );
    const { controller, rows } = realStackController(services);

    await expect(
      deliver(controller, wahaMessagePayload()),
    ).rejects.toBeInstanceOf(Error);
    expect([...rows.values()][0].status).toBe("failed");

    const results = await Promise.all([
      deliver(controller, wahaMessagePayload()),
      deliver(controller, wahaMessagePayload()),
    ]);
    const statuses = results
      .map((result) => (result as { status: string }).status)
      .sort();

    expect(statuses).toEqual(["duplicate", "received"]);
    // Exactly one retry ran the downstream work: 1 for the failed attempt
    // plus 1 for the winning claim.
    expect(
      services.leadsService.upsertFromWhatsappWebhook,
    ).toHaveBeenCalledTimes(2);
    expect(rows.size).toBe(1);
    expect([...rows.values()][0].status).toBe("processed");
  });

  it("quarantines a divergent payload as conflict without reclaiming the failed delivery", async () => {
    const services = downstreamServices();
    services.leadsService.upsertFromWhatsappWebhook.mockRejectedValueOnce(
      new Error("provider indisponivel"),
    );
    const { controller, rows } = realStackController(services);

    await expect(
      deliver(controller, wahaMessagePayload()),
    ).rejects.toBeInstanceOf(Error);

    // Same message id, different body: a conflict, never a retry claim.
    await expect(
      deliver(controller, wahaMessagePayload({ body: "outro texto" })),
    ).resolves.toMatchObject({ status: "conflict" });

    expect(rows.size).toBe(2);
    const original = [...rows.values()][0];
    expect(original.status).toBe("failed");
    expect([...rows.values()][1].status).toBe("conflict");
    expect(
      services.leadsService.upsertFromWhatsappWebhook,
    ).toHaveBeenCalledTimes(1);
  });

  it("redacts the persisted failure message: no phone, token, or raw error text", async () => {
    const services = downstreamServices();
    const failure = new Error(
      "falha ao enviar para 5511999999999 com Bearer super-secret-token",
    );
    failure.name = "ProviderTimeoutError";
    services.leadsService.upsertFromWhatsappWebhook.mockRejectedValueOnce(
      failure,
    );
    const { controller, rows } = realStackController(services);

    await expect(deliver(controller, wahaMessagePayload())).rejects.toBe(
      failure,
    );

    const errorMessage = [...rows.values()][0].errorMessage as string;
    expect(errorMessage).toContain("ProviderTimeoutError");
    expect(errorMessage).not.toContain("5511999999999");
    expect(errorMessage).not.toMatch(/bearer|super-secret-token/i);
    expect(errorMessage).not.toContain(failure.message);
  });
});
