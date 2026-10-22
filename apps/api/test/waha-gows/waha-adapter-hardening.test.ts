import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WAHA_LID_LOOKUP_TIMEOUT_MS,
  WAHA_SESSION_UPDATE_TIMEOUT_MS,
  WahaWhatsappAdapter,
} from "../../src/integrations/whatsapp-providers/waha-whatsapp.adapter";
import type { WhatsappProviderConfig } from "../../src/integrations/whatsapp-providers/whatsapp-provider.types";

const config: WhatsappProviderConfig = {
  provider: "waha",
  config: {
    baseUrl: "https://waha.example.com",
    apiKey: "api-key-sintetica",
    session: "aluno-sessao-teste",
  },
};
const ENDPOINT = "https://api.example.com/webhooks/whatsapp/connection-waha";
const TOKEN = "token-novo-sintetico";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function ourWebhook(token = TOKEN) {
  return {
    url: ENDPOINT,
    events: ["message", "message.any", "session.status"],
    customHeaders: [{ name: "X-Wpptrack-Webhook-Token", value: token }],
  };
}

type Step = (url: string, init: RequestInit) => Promise<Response>;

function fakeWaha(steps: Step[]) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body as string });
    const step = steps.shift();
    if (!step) throw new Error("unexpected call");
    return step(url, init);
  }) as typeof fetch;
  return { calls, adapter: new WahaWhatsappAdapter({}, fetchImpl) };
}

/** Never answers; rejects only when the request is aborted by its timeout. */
const hang: Step = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    });
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("WAHA configureWebhook — PUT que reinicia a sessão", () => {
  it("waits longer than the read timeout for the PUT (session restart)", async () => {
    vi.useFakeTimers();
    const { adapter } = fakeWaha([
      async () => json(200, { status: "WORKING", config: {} }),
      () =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(json(200, {})), 12_000);
          void reject;
          void timer;
        }),
    ]);

    const pending = adapter.configureWebhook(config, { url: ENDPOINT, token: TOKEN });
    await vi.advanceTimersByTimeAsync(12_000);

    await expect(pending).resolves.toMatchObject({ configured: true });
    expect(WAHA_SESSION_UPDATE_TIMEOUT_MS).toBe(30_000);
  });

  it("on PUT timeout, re-reads the session and succeeds when our webhook is saved", async () => {
    vi.useFakeTimers();
    const { adapter, calls } = fakeWaha([
      async () => json(200, { status: "WORKING", config: {} }),
      hang,
      async () =>
        json(200, { status: "STARTING", config: { webhooks: [ourWebhook()] } }),
    ]);

    const pending = adapter.configureWebhook(config, { url: ENDPOINT, token: TOKEN });
    await vi.advanceTimersByTimeAsync(WAHA_SESSION_UPDATE_TIMEOUT_MS);

    await expect(pending).resolves.toMatchObject({ configured: true });
    expect(calls.map((call) => call.method)).toEqual(["GET", "PUT", "GET"]);
  });

  it("on PUT 5xx, re-reads the session and succeeds when our webhook is saved", async () => {
    const { adapter, calls } = fakeWaha([
      async () => json(200, { status: "WORKING", config: {} }),
      async () => json(502, {}),
      async () => json(200, { config: { webhooks: [ourWebhook()] } }),
    ]);

    await expect(
      adapter.configureWebhook(config, { url: ENDPOINT, token: TOKEN }),
    ).resolves.toMatchObject({ configured: true });
    expect(calls.map((call) => call.method)).toEqual(["GET", "PUT", "GET"]);
  });

  it.each([
    ["the old token", { webhooks: [ourWebhook("token-antigo")] }],
    ["a masked token", { webhooks: [ourWebhook("****")] }],
    ["missing events", { webhooks: [{ ...ourWebhook(), events: ["message"] }] }],
    ["no webhook", {}],
  ])("on PUT 5xx, fails when the re-read shows %s", async (_label, savedConfig) => {
    const { adapter } = fakeWaha([
      async () => json(200, { status: "WORKING", config: {} }),
      async () => json(503, {}),
      async () => json(200, { config: savedConfig }),
    ]);

    await expect(
      adapter.configureWebhook(config, { url: ENDPOINT, token: TOKEN }),
    ).resolves.toMatchObject({ configured: false, reason: "provider_error" });
  });

  it("does not re-read on a 4xx refusal", async () => {
    const { adapter, calls } = fakeWaha([
      async () => json(200, { status: "WORKING", config: {} }),
      async () => json(422, {}),
    ]);

    await expect(
      adapter.configureWebhook(config, { url: ENDPOINT, token: TOKEN }),
    ).resolves.toMatchObject({ configured: false, reason: "provider_error" });
    expect(calls).toHaveLength(2);
  });
});

