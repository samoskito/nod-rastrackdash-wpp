import "reflect-metadata";
import { UnauthorizedException } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../../src/auth/auth.service";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import {
  RUNTIME_ENV,
  RUNTIME_FETCH,
} from "../../src/common/runtime/runtime.module";
import { MetaCloudWabaSubscriptionController } from "../../src/inbound-webhooks/meta-cloud-waba-subscription.controller";
import {
  META_CLOUD_WABA_RATE_LIMITS,
  MetaCloudWabaRateLimiter,
  type MetaCloudWabaRateLimits,
} from "../../src/inbound-webhooks/meta-cloud-waba-rate-limiter";
import {
  META_CLOUD_WABA_TIMEOUTS,
  MetaCloudWabaSubscriptionService,
  type MetaCloudWabaTimeouts,
} from "../../src/inbound-webhooks/meta-cloud-waba-subscription.service";
import { LicenseClientService } from "../../src/licensing-client/license-client.service";
import { LicenseSoftlockGuard } from "../../src/licensing-client/license-softlock.guard";
import { WorkspacesService } from "../../src/workspaces/workspaces.service";

// Valores sintéticos: nenhum é credencial real.
const STUDENT_TOKEN = "EAAGsyntheticStudentToken" + "Q".repeat(40);
const APP_ID = "111222333444555";
const APP_SECRET = "synthetic-app-secret-0123456789";
const WABA_ID = "102290129340398";
const PHONE_ID = "106540352242922";
const OTHER_APP = { id: "999888777666555", name: "Outro CRM" };
const bearer = "Bearer synthetic-session";
const base = "/integrations/inbound-webhooks/conn_meta/meta-cloud/waba-subscription";

type GraphCall = { method: string; path: string; query: URLSearchParams; auth: string };

type DebugData = {
  app_id?: string;
  type?: string;
  is_valid?: boolean;
  expires_at?: number;
  scopes?: string[];
  granular_scopes?: Array<{ scope: string; target_ids?: string[] }>;
};

function userToken(change: Partial<DebugData> = {}): DebugData {
  return {
    app_id: APP_ID,
    type: "USER",
    is_valid: true,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
    granular_scopes: [{ scope: "whatsapp_business_management" }],
    ...change,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function graphFake() {
  const state = {
    debug: userToken() as DebugData,
    subscribed: [{ whatsapp_business_api_data: { id: APP_ID, name: "App da instalação" } }] as unknown[],
    phoneNumbers: [{ id: PHONE_ID, display_phone_number: "+55 11 4000-0000", verified_name: "Loja Sintética" }] as unknown[],
    phoneNumbersError: null as null | { code: number },
    subscribedError: null as null | { code: number },
    postError: null as null | { code: number },
    postAddsApp: true,
    probeIsPhone: false,
    networkFailure: false,
    debugTopLevelError: null as null | { code: number },
    delayMs: 0,
    hangPath: null as null | string,
    calls: [] as GraphCall[],
  };
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    if (state.networkFailure) throw new TypeError(`fetch failed ${String(input)}`);
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/v\d+\.\d+/, "");
    const signal = init?.signal as AbortSignal | undefined;
    const wait = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    if (state.hangPath === path) await wait(60_000);
    if (state.delayMs > 0) await wait(state.delayMs);
    const auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    state.calls.push({ method, path, query: url.searchParams, auth });

    if (path === "/debug_token") {
      if (state.debugTopLevelError) return json({ error: state.debugTopLevelError }, 400);
      return json({ data: state.debug });
    }
    if (path === `/${WABA_ID}/phone_numbers` || path === `/${PHONE_ID}/phone_numbers`) {
      if (path === `/${PHONE_ID}/phone_numbers`) {
        return json({ error: { code: 100, message: "nonexisting field (phone_numbers)" } }, 400);
      }
      if (state.phoneNumbersError) return json({ error: state.phoneNumbersError }, 400);
      return json({ data: state.phoneNumbers });
    }
    if (path === `/${PHONE_ID}`) {
      return json({ id: PHONE_ID, display_phone_number: "+55 11 4000-0000" });
    }
    if (path === `/${WABA_ID}/subscribed_apps`) {
      if (method === "GET") {
        if (state.subscribedError) return json({ error: state.subscribedError }, 400);
        return json({ data: state.subscribed });
      }
      if (method === "POST") {
        if (state.postError) return json({ error: state.postError }, 400);
        if (state.postAddsApp) {
          state.subscribed.push({ whatsapp_business_api_data: { id: APP_ID, name: "App da instalação" } });
        }
        return json({ success: true });
      }
    }
    return json({ error: { code: 100, message: "unknown path" } }, 404);
  });
  return { state, fetchImpl };
}

