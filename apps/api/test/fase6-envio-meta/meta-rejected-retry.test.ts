import "reflect-metadata";
import type { ExecutionContext, INestApplication } from "@nestjs/common";
import {
  BadRequestException,
  ConflictException,
  HttpException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../../src/auth/auth.service";
import {
  canRetryFixableMetaRejectionConversionEvent,
  isFixableMetaRejectionResponse,
  isMetaAuthFailureConversionEvent,
  META_EVENT_TIME_WINDOW_MS,
  metaAuthFailureConversionEventWhere,
} from "../../src/conversion-events/conversion-event-retry";
import { ConversionEventsService } from "../../src/conversion-events/conversion-events.service";
import { DiagnosticsService } from "../../src/diagnostics/diagnostics.service";
import { MetaConnectionResolverService } from "../../src/integrations/meta/meta-connection-resolver.service";
import { MetaTokenEncryptionService } from "../../src/integrations/meta/meta-token-encryption.service";
import { LicenseSoftlockGuard } from "../../src/licensing-client/license-softlock.guard";
import type { LicenseClientService } from "../../src/licensing-client/license-client.service";
import { MetaInitialSyncPeriodService } from "../../src/reporting/meta-initial-sync-period";
import { MetaReportSyncQueueService } from "../../src/reporting/meta-report-sync-queue.service";
import { MetaReportingService } from "../../src/reporting/meta-reporting.service";
import { ReportingController } from "../../src/reporting/reporting.controller";
import { WorkspacesService } from "../../src/workspaces/workspaces.service";

const ctwaResolution = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../../src/inbound-webhooks/authorized-ctwa-destination", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveCtwaDestination: vi.fn(async () => ctwaResolution.current),
}));

/**
 * 1.3.1: "Reenviar recusados" em Eventos Meta. Recusas que o aluno corrige no
 * painel (100 com subcódigos, 10, 200-299, e recusas antigas sem código),
 * dentro dos 7 dias, com o MESMO event_id e rota/destino recalculados com a
 * configuração atual. Dados fictícios.
 */

const DAY = 24 * 60 * 60_000;
const now = Date.UTC(2026, 9, 27, 12);

function rejected(overrides: Record<string, unknown> = {}) {
  return {
    id: "rejected_1",
    workspaceId: "workspace_1",
    eventName: "LeadSubmitted",
    sourceTrigger: "inbound_webhook:waha:message_phrase",
    status: "error",
    errorCode: "MetaCapiRejected" as string | null,
    errorMessage: "Meta CAPI request failed",
    providerResponseSummary: {
      httpStatus: 400,
      error: { code: 100, error_subcode: 2804050 },
    } as unknown,
    eventOccurredAt: new Date(Date.now() - 2 * DAY),
    pixelId: "pixel-antigo" as string | null,
    pageId: "pagina-errada" as string | null,
    sentAt: null,
    jobId: "job_original",
    dedupeKey: "dedupe_1",
    eventId: "evento_meta_1",
    ...overrides,
  };
}

