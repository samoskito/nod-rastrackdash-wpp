import "reflect-metadata";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
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

type Services = {
  diagnosticsService: {
    recordWebhookLog: ReturnType<typeof vi.fn>;
    markWebhookLogProcessed: ReturnType<typeof vi.fn>;
    markWebhookLogFailed: ReturnType<typeof vi.fn>;
  };
  conversionRulesService: { evaluateTriggers: ReturnType<typeof vi.fn> };
  conversionEventsService: {
    recordAutomaticLeadSubmitted: ReturnType<typeof vi.fn>;
    recordRuleMatches: ReturnType<typeof vi.fn>;
    listReadyLogIds: ReturnType<typeof vi.fn>;
  };
  conversionEventsQueueService: { enqueueSend: ReturnType<typeof vi.fn> };
  leadsService: { upsertFromWhatsappWebhook: ReturnType<typeof vi.fn> };
};

function defaultServices(): Services {
  return {
    diagnosticsService: {
      recordWebhookLog: vi.fn(async () => ({
        webhookLogId: "webhook-log-1",
        diagnosticEventId: "diagnostic-event-1",
        status: "received",
      })),
      markWebhookLogProcessed: vi.fn(async () => true),
      markWebhookLogFailed: vi.fn(async () => true),
    },
    conversionRulesService: {
      evaluateTriggers: vi.fn(async () => []),
    },
    conversionEventsService: {
      recordAutomaticLeadSubmitted: vi.fn(async () => ({
        created: [],
        duplicates: [],
      })),
      recordRuleMatches: vi.fn(async () => ({ created: [], duplicates: [] })),
      listReadyLogIds: vi.fn(async () => []),
    },
    conversionEventsQueueService: {
      enqueueSend: vi.fn(async () => ({ queued: true })),
    },
    leadsService: {
      upsertFromWhatsappWebhook: vi.fn(async () => ({ id: "lead-1" })),
    },
  };
}

function controllerFor(instance: Instance, services: Services = defaultServices()) {
  const prisma = {
    whatsappInstance: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === instance.id ? instance : null,
      ),
    },
    metaAd: {
      findFirst: vi.fn(async () => null),
    },
  };
  const controller = new WebhooksController(
    services.diagnosticsService as never,
    services.conversionRulesService as never,
    services.conversionEventsService as never,
    services.conversionEventsQueueService as never,
    services.leadsService as never,
    {} as never,
    prisma as never,
  );
  return { controller, prisma, services };
}

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
      ...overrides,
    },
  };
}

function zapiMessagePayload(overrides: Record<string, unknown> = {}) {
  return {
    instanceId: "instance-1",
    connectedPhone: "5511888888888",
    phone: "5511999999999",
    timestamp: 1_700_000_000,
    fromMe: false,
    isGroup: false,
    message: "Ola",
    messageId: "zapi-msg-1",
    ...overrides,
  };
}

const ctwaFixture = { ad_id: "ad-123", clid: "clid-123" };