function prismaFake() {
  const connections = [
    { id: "conn_meta", workspaceId: "ws", provider: "meta_cloud", removedAt: null },
    { id: "conn_umbler", workspaceId: "ws", provider: "umbler", removedAt: null },
    { id: "conn_foreign", workspaceId: "other_ws", provider: "meta_cloud", removedAt: null },
  ];
  const channels: Array<{ workspaceId: string; connectionId: string; organizationId: string; providerChannelId: string }> = [
    {
      workspaceId: "ws",
      connectionId: "conn_meta",
      organizationId: "provisional:conn_meta",
      providerChannelId: "provisional:5511940000000",
    },
  ];
  const audits: Array<{ data: Record<string, unknown> }> = [];
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const prisma = {
    inboundWebhookConnection: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        connections.find((row) => matches(row, where)) ?? null,
      ),
    },
    inboundWebhookChannel: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        channels.find((row) => matches(row, where)) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        channels.filter((row) => matches(row, where)),
      ),
    },
    auditLog: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        audits.push(args);
        return args.data;
      }),
    },
  };
  return { prisma, channels, audits };
}

const apps: NestExpressApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
});

async function fixture(
  options: {
    locked?: boolean;
    env?: Record<string, string | undefined>;
    limits?: Partial<MetaCloudWabaRateLimits>;
    timeouts?: MetaCloudWabaTimeouts;
  } = {},
) {
  const graph = graphFake();
  const db = prismaFake();
  const session: any = {
    user: { id: "actor", platformRole: "user" },
    activeWorkspaceId: "ws",
    workspaces: [{ id: "ws", name: "synthetic", slug: "synthetic", role: "owner", operationalStatus: "active" }],
  };
  const auth = {
    getSession: vi.fn(async (token: string) => {
      if (token !== "synthetic-session") throw new UnauthorizedException();
      return session;
    }),
  };
  const license = {
    getLockState: vi.fn(async () => ({
      inert: false,
      locked: Boolean(options.locked),
      reason: "revoked",
      state: { status: "blocked" },
    })),
  };
  const env = options.env ?? {
    META_APP_ID: APP_ID,
    META_APP_SECRET: APP_SECRET,
    META_GRAPH_API_VERSION: "v25.0",
  };
  const module = await Test.createTestingModule({
    controllers: [MetaCloudWabaSubscriptionController],
    providers: [
      MetaCloudWabaSubscriptionService,
      MetaCloudWabaRateLimiter,
      {
        provide: META_CLOUD_WABA_RATE_LIMITS,
        useValue: options.limits ?? { perUserMinIntervalMs: 0, perWorkspaceMax: 10_000 },
      },
      {
        provide: META_CLOUD_WABA_TIMEOUTS,
        useValue: options.timeouts ?? { callMs: 10_000, totalMs: 25_000 },
      },
      { provide: PrismaService, useValue: db.prisma },
      { provide: RUNTIME_ENV, useValue: env },
      { provide: RUNTIME_FETCH, useValue: graph.fetchImpl },
      { provide: AuthService, useValue: auth },
      { provide: WorkspacesService, useValue: new WorkspacesService({} as never) },
      { provide: LicenseClientService, useValue: license },
      { provide: APP_GUARD, useClass: LicenseSoftlockGuard },
    ],
  }).compile();
  const app = module.createNestApplication<NestExpressApplication>({ logger: false });
  apps.push(app);
  await app.init();
  return { ...graph, ...db, session, api: request(app.getHttpServer()) };
}