describe("lista de códigos do Reenviar recusados", () => {
  it.each([
    [{ httpStatus: 400, error: { code: 100 } }, true],
    [{ httpStatus: 400, error: { code: 100, error_subcode: 2804050 } }, true],
    [{ httpStatus: 400, error: { code: "100" } }, true],
    [{ httpStatus: 403, error: { code: 10 } }, true],
    [{ httpStatus: 403, error: { code: 200 } }, true],
    [{ httpStatus: 403, error: { code: 294 } }, true],
    [{ httpStatus: 403, error: { code: 299 } }, true],
    // Recusa antiga (1.2.0): só o status HTTP.
    [{ httpStatus: 400 }, true],
    // Fora: login (já no Reenviar bloqueados), limites de uso, 368 e outros.
    [{ httpStatus: 400, error: { code: 190 } }, false],
    [{ httpStatus: 400, error: { code: 102 } }, false],
    [{ httpStatus: 400, error: { code: 4 } }, false],
    [{ httpStatus: 400, error: { code: 17 } }, false],
    [{ httpStatus: 400, error: { code: 613 } }, false],
    [{ httpStatus: 400, error: { code: 80004 } }, false],
    [{ httpStatus: 400, error: { code: 368 } }, false],
    [{ httpStatus: 400, error: { code: 300 } }, false],
    [{ httpStatus: 400, error: { type: "OAuthException" } }, false],
    [null, false],
  ])("%j → %s", (summary, expected) => {
    expect(isFixableMetaRejectionResponse(summary)).toBe(expected);
  });

  it("só MetaCapiRejected com status error; nunca sent, Kommo, Pipedrive ou Meta Cloud", () => {
    const at = new Date(now - 2 * DAY);
    const event = (overrides: Record<string, unknown> = {}) =>
      rejected({ eventOccurredAt: at, ...overrides });
    expect(canRetryFixableMetaRejectionConversionEvent(event(), now)).toBe(true);
    expect(
      canRetryFixableMetaRejectionConversionEvent(event({ status: "sent" }), now),
    ).toBe(false);
    expect(
      canRetryFixableMetaRejectionConversionEvent(
        event({ errorCode: "MetaCapiNetworkError" }),
        now,
      ),
    ).toBe(false);
    for (const sourceTrigger of [
      "kommo_stage",
      "pipedrive_stage",
      "inbound_webhook:meta_cloud",
    ])
      expect(
        canRetryFixableMetaRejectionConversionEvent(event({ sourceTrigger }), now),
      ).toBe(false);
  });

  it("janela de 7 dias da Meta", () => {
    expect(
      canRetryFixableMetaRejectionConversionEvent(
        rejected({ eventOccurredAt: new Date(now - META_EVENT_TIME_WINDOW_MS + 60_000) }),
        now,
      ),
    ).toBe(true);
    expect(
      canRetryFixableMetaRejectionConversionEvent(
        rejected({ eventOccurredAt: new Date(now - META_EVENT_TIME_WINDOW_MS - 60_000) }),
        now,
      ),
    ).toBe(false);
  });
});

function diagnosticsHarness(events = [rejected()]) {
  const prisma = {
    conversionEventLog: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = events.find((item) => item.id === where.id);
        return row ? { ...row } : null;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const row = events.find((item) =>
            Object.entries(where).every(
              ([key, value]) => (item as Record<string, unknown>)[key] === value,
            ),
          );
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
      update: vi.fn(async () => ({})),
    },
    auditLog: { create: vi.fn(async () => ({ id: "audit" })) },
    jobAttempt: { create: vi.fn(async () => ({ id: "attempt" })) },
    diagnosticEvent: { create: vi.fn(async () => ({ id: "diagnostic" })) },
    inboundWebhookChannel: {
      findFirst: vi.fn(async () => ({ id: "canal_1", routes: [], connection: {} })),
    },
  };
  const queue = { retrySend: vi.fn(async () => ({ jobId: "retry_job" })) };
  const service = new DiagnosticsService(prisma as never, undefined, queue as never);
  return { prisma, queue, service, events: events as Array<Record<string, any>> };
}

const context = {
  workspaceId: "workspace_1",
  actorUserId: "admin_1",
  actorType: "workspace_admin",
};
const input = { reason: "Pixel ligado à página certa" };