describe("POST /webhooks/whatsapp/:id", () => {
  it("rejects missing and invalid tokens before any ingestion", async () => {
    const { controller } = controllerFor({
      id: "connection-a",
      workspaceId: "workspace-a",
      provider: "uazapi_byo",
      providerInstanceId: "provider-a",
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });
    const receiver = vi.spyOn(
      controller as never,
      "recordUazapiWebhook" as never,
    );

    await expect(
      controller.recordWhatsappConnection(
        "connection-a",
        {},
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(receiver).not.toHaveBeenCalled();

    await expect(
      controller.recordWhatsappConnection(
        "connection-a",
        {},
        undefined,
        undefined,
        "invalid-token",
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(receiver).not.toHaveBeenCalled();
  });

  it("rejects an inactive connection before any ingestion", async () => {
    const inactive = controllerFor({
      id: "connection-b",
      workspaceId: "workspace-a",
      provider: "uazapi_byo",
      providerInstanceId: "provider-a",
      webhookTokenHash: hash("valid-token"),
      status: "suspended",
    }).controller;
    await expect(
      inactive.recordWhatsappConnection(
        "connection-b",
        {},
        "valid-token",
        undefined,
        undefined,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a malformed stored hash without attempting an unsafe comparison", async () => {
    const { controller } = controllerFor({
      id: "connection-malformed-hash",
      workspaceId: "workspace-a",
      provider: "uazapi_byo",
      providerInstanceId: "provider-a",
      webhookTokenHash: "not-a-sha256-hash",
      status: "active",
    });

    await expect(
      controller.recordWhatsappConnection(
        "connection-malformed-hash",
        {},
        "valid-token",
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("accepts header, Bearer, and query tokens and binds ingestion to the stored workspace and connection", async () => {
    const { controller } = controllerFor({
      id: "connection-a",
      workspaceId: "workspace-a",
      provider: "uazapi_byo",
      providerInstanceId: "provider-a",
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });
    const receiver = vi
      .spyOn(controller as never, "recordUazapiWebhook" as never)
      .mockResolvedValue({ accepted: true } as never);

    await expect(
      controller.recordWhatsappConnection(
        "connection-a",
        {},
        undefined,
        "Bearer valid-token",
        undefined,
      ),
    ).resolves.toEqual({ accepted: true });
    await expect(
      controller.recordWhatsappConnection(
        "connection-a",
        {},
        "valid-token",
        undefined,
        undefined,
      ),
    ).resolves.toEqual({ accepted: true });
    await expect(
      controller.recordWhatsappConnection(
        "connection-a",
        {},
        undefined,
        undefined,
        "valid-token",
      ),
    ).resolves.toEqual({ accepted: true });
    expect(receiver).toHaveBeenLastCalledWith(
      {},
      expect.objectContaining({
        workspaceId: "workspace-a",
        whatsappInstanceId: "connection-a",
        providerInstanceId: "provider-a",
      }),
    );
  });

  it("uses dedicated header and Bearer tokens before the query token", async () => {
    const { controller } = controllerFor({
      id: "connection-a",
      workspaceId: "workspace-a",
      provider: "uazapi_byo",
      providerInstanceId: "provider-a",
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });

    await expect(
      controller.recordWhatsappConnection(
        "connection-a",
        {},
        "invalid-token",
        "Bearer valid-token",
        "valid-token",
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      controller.recordWhatsappConnection(
        "connection-a",
        {},
        undefined,
        "Bearer invalid-token",
        "valid-token",
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a payload that claims another workspace or connection", async () => {
    const { controller } = controllerFor({
      id: "connection-a",
      workspaceId: "workspace-a",
      provider: "uazapi_byo",
      providerInstanceId: "provider-a",
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });

    await expect(
      controller.recordWhatsappConnection(
        "connection-a",
        { workspaceId: "workspace-b" },
        "valid-token",
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      controller.recordWhatsappConnection(
        "connection-a",
        { whatsappInstanceId: "connection-b" },
        "valid-token",
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("does not acknowledge a provider without a wired receiver", async () => {
    const { controller } = controllerFor({
      id: "connection-unknown",
      workspaceId: "workspace-a",
      // Fail-closed contract: any provider besides uazapi_byo/waha/zapi
      // must keep returning 501, including provider values that don't
      // exist in the WhatsApp connection catalog at all.
      provider: "does_not_exist",
      providerInstanceId: null,
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });

    await expect(
      controller.recordWhatsappConnection(
        "connection-unknown",
        { event: "message" },
        "valid-token",
      ),
    ).rejects.toMatchObject({ status: 501 });
  });

  it("does not forward NOD API without a documented compatible parser", async () => {
    const { controller } = controllerFor({
      id: "connection-nod",
      workspaceId: "workspace-a",
      provider: "nod_api",
      providerInstanceId: "provider-a",
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });
    const receiver = vi.spyOn(
      controller as never,
      "recordUazapiWebhook" as never,
    );

    await expect(
      controller.recordWhatsappConnection("connection-nod", {}, "valid-token"),
    ).rejects.toMatchObject({ status: 501 });
    expect(receiver).not.toHaveBeenCalled();
  });

  it("rejects a WAHA delivery whose payload.session is missing or diverges from the persisted session, before parsing/logging", async () => {
    const { controller, services } = controllerFor({
      id: "connection-waha",
      workspaceId: "workspace-a",
      provider: "waha",
      providerInstanceId: "session-1",
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });

    // `session` lives at the top level of the WAHA envelope, alongside
    // `payload` (unlike `ctwa`, which nests inside `payload`), so it is
    // overridden by spreading over the whole message rather than through
    // wahaMessagePayload's `payload`-scoped overrides.
    const { session: _missingSession, ...missingSession } = wahaMessagePayload({
      ctwa: ctwaFixture,
    });

    await expect(
      controller.recordWhatsappConnection(
        "connection-waha",
        missingSession,
        "valid-token",
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      controller.recordWhatsappConnection(
        "connection-waha",
        {
          ...wahaMessagePayload({ ctwa: ctwaFixture }),
          session: "other-session",
        },
        "valid-token",
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(services.diagnosticsService.recordWebhookLog).not.toHaveBeenCalled();
    expect(
      services.leadsService.upsertFromWhatsappWebhook,
    ).not.toHaveBeenCalled();
  });

  it("rejects a Z-API delivery whose body.instanceId is missing or diverges from the persisted providerInstanceId, before parsing/logging", async () => {
    const { controller, services } = controllerFor({
      id: "connection-zapi",
      workspaceId: "workspace-a",
      provider: "zapi",
      providerInstanceId: "instance-1",
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });

    await expect(
      controller.recordWhatsappConnection(
        "connection-zapi",
        zapiMessagePayload({ ctwa: ctwaFixture, instanceId: undefined }),
        "valid-token",
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      controller.recordWhatsappConnection(
        "connection-zapi",
        zapiMessagePayload({ ctwa: ctwaFixture, instanceId: "other-instance" }),
        "valid-token",
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(services.diagnosticsService.recordWebhookLog).not.toHaveBeenCalled();
    expect(
      services.leadsService.upsertFromWhatsappWebhook,
    ).not.toHaveBeenCalled();
  });

  it("fails closed on a WAHA/Z-API connection whose providerInstanceId has not been persisted yet, even with a plausible payload", async () => {
    const waha = controllerFor({
      id: "connection-waha",
      workspaceId: "workspace-a",
      provider: "waha",
      providerInstanceId: null,
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });

    await expect(
      waha.controller.recordWhatsappConnection(
        "connection-waha",
        wahaMessagePayload({ ctwa: ctwaFixture }),
        "valid-token",
      ),
    ).rejects.toMatchObject({ status: 401 });

    const zapi = controllerFor({
      id: "connection-zapi",
      workspaceId: "workspace-a",
      provider: "zapi",
      providerInstanceId: null,
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });

    await expect(
      zapi.controller.recordWhatsappConnection(
        "connection-zapi",
        zapiMessagePayload({ ctwa: ctwaFixture }),
        "valid-token",
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("accepts a WAHA paid CTWA message, logs WebhookLog, and creates a lead", async () => {
    const { controller, services } = controllerFor({
      id: "connection-waha",
      workspaceId: "workspace-a",
      provider: "waha",
      providerInstanceId: "session-1",
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });

    await expect(
      controller.recordWhatsappConnection(
        "connection-waha",
        wahaMessagePayload({ ctwa: ctwaFixture }),
        "valid-token",
      ),
    ).resolves.toMatchObject({ webhookLogId: "webhook-log-1" });

    expect(services.diagnosticsService.recordWebhookLog).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-a",
        whatsappInstanceId: "connection-waha",
        source: "waha",
        eventType: "message",
      }),
    );
    expect(
      services.leadsService.upsertFromWhatsappWebhook,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-a",
        whatsappInstanceId: "connection-waha",
        phone: "5511999999999",
        source: "waha",
        ctwaClid: "clid-123",
      }),
    );
  });

  it("accepts a Z-API paid CTWA message, logs WebhookLog, and creates a lead", async () => {
    const { controller, services } = controllerFor({
      id: "connection-zapi",
      workspaceId: "workspace-a",
      provider: "zapi",
      providerInstanceId: "instance-1",
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });

    await expect(
      controller.recordWhatsappConnection(
        "connection-zapi",
        zapiMessagePayload({ ctwa: ctwaFixture }),
        "valid-token",
      ),
    ).resolves.toMatchObject({ webhookLogId: "webhook-log-1" });

    expect(services.diagnosticsService.recordWebhookLog).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-a",
        whatsappInstanceId: "connection-zapi",
        source: "zapi",
      }),
    );
    expect(
      services.leadsService.upsertFromWhatsappWebhook,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-a",
        whatsappInstanceId: "connection-zapi",
        phone: "5511999999999",
        source: "zapi",
        ctwaClid: "clid-123",
      }),
    );
  });

  it("does not create a lead for an organic message without CTWA (WAHA/Z-API)", async () => {
    const waha = controllerFor({
      id: "connection-waha",
      workspaceId: "workspace-a",
      provider: "waha",
      providerInstanceId: "session-1",
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });

    await waha.controller.recordWhatsappConnection(
      "connection-waha",
      wahaMessagePayload(),
      "valid-token",
    );
    expect(
      waha.services.leadsService.upsertFromWhatsappWebhook,
    ).not.toHaveBeenCalled();

    const zapi = controllerFor({
      id: "connection-zapi",
      workspaceId: "workspace-a",
      provider: "zapi",
      providerInstanceId: "instance-1",
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });

    await zapi.controller.recordWhatsappConnection(
      "connection-zapi",
      zapiMessagePayload(),
      "valid-token",
    );
    expect(
      zapi.services.leadsService.upsertFromWhatsappWebhook,
    ).not.toHaveBeenCalled();
  });

  it("does not create a lead for a fromMe message even with CTWA (WAHA/Z-API)", async () => {
    const waha = controllerFor({
      id: "connection-waha",
      workspaceId: "workspace-a",
      provider: "waha",
      providerInstanceId: "session-1",
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });

    await waha.controller.recordWhatsappConnection(
      "connection-waha",
      wahaMessagePayload({ fromMe: true, ctwa: ctwaFixture }),
      "valid-token",
    );
    expect(
      waha.services.leadsService.upsertFromWhatsappWebhook,
    ).not.toHaveBeenCalled();

    const zapi = controllerFor({
      id: "connection-zapi",
      workspaceId: "workspace-a",
      provider: "zapi",
      providerInstanceId: "instance-1",
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });

    await zapi.controller.recordWhatsappConnection(
      "connection-zapi",
      zapiMessagePayload({ fromMe: true, ctwa: ctwaFixture }),
      "valid-token",
    );
    expect(
      zapi.services.leadsService.upsertFromWhatsappWebhook,
    ).not.toHaveBeenCalled();
  });

  it("skips WebhookLog and lead work on a duplicate delivery (dedupe/replay)", async () => {
    const services = defaultServices();
    services.diagnosticsService.recordWebhookLog = vi.fn(async () => ({
      webhookLogId: "webhook-log-existing",
      diagnosticEventId: "diagnostic-event-existing",
      status: "duplicate",
    }));
    const { controller } = controllerFor(
      {
        id: "connection-waha",
        workspaceId: "workspace-a",
        provider: "waha",
        providerInstanceId: "session-1",
        webhookTokenHash: hash("valid-token"),
        status: "active",
      },
      services,
    );

    await expect(
      controller.recordWhatsappConnection(
        "connection-waha",
        wahaMessagePayload({ ctwa: ctwaFixture }),
        "valid-token",
      ),
    ).resolves.toMatchObject({
      status: "duplicate",
      conversion: { created: [], duplicates: [], queued: [] },
    });
    expect(
      services.leadsService.upsertFromWhatsappWebhook,
    ).not.toHaveBeenCalled();
    expect(
      services.conversionRulesService.evaluateTriggers,
    ).not.toHaveBeenCalled();
  });

  it("skips WebhookLog and lead work on an idempotency payload conflict (WAHA/Z-API quarantine)", async () => {
    const services = defaultServices();
    services.diagnosticsService.recordWebhookLog = vi.fn(async () => ({
      webhookLogId: "webhook-log-quarantine",
      diagnosticEventId: "diagnostic-event-quarantine",
      status: "conflict",
    }));
    const { controller } = controllerFor(
      {
        id: "connection-waha",
        workspaceId: "workspace-a",
        provider: "waha",
        providerInstanceId: "session-1",
        webhookTokenHash: hash("valid-token"),
        status: "active",
      },
      services,
    );

    await expect(
      controller.recordWhatsappConnection(
        "connection-waha",
        wahaMessagePayload({ ctwa: ctwaFixture }),
        "valid-token",
      ),
    ).resolves.toMatchObject({
      status: "conflict",
      conversion: { created: [], duplicates: [], queued: [] },
    });
    expect(
      services.leadsService.upsertFromWhatsappWebhook,
    ).not.toHaveBeenCalled();
    expect(
      services.conversionRulesService.evaluateTriggers,
    ).not.toHaveBeenCalled();
  });

  it("computes and sends a canonical SHA-256 payload hash for WAHA/Z-API deliveries", async () => {
    const waha = controllerFor({
      id: "connection-waha",
      workspaceId: "workspace-a",
      provider: "waha",
      providerInstanceId: "session-1",
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });

    await waha.controller.recordWhatsappConnection(
      "connection-waha",
      wahaMessagePayload({ ctwa: ctwaFixture }),
      "valid-token",
    );

    expect(
      waha.services.diagnosticsService.recordWebhookLog,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    );

    const zapi = controllerFor({
      id: "connection-zapi",
      workspaceId: "workspace-a",
      provider: "zapi",
      providerInstanceId: "instance-1",
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });

    await zapi.controller.recordWhatsappConnection(
      "connection-zapi",
      zapiMessagePayload({ ctwa: ctwaFixture }),
      "valid-token",
    );

    expect(
      zapi.services.diagnosticsService.recordWebhookLog,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    );
  });

  it("does not send a payloadHash for Uazapi webhooks (regression: only WAHA/Z-API compute it)", async () => {
    const { controller, services } = controllerFor({
      id: "connection-a",
      workspaceId: "workspace-a",
      provider: "uazapi_byo",
      providerInstanceId: "provider-a",
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });

    await controller.recordWhatsappConnection(
      "connection-a",
      { type: "message", instance: "provider-a" },
      "valid-token",
    );

    const call = services.diagnosticsService.recordWebhookLog.mock.calls.at(-1);
    expect(call?.[0]).not.toHaveProperty("payloadHash");
  });
});
