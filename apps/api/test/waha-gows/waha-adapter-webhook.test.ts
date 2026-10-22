import { describe, expect, it } from "vitest";
import { WahaWhatsappAdapter } from "../../src/integrations/whatsapp-providers/waha-whatsapp.adapter";
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

type Call = { url: string; init?: RequestInit };

function fakeWaha(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected call");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { calls, adapter: new WahaWhatsappAdapter({}, fetchImpl) };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("WahaWhatsappAdapter.configureWebhook (motor GoWS)", () => {
  it("reads the session and PUTs it back preserving its config, replacing only our webhook", async () => {
    const { calls, adapter } = fakeWaha([
      json(200, {
        name: "aluno-sessao-teste",
        status: "WORKING",
        engine: { engine: "GOWS" },
        config: {
          proxy: { server: "proxy.example.com:3128" },
          metadata: { "user.id": "123" },
          noweb: null,
          webhooks: [
            { url: "https://n8n.example.com/hook", events: ["message"] },
            { url: `${ENDPOINT}?token=antigo`, events: ["message"] },
          ],
        },
      }),
      json(200, { name: "aluno-sessao-teste", status: "STARTING" }),
    ]);

    const result = await adapter.configureWebhook(config, {
      url: ENDPOINT,
      token: "token-novo",
    });

    expect(result).toEqual({
      configured: true,
      events: ["message", "message.any", "session.status"],
      sessionStatus: "WORKING",
    });
    expect(calls.map((call) => [call.init?.method, call.url])).toEqual([
      ["GET", "https://waha.example.com/api/sessions/aluno-sessao-teste"],
      ["PUT", "https://waha.example.com/api/sessions/aluno-sessao-teste"],
    ]);
    expect((calls[1]!.init?.headers as Record<string, string>)["X-Api-Key"]).toBe(
      "api-key-sintetica",
    );
    const body = JSON.parse(String(calls[1]!.init?.body));
    expect(body).toEqual({
      name: "aluno-sessao-teste",
      config: {
        proxy: { server: "proxy.example.com:3128" },
        metadata: { "user.id": "123" },
        noweb: null,
        webhooks: [
          { url: "https://n8n.example.com/hook", events: ["message"] },
          {
            url: ENDPOINT,
            events: ["message", "message.any", "session.status"],
            customHeaders: [
              { name: "X-Wpptrack-Webhook-Token", value: "token-novo" },
            ],
            retries: { policy: "linear", delaySeconds: 2, attempts: 5 },
          },
        ],
      },
    });
    // No QR, no session creation: only the session's own endpoint is used.
    expect(calls.some((call) => /qr|start|POST/i.test(`${call.url} ${call.init?.method}`))).toBe(false);
  });

  it("creates the webhooks list when the session has none", async () => {
    const { calls, adapter } = fakeWaha([
      json(200, { status: "SCAN_QR_CODE", config: null }),
      json(200, {}),
    ]);

    const result = await adapter.configureWebhook(config, {
      url: ENDPOINT,
      token: "token-novo",
    });

    expect(result).toMatchObject({ configured: true, sessionStatus: "SCAN_QR_CODE" });
    expect(JSON.parse(String(calls[1]!.init?.body)).config.webhooks).toHaveLength(1);
  });

  it.each([
    [404, "session_not_found"],
    [401, "unauthorized"],
    [403, "unauthorized"],
    [500, "provider_error"],
  ] as const)("does not PUT when reading the session answers %s", async (status, reason) => {
    const { calls, adapter } = fakeWaha([json(status, {})]);

    const result = await adapter.configureWebhook(config, {
      url: ENDPOINT,
      token: "token-novo",
    });

    expect(result).toMatchObject({ configured: false, reason });
    expect(calls).toHaveLength(1);
  });

  it("refuses a session that runs another engine (only GOWS is read)", async () => {
    const { calls, adapter } = fakeWaha([
      json(200, { status: "WORKING", engine: { engine: "NOWEB" }, config: {} }),
    ]);

    const result = await adapter.configureWebhook(config, {
      url: ENDPOINT,
      token: "token-novo",
    });

    expect(result).toMatchObject({
      configured: false,
      reason: "engine_not_supported",
      sessionStatus: "WORKING",
    });
    expect(calls).toHaveLength(1);
  });

  it("reports an unreachable server and a refused PUT without leaking the API key", async () => {
    const unreachable = fakeWaha([new Error("connect ECONNREFUSED api-key-sintetica")]);
    const refused = fakeWaha([json(200, { status: "WORKING", config: {} }), json(422, {})]);

    const first = await unreachable.adapter.configureWebhook(config, {
      url: ENDPOINT,
      token: "t",
    });
    const second = await refused.adapter.configureWebhook(config, {
      url: ENDPOINT,
      token: "t",
    });

    expect(first).toMatchObject({ configured: false, reason: "unreachable" });
    expect(second).toMatchObject({ configured: false, reason: "provider_error" });
    expect(JSON.stringify([first, second])).not.toContain("api-key-sintetica");
  });

  it("never falls back to env credentials or a default session when configuring", async () => {
    const adapter = new WahaWhatsappAdapter(
      { WAHA_BASE_URL: "https://env.example.com", WAHA_API_KEY: "env-key" },
      (async () => {
        throw new Error("must not call");
      }) as typeof fetch,
    );

    const result = await adapter.configureWebhook(
      { provider: "waha", config: { baseUrl: "https://waha.example.com", apiKey: "k" } },
      { url: ENDPOINT, token: "t" },
    );

    expect(result).toMatchObject({ configured: false, reason: "invalid_config" });
  });
});

describe("WahaWhatsappAdapter.getHealth (status da sessão)", () => {
  it.each([
    ["WORKING", "connected"],
    ["SCAN_QR_CODE", "needs_reconnect"],
    ["STARTING", "needs_reconnect"],
    ["FAILED", "error"],
    ["STOPPED", "disconnected"],
  ] as const)("maps %s to %s and exposes the raw status", async (status, expected) => {
    const { adapter } = fakeWaha([json(200, { status })]);

    const health = await adapter.getHealth(config);

    expect(health.status).toBe(expected);
    expect(health.providerStatus).toBe(status);
  });

  it("flags a session running another engine as an error", async () => {
    const { adapter } = fakeWaha([
      json(200, { status: "WORKING", engine: { engine: "WEBJS" } }),
    ]);

    const health = await adapter.getHealth(config);

    expect(health.status).toBe("error");
    expect(health.message).toBe("WAHA engine not supported: use GOWS");
  });
});
