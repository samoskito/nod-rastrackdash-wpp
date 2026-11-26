import "reflect-metadata";
import { createHash } from "node:crypto";
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
import { InboundWebhookMetaCloudVerificationService } from "../../src/inbound-webhooks/inbound-webhook-meta-cloud-verification.service";
import { InboundWebhookPublicController } from "../../src/inbound-webhooks/inbound-webhook-public.controller";
import { MetaCloudWabaSubscriptionController } from "../../src/inbound-webhooks/meta-cloud-waba-subscription.controller";
import {
  META_CLOUD_WABA_RATE_LIMITS,
  MetaCloudWabaRateLimiter,
  type MetaCloudWabaRateLimits,
} from "../../src/inbound-webhooks/meta-cloud-waba-rate-limiter";
import {
  META_CLOUD_WABA_TIMEOUTS,
  MetaCloudWabaSubscriptionService,
  classifyMetaCloudCallbackUrl,
  type MetaCloudWabaTimeouts,
} from "../../src/inbound-webhooks/meta-cloud-waba-subscription.service";
import { encryptMetaCloudAppSecret } from "../../src/inbound-webhooks/meta-cloud-app-secret";
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

type GraphCall = {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string;
  body: string | null;
  contentType: string | null;
};

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
    /** GET /{APP_ID}/subscriptions (null = a Meta recusa). */
    appSubscriptions: null as null | unknown[],
    /** webhook_configuration do número (undefined = sem o campo). */
    phoneWebhookConfiguration: undefined as undefined | Record<string, string>,
    /** O POST com desvio grava o override_callback_uri no item deste app. */
    postAppliesOverride: true,
    /** Erro da reconsulta de subscribed_apps depois de um POST aceito. */
    subscribedErrorAfterPost: null as null | { code: number },
    /** Erro ao ler webhook_configuration do número. */
    phoneConfigError: null as null | { code: number },
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
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = String(headers.Authorization ?? "");
    const body = typeof init?.body === "string" ? init.body : null;
    state.calls.push({
      method,
      path,
      query: url.searchParams,
      auth,
      body,
      contentType: headers["Content-Type"] ?? null,
    });

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
      if (url.searchParams.get("fields") === "webhook_configuration") {
        if (state.phoneConfigError) return json({ error: state.phoneConfigError }, 400);
        return json({
          id: PHONE_ID,
          ...(state.phoneWebhookConfiguration
            ? { webhook_configuration: state.phoneWebhookConfiguration }
            : {}),
        });
      }
      return json({ id: PHONE_ID, display_phone_number: "+55 11 4000-0000" });
    }
    if (path === `/${APP_ID}/subscriptions`) {
      if (!state.appSubscriptions) return json({ error: { code: 100 } }, 400);
      return json({ data: state.appSubscriptions });
    }
    if (path === `/${WABA_ID}/subscribed_apps`) {
      if (method === "GET") {
        if (state.subscribedError) return json({ error: state.subscribedError }, 400);
        return json({ data: state.subscribed });
      }
      if (method === "POST") {
        if (state.postError) return json({ error: state.postError }, 400);
        if (state.subscribedErrorAfterPost) state.subscribedError = state.subscribedErrorAfterPost;
        const parsed = body ? (JSON.parse(body) as Record<string, string>) : {};
        const override = parsed.override_callback_uri;
        // Igual à Meta: reinscrever sem corpo apaga o desvio deste app.
        state.subscribed = state.subscribed.filter(
          (item) =>
            (item as { whatsapp_business_api_data?: { id?: string } }).whatsapp_business_api_data?.id !== APP_ID,
        );
        if (state.postAddsApp) {
          state.subscribed.push({
            whatsapp_business_api_data: { id: APP_ID, name: "App da instalação" },
            ...(override && state.postAppliesOverride ? { override_callback_uri: override } : {}),
          });
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
  return { prisma, channels, audits, connections };
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
      // Leituras só para a tela (URL do app e desvio por número).
      `GET /${APP_ID}/subscriptions`,
      `GET /${PHONE_ID}`,
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
      `GET /${APP_ID}/subscriptions`,
      `GET /${PHONE_ID}`,
    ]);
    expect(posts[0]!.body).toBeNull();
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
    expect(res.body.message).toContain("App Secret");
    expect(res.body.message).toContain("App do Meta desta conexão");
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
    expect(res.body.message).toContain("META_APP_ID e META_APP_SECRET");
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

describe("Meta Cloud WABA: app Meta salvo na conexão (agências, um app por BM)", () => {
  const CONNECTION_APP_ID = "555444333222111";
  const CONNECTION_APP_SECRET = "connection-app-secret-abcdef0123456789";
  const encryptionEnv = {
    NODE_ENV: "test",
    API_PUBLIC_URL: "http://localhost:3333",
    INBOUND_WEBHOOKS_ENABLED: "true",
    INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  };

  async function withConnectionApp(
    env: Record<string, string | undefined>,
    secret: string | null = CONNECTION_APP_SECRET,
  ) {
    const h = await fixture({
      env: { ...encryptionEnv, META_GRAPH_API_VERSION: "v25.0", ...env },
    });
    const connection = h.connections.find(
      (row) => row.id === "conn_meta",
    ) as Record<string, unknown>;
    connection.metaAppId = CONNECTION_APP_ID;
    connection.metaAppSecretEncrypted =
      secret === null
        ? "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==.AAAA"
        : encryptMetaCloudAppSecret(
            secret,
            { workspaceId: "ws", connectionId: "conn_meta" },
            encryptionEnv,
          );
    h.state.debug = userToken({ app_id: CONNECTION_APP_ID });
    h.state.subscribed = [
      { whatsapp_business_api_data: { id: CONNECTION_APP_ID, name: "App do cliente" } },
    ];
    return h;
  }

  it("usa o App ID e o App Secret da conexão no debug_token, mesmo sem nada no ambiente", async () => {
    const h = await withConnectionApp({});
    const res = await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(200);
    expect(res.body).toMatchObject({ thisAppId: CONNECTION_APP_ID, thisAppSubscribed: true });
    const debug = h.state.calls.find((call) => call.path === "/debug_token");
    expect(debug?.auth).toBe(`Bearer ${CONNECTION_APP_ID}|${CONNECTION_APP_SECRET}`);
    expect(JSON.stringify(res.body)).not.toContain(CONNECTION_APP_SECRET);
    expect(JSON.stringify(h.audits)).not.toContain(CONNECTION_APP_SECRET);
  });

  it("a conexão vence o app do ambiente: token do app da instalação é de outro app", async () => {
    const h = await withConnectionApp({ META_APP_ID: APP_ID, META_APP_SECRET: APP_SECRET });
    h.state.debug = userToken({ app_id: APP_ID });
    const res = await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(422);
    expect(res.body.code).toBe("token_app_mismatch");
    const debug = h.state.calls.find((call) => call.path === "/debug_token");
    expect(debug?.auth).toBe(`Bearer ${CONNECTION_APP_ID}|${CONNECTION_APP_SECRET}`);
    expect(debug?.auth).not.toContain(APP_SECRET);
  });

  it("credenciais da conexão recusadas pela Meta apontam para o bloco da conexão", async () => {
    const h = await withConnectionApp({});
    h.state.debugTopLevelError = { code: 190 };
    const res = await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(503);
    expect(res.body.code).toBe("meta_app_not_configured");
    expect(res.body.message).toContain("salvos nesta conexão");
  });

  it("segredo salvo que não decifra: 503 sem cair para o app do ambiente e sem chamar a Meta", async () => {
    const h = await withConnectionApp({ META_APP_ID: APP_ID, META_APP_SECRET: APP_SECRET }, null);
    const res = await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(503);
    expect(res.body.code).toBe("meta_app_not_configured");
    expect(res.body.message).toContain("Salve o App ID e o App Secret de novo");
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// App central da agência: inscrição com desvio da WABA (override_callback_uri)
// ---------------------------------------------------------------------------

// Valor sintético: não é credencial real.
const VERIFY_TOKEN = "synthetic-verify-token-0123456789abcdef";
const PUBLIC_URL = "https://api.agencia-sintetica.test";
const CONNECTION_URL = `${PUBLIC_URL}/webhooks/inbound/conn_meta`;
const centralEnv = {
  META_APP_ID: APP_ID,
  META_APP_SECRET: APP_SECRET,
  META_GRAPH_API_VERSION: "v25.0",
  INBOUND_WEBHOOKS_ENABLED: "true",
  API_PUBLIC_URL: `${PUBLIC_URL}/`,
  INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const centralBody = {
  ...subscribeBody,
  mode: "agency_central_app",
  verifyToken: VERIFY_TOKEN,
};

async function centralFixture(env: Record<string, string | undefined> = centralEnv) {
  const h = await fixture({ env });
  Object.assign(h.connections[0]!, { secretHash: sha256(VERIFY_TOKEN) });
  return h;
}

function thisAppItem(override?: string) {
  return {
    whatsapp_business_api_data: { id: APP_ID, name: "App da agência" },
    ...(override ? { override_callback_uri: override } : {}),
  };
}

describe("App central da agência: inscrição com desvio da WABA", () => {
  it("envia override_callback_uri (URL desta conexão) e verify_token no corpo do POST, reconsulta e mostra o desvio ativo", async () => {
    const h = await centralFixture();
    h.state.subscribed = [{ whatsapp_business_api_data: OTHER_APP }];
    h.state.appSubscriptions = [
      {
        object: "whatsapp_business_account",
        callback_url: "https://agencia-sintetica.test/webhook-padrao",
        active: true,
        fields: [{ name: "messages", version: "v25.0" }],
      },
    ];

    const res = await h.api.post(base).set("Authorization", bearer).send(centralBody).expect(200);

    expect(res.body).toMatchObject({
      outcome: "override_set",
      mode: "agency_central_app",
      thisAppSubscribed: true,
      callback: {
        expectedUrl: CONNECTION_URL,
        wabaOverride: "this_connection",
        wabaOverrideHost: null,
        appCallback: "other_url",
        appMessagesField: true,
        effective: "this_connection",
      },
    });
    const posts = h.state.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe(`/${WABA_ID}/subscribed_apps`);
    expect(posts[0]!.contentType).toBe("application/json");
    expect(JSON.parse(posts[0]!.body ?? "{}")).toEqual({
      override_callback_uri: CONNECTION_URL,
      verify_token: VERIFY_TOKEN,
    });
    // O token de verificação nunca vai na URL.
    expect(posts[0]!.query.has("verify_token")).toBe(false);
    expect(h.state.calls.some((c) => c.method === "DELETE")).toBe(false);
    // O outro app continua inscrito.
    expect(res.body.apps.map((a: { appId: string }) => a.appId)).toContain(OTHER_APP.id);
    // Nem a resposta nem a auditoria carregam o token de verificação ou o do aluno.
    const everything = JSON.stringify({ body: res.body, audits: h.audits });
    expect(everything).not.toContain(VERIFY_TOKEN);
    expect(everything).not.toContain(STUDENT_TOKEN);
    expect(h.audits.at(-1)!.data).toMatchObject({
      action: "inbound_webhook.meta_cloud_waba_subscribe",
      afterSummary: expect.objectContaining({
        mode: "agency_central_app",
        outcome: "override_set",
        wabaOverride: "this_connection",
      }),
    });
  });

  it("app já inscrito sem desvio: reinscreve com o desvio (POST), sem DELETE", async () => {
    const h = await centralFixture();
    h.state.subscribed = [thisAppItem()];

    const res = await h.api.post(base).set("Authorization", bearer).send(centralBody).expect(200);

    expect(res.body.outcome).toBe("override_set");
    expect(h.state.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(h.state.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("desvio já aponta para esta conexão: nada é enviado (already_subscribed)", async () => {
    const h = await centralFixture();
    h.state.subscribed = [thisAppItem(`${CONNECTION_URL}/`)];

    const res = await h.api.post(base).set("Authorization", bearer).send(centralBody).expect(200);

    expect(res.body).toMatchObject({
      outcome: "already_subscribed",
      callback: { wabaOverride: "this_connection", effective: "this_connection" },
    });
    expect(h.state.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("a Meta aceita mas a reconsulta não mostra o desvio: override_unconfirmed", async () => {
    const h = await centralFixture();
    h.state.subscribed = [];
    h.state.postAppliesOverride = false;

    const res = await h.api.post(base).set("Authorization", bearer).send(centralBody).expect(200);

    expect(res.body).toMatchObject({
      outcome: "override_unconfirmed",
      callback: { wabaOverride: "none" },
    });
  });

  it("token de verificação errado: recusa antes de chamar a Meta", async () => {
    const h = await centralFixture();

    const res = await h.api
      .post(base)
      .set("Authorization", bearer)
      .send({ ...centralBody, verifyToken: "outro-token-de-verificacao" })
      .expect(422);

    expect(res.body.code).toBe("verify_token_mismatch");
    expect(res.body.message).toContain("Gerar nova URL");
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(h.audits)).not.toContain("outro-token-de-verificacao");
  });

  it("sem API_PUBLIC_URL em HTTPS: recusa antes de chamar a Meta", async () => {
    const h = await centralFixture({ ...centralEnv, API_PUBLIC_URL: "http://localhost:3333" });

    const res = await h.api.post(base).set("Authorization", bearer).send(centralBody).expect(422);

    expect(res.body.code).toBe("callback_url_unavailable");
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("modo App central sem token de verificação e modo padrão com token: 400 sem eco", async () => {
    const h = await centralFixture();

    const missing = await h.api
      .post(base)
      .set("Authorization", bearer)
      .send({ ...subscribeBody, mode: "agency_central_app" })
      .expect(400);
    expect(missing.body.code).toBe("invalid_input");
    expect(missing.body.message).toContain("token de verificação");

    const extra = await h.api
      .post(base)
      .set("Authorization", bearer)
      .send({ ...subscribeBody, verifyToken: VERIFY_TOKEN })
      .expect(400);
    expect(extra.body.code).toBe("invalid_input");
    expect(JSON.stringify(extra.body)).not.toContain(VERIFY_TOKEN);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("a Meta recusa a URL (falha na verificação): override_verification_failed", async () => {
    const h = await centralFixture();
    h.state.subscribed = [];
    h.state.postError = { code: 2200 };

    const res = await h.api.post(base).set("Authorization", bearer).send(centralBody).expect(422);

    expect(res.body.code).toBe("override_verification_failed");
    expect(res.body.message).toContain("HTTPS");
    expect(JSON.stringify(res.body)).not.toContain(VERIFY_TOKEN);
  });

  it("modo padrão com o app já inscrito e um desvio ativo: não envia nada (o desvio fica)", async () => {
    const h = await centralFixture();
    h.state.subscribed = [thisAppItem(CONNECTION_URL)];

    const res = await h.api.post(base).set("Authorization", bearer).send(subscribeBody).expect(200);

    expect(res.body).toMatchObject({
      outcome: "already_subscribed",
      mode: "standard",
      callback: { wabaOverride: "this_connection" },
    });
    expect(h.state.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("consulta nunca envia nada, mesmo se o corpo pedir o modo App central", async () => {
    const h = await centralFixture();
    await h.api
      .post(`${base}/lookup`)
      .set("Authorization", bearer)
      .send({ ...lookupBody, mode: "agency_central_app" })
      .expect(400);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("estado do destino: desvio da WABA, URL do app e desvio por número", () => {
  it("desvio para outra conexão deste painel", async () => {
    const h = await centralFixture();
    h.state.subscribed = [thisAppItem(`${PUBLIC_URL}/webhooks/inbound/conn_outra`)];

    const res = await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(200);

    expect(res.body.callback).toMatchObject({
      wabaOverride: "other_connection_here",
      wabaOverrideHost: null,
      effective: "elsewhere",
    });
  });

  it("desvio para outro endereço: mostra só o domínio, nunca caminho ou parâmetros", async () => {
    const h = await centralFixture();
    h.state.subscribed = [thisAppItem("https://crm-terceiro.test/hook/abc?token=segredo-de-terceiro")];

    const res = await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(200);

    expect(res.body.callback).toMatchObject({
      wabaOverride: "other_url",
      wabaOverrideHost: "crm-terceiro.test",
      effective: "elsewhere",
    });
    expect(JSON.stringify(res.body)).not.toContain("segredo-de-terceiro");
    expect(JSON.stringify(res.body)).not.toContain("/hook/abc");
  });

  it("sem desvio: vale a URL do app (lida com o app token) e o campo messages", async () => {
    const h = await centralFixture();
    h.state.subscribed = [thisAppItem()];
    h.state.appSubscriptions = [
      { object: "whatsapp_business_account", callback_url: CONNECTION_URL, active: true, fields: ["messages"] },
    ];

    const res = await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(200);

    expect(res.body.callback).toMatchObject({
      wabaOverride: "none",
      appCallback: "this_connection",
      appMessagesField: true,
      effective: "this_connection",
      phoneOverrides: [{ phoneNumberId: PHONE_ID, target: "none" }],
    });
    const appRead = h.state.calls.find((c) => c.path === `/${APP_ID}/subscriptions`);
    expect(appRead!.auth).toBe(`Bearer ${APP_ID}|${APP_SECRET}`);
  });

  it("URL do app ilegível e sem desvio: destino desconhecido, sem derrubar a consulta", async () => {
    const h = await centralFixture();
    h.state.subscribed = [thisAppItem()];
    h.state.appSubscriptions = null;

    const res = await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(200);

    expect(res.body.callback).toMatchObject({
      appCallback: "unknown",
      appMessagesField: null,
      effective: "unknown",
    });
  });

  it("desvio do número vence o da WABA", async () => {
    const h = await centralFixture();
    h.state.subscribed = [thisAppItem(CONNECTION_URL)];
    h.state.phoneWebhookConfiguration = {
      phone_number: "https://outro-destino.test/numero",
      whatsapp_business_account: CONNECTION_URL,
      application: "https://agencia-sintetica.test/webhook-padrao",
    };

    const res = await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(200);

    expect(res.body.callback).toMatchObject({
      wabaOverride: "this_connection",
      phoneOverrides: [{ phoneNumberId: PHONE_ID, target: "other_url" }],
      effective: "elsewhere",
    });
  });

  it("app não inscrito: not_subscribed", async () => {
    const h = await centralFixture();
    h.state.subscribed = [];

    const res = await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(200);

    expect(res.body.callback).toMatchObject({ effective: "not_subscribed", phoneOverrides: [] });
  });

  it("classifyMetaCloudCallbackUrl compara origem e caminho", () => {
    expect(classifyMetaCloudCallbackUrl(CONNECTION_URL, CONNECTION_URL, "conn_meta")).toBe("this_connection");
    expect(classifyMetaCloudCallbackUrl(`${CONNECTION_URL}/`, CONNECTION_URL, "conn_meta")).toBe("this_connection");
    expect(
      classifyMetaCloudCallbackUrl("https://API.agencia-sintetica.test/webhooks/inbound/conn_meta", CONNECTION_URL, "conn_meta"),
    ).toBe("this_connection");
    expect(classifyMetaCloudCallbackUrl(`${PUBLIC_URL}/webhooks/inbound/x`, CONNECTION_URL, "conn_meta")).toBe(
      "other_connection_here",
    );
    expect(classifyMetaCloudCallbackUrl("https://outro.test/webhooks/inbound/conn_meta", CONNECTION_URL, "conn_meta")).toBe(
      "other_url",
    );
    expect(classifyMetaCloudCallbackUrl("", CONNECTION_URL, "conn_meta")).toBe("none");
    expect(classifyMetaCloudCallbackUrl(null, CONNECTION_URL, "conn_meta")).toBe("none");
    expect(classifyMetaCloudCallbackUrl("não é url", CONNECTION_URL, "conn_meta")).toBe("other_url");
  });
});

describe("handshake da URL usada no desvio", () => {
  it("o GET de verificação da Meta na URL desta conexão devolve o challenge só com o token desta conexão", async () => {
    const prisma = {
      inboundWebhookConnection: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id === "conn_meta" ? { secretHash: sha256(VERIFY_TOKEN) } : null,
        ),
      },
    };
    const module = await Test.createTestingModule({
      controllers: [InboundWebhookPublicController],
      providers: [
        InboundWebhookMetaCloudVerificationService,
        { provide: PrismaService, useValue: prisma },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    const app = module.createNestApplication<NestExpressApplication>({ logger: false });
    apps.push(app);
    await app.init();
    const path = new URL(CONNECTION_URL).pathname;

    const ok = await request(app.getHttpServer())
      .get(path)
      .query({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1158201444" })
      .expect(200);
    expect(ok.text).toBe("1158201444");

    await request(app.getHttpServer())
      .get(path)
      .query({ "hub.mode": "subscribe", "hub.verify_token": "token-errado", "hub.challenge": "1" })
      .expect(401);
    await request(app.getHttpServer())
      .get("/webhooks/inbound/conn_outra")
      .query({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1" })
      .expect(401);
  });
});

describe("revisão: estados que nunca podem aparecer como 'chega nesta conexão'", () => {
  it("app sem o campo messages assinado: app_messages_off, mesmo com o desvio apontando para cá", async () => {
    const h = await centralFixture();
    h.state.subscribed = [thisAppItem(CONNECTION_URL)];
    h.state.appSubscriptions = [
      { object: "whatsapp_business_account", callback_url: CONNECTION_URL, active: true, fields: ["account_update"] },
    ];

    const res = await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(200);

    expect(res.body.callback).toMatchObject({
      wabaOverride: "this_connection",
      appMessagesField: false,
      effective: "app_messages_off",
    });
  });

  it("número que não deu para ler: effective unknown", async () => {
    const h = await centralFixture();
    h.state.subscribed = [thisAppItem(CONNECTION_URL)];
    h.state.phoneConfigError = { code: 100 };

    const res = await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(200);

    expect(res.body.callback).toMatchObject({
      wabaOverride: "this_connection",
      phoneOverrides: [{ phoneNumberId: PHONE_ID, target: "unknown" }],
      phoneOverridesNotChecked: 0,
      effective: "unknown",
    });
  });

  it("números além do limite de 20: contados como não conferidos e effective unknown", async () => {
    const h = await centralFixture();
    h.state.subscribed = [thisAppItem(CONNECTION_URL)];
    h.state.phoneNumbers = Array.from({ length: 21 }, () => ({
      id: PHONE_ID,
      display_phone_number: "+55 11 4000-0000",
      verified_name: "Loja",
    }));

    const res = await h.api.post(`${base}/lookup`).set("Authorization", bearer).send(lookupBody).expect(200);

    expect(res.body.callback.phoneOverrides).toHaveLength(20);
    expect(res.body.callback.phoneOverrides.every((p: { target: string }) => p.target === "none")).toBe(true);
    expect(res.body.callback).toMatchObject({ phoneOverridesNotChecked: 1, effective: "unknown" });
  });

  it("POST com desvio aceito e reconsulta falha: override_unconfirmed, sem erro", async () => {
    const h = await centralFixture();
    h.state.subscribed = [];
    h.state.subscribedErrorAfterPost = { code: 2 };

    const res = await h.api.post(base).set("Authorization", bearer).send(centralBody).expect(200);

    expect(res.body).toMatchObject({
      outcome: "override_unconfirmed",
      callback: { effective: "unknown" },
    });
    expect(h.state.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(h.audits.at(-1)!.data).toMatchObject({
      afterSummary: expect.objectContaining({ outcome: "override_unconfirmed" }),
    });
  });

  it("POST com desvio: 100 sem relação com o callback vira erro genérico, sem falar de API_PUBLIC_URL", async () => {
    const h = await centralFixture();
    h.state.subscribed = [];
    h.state.postError = { code: 100, message: "Invalid parameter" } as never;

    const res = await h.api.post(base).set("Authorization", bearer).send(centralBody).expect(502);

    expect(res.body.code).toBe("subscribe_failed");
    expect(res.body.message).not.toContain("API_PUBLIC_URL");
    expect(res.body.message).not.toContain("token de verificação");
  });

  it("POST com desvio: 100 com mensagem de verificação do callback vira override_verification_failed", async () => {
    const h = await centralFixture();
    h.state.subscribed = [];
    h.state.postError = { code: 100, message: "Callback verification failed with the provided verify token" } as never;

    const res = await h.api.post(base).set("Authorization", bearer).send(centralBody).expect(422);

    expect(res.body.code).toBe("override_verification_failed");
    expect(res.body.message).not.toContain("Callback verification failed");
  });

  it("POST com desvio: erro HTTP sem corpo da Meta não aponta para a verificação", async () => {
    const h = await centralFixture();
    h.state.subscribed = [];
    h.state.postError = { code: 1 };

    const res = await h.api.post(base).set("Authorization", bearer).send(centralBody).expect(502);

    expect(res.body.code).toBe("graph_unavailable");
  });
});
