import { describe, expect, it, vi } from "vitest";
import {
  ConversionEventsService,
  MANUAL_STATUS_TRIGGER,
} from "../src/conversion-events/conversion-events.service";

function createService() {
  const logs = new Map<string, Record<string, unknown>>();
  const prisma = {
    conversionEventLog: {
      findUnique: vi.fn(async ({ where }) => logs.get(where.dedupeKey) ?? null),
      create: vi.fn(async ({ data }) => {
        if (logs.has(data.dedupeKey)) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        const log = { id: `log_${logs.size + 1}`, ...data };
        logs.set(data.dedupeKey, log);
        return log;
      }),
    },
  };
  const service = new ConversionEventsService(
    prisma as never,
    {} as never,
    {} as never,
    undefined,
    {} as never,
    {},
  );

  return { service, prisma, logs };
}

const input = {
  workspaceId: "ws1",
  leadId: "lead1",
  phoneHash: "hash1",
  eventName: "QualifiedLead" as const,
  actorUserId: "user1",
  campaignId: "cmp1",
  adSetId: "adset1",
  adId: "ad1",
  ctwaClid: "ctwa1",
};

describe("recordManualStatusConversion", () => {
  it("records one ready QualifiedLead per lead, attributed to the ad", async () => {
    const { service, logs } = createService();

    const result = await service.recordManualStatusConversion(input);

    expect(result.created).toHaveLength(1);
    const [log] = [...logs.values()];
    expect(log).toMatchObject({
      sourceTrigger: MANUAL_STATUS_TRIGGER,
      eventName: "QualifiedLead",
      status: "ready_to_send",
      adId: "ad1",
      ctwaClid: "ctwa1",
      eventId: "ws1:lead1:manual_status:QualifiedLead",
      sourcePayload: { actorUserId: "user1" },
    });
  });

  it("marking again returns the existing event, even with another ad", async () => {
    const { service } = createService();
    const first = await service.recordManualStatusConversion(input);

    const second = await service.recordManualStatusConversion({
      ...input,
      adId: "ad2",
    });

    expect(second).toEqual({ created: [], duplicates: first.created });
  });

  it("a concurrent click that loses the unique key is a duplicate", async () => {
    const { service, prisma } = createService();
    await service.recordManualStatusConversion(input);
    prisma.conversionEventLog.findUnique.mockResolvedValueOnce(null);

    const raced = await service.recordManualStatusConversion(input);

    expect(raced.created).toEqual([]);
    expect(raced.duplicates).toEqual(["log_1"]);
  });

  it("without ad context the event waits instead of being sent", async () => {
    const { service, logs } = createService();

    await service.recordManualStatusConversion({ ...input, adId: null });

    expect([...logs.values()][0]).toMatchObject({
      status: "pending_meta_context",
      errorCode: "MissingAdId",
    });
  });
});
