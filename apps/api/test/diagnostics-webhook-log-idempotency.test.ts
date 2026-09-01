import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsService } from "../src/diagnostics/diagnostics.service";

function uniqueConstraintError(target: readonly string[] = ["idempotencyKey"]) {
  return new Prisma.PrismaClientKnownRequestError("unique constraint", {
    code: "P2002",
    clientVersion: "test",
    meta: { target },
  });
}

function makePrisma() {
  const prisma = {
    webhookLog: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    diagnosticEvent: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    $transaction: undefined as unknown as ReturnType<typeof vi.fn>,
  };
  // Mirrors the codebase's `this.prisma.$transaction(async (tx) => ...)`
  // convention (see platform-workspace-access.service.ts): the callback
  // receives a transaction client. The mock delegates to the same
  // create/findUnique/findMany spies so tests can assert on them directly
  // while still exercising the real atomic-write code path.
  prisma.$transaction = vi.fn(
    async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
  );
  return prisma;
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "workspace-a",
    whatsappInstanceId: "connection-waha",
    source: "waha" as const,
    eventType: "waha.webhook",
    externalEventId: "waha-msg-1",
    idempotencyKey: "waha:workspace-a:connection-waha:waha-msg-1",
    payloadHash: "a".repeat(64),
    summaryPayload: { hello: "world" },
    ...overrides,
  };
}

