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
  META_EVENT_TIME_WINDOW_MS,
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
    ).resolves.toEqual({ claimed: 1, enqueued: 1, skipped: 1, expired: 1, failed: 0 });
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

describe("rota recalculada no envio (configuração atual)", () => {
  // Caminho por conta/anúncio: o resolver lê pixel e página do destino atual
  // (e prefere o destino atual do anúncio); o pixel e a página gravados na
  // tentativa recusada são apagados para nunca servirem de reserva.
  it("depois do reenvio, o envio usa o pixel e a página atuais do destino, não os gravados", async () => {
    const encryption = new MetaTokenEncryptionService({
      META_TOKEN_ENCRYPTION_KEY: "test-only-encryption-key",
    });
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
      defaultConversionDestinationId: "destination-a",
    };
    const account = {
      id: "account-a",
      workspaceId: "workspace_1",
      active: true,
      adAccountId: "act-a",
      businessConnectionId: connection.id,
      conversionDestinationId: null,
    };
    // O aluno corrigiu o vínculo: o destino agora aponta para a página certa.
    const destination = {
      id: "destination-a",
      workspaceId: "workspace_1",
      status: "configured",
      pixelId: "pixel-corrigido",
      pageId: "pagina-do-anuncio",
    };
    const prisma = {
      metaIntegration: { findUnique: vi.fn(async () => null) },
      metaReportingAccount: {
        findFirst: vi.fn(async () => account),
        findMany: vi.fn(async () => [account]),
      },
      metaBusinessConnection: { findFirst: vi.fn(async () => connection) },
      metaAd: { findFirst: vi.fn(async () => null) },
      metaConversionDestination: { findFirst: vi.fn(async () => destination) },
      metaReportingAccountDestination: { findMany: vi.fn(async () => []) },
    };
    const resolver = new MetaConnectionResolverService(prisma as never, encryption);
    const sender = new ConversionEventsService(
      prisma as never,
      {} as never,
      encryption,
      resolver,
      {} as never,
    );

    const h = diagnosticsHarness([
      rejected({ metaAccountId: "act-a", metaConversionDestinationId: "destination-a" }),
    ]);
    await h.service.retryRejectedConversionEvent("rejected_1", input, context);
    const route = await (sender as any).resolveDeliveryRoute(h.events[0]);
    expect(route).toMatchObject({
      pixelId: "pixel-corrigido",
      pageId: "pagina-do-anuncio",
      routeError: null,
    });
    expect(h.events[0]).toMatchObject({ pixelId: null, pageId: null });
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