describe("DiagnosticsService.retryRejectedConversionEvent", () => {
  it("mesmo event_id, limpa pixel e página da tentativa recusada e audita", async () => {
    const h = diagnosticsHarness();
    await expect(
      h.service.retryRejectedConversionEvent("rejected_1", input, context),
    ).resolves.toMatchObject({ ok: true, status: "queued" });
    expect(h.events[0]).toMatchObject({
      status: "ready_to_send",
      errorCode: null,
      errorMessage: null,
      eventId: "evento_meta_1",
      dedupeKey: "dedupe_1",
      pixelId: null,
      pageId: null,
    });
    expect(h.queue.retrySend).toHaveBeenCalledWith("rejected_1", "workspace_1");
    expect(h.prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "diagnostic.conversion_rejected_retry_requested",
          targetId: "rejected_1",
          actorUserId: "admin_1",
          beforeSummary: expect.objectContaining({
            status: "error",
            errorCode: "MetaCapiRejected",
            pixelId: "pixel-antigo",
          }),
        }),
      }),
    );
  });

  it("idempotente: o segundo clique não enfileira de novo", async () => {
    const h = diagnosticsHarness();
    await h.service.retryRejectedConversionEvent("rejected_1", input, context);
    await expect(
      h.service.retryRejectedConversionEvent("rejected_1", input, context),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.queue.retrySend).toHaveBeenCalledTimes(1);
  });

  it("envio concorrente: a troca de estado condicional responde 409", async () => {
    const h = diagnosticsHarness();
    // Outro reenvio trocou o estado entre a leitura e a troca.
    h.prisma.conversionEventLog.findUnique.mockImplementationOnce(async () => {
      const snapshot = { ...h.events[0]! } as ReturnType<typeof rejected>;
      h.events[0]!.status = "ready_to_send";
      return snapshot;
    });
    await expect(
      h.service.retryRejectedConversionEvent("rejected_1", input, context),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.queue.retrySend).not.toHaveBeenCalled();
  });

  it("recusa fora da lista, enviado ou com mais de 7 dias fica de fora", async () => {
    for (const overrides of [
      { providerResponseSummary: { httpStatus: 400, error: { code: 190 } } },
      { providerResponseSummary: { httpStatus: 400, error: { code: 368 } } },
      { status: "sent", errorCode: null },
      { sourceTrigger: "kommo_stage" },
      { eventOccurredAt: new Date(Date.now() - 8 * DAY) },
    ]) {
      const h = diagnosticsHarness([rejected(overrides)]);
      await expect(
        h.service.retryRejectedConversionEvent("rejected_1", input, context),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(h.queue.retrySend).not.toHaveBeenCalled();
    }
  });

  it("em lote: ids repetidos contam uma vez e os vencidos aparecem como expirados", async () => {
    const h = diagnosticsHarness([
      rejected(),
      rejected({ id: "rejected_old", eventOccurredAt: new Date(Date.now() - 9 * DAY) }),
    ]);
    await expect(
      h.service.retryRejectedConversionEvents(
        ["rejected_1", "rejected_1", "rejected_old"],
        input,
        context,
      ),
    ).resolves.toEqual({
      claimed: 1,
      enqueued: 1,
      skipped: 1,
      expired: 1,
      notReady: 0,
      alreadyConverted: 0,
      failed: 0,
    });
    expect(h.queue.retrySend).toHaveBeenCalledTimes(1);
  });
});

describe("destino CTWA (página + pixel do número) refeito no reenvio", () => {
  const intent = (pixelId: string, pageId: string) => ({
    kind: "authorized_ctwa_destination",
    workspaceId: "workspace_1",
    channelId: "canal_1",
    connectionId: "conexao_1",
    organizationId: "org_1",
    providerChannelId: "numero_1",
    destinationId: "destino_1",
    businessConnectionId: "bm_1",
    credentialId: "credencial_1",
    credentialFingerprint: "fp_1",
    deliveryKind: "page_pixel",
    pixelId,
    pageId,
  });

  it("grava o destino atual do número (o gravado é o que a Meta recusou)", async () => {
    ctwaResolution.current = intent("pixel-corrigido", "pagina-do-anuncio");
    const h = diagnosticsHarness([
      rejected({
        sourcePayload: {
          processingMode: "ctwa",
          ctwaDestination: intent("pixel-antigo", "pagina-errada"),
        },
      }),
    ]);
    await h.service.retryRejectedConversionEvent("rejected_1", input, context);
    expect(h.events[0]).toMatchObject({
      status: "ready_to_send",
      eventId: "evento_meta_1",
      sourcePayload: {
        processingMode: "ctwa",
        ctwaDestination: { pixelId: "pixel-corrigido", pageId: "pagina-do-anuncio" },
      },
    });
  });

  it("sem rota pronta no número, não reenvia e diz o motivo", async () => {
    ctwaResolution.current = { kind: "blocked_ctwa_destination", reason: "x" };
    const h = diagnosticsHarness([
      rejected({
        sourcePayload: { ctwaDestination: intent("pixel-antigo", "pagina-errada") },
      }),
    ]);
    await expect(
      h.service.retryRejectedConversionEvent("rejected_1", input, context),
    ).rejects.toThrow(/rota Meta do número/u);
    expect(h.events[0]!.status).toBe("error");
    expect(h.queue.retrySend).not.toHaveBeenCalled();
  });
});

