import "reflect-metadata";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { hashPhoneIdentity } from "../../src/common/phone/phone-identity";
import { WebhooksController } from "../../src/webhooks/webhooks.controller";
import {
  FIXTURE_SESSION,
  wahaGowsFixture,
  type WahaGowsFixtureName,
} from "./helpers/fixtures";

const TOKEN = "waha-webhook-token-sintetico";
const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

type ReleaseStatus = "certified" | "observation_only" | "retired" | null;

function harness(
  options: {
    release?: ReleaseStatus;
    providerInstanceId?: string;
    lidPhone?: string | null;
    lastHealthCheckedAt?: Date | null;
  } = {},
) {
  const release = options.release === undefined ? "certified" : options.release;
  const instance = {
    id: "connection-waha",
    workspaceId: "workspace-a",
    provider: "waha",
    providerInstanceId: options.providerInstanceId ?? FIXTURE_SESSION,
    webhookTokenHash: hash(TOKEN),
    status: "active" as const,
    lastHealthStatus: null as string | null,
    lastHealthCheckedAt: options.lastHealthCheckedAt ?? (null as Date | null),
  };
  const leadsByPhoneHash = new Map<string, { id: string }>();
  const services = {
    diagnosticsService: {
      recordWebhookLog: vi.fn(async (_input: Record<string, any>) => ({
        webhookLogId: "webhook-log-1",
        diagnosticEventId: "diagnostic-event-1",
        status: "received",
      })),
      markWebhookLogProcessed: vi.fn(async () => true),
      markWebhookLogFailed: vi.fn(async () => true),
    },
    conversionRulesService: { evaluateTriggers: vi.fn(async () => []) },
    conversionEventsService: {
      recordAutomaticLeadSubmitted: vi.fn(async () => ({
        created: ["log-lead-submitted"],
        duplicates: [],
      })),
      recordRuleMatches: vi.fn(async () => ({ created: [], duplicates: [] })),
      listReadyLogIds: vi.fn(async (ids: string[]) => ids),
    },
    conversionEventsQueueService: {
      enqueueSend: vi.fn(async () => ({ queued: true })),
    },
    leadsService: {
      // Same identity rule as LeadsService: one lead per workspace+phoneHash.
      upsertFromWhatsappWebhook: vi.fn(
        async (input: { workspaceId: string; phoneHash?: string }) => {
          const key = `${input.workspaceId}:${input.phoneHash}`;
          const existing = leadsByPhoneHash.get(key);
          if (existing) return existing;
          const created = { id: `lead-${leadsByPhoneHash.size + 1}` };
          leadsByPhoneHash.set(key, created);
          return created;
        },
      ),
    },
  };
  const prisma = {
    whatsappInstance: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === instance.id ? instance : null,
      ),
      // Emulates the conditional UPDATE (lastHealthCheckedAt null or older).
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { OR?: Array<{ lastHealthCheckedAt: null | { lt: Date } }> };
          data: { lastHealthStatus: string; lastHealthCheckedAt: Date };
        }) => {
          const current = instance.lastHealthCheckedAt;
          const allowed = (where.OR ?? []).some((condition) =>
            condition.lastHealthCheckedAt === null
              ? current === null
              : current !== null && current < condition.lastHealthCheckedAt.lt,
          );
          if (!allowed) return { count: 0 };
          instance.lastHealthStatus = data.lastHealthStatus;
          instance.lastHealthCheckedAt = data.lastHealthCheckedAt;
          return { count: 1 };
        },
      ),
    },
    metaAd: {
      findFirst: vi.fn(async () => ({
        campaignId: "campaign-sintetica",
        adSetId: "adset-sintetico",
      })),
    },
    inboundWebhookParserRelease: {
      findUnique: vi.fn(async () =>
        release
          ? { provider: "waha", version: "v2", status: release }
          : null,
      ),
    },
  };
  const lidResolver = {
    resolvePhone: vi.fn(async () => options.lidPhone ?? null),
  };
  // Regras de frase da equipe (mesmo serviço da Uazapi, provedor "waha").
  const teamConversion = {
    evaluateTeamMessage: vi.fn(async (_input: Record<string, any>) => ({
      evaluated: true,
      eligibleExecutionId: "execution-team-1" as string | null,
    })),
  };
  const controller = new WebhooksController(
    services.diagnosticsService as never,
    services.conversionRulesService as never,
    services.conversionEventsService as never,
    services.conversionEventsQueueService as never,
    services.leadsService as never,
    teamConversion as never,
    prisma as never,
    lidResolver as never,
  );

  const deliver = (body: Record<string, unknown>) =>
    controller.recordWhatsappConnection(instance.id, body, TOKEN);
  const deliverFixture = (name: WahaGowsFixtureName) =>
    deliver(wahaGowsFixture(name));

  return {
    controller,
    services,
    prisma,
    deliver,
    deliverFixture,
    leadsByPhoneHash,
    instance,
    lidResolver,
    teamConversion,
  };
}

