import { describe, expect, it, vi } from "vitest";
import {
  MetaCapiAdapter,
  type MetaCapiSendEventInput,
} from "../../src/conversion-events/meta-capi.adapter";

// Fase 6.4 (porte do SaaS 70625e41): micro-batching opcional da CAPI.
// Adaptado ao nod: confirmação estrita (events_received + messages +
// fbtrace_id) e nenhum corpo do provedor guardado no responseSummary.
// Dados sintéticos; nenhuma chamada real à Meta.

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

const baseInput = (
  overrides: Partial<MetaCapiSendEventInput> = {},
): MetaCapiSendEventInput => ({
  accessToken: "synthetic-token",
  pixelId: "pixel_1",
  pageId: "page_1",
  eventName: "QualifiedLead",
  dedupeKey: "workspace_1:lead_0:QualifiedLead",
  phoneHash: "a".repeat(64),
  adId: "ad_1",
  ctwaClid: "synthetic-click",
  ...overrides,
});

const event = (
  index: number,
  overrides: Partial<MetaCapiSendEventInput> = {},
) =>
  baseInput({
    dedupeKey: `workspace_1:lead_${index}:QualifiedLead`,
    ...overrides,
  });

const ack = (received: number, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      events_received: received,
      messages: [],
      fbtrace_id: "synthetic-trace",
      ...extra,
    }),
    { status: 200 },
  );

const batchEnv = {
  META_GRAPH_API_VERSION: "v21.0",
  META_CAPI_BATCH_ENABLED: "true",
  META_CAPI_BATCH_WINDOW_MS: "10000",
};

const bodyOf = (fetchMock: FetchMock, call: number) =>
  JSON.parse(String((fetchMock.mock.calls[call]?.[1] as RequestInit).body));

