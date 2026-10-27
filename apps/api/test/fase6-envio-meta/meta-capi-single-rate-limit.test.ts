import { describe, expect, it, vi } from "vitest";
import { ConversionEventProcessor } from "../../src/common/queue/conversion-event.processor";
import { ConversionEventsService } from "../../src/conversion-events/conversion-events.service";
import { MetaCapiAdapter } from "../../src/conversion-events/meta-capi.adapter";

/**
 * 1.3.1 (revisão do #121): no envio unitário padrão (fila de conversões), o
 * limite de uso da Meta volta para a fila (MetaCapiNetworkError, reenviável)
 * com a mensagem dizendo que foi limite de uso, como já era no lote. Os envios
 * com trava de envio único (signal/beforeDispatch) continuam MetaCapiRejected.
 */
const input = {
  accessToken: "synthetic-token",
  pixelId: "synthetic-pixel",
  pageId: "synthetic-page",
  eventName: "Purchase" as const,
  dedupeKey: "synthetic-event",
  phoneHash: "a".repeat(64),
  adId: "synthetic-ad",
  ctwaClid: "synthetic-click",
};

const limited = (code: number) =>
  new MetaCapiAdapter(
    {},
    vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: { code, message: "limit" } }), {
          status: 400,
        }),
    ),
  );

describe("MetaCapiAdapter: limite de uso no envio unitário", () => {
  it.each([4, 17, 32, 613, 80000, 80004, 80014])(
    "código %s: reenviável, com a mensagem de limite de uso",
    async (code) => {
      const result = await limited(code).sendEvent(input);
      expect(result).toMatchObject({
        status: "error",
        errorCode: "MetaCapiNetworkError",
        errorMessage: `Meta CAPI usage limit (code ${code}): will retry`,
        responseSummary: { httpStatus: 400, error: { code } },
      });
      expect(result.deliveryOutcome).toBeUndefined();
    },
  );

  it("parâmetro inválido (100) continua recusa definitiva", async () => {
    expect(await limited(100).sendEvent(input)).toMatchObject({
      errorCode: "MetaCapiRejected",
    });
  });

  it("envio com trava (Kommo, Pipedrive, regras de entrada) continua MetaCapiRejected", async () => {
    const result = await limited(613).sendEvent(input, {
      beforeDispatch: () => undefined,
      signal: AbortSignal.timeout(5_000),
    });
    expect(result).toMatchObject({ errorCode: "MetaCapiRejected" });
  });
});

describe("fila de conversões: nova tentativa rearma a falha passageira (1.3.1)", () => {
  function service(log: Record<string, unknown>) {
    const prisma: any = {
      conversionEventLog: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(log)
          // Depois de rearmar, o envio segue com o evento relido.
          .mockResolvedValueOnce(null),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const sender = new ConversionEventsService(
      prisma,
      { sendEvent: vi.fn() } as any,
      {} as any,
      undefined,
      undefined as never,
      {},
    );
    return { prisma, sender };
  }
  const failed = {
    id: "log_1",
    workspaceId: "ws1",
    sourceTrigger: "auto_lead",
    status: "error",
    errorCode: "MetaCapiNetworkError",
    eventId: "event_1",
  };

  it("na nova tentativa do BullMQ, volta a ready_to_send com troca condicional", async () => {
    const h = service(failed);
    await h.sender.sendReadyEvent("log_1", { queueRetry: true });
    expect(h.prisma.conversionEventLog.updateMany).toHaveBeenCalledWith({
      where: { id: "log_1", status: "error", errorCode: "MetaCapiNetworkError" },
      data: { status: "ready_to_send", errorCode: null, errorMessage: null },
    });
    expect(h.prisma.conversionEventLog.findUnique).toHaveBeenCalledTimes(2);
  });

  it("primeira tentativa, recusa definitiva ou envio único (Kommo, Pipedrive, Meta Cloud): não rearma", async () => {
    for (const [log, queueRetry] of [
      [failed, false],
      [{ ...failed, errorCode: "MetaCapiRejected" }, true],
      [{ ...failed, sourceTrigger: "kommo_stage" }, true],
      [{ ...failed, sourceTrigger: "pipedrive_stage" }, true],
      [{ ...failed, sourceTrigger: "inbound_webhook:meta_cloud" }, true],
    ] as const) {
      const h = service(log);
      await h.sender
        .sendReadyEvent("log_1", { queueRetry })
        .catch(() => undefined);
      expect(h.prisma.conversionEventLog.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "ready_to_send" }),
        }),
      );
    }
  });

  it("o processor pede o rearme só a partir da segunda tentativa", async () => {
    const sendReadyEvent = vi.fn(async () => ({
      conversionEventLogId: "log_1",
      workspaceId: "ws1",
      status: "sent",
    }));
    const processor = new ConversionEventProcessor(
      { sendReadyEvent } as any,
      { jobAttempt: { create: vi.fn(async () => ({})) } } as any,
    );
    for (const attemptsMade of [0, 1]) {
      await processor
        .process({
          id: "job",
          name: "send-ready-event",
          data: { conversionEventLogId: "log_1", workspaceId: "ws1" },
          attemptsMade,
        } as any)
        .catch(() => undefined);
    }
    expect(sendReadyEvent.mock.calls.map((call: any[]) => call[1].queueRetry)).toEqual([
      false,
      true,
    ]);
  });
});