function lastLog(services: ReturnType<typeof harness>["services"]) {
  return services.diagnosticsService.recordWebhookLog.mock.calls.at(-1)?.[0] as
    | Record<string, any>
    | undefined;
}

describe("POST /webhooks/whatsapp/:id — WAHA GoWS com a release waha/v2 certificada", () => {
  it("uses the certified waha/v2 release and turns a CTWA click into a lead + LeadSubmitted to Meta", async () => {
    const { services, prisma, deliverFixture } = harness();

    const result = await deliverFixture("message-ctwa-clid");

    expect(prisma.inboundWebhookParserRelease.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider_version: { provider: "waha", version: "v2" } },
      }),
    );
    expect(services.leadsService.upsertFromWhatsappWebhook).toHaveBeenCalledTimes(1);
    const leadInput = services.leadsService.upsertFromWhatsappWebhook.mock
      .calls[0]![0] as Record<string, unknown>;
    expect(leadInput).toMatchObject({
      workspaceId: "workspace-a",
      whatsappInstanceId: "connection-waha",
      phone: "5500900000101",
      phoneHash: hashPhoneIdentity("5500900000101"),
      name: "Contato Sintético 01",
      preserveExistingName: true,
      source: "waha",
      adId: "120200000000000001",
      campaignId: "campaign-sintetica",
      adSetId: "adset-sintetico",
      ctwaSourceUrl: "https://fb.me/0Synth1",
    });
    expect(leadInput.ctwaClid).toMatch(/^Af/u);
    expect(
      services.conversionEventsService.recordAutomaticLeadSubmitted,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        leadId: "lead-1",
        ctwaClid: leadInput.ctwaClid,
        adId: "120200000000000001",
      }),
    );
    expect(services.conversionEventsQueueService.enqueueSend).toHaveBeenCalledWith(
      "log-lead-submitted",
      "workspace-a",
    );
    expect(services.diagnosticsService.markWebhookLogProcessed).toHaveBeenCalledWith(
      "webhook-log-1",
    );
    expect(result).toMatchObject({ status: "received" });
  });

  it.each([
    "message-ctwa-image-first",
    "message-ctwa-ephemeral",
    "message-ctwa-view-once",
  ] as const)("creates the ad lead when the first message is %s", async (name) => {
    const { services, deliverFixture } = harness();

    await deliverFixture(name);

    expect(services.leadsService.upsertFromWhatsappWebhook).toHaveBeenCalledTimes(1);
    expect(
      services.conversionEventsService.recordAutomaticLeadSubmitted,
    ).toHaveBeenCalledTimes(1);
  });

  it("Status ad with only sourceID (no clid): ad lead attributed by the ad id, nothing sent to Meta (like the Rastrackapp)", async () => {
    const { services, deliverFixture } = harness();

    await deliverFixture("message-ctwa-source-id-only");

    expect(lastLog(services)).toMatchObject({
      source: "waha",
      eventType: "message",
      adId: "120200000000000002",
      phoneHash: hashPhoneIdentity("5500900000102"),
    });
    expect(services.leadsService.upsertFromWhatsappWebhook).toHaveBeenCalledTimes(1);
    const leadInput = services.leadsService.upsertFromWhatsappWebhook.mock
      .calls[0]![0] as Record<string, unknown>;
    expect(leadInput).toMatchObject({
      workspaceId: "workspace-a",
      whatsappInstanceId: "connection-waha",
      phone: "5500900000102",
      phoneHash: hashPhoneIdentity("5500900000102"),
      source: "waha",
      adId: "120200000000000002",
      campaignId: "campaign-sintetica",
      adSetId: "adset-sintetico",
      ctwaSourceUrl: "https://wa.me/wamo/0Synth2",
      name: "Contato Sintético 02",
      preserveExistingName: true,
    });
    // No clid is ever invented (the ctwaPayload is never a clid).
    expect(leadInput.ctwaClid).toBeUndefined();
    expect(JSON.stringify(leadInput)).not.toContain("c3ludGhldGljLWN0d2Et");
    // Nothing goes to Meta: no LeadSubmitted, no rule evaluation, no queue.
    expect(
      services.conversionEventsService.recordAutomaticLeadSubmitted,
    ).not.toHaveBeenCalled();
    expect(services.conversionRulesService.evaluateTriggers).not.toHaveBeenCalled();
    expect(services.conversionEventsService.recordRuleMatches).not.toHaveBeenCalled();
    expect(services.conversionEventsQueueService.enqueueSend).not.toHaveBeenCalled();
    expect(services.diagnosticsService.markWebhookLogProcessed).toHaveBeenCalled();
  });

  it("keeps the v1 behavior for sourceID-only when the waha/v2 release is not certified", async () => {
    const { services, deliverFixture } = harness({ release: null });

    await deliverFixture("message-ctwa-source-id-only");

    expect(services.leadsService.upsertFromWhatsappWebhook).not.toHaveBeenCalled();
  });

  it("does not duplicate the lead when a sourceID-only click is followed by a clid click", async () => {
    const { services, deliver, leadsByPhoneHash } = harness();
    const sourceOnly = wahaGowsFixture("message-ctwa-source-id-only");
    const withClid = wahaGowsFixture("message-ctwa-clid");
    withClid.payload.id = "false_100000000000102@lid_3EB0000000000000000098";
    withClid.payload.from = "100000000000102@lid";
    withClid.payload._data.Info.ID = "3EB0000000000000000098";
    withClid.payload._data.Info.Chat = "100000000000102@lid";
    withClid.payload._data.Info.Sender = "100000000000102@lid";
    withClid.payload._data.Info.SenderAlt = "5500900000102@s.whatsapp.net";

    await deliver(sourceOnly);
    await deliver(withClid);

    expect(services.leadsService.upsertFromWhatsappWebhook).toHaveBeenCalledTimes(2);
    expect(leadsByPhoneHash.size).toBe(1);
    expect(
      services.conversionEventsService.recordAutomaticLeadSubmitted,
    ).toHaveBeenCalledTimes(1);
  });

  it.each([
    "message-organic",
    "message-any-team-recipient-alt",
    "message-any-team-no-recipient-alt",
    "message-any-inbound-duplicate",
    "message-jid-device-suffix",
    "message-group",
    "message-status-broadcast",
    "message-lid-without-sender-alt",
  ] as const)("logs %s and never creates a lead or a Meta event", async (name) => {
    const { services, deliverFixture } = harness();

    await deliverFixture(name);

    expect(services.diagnosticsService.recordWebhookLog).toHaveBeenCalledTimes(1);
    expect(services.leadsService.upsertFromWhatsappWebhook).not.toHaveBeenCalled();
    expect(services.conversionRulesService.evaluateTriggers).not.toHaveBeenCalled();
    expect(
      services.conversionEventsService.recordAutomaticLeadSubmitted,
    ).not.toHaveBeenCalled();
    expect(services.diagnosticsService.markWebhookLogProcessed).toHaveBeenCalled();
  });

  it("keys idempotency by event, so the message.any copy never collides with the message delivery", async () => {
    const { services, deliverFixture } = harness();

    await deliverFixture("message-ctwa-clid");
    await deliverFixture("message-any-inbound-duplicate");

    const keys = services.diagnosticsService.recordWebhookLog.mock.calls.map(
      (call) => (call[0] as { idempotencyKey?: string }).idempotencyKey,
    );
    expect(keys).toEqual([
      "waha:workspace-a:connection-waha:message:false_100000000000101@lid_3EB0000000000000000001",
      "waha:workspace-a:connection-waha:message.any:false_100000000000101@lid_3EB0000000000000000001",
    ]);
    expect(services.leadsService.upsertFromWhatsappWebhook).toHaveBeenCalledTimes(1);
  });

  it("stores only a structural summary: no text, name, LID, phone, clid or thumbnail", async () => {
    const { services, deliverFixture } = harness();

    await deliverFixture("message-ctwa-clid");

    const log = lastLog(services)!;
    expect(log.summaryPayload).toEqual({
      parser: { provider: "waha", version: "v2" },
      engine: "GOWS",
      event: "message",
      classification: "eligible_route_unresolved",
      classificationReason: "route_resolution_pending",
      messageDirection: "inbound",
      messageType: "text",
      hasCtwa: true,
      adId: "120200000000000001",
      contactHasLid: true,
    });
    expect(typeof log.payloadHash).toBe("string");
    const serialized = JSON.stringify(log.summaryPayload);
    for (const forbidden of [
      "5500900000101",
      "100000000000101",
      "Contato Sintético",
      "mensagem sintética",
      "/9j/",
      "Af",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("does not duplicate the lead when the same contact writes by LID and later by phone JID", async () => {
    const { services, deliver, leadsByPhoneHash } = harness();
    const byLid = wahaGowsFixture("message-ctwa-clid");
    const byPhone = wahaGowsFixture("message-ctwa-clid");
    byPhone.payload.id = "false_5500900000101@c.us_3EB0000000000000000099";
    byPhone.payload.from = "5500900000101@c.us";
    byPhone.payload._data.Info.ID = "3EB0000000000000000099";
    byPhone.payload._data.Info.Chat = "5500900000101@s.whatsapp.net";
    byPhone.payload._data.Info.Sender = "5500900000101@s.whatsapp.net";
    byPhone.payload._data.Info.SenderAlt = "100000000000101@lid";

    await deliver(byLid);
    await deliver(byPhone);

    const phoneHashes = services.leadsService.upsertFromWhatsappWebhook.mock.calls.map(
      (call) => (call[0] as { phoneHash: string }).phoneHash,
    );
    expect(phoneHashes).toEqual([
      hashPhoneIdentity("5500900000101"),
      hashPhoneIdentity("5500900000101"),
    ]);
    expect(leadsByPhoneHash.size).toBe(1);
  });

  it.each([
    ["working", "connected"],
    ["scan-qr-code", "needs_reconnect"],
    ["failed", "error"],
    ["stopped", "disconnected"],
  ] as const)(
    "mirrors session.status %s on the connection health (%s)",
    async (status, expected) => {
      const { prisma, services, deliverFixture } = harness();

      await deliverFixture(`session-status-${status}`);

      const envelopeTime = new Date(wahaGowsFixture(`session-status-${status}`).timestamp);
      expect(prisma.whatsappInstance.updateMany).toHaveBeenCalledWith({
        where: {
          id: "connection-waha",
          workspaceId: "workspace-a",
          OR: [
            { lastHealthCheckedAt: null },
            { lastHealthCheckedAt: { lt: envelopeTime } },
          ],
        },
        data: { lastHealthStatus: expected, lastHealthCheckedAt: envelopeTime },
      });
      expect(lastLog(services)).toMatchObject({
        eventType: "session.status",
        idempotencyKey: undefined,
        summaryPayload: expect.objectContaining({
          sessionStatus: status.toUpperCase().replace(/-/gu, "_"),
        }),
      });
      expect(services.leadsService.upsertFromWhatsappWebhook).not.toHaveBeenCalled();
    },
  );

  it("ignores a STARTING that arrives after a newer WORKING (out-of-order retry)", async () => {
    const { deliver, instance } = harness();
    const working = wahaGowsFixture("session-status-working");
    const starting = wahaGowsFixture("session-status-working");
    starting.payload.status = "STARTING";
    starting.timestamp = working.timestamp - 10_000;

    await deliver(working);
    await deliver(starting);

    expect(instance.lastHealthStatus).toBe("connected");
    expect(instance.lastHealthCheckedAt).toEqual(new Date(working.timestamp));

    // A newer STARTING does replace it.
    starting.timestamp = working.timestamp + 10_000;
    await deliver(starting);
    expect(instance.lastHealthStatus).toBe("needs_reconnect");
  });

  it("never lets an old session.status overwrite a newer Testar result", async () => {
    const fixture = wahaGowsFixture("session-status-failed");
    const { deliver, instance } = harness({
      lastHealthCheckedAt: new Date(fixture.timestamp + 60_000),
    });

    await deliver(fixture);

    expect(instance.lastHealthStatus).toBeNull();
  });

  it("LID-only ad click: logs hasCtwa/adId with its own reason and no lead when the WAHA cannot resolve it", async () => {
    const { services, deliverFixture, lidResolver } = harness({ lidPhone: null });

    await deliverFixture("message-lid-without-sender-alt");

    expect(lidResolver.resolvePhone).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      whatsappInstanceId: "connection-waha",
      lid: "100000000000113",
    });
    expect(lastLog(services)).toMatchObject({
      adId: "1202000000000000013",
      phoneHash: undefined,
      summaryPayload: {
        classificationReason: "ctwa_contact_phone_unresolved",
        hasCtwa: true,
        adId: "1202000000000000013",
      },
    });
    expect(services.leadsService.upsertFromWhatsappWebhook).not.toHaveBeenCalled();
    expect(services.diagnosticsService.markWebhookLogProcessed).toHaveBeenCalled();
  });

  it("LID-only ad click: creates the ad lead with the phone resolved by GET /lids/{lid}", async () => {
    const { services, deliverFixture } = harness({ lidPhone: "5500900000113" });

    await deliverFixture("message-lid-without-sender-alt");

    expect(services.leadsService.upsertFromWhatsappWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: "5500900000113",
        phoneHash: hashPhoneIdentity("5500900000113"),
        adId: "1202000000000000013",
      }),
    );
    expect(lastLog(services)?.summaryPayload).toMatchObject({
      classification: "eligible_route_unresolved",
      contactPhoneFromLidLookup: true,
    });
  });

  it("does not look up LIDs for organic LID-only messages", async () => {
    const { deliver, lidResolver } = harness({ lidPhone: "5500900000113" });
    const fixture = wahaGowsFixture("message-lid-without-sender-alt");
    fixture.payload._data.Message = { conversation: "Oi (mensagem sintética)" };

    await deliver(fixture);

    expect(lidResolver.resolvePhone).not.toHaveBeenCalled();
  });

  it("still rejects a delivery for another session before parsing (binding stays on the session)", async () => {
    const { services, deliverFixture } = harness({
      providerInstanceId: "outra-sessao",
    });

    await expect(deliverFixture("message-ctwa-clid")).rejects.toMatchObject({
      status: 401,
    });
    expect(services.diagnosticsService.recordWebhookLog).not.toHaveBeenCalled();
  });

  it.each([null, "observation_only", "retired"] as const)(
    "keeps the v1 parser when the waha/v2 release is %s",
    async (release) => {
      const { services, prisma, deliverFixture } = harness({ release });

      await deliverFixture("message-ctwa-clid");
      await deliverFixture("session-status-working");

      // v1 does not read the GoWS ad context: no lead, the full body is
      // logged as before and session.status changes nothing.
      expect(services.leadsService.upsertFromWhatsappWebhook).not.toHaveBeenCalled();
      expect(prisma.whatsappInstance.updateMany).not.toHaveBeenCalled();
      const first = services.diagnosticsService.recordWebhookLog.mock
        .calls[0]![0] as Record<string, any>;
      expect(first.summaryPayload.event).toBe("message");
      expect(first.summaryPayload.payload).toBeDefined();
    },
  );
});