describe("DiagnosticsService.recordWebhookLog idempotency hardening", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: DiagnosticsService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new DiagnosticsService(prisma as never);
  });

  it("creates a new WebhookLog and DiagnosticEvent on first receipt", async () => {
    prisma.webhookLog.create.mockResolvedValueOnce({ id: "webhook-log-1" });
    prisma.diagnosticEvent.create.mockResolvedValueOnce({
      id: "diagnostic-event-1",
    });

    const result = await service.recordWebhookLog(baseInput());

    expect(result).toEqual({
      webhookLogId: "webhook-log-1",
      diagnosticEventId: "diagnostic-event-1",
      status: "received",
    });
    expect(prisma.webhookLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ payloadHash: "a".repeat(64) }),
      }),
    );
  });

  it("replay idêntico: mesmo idempotencyKey e mesmo payloadHash retorna duplicate e preserva o registro original", async () => {
    const existing = {
      id: "webhook-log-1",
      workspaceId: "workspace-a",
      source: "waha",
      payloadHash: "a".repeat(64),
    };
    prisma.webhookLog.create.mockRejectedValueOnce(uniqueConstraintError());
    prisma.webhookLog.findUnique.mockResolvedValueOnce(existing);
    prisma.diagnosticEvent.findMany.mockResolvedValueOnce([
      { id: "diagnostic-event-1" },
    ]);

    const result = await service.recordWebhookLog(baseInput());

    expect(result).toEqual({
      webhookLogId: "webhook-log-1",
      diagnosticEventId: "diagnostic-event-1",
      status: "duplicate",
    });
    // The original row must never be touched on a replay.
    expect(prisma.webhookLog.update).not.toHaveBeenCalled();
    expect(prisma.webhookLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.diagnosticEvent.create).not.toHaveBeenCalled();
  });

  it("mesmo idempotencyKey com payload divergente retorna conflict em quarentena sem sobrescrever o original", async () => {
    const existing = {
      id: "webhook-log-1",
      workspaceId: "workspace-a",
      source: "waha",
      payloadHash: "b".repeat(64),
    };
    prisma.webhookLog.create
      .mockRejectedValueOnce(uniqueConstraintError())
      .mockResolvedValueOnce({ id: "webhook-log-quarantine-1" });
    prisma.webhookLog.findUnique.mockResolvedValueOnce(existing);
    prisma.diagnosticEvent.create.mockResolvedValueOnce({
      id: "diagnostic-event-quarantine-1",
    });

    const result = await service.recordWebhookLog(
      baseInput({ payloadHash: "a".repeat(64) }),
    );

    expect(result).toEqual({
      webhookLogId: "webhook-log-quarantine-1",
      diagnosticEventId: "diagnostic-event-quarantine-1",
      status: "conflict",
    });
    // The original row must never be updated/overwritten.
    expect(prisma.webhookLog.update).not.toHaveBeenCalled();
    // A second, distinct row is created for the quarantined delivery.
    expect(prisma.webhookLog.create).toHaveBeenCalledTimes(2);
    const quarantineCreateData = prisma.webhookLog.create.mock.calls[1][0].data;
    expect(quarantineCreateData.idempotencyKey).toBeNull();
    expect(quarantineCreateData.status).toBe("conflict");
    // The audit trail references the original by internal id only - no
    // token or phone number embedded in the error message.
    expect(quarantineCreateData.errorMessage).toContain("webhook-log-1");
    expect(quarantineCreateData.errorMessage).not.toMatch(/bearer|token/i);
    expect(quarantineCreateData.errorMessage).not.toContain(
      "5511999999999",
    );
  });

  it("resolve uma corrida de unique violation (P2002) de forma deterministica, sem propagar o erro bruto", async () => {
    const existing = {
      id: "webhook-log-1",
      workspaceId: "workspace-a",
      source: "waha",
      payloadHash: "a".repeat(64),
    };
    prisma.webhookLog.create.mockRejectedValueOnce(uniqueConstraintError());
    prisma.webhookLog.findUnique.mockResolvedValueOnce(existing);
    prisma.diagnosticEvent.findMany.mockResolvedValueOnce([
      { id: "diagnostic-event-1" },
    ]);

    await expect(service.recordWebhookLog(baseInput())).resolves.toMatchObject(
      { status: "duplicate" },
    );
  });

  it("still guards against an idempotencyKey collision belonging to another workspace/source", async () => {
    prisma.webhookLog.create.mockRejectedValueOnce(uniqueConstraintError());
    prisma.webhookLog.findUnique.mockResolvedValueOnce({
      id: "webhook-log-1",
      workspaceId: "workspace-b",
      source: "waha",
      payloadHash: "a".repeat(64),
    });

    await expect(
      service.recordWebhookLog(baseInput()),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.webhookLog.update).not.toHaveBeenCalled();
  });

  it("persists WebhookLog and its DiagnosticEvent inside a single transaction", async () => {
    prisma.webhookLog.create.mockResolvedValueOnce({ id: "webhook-log-1" });
    prisma.diagnosticEvent.create.mockResolvedValueOnce({
      id: "diagnostic-event-1",
    });

    await service.recordWebhookLog(baseInput());

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.webhookLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.diagnosticEvent.create).toHaveBeenCalledTimes(1);
  });

  it("does not write a DiagnosticEvent when the WebhookLog write fails for a non-idempotency reason", async () => {
    const infrastructureFailure = new Error("connection reset");
    prisma.webhookLog.create.mockRejectedValueOnce(infrastructureFailure);

    await expect(service.recordWebhookLog(baseInput())).rejects.toBe(
      infrastructureFailure,
    );
    expect(prisma.diagnosticEvent.create).not.toHaveBeenCalled();
    expect(prisma.webhookLog.findUnique).not.toHaveBeenCalled();
  });

  it("propagates a P2002 raised by a different unique constraint instead of treating it as an idempotencyKey replay/conflict", async () => {
    const otherConstraintError = uniqueConstraintError(["someOtherColumn"]);
    prisma.webhookLog.create.mockRejectedValueOnce(otherConstraintError);

    await expect(service.recordWebhookLog(baseInput())).rejects.toBe(
      otherConstraintError,
    );
    // Restricted to the idempotencyKey constraint: an unrelated unique
    // violation must not trigger the find-and-resolve conflict path at all.
    expect(prisma.webhookLog.findUnique).not.toHaveBeenCalled();
    expect(prisma.diagnosticEvent.create).not.toHaveBeenCalled();
  });

  it("propagates a P2002 whose constraint target is a string that does not name idempotencyKey", async () => {
    const otherConstraintError = new Prisma.PrismaClientKnownRequestError(
      "unique constraint",
      {
        code: "P2002",
        clientVersion: "test",
        meta: { target: "WebhookLog_someOtherColumn_key" },
      },
    );
    prisma.webhookLog.create.mockRejectedValueOnce(otherConstraintError);

    await expect(service.recordWebhookLog(baseInput())).rejects.toBe(
      otherConstraintError,
    );
    expect(prisma.webhookLog.findUnique).not.toHaveBeenCalled();
  });
});