const lookupBody = { wabaId: WABA_ID, accessToken: STUDENT_TOKEN };
const subscribeBody = { ...lookupBody, confirm: true };

describe("Meta Cloud: consulta e inscrição do app na WABA", () => {
  it("consulta: já inscrito, marca 'este app' e lista outro app", async () => {
    const h = await fixture();
    h.state.subscribed.push({ whatsapp_business_api_data: OTHER_APP });

    const res = await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(200);

    expect(res.body).toMatchObject({
      connectionId: "conn_meta",
      wabaId: WABA_ID,
      thisAppId: APP_ID,
      thisAppSubscribed: true,
      outcome: "lookup",
      channelCheck: { status: "no_real_channel", mismatchedChannels: 0 },
    });
    expect(res.body.apps).toEqual([
      { appId: APP_ID, name: "App da instalação", isThisApp: true },
      { appId: OTHER_APP.id, name: OTHER_APP.name, isThisApp: false },
    ]);
    expect(h.state.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /debug_token",
      `GET /${WABA_ID}/phone_numbers`,
      `GET /${WABA_ID}/subscribed_apps`,
    ]);
    // debug_token usa o app token montado no servidor; as demais, o token do aluno.
    expect(h.state.calls[0]!.auth).toBe(`Bearer ${APP_ID}|${APP_SECRET}`);
    expect(h.state.calls[0]!.query.get("input_token")).toBe(STUDENT_TOKEN);
    expect(h.state.calls[1]!.auth).toBe(`Bearer ${STUDENT_TOKEN}`);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]!.data).toMatchObject({
      workspaceId: "ws",
      actorUserId: "actor",
      action: "inbound_webhook.meta_cloud_waba_lookup",
      targetId: "conn_meta",
      resultStatus: "subscribed",
      afterSummary: expect.objectContaining({ wabaId: WABA_ID, otherAppsCount: 1 }),
    });
  });

  it("assinar quando já inscrito não faz POST", async () => {
    const h = await fixture();
    const res = await h.api.post(base).set("Authorization", bearer).send(subscribeBody).expect(200);
    expect(res.body).toMatchObject({ outcome: "already_subscribed", thisAppSubscribed: true });
    expect(h.state.calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("ausente: assina, reconsulta e preserva o outro app sem DELETE", async () => {
    const h = await fixture();
    h.state.subscribed = [{ whatsapp_business_api_data: OTHER_APP }];

    const before = await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(200);
    expect(before.body.thisAppSubscribed).toBe(false);

    const res = await h.api.post(base).set("Authorization", bearer).send(subscribeBody).expect(200);

    expect(res.body).toMatchObject({ outcome: "subscribed", thisAppSubscribed: true });
    expect(res.body.apps.map((a: { appId: string }) => a.appId)).toEqual([OTHER_APP.id, APP_ID]);
    const posts = h.state.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe(`/${WABA_ID}/subscribed_apps`);
    expect(posts[0]!.query.has("override_callback_uri")).toBe(false);
    expect(posts[0]!.auth).toBe(`Bearer ${STUDENT_TOKEN}`);
    expect(h.state.calls.some((c) => c.method === "DELETE")).toBe(false);
    const subscribeCalls = h.state.calls.slice(h.state.calls.indexOf(posts[0]!));
    expect(subscribeCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST /${WABA_ID}/subscribed_apps`,
      `GET /${WABA_ID}/subscribed_apps`,
    ]);
    expect(h.audits.at(-1)!.data).toMatchObject({
      action: "inbound_webhook.meta_cloud_waba_subscribe",
      resultStatus: "subscribed",
      afterSummary: expect.objectContaining({ outcome: "subscribed", otherAppsCount: 1 }),
    });
  });

  it("devolve o estado real quando a Meta aceita o POST mas a reconsulta não mostra o app", async () => {
    const h = await fixture();
    h.state.subscribed = [];
    h.state.postAddsApp = false;
    const res = await h.api.post(base).set("Authorization", bearer).send(subscribeBody).expect(200);
    expect(res.body).toMatchObject({ outcome: "subscribe_unconfirmed", thisAppSubscribed: false, apps: [] });
  });

  it("exige confirm: true para assinar", async () => {
    const h = await fixture();
    const res = await h.api.post(base).set("Authorization", bearer).send(lookupBody).expect(400);
    expect(res.body.code).toBe("invalid_input");
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["token inválido", { is_valid: false }, "token_invalid"],
    ["token expirado", { expires_at: 1_000 }, "token_invalid"],
    ["app divergente", { app_id: "777000777000777" }, "token_app_mismatch"],
    ["sem escopo", { scopes: ["whatsapp_business_messaging"] }, "token_missing_scope"],
    ["tipo de token não aceito", { type: "PAGE" }, "token_type_not_supported"],
    [
      "WABA fora dos target_ids",
      { granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["555000555000555"] }] },
      "token_waba_not_granted",
    ],
  ])("bloqueia %s antes de tocar na WABA", async (_label, change, code) => {
    const h = await fixture();
    h.state.debug = userToken(change as Partial<DebugData>);

    const res = await h.api.post(base).set("Authorization", bearer).send(subscribeBody).expect(422);

    expect(res.body.code).toBe(code);
    expect(res.body.message).toMatch(/[ãçéêóú]/);
    expect(h.state.calls.filter((c) => c.path.includes("subscribed_apps"))).toHaveLength(0);
    expect(h.audits.at(-1)!.data).toMatchObject({
      resultStatus: "failed",
      afterSummary: expect.objectContaining({ wabaId: WABA_ID, errorCode: code }),
    });
  });

  it("aceita token USER com target_ids contendo a WABA e token SYSTEM_USER", async () => {
    const h = await fixture();
    h.state.debug = userToken({
      granular_scopes: [{ scope: "whatsapp_business_management", target_ids: [WABA_ID] }],
    });
    await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(200);
    h.state.debug = userToken({ type: "SYSTEM_USER", expires_at: 0 });
    await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(200);
  });

  it("token USER sem target_ids: a confirmação fica com a Graph (permissão negada 200)", async () => {
    const h = await fixture();
    h.state.debug = userToken({ granular_scopes: [{ scope: "whatsapp_business_management" }] });
    h.state.subscribedError = { code: 200 };

    const res = await h.api.post(base).set("Authorization", bearer).send(subscribeBody).expect(422);

    expect(res.body.code).toBe("permission_denied");
    expect(h.state.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("permissão negada (200) no POST de inscrição", async () => {
    const h = await fixture();
    h.state.subscribed = [];
    h.state.postError = { code: 200 };
    const res = await h.api.post(base).set("Authorization", bearer).send(subscribeBody).expect(422);
    expect(res.body.code).toBe("permission_denied");
  });

  it("detecta phone number ID no lugar do WABA ID (sem target_ids, pela Graph)", async () => {
    const h = await fixture();
    const res = await h.api
      .post(`${base}/lookup`)
      .set("Authorization", bearer)
      .send({ wabaId: PHONE_ID, accessToken: STUDENT_TOKEN })
      .expect(422);
    expect(res.body.code).toBe("waba_id_is_phone_number");
    expect(res.body.message).toContain("ID da conta do WhatsApp Business");
  });

  it("detecta phone number ID pelo canal real da conexão quando há target_ids", async () => {
    const h = await fixture();
    h.channels.push({ workspaceId: "ws", connectionId: "conn_meta", organizationId: WABA_ID, providerChannelId: PHONE_ID });
    h.state.debug = userToken({
      granular_scopes: [{ scope: "whatsapp_business_management", target_ids: [WABA_ID] }],
    });
    const res = await h.api
      .post(`${base}/lookup`)
      .set("Authorization", bearer)
      .send({ wabaId: PHONE_ID, accessToken: STUDENT_TOKEN })
      .expect(422);
    expect(res.body.code).toBe("waba_id_is_phone_number");
  });

  it("avisa quando o phone number ID real do canal não pertence à WABA", async () => {
    const h = await fixture();
    h.channels.push({ workspaceId: "ws", connectionId: "conn_meta", organizationId: "300300300300300", providerChannelId: "200200200200200" });
    const res = await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(200);
    expect(res.body.channelCheck).toEqual({ status: "mismatch", mismatchedChannels: 1 });

    h.channels.splice(1, 1, { workspaceId: "ws", connectionId: "conn_meta", organizationId: WABA_ID, providerChannelId: PHONE_ID });
    const ok = await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(200);
    expect(ok.body.channelCheck).toEqual({ status: "all_match", mismatchedChannels: 0 });
  });

  it.each([
    ["WABA inexistente (100)", { phoneNumbersError: { code: 100 } }, 422, "waba_not_found"],
    ["limite (4)", { phoneNumbersError: { code: 4 } }, 429, "rate_limited"],
    ["limite (80007)", { subscribedError: { code: 80007 } }, 429, "rate_limited"],
    ["token revogado na chamada (190)", { subscribedError: { code: 190 } }, 422, "token_invalid"],
    ["permissão (10)", { phoneNumbersError: { code: 10 } }, 422, "permission_denied"],
    ["rede/timeout", { networkFailure: true }, 504, "graph_unavailable"],
  ])("mapeia %s", async (_label, change, status, code) => {
    const h = await fixture();
    Object.assign(h.state, change);
    const res = await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(status);
    expect(res.body.code).toBe(code);
  });

  it.each([
    ["sem META_APP_ID", { META_APP_SECRET: APP_SECRET }],
    ["sem META_APP_SECRET", { META_APP_ID: APP_ID }],
  ])("%s: responde que a instalação precisa das variáveis, sem chamar a Meta", async (_label, env) => {
    const h = await fixture({ env });
    const res = await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(503);
    expect(res.body.code).toBe("meta_app_not_configured");
    expect(res.body.message).toContain("App ID e App Secret");
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["analyst", "viewer"])("membro %s sem permissão recebe 403 e nada é chamado", async (role) => {
    const h = await fixture();
    h.session.workspaces[0].role = role;
    await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(403);
    await h.api.post(base).set("Authorization", bearer).send(subscribeBody).expect(403);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.audits).toHaveLength(0);
  });

  it("admin do workspace pode consultar", async () => {
    const h = await fixture();
    h.session.workspaces[0].role = "admin";
    await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(200);
  });

  it("licença bloqueada: 423 e nenhuma chamada à Meta", async () => {
    const h = await fixture({ locked: true });
    await h.api.post(base).set("Authorization", bearer).send(subscribeBody).expect(423);
    await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(423);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("isolamento: conexão de outro workspace é 404, conexão não Meta Cloud é 400", async () => {
    const h = await fixture();
    await h.api
      .post(base.replace("conn_meta", "conn_foreign"))
      .set("Authorization", bearer)
      .send(subscribeBody)
      .expect(404);
    const other = await h.api
      .post(`${base.replace("conn_meta", "conn_umbler")}/lookup`)
      .set("Authorization", bearer)
      .send(lookupBody)
      .expect(400);
    expect(other.body.code).toBe("connection_not_meta_cloud");
    await h.api.post(`${base}/lookup`).send(lookupBody).expect(401);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.audits).toHaveLength(0);
    // O workspace vem só da sessão: o corpo não aceita workspaceId.
    await h.api
      .post(`${base}/lookup`)
      .set("Authorization", bearer)
      .send({ ...lookupBody, workspaceId: "other_ws" })
      .expect(400);
  });

  it("nenhum segredo na resposta, nos logs ou na auditoria", async () => {
    const output: string[] = [];
    const capture = (...args: unknown[]) => {
      output.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation(capture);
    }
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as never);

    const h = await fixture();
    const bodies: string[] = [];
    h.state.subscribed = [{ whatsapp_business_api_data: OTHER_APP }];
    bodies.push(JSON.stringify((await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody)).body));
    bodies.push(JSON.stringify((await h.api.post(base).set("Authorization", bearer).send(subscribeBody)).body));
    h.state.debug = userToken({ app_id: "777000777000777" });
    bodies.push(JSON.stringify((await h.api.post(base).set("Authorization", bearer).send(subscribeBody)).body));
    h.state.networkFailure = true;
    bodies.push(JSON.stringify((await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody)).body));
    bodies.push(
      JSON.stringify(
        (await h.api.post(base).set("Authorization", bearer).send({ wabaId: "abc", accessToken: STUDENT_TOKEN, confirm: true })).body,
      ),
    );
    bodies.push(
      JSON.stringify(
        (await h.api.post(base).set("Authorization", bearer).send({ wabaId: WABA_ID, accessToken: `${STUDENT_TOKEN} x`, confirm: true })).body,
      ),
    );

    const everything = [...bodies, ...output, JSON.stringify(h.audits)].join("\n");
    expect(h.audits.length).toBeGreaterThanOrEqual(4);
    for (const secret of [STUDENT_TOKEN, APP_SECRET, `${APP_ID}|${APP_SECRET}`]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).not.toMatch(/access_?token|input_token/i);
  });

  it("limite por usuário: 429 com code rate_limited e libera depois do intervalo", async () => {
    let now = 1_000_000;
    const h = await fixture({ limits: { perUserMinIntervalMs: 4_000, perWorkspaceMax: 20, now: () => now } });
    await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(200);
    const callsBefore = h.fetchImpl.mock.calls.length;
    const blocked = await h.api.post(base).set("Authorization", bearer).send(subscribeBody).expect(429);
    expect(blocked.body.code).toBe("rate_limited");
    expect(blocked.body.message).toContain("Aguarde alguns segundos");
    expect(h.fetchImpl.mock.calls.length).toBe(callsBefore);
    now += 4_000;
    await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(200);
  });

  it("limite por workspace: teto de 20 por hora entre usuários", async () => {
    let now = 5_000_000;
    const h = await fixture({ limits: { perUserMinIntervalMs: 4_000, perWorkspaceMax: 20, now: () => now } });
    for (let i = 0; i < 20; i += 1) {
      now += 5_000;
      await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(200);
    }
    now += 5_000;
    h.session.user.id = "other_admin";
    const res = await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(429);
    expect(res.body.code).toBe("rate_limited");
    expect(res.body.message).toContain("última hora");
    now += 60 * 60 * 1000;
    await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(200);
  });

  it("falha ao gravar a auditoria de um sucesso não vira erro nem gera 'failed'", async () => {
    const h = await fixture();
    h.prisma.auditLog.create.mockRejectedValueOnce(new Error(`db down ${STUDENT_TOKEN}`));
    const res = await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(200);
    expect(res.body.thisAppSubscribed).toBe(true);
    expect(h.prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(h.audits.some((a) => a.data.resultStatus === "failed")).toBe(false);
  });

  it("código desconhecido na consulta não fala em inscrição; no POST, sim", async () => {
    const h = await fixture();
    h.state.subscribedError = { code: 99999 };
    const lookup = await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(502);
    expect(lookup.body.code).toBe("graph_unavailable");
    expect(lookup.body.message).not.toMatch(/inscrição/);

    h.state.subscribedError = null;
    h.state.subscribed = [];
    h.state.postError = { code: 99999 };
    const sub = await h.api.post(base).set("Authorization", bearer).send(subscribeBody).expect(502);
    expect(sub.body.code).toBe("subscribe_failed");
  });

  it("erro 100 no nível de cima do debug_token é credencial da instalação", async () => {
    const h = await fixture();
    h.state.debugTopLevelError = { code: 100 };
    const res = await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(503);
    expect(res.body.code).toBe("meta_app_not_configured");
    expect(res.body.message).toContain("App ID e App Secret");
  });

  it("prazo total da operação: 504 sugerindo Consultar de novo", async () => {
    const h = await fixture({ timeouts: { callMs: 5_000, totalMs: 250 } });
    h.state.delayMs = 20;
    h.state.hangPath = `/${WABA_ID}/subscribed_apps`;
    const started = Date.now();
    const res = await h.api.post(base).set("Authorization", bearer).send(subscribeBody).expect(504);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(res.body.code).toBe("graph_unavailable");
    expect(res.body.message).toContain("Consultar");
    expect(h.state.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("grava o IP de origem na auditoria", async () => {
    const h = await fixture();
    await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(200);
    expect(typeof h.audits[0]!.data.sourceIp).toBe("string");
  });
});