describe("POST /webhooks/whatsapp/:id — regras de frase da equipe na WAHA (message.any fromMe)", () => {
  it("leva a mensagem do time ao pipeline das regras de frase, pelo RecipientAlt, sem criar lead", async () => {
    const { services, deliverFixture, teamConversion } = harness();

    const response = await deliverFixture("message-any-team-recipient-alt");

    expect(teamConversion.evaluateTeamMessage).toHaveBeenCalledTimes(1);
    const input = teamConversion.evaluateTeamMessage.mock.calls[0]![0];
    expect(input).toMatchObject({
      workspaceId: "workspace-a",
      provider: "waha",
      phone: "5500900000101",
      messageText: "Olá! Segue o link de pagamento (mensagem sintética).",
      externalMessageId: "true_100000000000101@lid_3EB0000000000000000004",
      instance: { id: "connection-waha", workspaceId: "workspace-a" },
    });
    // The store's own number travels with the instance (bridge phone).
    expect(input.instance.connectedPhone).toBe("5500900009999");
    expect(input.occurredAt).toBeInstanceOf(Date);
    expect((response as any).conversion.teamMessage).toEqual({
      evaluated: true,
      eligibleExecutionId: "execution-team-1",
    });
    expect(services.leadsService.upsertFromWhatsappWebhook).not.toHaveBeenCalled();
    expect(
      services.conversionEventsService.recordAutomaticLeadSubmitted,
    ).not.toHaveBeenCalled();
    expect(services.diagnosticsService.markWebhookLogProcessed).toHaveBeenCalled();
  });

  it("usa o telefone do `to`/Chat quando não há RecipientAlt", async () => {
    const { deliverFixture, teamConversion } = harness();

    await deliverFixture("message-any-team-no-recipient-alt");

    expect(teamConversion.evaluateTeamMessage).toHaveBeenCalledTimes(1);
    expect(teamConversion.evaluateTeamMessage.mock.calls[0]![0]).toMatchObject({
      provider: "waha",
      phone: "5500900000103",
      messageText: "Pedido confirmado (mensagem sintética).",
    });
  });

  it("contato só com LID: resolve o telefone na WAHA do aluno e segue para a regra", async () => {
    const { deliver, teamConversion, lidResolver } = harness({
      lidPhone: "5500900000101",
    });
    const body = wahaGowsFixture("message-any-team-recipient-alt");
    body.payload._data.Info.RecipientAlt = "";

    await deliver(body);

    expect(lidResolver.resolvePhone).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      whatsappInstanceId: "connection-waha",
      lid: "100000000000101",
    });
    expect(teamConversion.evaluateTeamMessage).toHaveBeenCalledTimes(1);
    expect(teamConversion.evaluateTeamMessage.mock.calls[0]![0]).toMatchObject({
      phone: "5500900000101",
    });
  });

  it("contato só com LID que a WAHA não resolve: registra e não roda regra", async () => {
    const { services, deliver, teamConversion, lidResolver } = harness({
      lidPhone: null,
    });
    const body = wahaGowsFixture("message-any-team-recipient-alt");
    body.payload._data.Info.RecipientAlt = "";

    await deliver(body);

    expect(lidResolver.resolvePhone).toHaveBeenCalledTimes(1);
    expect(teamConversion.evaluateTeamMessage).not.toHaveBeenCalled();
    expect(lastLog(services)?.summaryPayload).toMatchObject({
      classificationReason: "contact_phone_unresolved",
    });
    expect(services.diagnosticsService.markWebhookLogProcessed).toHaveBeenCalled();
  });

  it.each([
    "message-organic",
    "message-ctwa-clid",
    "message-any-inbound-duplicate",
  ] as const)(
    "mensagem recebida do contato (%s) nunca roda a regra de frase da equipe",
    async (name) => {
      const { deliverFixture, teamConversion } = harness();

      await deliverFixture(name);

      expect(teamConversion.evaluateTeamMessage).not.toHaveBeenCalled();
    },
  );

  it("a cópia `message` de uma mensagem do time é descartada: uma avaliação só", async () => {
    const { deliver, teamConversion } = harness();
    const any = wahaGowsFixture("message-any-team-recipient-alt");
    const copy = wahaGowsFixture("message-any-team-recipient-alt");
    copy.event = "message";

    await deliver(copy);
    await deliver(any);

    expect(teamConversion.evaluateTeamMessage).toHaveBeenCalledTimes(1);
  });

  it("reentrega do webhook (duplicada no WebhookLog) não avalia de novo", async () => {
    const { services, deliverFixture, teamConversion } = harness();
    services.diagnosticsService.recordWebhookLog
      .mockResolvedValueOnce({
        webhookLogId: "webhook-log-1",
        diagnosticEventId: "diagnostic-event-1",
        status: "received",
      })
      .mockResolvedValueOnce({
        webhookLogId: "webhook-log-1",
        diagnosticEventId: "diagnostic-event-1",
        status: "duplicate",
      });

    await deliverFixture("message-any-team-recipient-alt");
    await deliverFixture("message-any-team-recipient-alt");

    expect(teamConversion.evaluateTeamMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["mídia sem legenda", (body: Record<string, any>) => {
      body.payload.body = null;
      body.payload.hasMedia = true;
      body.payload._data.Message = { imageMessage: { mimetype: "image/jpeg" } };
    }],
    ["áudio", (body: Record<string, any>) => {
      body.payload.body = "";
      body.payload.hasMedia = true;
      body.payload._data.Message = { audioMessage: { seconds: 3 } };
    }],
    ["figurinha", (body: Record<string, any>) => {
      delete body.payload.body;
      body.payload._data.Message = { stickerMessage: {} };
    }],
  ])("mensagem do time sem texto (%s) não quebra nem roda regra", async (_label, mutate) => {
    const { services, deliver, teamConversion } = harness();
    const body = wahaGowsFixture("message-any-team-recipient-alt");
    mutate(body);

    await deliver(body);

    expect(teamConversion.evaluateTeamMessage).not.toHaveBeenCalled();
    expect(services.diagnosticsService.markWebhookLogProcessed).toHaveBeenCalled();
  });

  it("falha na regra marca a entrega como falha para a retentativa da WAHA", async () => {
    const { services, deliverFixture, teamConversion } = harness();
    teamConversion.evaluateTeamMessage.mockRejectedValueOnce(new Error("db down"));

    await expect(
      deliverFixture("message-any-team-recipient-alt"),
    ).rejects.toThrow("db down");
    expect(services.diagnosticsService.markWebhookLogFailed).toHaveBeenCalled();
    expect(services.diagnosticsService.markWebhookLogProcessed).not.toHaveBeenCalled();
  });

  it("com a release waha/v2 fora de produção (v1), a mensagem do time não roda regra", async () => {
    const { deliverFixture, teamConversion } = harness({ release: "retired" });

    await deliverFixture("message-any-team-recipient-alt");

    expect(teamConversion.evaluateTeamMessage).not.toHaveBeenCalled();
  });
});