describe("destino recalculado no envio (configuração atual)", () => {
  // O par Página/Pixel é a identidade do destino: corrigir o par cria ou
  // escolhe OUTRO destino. O reenvio não pode ficar preso ao destino da
  // tentativa recusada (metaConversionDestinationId).
  const encryption = new MetaTokenEncryptionService({
    META_TOKEN_ENCRYPTION_KEY: "test-only-encryption-key",
  });
  const destinations: Record<string, { pixelId: string; pageId: string }> = {
    "destination-a": { pixelId: "pixel-antigo", pageId: "pagina-errada" },
    "destination-b": { pixelId: "pixel-novo", pageId: "pagina-do-anuncio" },
  };

  function metaWorld(options: {
    defaultDestinationId: string;
    adAssignmentDestinationId?: string | null;
    allowedDestinationIds?: string[];
    channelRoutes?: Array<Record<string, unknown>>;
  }) {
    const credential = {
      id: "credential-a",
      workspaceId: "workspace_1",
      source: "manual",
      status: "active",
      ...encryption.encrypt("connection-token"),
    };
    const connection = {
      id: "connection-a",
      workspaceId: "workspace_1",
      status: "active",
      credentialId: credential.id,
      credential,
      defaultConversionDestinationId: options.defaultDestinationId,
    };
    const allowed = (options.allowedDestinationIds ?? []).map((id) => ({
      workspaceId: "workspace_1",
      reportingAccountId: "account-a",
      conversionDestinationId: id,
      active: true,
    }));
    const account = {
      id: "account-a",
      workspaceId: "workspace_1",
      active: true,
      adAccountId: "act-a",
      businessConnectionId: connection.id,
      conversionDestinationId: null,
      allowedDestinations: allowed,
    };
    return {
      metaIntegration: { findUnique: vi.fn(async () => null) },
      metaReportingAccount: {
        findFirst: vi.fn(async () => account),
        findMany: vi.fn(async () => [account]),
      },
      metaBusinessConnection: { findFirst: vi.fn(async () => connection) },
      metaAd: {
        findFirst: vi.fn(async () =>
          options.adAssignmentDestinationId === undefined
            ? null
            : {
                adAccountId: "act-a",
                destinationAssignment: options.adAssignmentDestinationId
                  ? {
                      reportingAccountId: "account-a",
                      conversionDestinationId: options.adAssignmentDestinationId,
                    }
                  : null,
              },
        ),
      },
      metaConversionDestination: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          destinations[where.id]
            ? {
                id: where.id,
                workspaceId: "workspace_1",
                status: "configured",
                ...destinations[where.id],
              }
            : null,
        ),
      },
      metaReportingAccountDestination: { findMany: vi.fn(async () => allowed) },
      inboundWebhookChannelRoute: {
        findMany: vi.fn(async () => options.channelRoutes ?? []),
      },
    };
  }

  function harness(
    world: ReturnType<typeof metaWorld>,
    events: Array<ReturnType<typeof rejected>>,
  ) {
    const h = diagnosticsHarness(events);
    Object.assign(h.prisma, world);
    const resolver = new MetaConnectionResolverService(world as never, encryption);
    const sender = new ConversionEventsService(
      world as never,
      {} as never,
      encryption,
      resolver,
      {} as never,
    );
    const routeOf = (event: Record<string, unknown>) =>
      (sender as any).resolveDeliveryRoute(event);
    return { ...h, routeOf };
  }

  const refusedOnA = (overrides: Record<string, unknown> = {}) =>
    rejected({
      sourceTrigger: "manual_conversion",
      metaAccountId: "act-a",
      metaBusinessConnectionId: "connection-a",
      metaConversionDestinationId: "destination-a",
      adId: null,
      ...overrides,
    });

  it("destino A recusado; o aluno cria o destino B como padrão: o reenvio vai para B", async () => {
    const world = metaWorld({
      defaultDestinationId: "destination-b",
      allowedDestinationIds: ["destination-a", "destination-b"],
    });
    const h = harness(world, [refusedOnA()]);
    // Antes da correção, o destino gravado (A) prendia o envio.
    await expect(h.routeOf(h.events[0]!)).resolves.toMatchObject({
      conversionDestinationId: "destination-a",
    });

    await h.service.retryRejectedConversionEvent("rejected_1", input, context);

    expect(h.events[0]).toMatchObject({
      eventId: "evento_meta_1",
      metaAccountId: "act-a",
      metaBusinessConnectionId: "connection-a",
      // O destino atual é gravado no lugar do recusado (nunca nulo: um log
      // sem destino bloquearia o lead em todos os pixels).
      metaConversionDestinationId: "destination-b",
      pixelId: null,
      pageId: null,
    });
    await expect(h.routeOf(h.events[0]!)).resolves.toMatchObject({
      conversionDestinationId: "destination-b",
      pixelId: "pixel-novo",
      pageId: "pagina-do-anuncio",
      routeError: null,
    });
    expect(h.prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          beforeSummary: expect.objectContaining({
            pixelId: "pixel-antigo",
            pageId: "pagina-errada",
            metaConversionDestinationId: "destination-a",
            metaBusinessConnectionId: "connection-a",
          }),
        }),
      }),
    );
  });

  it("destino do anúncio trocado de A para B: o reenvio vai para B, sem 'destino explícito difere'", async () => {
    const world = metaWorld({
      defaultDestinationId: "destination-a",
      adAssignmentDestinationId: "destination-b",
      allowedDestinationIds: ["destination-a", "destination-b"],
    });
    const h = harness(world, [refusedOnA({ adId: "ad-1" })]);
    await expect(h.routeOf(h.events[0]!)).resolves.toMatchObject({
      routeError: "O destino explícito difere da rota do anúncio",
    });

    await h.service.retryRejectedConversionEvent("rejected_1", input, context);

    await expect(h.routeOf(h.events[0]!)).resolves.toMatchObject({
      conversionDestinationId: "destination-b",
      pixelId: "pixel-novo",
      routeError: null,
    });
  });

  it("entrada do número (inbound_webhook:<provedor>): refaz a rota atual do anúncio e do número", async () => {
    const world = metaWorld({
      defaultDestinationId: "destination-a",
      adAssignmentDestinationId: "destination-b",
      allowedDestinationIds: ["destination-a", "destination-b"],
      channelRoutes: [
        {
          metaBusinessConnectionId: "connection-a",
          metaReportingAccountId: "account-a",
          metaConversionDestinationId: null,
        },
      ],
    });
    const h = harness(world, [
      refusedOnA({
        sourceTrigger: "inbound_webhook:uazapi",
        adId: "ad-1",
        sourcePayload: { inboundEventId: "entrada_1", channelId: "canal_1" },
      }),
    ]);

    await h.service.retryRejectedConversionEvent("rejected_1", input, context);

    expect(h.events[0]).toMatchObject({
      metaAccountId: "act-a",
      metaBusinessConnectionId: "connection-a",
      metaConversionDestinationId: "destination-b",
    });
    await expect(h.routeOf(h.events[0]!)).resolves.toMatchObject({
      conversionDestinationId: "destination-b",
      routeError: null,
    });
  });

  it("número sem rota que case com a rota atual: não reenvia e o lote conta como fora por configuração", async () => {
    const world = metaWorld({
      defaultDestinationId: "destination-a",
      adAssignmentDestinationId: "destination-b",
      allowedDestinationIds: ["destination-a", "destination-b"],
      channelRoutes: [
        {
          metaBusinessConnectionId: "connection-a",
          metaReportingAccountId: "account-a",
          metaConversionDestinationId: "destination-a",
        },
      ],
    });
    const h = harness(world, [
      refusedOnA({
        sourceTrigger: "inbound_webhook:uazapi",
        adId: "ad-1",
        sourcePayload: { inboundEventId: "entrada_1", channelId: "canal_1" },
      }),
    ]);

    await expect(
      h.service.retryRejectedConversionEvents(["rejected_1"], input, context),
    ).resolves.toEqual({
      claimed: 0,
      enqueued: 0,
      skipped: 1,
      expired: 0,
      notReady: 1,
      alreadyConverted: 0,
      failed: 0,
    });
    expect(h.events[0]).toMatchObject({
      status: "error",
      metaConversionDestinationId: "destination-a",
    });
    expect(h.queue.retrySend).not.toHaveBeenCalled();
  });

  it("a fila falhou: devolve destino, conta, conexão, pixel e página", async () => {
    const world = metaWorld({
      defaultDestinationId: "destination-a",
      adAssignmentDestinationId: "destination-b",
      allowedDestinationIds: ["destination-a", "destination-b"],
    });
    const h = harness(world, [
      refusedOnA({ sourceTrigger: "inbound_webhook:waha:message_phrase", adId: "ad-1" }),
    ]);
    h.queue.retrySend.mockRejectedValueOnce(new Error("fila fora"));

    await expect(
      h.service.retryRejectedConversionEvent("rejected_1", input, context),
    ).rejects.toThrow("fila fora");

    expect(h.events[0]).toMatchObject({
      status: "error",
      errorCode: "MetaCapiRejected",
      metaAccountId: "act-a",
      metaBusinessConnectionId: "connection-a",
      metaConversionDestinationId: "destination-a",
      pixelId: "pixel-antigo",
      pageId: "pagina-errada",
    });
  });
});

