import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticsService } from "../src/diagnostics/diagnostics.service";

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: "blocked",
    workspaceId: "workspace_1",
    eventName: "Purchase",
    sourceTrigger: "keyword",
    status: "not_configured",
    errorCode: "MissingAccessToken" as string | null,
    errorMessage: "original",
    sentAt: null,
    jobId: "original_job",
    dedupeKey: "dedupe",
    eventId: "meta_event",
    ...overrides,
  };
}

function harness(events = [event()]) {
  const prisma = {
    conversionEventLog: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = events.find((row) => row.id === where.id);
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
          const row = events.find((row) =>
            Object.entries(where).every(
              ([key, value]) => (row as Record<string, unknown>)[key] === value,
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
  };
  const queue = { retrySend: vi.fn(async () => ({ jobId: "retry_job" })) };
  const service = new DiagnosticsService(
    prisma as never,
    undefined,
    queue as never,
  );
  return { prisma, queue, service, events };
}

const context = {
  workspaceId: "workspace_1",
  actorUserId: "owner",
  actorType: "workspace_owner",
  transientOnly: true,
  allowConfigurationBlocked: true,
};
const input = { reason: "Configuration repaired" };

describe("diagnostics conversion retries", () => {
  it.each([
    ["not_configured", "MissingAccessToken"],
    ["not_configured", "MissingMetaDestination"],
    ["not_configured", null],
    ["error", "MetaCapiNetworkError"],
  ])(
    "retries %s / %s once and preserves Meta identity",
    async (status, errorCode) => {
      const { service, queue, prisma, events } = harness([
        event({ status, errorCode }),
      ]);
      await expect(
        service.retryConversionEvent("blocked", input, context),
      ).resolves.toMatchObject({
        ok: true,
        status: "queued",
        auditLogId: "audit",
      });
      expect(queue.retrySend).toHaveBeenCalledTimes(1);
      expect(queue.retrySend).toHaveBeenCalledWith("blocked", "workspace_1");
      expect(events[0]).toMatchObject({
        status: "ready_to_send",
        errorCode: null,
        errorMessage: null,
        eventId: "meta_event",
        dedupeKey: "dedupe",
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: "workspace_1",
            actorUserId: "owner",
            actorType: "workspace_owner",
            beforeSummary: expect.objectContaining({ status, errorCode }),
          }),
        }),
      );
      await expect(
        service.retryConversionEvent("blocked", input, context),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(queue.retrySend).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["not_configured", "OtherError"],
    ["error", "MetaCapiRejected"],
    ["pending_meta_context", "MissingMetaDestination"],
    ["pending_value", null],
    ["not_eligible", null],
    ["sent", null],
    ["skipped", null],
    ["queued", null],
    ["ready_to_send", null],
  ])("rejects %s / %s without writes", async (status, errorCode) => {
    const { service, queue, prisma } = harness([event({ status, errorCode })]);
    await expect(
      service.retryConversionEvent("blocked", input, context),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.conversionEventLog.updateMany).not.toHaveBeenCalled();
    expect(queue.retrySend).not.toHaveBeenCalled();
  });

  it("retains the transient-only restriction unless configuration retries are enabled", async () => {
    const { service, queue } = harness();
    await expect(
      service.retryConversionEvent("blocked", input, {
        ...context,
        allowConfigurationBlocked: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(queue.retrySend).not.toHaveBeenCalled();
  });

  it("hides foreign and missing events from single retries", async () => {
    const { service, queue } = harness([event({ workspaceId: "workspace_2" })]);
    for (const id of ["blocked", "missing"]) {
      await expect(
        service.retryConversionEvent(id, input, context),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(queue.retrySend).not.toHaveBeenCalled();
  });

  it("rejects a lost single claim without enqueueing", async () => {
    const { service, prisma, queue } = harness();
    prisma.conversionEventLog.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      service.retryConversionEvent("blocked", input, context),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(queue.retrySend).not.toHaveBeenCalled();
  });

  it("rechecks bulk eligibility and workspace, restores queue failures and continues", async () => {
    const { service, queue, events } = harness([
      event(),
      event({ id: "destination", errorCode: "MissingMetaDestination" }),
      event({ id: "foreign", workspaceId: "workspace_2" }),
      event({ id: "changed", status: "sent" }),
      event({
        id: "network",
        status: "error",
        errorCode: "MetaCapiNetworkError",
      }),
    ]);
    queue.retrySend.mockRejectedValueOnce(new Error("Redis unavailable"));
    expect(
      await service.retryBlockedConversionEvents(
        [
          "blocked",
          "destination",
          "foreign",
          "changed",
          "network",
          "missing",
          "destination",
        ],
        input,
        context,
      ),
    ).toEqual({ claimed: 2, enqueued: 1, skipped: 4, expired: 0, failed: 1 });
    expect(events[0]).toMatchObject(event());
    expect(events[1].status).toBe("ready_to_send");
    expect(queue.retrySend.mock.calls).toEqual([
      ["blocked", "workspace_1"],
      ["destination", "workspace_1"],
    ]);
  });

  it("counts a lost bulk claim as skipped", async () => {
    const { service, prisma, queue } = harness();
    prisma.conversionEventLog.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(
      await service.retryBlockedConversionEvents(["blocked"], input, context),
    ).toEqual({ claimed: 0, enqueued: 0, skipped: 1, expired: 0, failed: 0 });
    expect(queue.retrySend).not.toHaveBeenCalled();
  });

  it("enqueues once when two bulk requests race for the same event", async () => {
    const { service, queue } = harness();
    const results = await Promise.all([
      service.retryBlockedConversionEvents(["blocked"], input, context),
      service.retryBlockedConversionEvents(["blocked"], input, context),
    ]);
    expect(results).toEqual(
      expect.arrayContaining([
        { claimed: 1, enqueued: 1, skipped: 0, expired: 0, failed: 0 },
        { claimed: 0, enqueued: 0, skipped: 1, expired: 0, failed: 0 },
      ]),
    );
    expect(queue.retrySend).toHaveBeenCalledTimes(1);
  });

  it("counts HTTP-style queue errors as failures after claiming", async () => {
    const { service, queue, events } = harness();
    queue.retrySend.mockRejectedValueOnce(
      new BadRequestException("Queue rejected retry"),
    );
    expect(
      await service.retryBlockedConversionEvents(["blocked"], input, context),
    ).toEqual({ claimed: 1, enqueued: 0, skipped: 0, expired: 0, failed: 1 });
    expect(events[0]).toMatchObject(event());
  });

  it("reports successful queueing even if audit persistence then fails", async () => {
    const { service, prisma, events } = harness();
    prisma.auditLog.create.mockRejectedValueOnce(
      new Error("Audit unavailable"),
    );
    expect(
      await service.retryBlockedConversionEvents(["blocked"], input, context),
    ).toEqual({ claimed: 1, enqueued: 1, skipped: 0, expired: 0, failed: 1 });
    expect(events[0].status).toBe("ready_to_send");
  });

  it("handles empty batches and caps deduplicated batches at 500", async () => {
    const events = Array.from({ length: 501 }, (_, index) =>
      event({ id: `blocked_${index}` }),
    );
    const { service, queue } = harness(events);
    expect(
      await service.retryBlockedConversionEvents([], input, context),
    ).toEqual({ claimed: 0, enqueued: 0, skipped: 0, expired: 0, failed: 0 });
    expect(
      await service.retryBlockedConversionEvents(
        [events[0].id, ...events.map((row) => row.id)],
        input,
        context,
      ),
    ).toEqual({ claimed: 500, enqueued: 500, skipped: 0, expired: 0, failed: 0 });
    expect(queue.retrySend).toHaveBeenCalledTimes(500);
    expect(events[500].status).toBe("not_configured");
  });

  describe("Meta login failures (code 190/102) after reconnecting (#181)", () => {
    const day = 86_400_000;
    // nod stores only the numeric Graph code of a rejection (no message).
    const rejected = (
      id: string,
      code: number | string,
      overrides: Record<string, unknown> = {},
    ) =>
      event({
        id,
        status: "error",
        errorCode: "MetaCapiRejected",
        errorMessage: "Meta CAPI request failed",
        dedupeKey: `dedupe_${id}`,
        eventId: `event_${id}`,
        createdAt: new Date(Date.now() - 2 * day),
        eventOccurredAt: new Date(Date.now() - 2 * day),
        providerResponseSummary: { httpStatus: 400, error: { code } },
        ...overrides,
      });

    it("requeues 190 and 102 refusals, keeping event_id/dedupe, and skips the rest", async () => {
      const { service, queue, events } = harness([
        rejected("auth_190", 190),
        rejected("auth_102", 102),
        rejected("invalid_param", 100),
        rejected("already_sent", 190, { status: "sent", errorCode: null }),
        rejected("expired", 190, {
          eventOccurredAt: new Date(Date.now() - 8 * day),
        }),
        rejected("foreign", 190, { workspaceId: "workspace_2" }),
        rejected("kommo", 190, { sourceTrigger: "kommo_stage" }),
        rejected("pipedrive", 190, { sourceTrigger: "pipedrive_stage" }),
        rejected("old_row", 190, { providerResponseSummary: { httpStatus: 400 } }),
      ]);

      const result = await service.retryBlockedConversionEvents(
        events.map((row) => row.id),
        input,
        context,
      );

      expect(result).toEqual({
        claimed: 2,
        enqueued: 2,
        skipped: 7,
        expired: 1,
        failed: 0,
      });
      expect(queue.retrySend.mock.calls).toEqual([
        ["auth_190", "workspace_1"],
        ["auth_102", "workspace_1"],
      ]);
      const byId = new Map(events.map((row) => [row.id, row]));
      for (const id of ["auth_190", "auth_102"]) {
        expect(byId.get(id)).toMatchObject({
          status: "ready_to_send",
          errorCode: null,
          eventId: `event_${id}`,
          dedupeKey: `dedupe_${id}`,
        });
      }
      for (const id of [
        "invalid_param",
        "expired",
        "foreign",
        "kommo",
        "pipedrive",
        "old_row",
      ]) {
        expect(byId.get(id)).toMatchObject({
          status: "error",
          errorCode: "MetaCapiRejected",
        });
      }
      expect(byId.get("already_sent")?.status).toBe("sent");
    });

    it("lets the single-event owner retry a login failure and explains an expired one", async () => {
      const { service, queue } = harness([
        rejected("auth_190", "190"),
        rejected("expired", 102, {
          eventOccurredAt: new Date(Date.now() - 8 * day),
        }),
        rejected("invalid_param", 100),
      ]);

      await expect(
        service.retryConversionEvent("auth_190", input, context),
      ).resolves.toMatchObject({ status: "queued" });
      await expect(
        service.retryConversionEvent("expired", input, context),
      ).rejects.toThrow("mais de 7 dias");
      await expect(
        service.retryConversionEvent("invalid_param", input, context),
      ).rejects.toThrow("Somente falhas transitórias");
      // Without allowConfigurationBlocked only network failures qualify.
      await expect(
        service.retryConversionEvent("expired", input, {
          ...context,
          allowConfigurationBlocked: false,
        }),
      ).rejects.toThrow("Somente falhas transitórias de comunicação");
      expect(queue.retrySend.mock.calls).toEqual([["auth_190", "workspace_1"]]);
    });

    it("never resends when the conditional claim loses the race", async () => {
      const { service, queue, prisma } = harness([rejected("auth_190", 190)]);
      prisma.conversionEventLog.updateMany.mockResolvedValueOnce({ count: 0 });
      expect(
        await service.retryBlockedConversionEvents(["auth_190"], input, context),
      ).toEqual({ claimed: 0, enqueued: 0, skipped: 1, expired: 0, failed: 0 });
      expect(queue.retrySend).not.toHaveBeenCalled();
    });
  });

  it("retries a ready_to_send stuck for more than 10 minutes, not a fresh one (7ac17df7)", async () => {
    const { service, queue } = harness([
      event({
        id: "stalled",
        status: "ready_to_send",
        errorCode: null,
        createdAt: new Date(Date.now() - 11 * 60_000),
      }),
      event({
        id: "fresh",
        status: "ready_to_send",
        errorCode: null,
        createdAt: new Date(Date.now() - 60_000),
      }),
    ]);
    await expect(
      service.retryConversionEvent("stalled", input, context),
    ).resolves.toMatchObject({ status: "queued" });
    await expect(
      service.retryConversionEvent("fresh", input, context),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(queue.retrySend.mock.calls).toEqual([["stalled", "workspace_1"]]);
  });
});