describe("WAHA configureWebhook — segredos mascarados", () => {
  it.each([
    [
      "proxy with a masked password",
      { proxy: { server: "proxy.example.com:3128", username: "u", password: "********" } },
    ],
    [
      "another system's webhook with a masked hmac key",
      {
        webhooks: [
          { url: "https://n8n.example.com/hook", events: ["message"], hmac: { key: "abc***" } },
        ],
      },
    ],
    [
      "another system's webhook with masked custom headers",
      {
        webhooks: [
          {
            url: "https://crm.example.com/hook",
            customHeaders: [{ name: "Authorization", value: "Bearer *****" }],
          },
        ],
      },
    ],
  ])("never PUTs when the session config has %s", async (_label, sessionConfig) => {
    const { adapter, calls } = fakeWaha([
      async () => json(200, { status: "WORKING", config: sessionConfig }),
    ]);

    const result = await adapter.configureWebhook(config, {
      url: ENDPOINT,
      token: TOKEN,
    });

    expect(result).toMatchObject({
      configured: false,
      reason: "masked_secrets",
      sessionStatus: "WORKING",
    });
    expect(result.configured ? "" : result.message).toMatch(/configuração manual/u);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("ignores our own old webhook, even if its token comes back masked", async () => {
    const { adapter, calls } = fakeWaha([
      async () =>
        json(200, {
          status: "WORKING",
          config: { webhooks: [ourWebhook("********")] },
        }),
      async () => json(200, {}),
    ]);

    await expect(
      adapter.configureWebhook(config, { url: ENDPOINT, token: TOKEN }),
    ).resolves.toMatchObject({ configured: true });
    const body = JSON.parse(calls[1]!.body!);
    expect(body.config.webhooks).toEqual([
      expect.objectContaining({
        customHeaders: [{ name: "X-Wpptrack-Webhook-Token", value: TOKEN }],
      }),
    ]);
  });
});

describe("WAHA resolveLidPhone (GET /api/{session}/lids/{lid})", () => {
  it("returns the phone of a known LID", async () => {
    const { adapter, calls } = fakeWaha([
      async () => json(200, { lid: "100000000000113@lid", pn: "5500900000113@c.us" }),
    ]);

    await expect(adapter.resolveLidPhone(config, "100000000000113")).resolves.toBe(
      "5500900000113",
    );
    expect(calls[0]!.url).toBe(
      "https://waha.example.com/api/aluno-sessao-teste/lids/100000000000113",
    );
  });

  it.each([
    ["an unknown LID (pn null)", async () => json(200, { lid: "x@lid", pn: null })],
    ["a LID as pn", async () => json(200, { pn: "100000000000113@lid" })],
    ["an HTTP error", async () => json(404, {})],
    ["a network error", async () => Promise.reject(new Error("down"))],
  ] as Array<[string, Step]>)("returns null for %s, without throwing", async (_label, step) => {
    const { adapter } = fakeWaha([step]);

    await expect(adapter.resolveLidPhone(config, "100000000000113")).resolves.toBeNull();
  });

  it("gives up after the short lookup timeout", async () => {
    vi.useFakeTimers();
    const { adapter } = fakeWaha([hang]);

    const pending = adapter.resolveLidPhone(config, "100000000000113");
    await vi.advanceTimersByTimeAsync(WAHA_LID_LOOKUP_TIMEOUT_MS);

    await expect(pending).resolves.toBeNull();
    expect(WAHA_LID_LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(3_000);
  });
});