describe("uma conversão por lead e pixel no reenvio", () => {
  it("o destino atual já recebeu o evento de outro log do lead: não reenvia", async () => {
    const encryption = new MetaTokenEncryptionService({
      META_TOKEN_ENCRYPTION_KEY: "test-only-encryption-key",
    });
    const h = diagnosticsHarness([
      rejected({
        sourceTrigger: "manual_conversion",
        leadId: "lead_1",
        metaAccountId: "act-a",
        metaBusinessConnectionId: "connection-a",
        metaConversionDestinationId: "destination-a",
        adId: null,
      }),
      rejected({
        id: "rejected_2",
        sourceTrigger: "manual_conversion",
        leadId: "lead_2",
        metaAccountId: "act-a",
        metaBusinessConnectionId: "connection-a",
        metaConversionDestinationId: "destination-a",
        adId: null,
      }),
    ]);
    Object.assign(h.prisma, {
      metaReportingAccount: {
        findFirst: vi.fn(async () => ({
          id: "account-a",
          active: true,
          businessConnectionId: "connection-a",
          conversionDestinationId: null,
        })),
      },
      metaBusinessConnection: {
        findFirst: vi.fn(async () => ({
          defaultConversionDestinationId: "destination-b",
        })),
      },
      metaAd: { findFirst: vi.fn(async () => null) },
      metaConversionDestination: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
        })),
      },
      lead: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          phoneHash: `hash_${where.id}`,
          phoneDisplay: null,
        })),
        findMany: vi.fn(async () => []),
      },
    });
    // lead_1 já tem o Lead recebido enviado ao destino B por outra origem.
    (h.prisma.conversionEventLog as any).findMany = vi.fn(
      async ({ where }: { where: { leadId: { in: string[] } } }) =>
        where.leadId.in.includes("lead_1")
          ? [
              {
                id: "outro_log",
                leadId: "lead_1",
                eventName: "LeadSubmitted",
                dedupeKey: "dedupe_outro",
                sourceTrigger: "inbound_webhook:waha",
                sourcePayload: { channelId: "canal_2" },
                metaConversionDestinationId: "destination-b",
                status: "sent",
              },
            ]
          : [],
    );
    void encryption;

    await expect(
      h.service.retryRejectedConversionEvents(
        ["rejected_1", "rejected_2"],
        input,
        context,
      ),
    ).resolves.toEqual({
      claimed: 1,
      enqueued: 1,
      skipped: 1,
      expired: 0,
      notReady: 0,
      alreadyConverted: 1,
      failed: 0,
    });
    expect(h.events[0]).toMatchObject({
      status: "error",
      metaConversionDestinationId: "destination-a",
    });
    expect(h.events[1]).toMatchObject({
      status: "ready_to_send",
      metaConversionDestinationId: "destination-b",
    });
    // O próprio log nunca conta.
    expect((h.prisma.conversionEventLog as any).findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { not: "rejected_1" } }),
      }),
    );
  });

  it("CTWA: a rota do número trocou para B, que já recebeu o evento do lead: não reenvia", async () => {
    const ctwaIntent = (destinationId: string, pixelId: string) => ({
      kind: "authorized_ctwa_destination",
      workspaceId: "workspace_1",
      channelId: "canal_1",
      connectionId: "conexao_1",
      organizationId: "org_1",
      providerChannelId: "numero_1",
      destinationId,
      businessConnectionId: "bm_1",
      credentialId: "credencial_1",
      credentialFingerprint: "fp_1",
      deliveryKind: "page_pixel",
      pixelId,
      pageId: "pagina_1",
    });
    ctwaResolution.current = ctwaIntent("destino_b", "pixel_b");
    const h = diagnosticsHarness([
      rejected({
        sourceTrigger: "inbound_webhook:waha",
        leadId: "lead_1",
        sourcePayload: {
          processingMode: "ctwa",
          ctwaDestination: ctwaIntent("destino_a", "pixel_a"),
        },
      }),
    ]);
    Object.assign(h.prisma, {
      lead: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          phoneHash: `hash_${where.id}`,
          phoneDisplay: null,
        })),
        findMany: vi.fn(async () => []),
      },
    });
    // Conversão manual de Lead recebido já enviada ao destino B.
    (h.prisma.conversionEventLog as any).findMany = vi.fn(async () => [
      {
        id: "manual_b",
        leadId: "lead_1",
        eventName: "LeadSubmitted",
        dedupeKey: "dedupe_manual",
        sourceTrigger: "manual_conversion",
        sourcePayload: {},
        metaConversionDestinationId: "destino_b",
        status: "sent",
      },
    ]);

    await expect(
      h.service.retryRejectedConversionEvent("rejected_1", input, context),
    ).rejects.toThrow();
    expect(h.events[0]!.status).toBe("error");
    expect(h.queue.retrySend).not.toHaveBeenCalled();
  });
});