describe("meta capi adapter batching (Fase 6.4)", () => {
  it("is off by default: one request per event", async () => {
    const fetchMock: FetchMock = vi.fn(async () => ack(1));
    const adapter = new MetaCapiAdapter({}, fetchMock);

    const results = await Promise.all([
      adapter.sendEvent(event(1)),
      adapter.sendEvent(event(2)),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results.map((result) => result.status)).toEqual(["sent", "sent"]);
  });

  it("groups concurrent events per pixel and test code into one request with per-event results", async () => {
    const fetchMock: FetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return ack(body.data.length, { extra: "synthetic private details" });
    });
    const adapter = new MetaCapiAdapter(batchEnv, fetchMock);

    const pending = Promise.all([
      adapter.sendEvent(event(1)),
      adapter.sendEvent(event(2)),
      adapter.sendEvent(event(3, { pixelId: "pixel_2" })),
      adapter.sendEvent(event(4, { testEventCode: "TEST1" })),
    ]);
    await adapter.flushAllBatches();
    const results = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    const pixel1 = urls.findIndex(
      (url, index) =>
        url.includes("/pixel_1/") && !bodyOf(fetchMock, index).test_event_code,
    );
    expect(
      bodyOf(fetchMock, pixel1).data.map(
        (item: { event_id: string }) => item.event_id,
      ),
    ).toEqual([
      "workspace_1:lead_1:QualifiedLead",
      "workspace_1:lead_2:QualifiedLead",
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "sent",
      "sent",
      "sent",
      "sent",
    ]);
    // Each caller keeps its own request payload for per-event tracking.
    expect(results[0].requestPayload?.data).toHaveLength(1);
    expect(results[0].requestPayload?.data[0].event_id).toBe(
      "workspace_1:lead_1:QualifiedLead",
    );
    expect(results[0].responseSummary).toEqual({
      events_received: 1,
      messageCount: 0,
      batch_size: 2,
    });
    // nod: the provider body is never persisted (PII).
    expect(JSON.stringify(results.map((r) => r.responseSummary))).not.toContain(
      "synthetic",
    );
  });

  it("flushes as soon as the batch reaches the maximum size", async () => {
    const fetchMock: FetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return ack(body.data.length);
    });
    const adapter = new MetaCapiAdapter(
      { ...batchEnv, META_CAPI_BATCH_MAX_EVENTS: "2" },
      fetchMock,
    );

    const results = await Promise.all([
      adapter.sendEvent(event(1)),
      adapter.sendEvent(event(2)),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result.status === "sent")).toBe(true);
  });

  it("retries every event individually when Meta rejects the batch", async () => {
    const rejected = () =>
      new Response(
        JSON.stringify({ error: { message: "Invalid parameter", code: 100 } }),
        { status: 400 },
      );
    const fetchMock: FetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));

      if (body.data.length > 1) {
        return rejected();
      }

      return body.data[0].event_id.includes("lead_2") ? rejected() : ack(1);
    });
    const adapter = new MetaCapiAdapter(batchEnv, fetchMock);

    const pending = Promise.all([
      adapter.sendEvent(event(1)),
      adapter.sendEvent(event(2)),
      adapter.sendEvent(event(3)),
    ]);
    await adapter.flushAllBatches();
    const results = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(results.map((result) => [result.status, result.errorCode])).toEqual(
      [
        ["sent", null],
        ["error", "MetaCapiRejected"],
        ["sent", null],
      ],
    );
    // The individual rejection keeps only the numeric Graph code (#181).
    expect(results[1].responseSummary).toEqual({
      httpStatus: 400,
      error: { code: 100 },
    });
  });

  it.each([190, 102, 4, 17, 613])(
    "does not resend one by one when the whole batch fails with code %i",
    async (code) => {
      const fetchMock: FetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code, message: "synthetic private details" },
            }),
            { status: 400 },
          ),
      );
      const adapter = new MetaCapiAdapter(batchEnv, fetchMock);

      const pending = Promise.all([
        adapter.sendEvent(event(1)),
        adapter.sendEvent(event(2)),
        adapter.sendEvent(event(3)),
      ]);
      await adapter.flushAllBatches();
      const results = await pending;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(results.map((result) => result.errorCode)).toEqual([
        "MetaCapiRejected",
        "MetaCapiRejected",
        "MetaCapiRejected",
      ]);
      expect(results[0].responseSummary).toEqual({
        httpStatus: 400,
        error: { code },
      });
      expect(results[0].errorMessage).toBe(
        code === 190 || code === 102
          ? "Meta CAPI authentication failed (code 190/102): reconnect Meta and resend"
          : "Meta CAPI request failed",
      );
      expect(JSON.stringify(results)).not.toContain("synthetic private");
    },
  );

  it("retries individually when Meta confirms fewer events than sent", async () => {
    const fetchMock: FetchMock = vi.fn(async () => ack(1));
    const adapter = new MetaCapiAdapter(batchEnv, fetchMock);

    const pending = Promise.all([
      adapter.sendEvent(event(1)),
      adapter.sendEvent(event(2)),
    ]);
    await adapter.flushAllBatches();
    const results = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(results.every((result) => result.status === "sent")).toBe(true);
  });

  it("retries individually when the batch acknowledgement is incomplete (no fbtrace_id)", async () => {
    const fetchMock: FetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return body.data.length > 1
        ? new Response(JSON.stringify({ events_received: 2 }), { status: 200 })
        : ack(1);
    });
    const adapter = new MetaCapiAdapter(batchEnv, fetchMock);

    const pending = Promise.all([
      adapter.sendEvent(event(1)),
      adapter.sendEvent(event(2)),
    ]);
    await adapter.flushAllBatches();
    const results = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(results.every((result) => result.status === "sent")).toBe(true);
  });

  it("reports an unknown delivery for every event when the batch request is lost", async () => {
    const fetchMock: FetchMock = vi.fn(async () => {
      throw new Error("socket hang up synthetic-token");
    });
    const adapter = new MetaCapiAdapter(batchEnv, fetchMock);

    const pending = Promise.all([
      adapter.sendEvent(event(1)),
      adapter.sendEvent(event(2)),
    ]);
    await adapter.flushAllBatches();
    const results = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.errorCode)).toEqual([
      "MetaCapiNetworkError",
      "MetaCapiNetworkError",
    ]);
    expect(
      results.every((result) => result.deliveryOutcome === "unknown"),
    ).toBe(true);
    expect(JSON.stringify(results)).not.toContain("socket hang up");
  });

  it("never batches lease-guarded dispatches (deadline/signal)", async () => {
    const fetchMock: FetchMock = vi.fn(async () => ack(1));
    const adapter = new MetaCapiAdapter(batchEnv, fetchMock);

    const result = await adapter.sendEvent(event(1), {
      beforeDispatch: () => undefined,
    });

    expect(result.status).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