describe("Reenviar bloqueados e falhas de login: Meta Cloud fica de fora", () => {
  const authFailure = (sourceTrigger: string) => ({
    status: "error",
    errorCode: "MetaCapiRejected",
    sourceTrigger,
    providerResponseSummary: { httpStatus: 400, error: { code: 190 } },
  });

  it("a trava de envio único do Meta Cloud deixaria o evento para sempre na fila", () => {
    expect(isMetaAuthFailureConversionEvent(authFailure("inbound_webhook:waha"))).toBe(
      true,
    );
    for (const sourceTrigger of [
      "inbound_webhook:meta_cloud",
      "kommo_stage",
      "pipedrive_stage",
    ])
      expect(isMetaAuthFailureConversionEvent(authFailure(sourceTrigger))).toBe(false);
    expect(metaAuthFailureConversionEventWhere.sourceTrigger.notIn).toEqual(
      expect.arrayContaining([
        "inbound_webhook:meta_cloud",
        "kommo_stage",
        "pipedrive_stage",
      ]),
    );
  });
});

const apps: INestApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function controllerHarness(role: string, accessMode = "membership") {
  const reporting = {
    getRejectedConversionEventRetryIds: vi.fn(async () => ["rejected_1"]),
  };
  const diagnostics = {
    retryRejectedConversionEvent: vi.fn(async () => ({ ok: true, status: "queued" })),
    retryRejectedConversionEvents: vi.fn(async () => ({
      claimed: 1,
      enqueued: 1,
      skipped: 0,
      expired: 0,
      notReady: 0,
      alreadyConverted: 0,
      failed: 0,
    })),
  };
  const module = await Test.createTestingModule({
    controllers: [ReportingController],
    providers: [
      { provide: MetaReportingService, useValue: reporting },
      { provide: DiagnosticsService, useValue: diagnostics },
      {
        provide: AuthService,
        useValue: { getSession: vi.fn(async () => ({ user: { id: "user_1" } })) },
      },
      {
        provide: WorkspacesService,
        useValue: {
          getCurrentWorkspace: () => ({
            id: "workspace_1",
            role,
            accessMode,
            permissions: { canViewReports: true },
          }),
        },
      },
      { provide: MetaReportSyncQueueService, useValue: {} },
      { provide: MetaInitialSyncPeriodService, useValue: {} },
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  apps.push(app);
  await app.init();
  return { app, reporting, diagnostics };
}

describe("permissão do Reenviar recusados", () => {
  it.each(["owner", "admin"])("%s reenvia em lote e por evento", async (role) => {
    const h = await controllerHarness(role);
    await request(h.app.getHttpServer())
      .post("/reports/conversions/audit/retry-rejected?since=2026-10-21&until=2026-10-27")
      .set("Cookie", "wpptrack_session=refresh-token")
      .expect(201);
    expect(h.diagnostics.retryRejectedConversionEvents).toHaveBeenCalledWith(
      ["rejected_1"],
      expect.anything(),
      expect.objectContaining({ workspaceId: "workspace_1", actorUserId: "user_1" }),
    );
    await request(h.app.getHttpServer())
      .post("/reports/conversions/audit/rejected_1/retry-rejected")
      .set("Cookie", "wpptrack_session=refresh-token")
      .expect(201);
    expect(h.diagnostics.retryRejectedConversionEvent).toHaveBeenCalledWith(
      "rejected_1",
      expect.anything(),
      expect.objectContaining({ workspaceId: "workspace_1" }),
    );
  });

  it("analista (member) recebe 403 e nada é reenviado", async () => {
    const h = await controllerHarness("member");
    await request(h.app.getHttpServer())
      .post("/reports/conversions/audit/retry-rejected")
      .set("Cookie", "wpptrack_session=refresh-token")
      .expect(403);
    await request(h.app.getHttpServer())
      .post("/reports/conversions/audit/rejected_1/retry-rejected")
      .set("Cookie", "wpptrack_session=refresh-token")
      .expect(403);
    expect(h.diagnostics.retryRejectedConversionEvents).not.toHaveBeenCalled();
    expect(h.diagnostics.retryRejectedConversionEvent).not.toHaveBeenCalled();
  });
});

describe("licença bloqueada: Reenviar recusados responde 423", () => {
  const blocked = {
    getLockState: vi.fn().mockResolvedValue({
      inert: false,
      locked: true,
      reason: "revoked",
      state: {},
    }),
  } as unknown as LicenseClientService;
  const contextOf = (method: string, path: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ method, path }),
        getResponse: () => ({}),
      }),
    }) as unknown as ExecutionContext;

  it.each([
    "/reports/conversions/audit/retry-rejected",
    "/reports/conversions/audit/rejected_1/retry-rejected",
  ])("POST %s", async (path) => {
    const write = new LicenseSoftlockGuard(blocked).canActivate(
      contextOf("POST", path),
    );
    await expect(write).rejects.toBeInstanceOf(HttpException);
    await write.catch((error: HttpException) => expect(error.getStatus()).toBe(423));
  });
});
