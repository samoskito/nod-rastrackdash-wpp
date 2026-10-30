import "reflect-metadata";
import { createHmac } from "node:crypto";
import { UnauthorizedException } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../../src/auth/auth.service";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { RUNTIME_ENV } from "../../src/common/runtime/runtime.module";
import { InboundConversionAutomationIngestionService } from "../../src/inbound-webhooks/inbound-conversion-automation-ingestion.service";
import { InboundWebhookChannelRoutesService } from "../../src/inbound-webhooks/inbound-webhook-channel-routes.service";
import { InboundWebhookConnectionsController } from "../../src/inbound-webhooks/inbound-webhook-connections.controller";
import { InboundWebhookConnectionsService } from "../../src/inbound-webhooks/inbound-webhook-connections.service";
import { InboundWebhookIngestionService } from "../../src/inbound-webhooks/inbound-webhook-ingestion.service";
import {
  assertMetaCloudSigningConfigured,
  missingMetaSigningSecretMessage,
} from "../../src/inbound-webhooks/inbound-webhook-parser-eligibility";
import { applyInboundWebhookConnectionStatus } from "../../src/inbound-webhooks/inbound-webhook-production-activation";
import { InboundWebhookPublicController } from "../../src/inbound-webhooks/inbound-webhook-public.controller";
import {
  decryptMetaCloudAppSecret,
  encryptMetaCloudAppSecret,
  metaCloudAppSecretSource,
  resolveMetaCloudAppSecret,
} from "../../src/inbound-webhooks/meta-cloud-app-secret";
import { LicenseClientService } from "../../src/licensing-client/license-client.service";
import { LicenseSoftlockGuard } from "../../src/licensing-client/license-softlock.guard";
import { WorkspacesService } from "../../src/workspaces/workspaces.service";

// Valores sintéticos: nenhum é credencial real.
const SECRET_A = "aaaaaaaaaaaaaaaa0123456789abcdef";
const SECRET_B = "bbbbbbbbbbbbbbbb0123456789abcdef";
const ENV_SECRET = "eeeeeeeeeeeeeeee0123456789abcdef";
const APP_ID = "1234567890123456";
const baseEnv = {
  NODE_ENV: "test",
  API_PUBLIC_URL: "http://localhost:3333",
  INBOUND_WEBHOOKS_ENABLED: "true",
  INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
  INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
};
type Env = Record<string, string | undefined>;

function sealed(secret: string, connectionId: string, workspaceId = "ws") {
  return encryptMetaCloudAppSecret(secret, { workspaceId, connectionId }, baseEnv);
}

function metaConnection(
  id: string,
  secret: string | null,
  change: Record<string, unknown> = {},
) {
  return {
    id,
    workspaceId: "ws",
    provider: "meta_cloud",
    displayName: `Meta ${id}`,
    secretHash: "unused-for-meta-post",
    status: "production",
    productionActivatedAt: new Date("2026-10-30T10:00:00.000Z"),
    removedAt: null,
    lastDeliveryAt: null,
    lastSuccessfulParseAt: null,
    createdAt: new Date("2026-10-30T09:00:00.000Z"),
    updatedAt: new Date("2026-10-30T10:00:00.000Z"),
    metaAppId: secret ? APP_ID : null,
    metaAppSecretEncrypted: secret ? sealed(secret, id) : null,
    metaAppSecretUpdatedAt: secret ? new Date("2026-10-30T10:00:00.000Z") : null,
    parserRelease: {
      id: "release_meta",
      provider: "meta_cloud",
      version: "v1",
      status: "certified",
    },
    ...change,
  };
}

describe("resolveMetaCloudAppSecret: conexão > ambiente > nenhum", () => {
  const connection = metaConnection("conn_a", SECRET_A);
  const bare = metaConnection("conn_bare", null);

  it("usa o segredo da conexão quando existe, mesmo com META_APP_SECRET", () => {
    expect(
      resolveMetaCloudAppSecret(connection, { ...baseEnv, META_APP_SECRET: ENV_SECRET }),
    ).toEqual({ source: "connection", secret: SECRET_A, appId: APP_ID });
    expect(metaCloudAppSecretSource(connection, baseEnv)).toBe("connection");
  });

  it("sem segredo na conexão, cai para o META_APP_SECRET do ambiente", () => {
    expect(
      resolveMetaCloudAppSecret(bare, {
        ...baseEnv,
        META_APP_SECRET: ` ${ENV_SECRET} `,
        META_APP_ID: "999",
      }),
    ).toEqual({ source: "environment", secret: ENV_SECRET, appId: "999" });
    expect(metaCloudAppSecretSource(bare, { META_APP_SECRET: ENV_SECRET })).toBe(
      "environment",
    );
  });

  it("sem nenhum dos dois: none", () => {
    expect(resolveMetaCloudAppSecret(bare, { ...baseEnv, META_APP_SECRET: "  " })).toEqual({
      source: "none",
      secret: null,
      appId: null,
    });
    expect(metaCloudAppSecretSource(null, {})).toBe("none");
  });

  it("segredo da conexão que não decifra falha fechado (não cai para o ambiente)", () => {
    const copied = { ...metaConnection("conn_b", null), metaAppSecretEncrypted: connection.metaAppSecretEncrypted };
    // Cifrado para outra conexão: o contexto (AAD) não confere.
    expect(
      resolveMetaCloudAppSecret(copied, { ...baseEnv, META_APP_SECRET: ENV_SECRET }),
    ).toMatchObject({ source: "connection", secret: null });
    // Chave de criptografia trocada.
    expect(
      resolveMetaCloudAppSecret(connection, {
        ...baseEnv,
        INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
      }),
    ).toMatchObject({ source: "connection", secret: null });
  });

  it("cifra em repouso: o valor gravado não contém o segredo e decifra só no mesmo contexto", () => {
    const value = sealed(SECRET_A, "conn_a");
    expect(value).not.toContain(SECRET_A);
    expect(value.startsWith("v1.")).toBe(true);
    expect(sealed(SECRET_A, "conn_a")).not.toBe(value);
    expect(decryptMetaCloudAppSecret(value, { workspaceId: "ws", connectionId: "conn_a" }, baseEnv)).toBe(SECRET_A);
    expect(() =>
      decryptMetaCloudAppSecret(value, { workspaceId: "other", connectionId: "conn_a" }, baseEnv),
    ).toThrow();
  });
});

function signedBody(secret: string) {
  const rawBody = Buffer.from(
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba_1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { display_phone_number: "551132630883", phone_number_id: "phone_1" },
                messages: [
                  {
                    id: `wamid.${secret.slice(0, 4)}`,
                    from: "5511974108069",
                    timestamp: "1789493700",
                    type: "text",
                    text: { body: "Oi" },
                  },
                ],
              },
            },
          ],
        },
      ],
    }),
    "utf8",
  );
  const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return { rawBody, signature };
}

function ingestionFixture(env: Env, connections: Array<Record<string, unknown>>) {
  const prisma = {
    inboundWebhookConnection: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        connections.find((row) => row.id === where.id) ?? null,
      ),
      findFirst: vi.fn(async () => ({ id: "x" })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    inboundWebhookDelivery: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => undefined),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: vi.fn(async (fn: (transaction: unknown) => Promise<unknown>) => fn(prisma)),
  };
  const ingestion = new InboundWebhookIngestionService(
    prisma as never,
    env,
    {
      encrypt: vi.fn(() => ({
        encryptedPayload: "ciphertext",
        payloadIv: "iv",
        payloadTag: "tag",
        encryptionKeyVersion: 1,
      })),
    } as never,
    { enqueueDelivery: vi.fn(async () => undefined) } as never,
  );
  const controller = new InboundWebhookPublicController(ingestion, {} as never, {} as never, {} as never);
  const receive = (connectionId: string, secret: string) => {
    const { rawBody, signature } = signedBody(secret);
    return controller.receive(connectionId, undefined, "application/json", undefined, signature, rawBody);
  };
  return { receive };
}

describe("assinatura x-hub-signature-256 com segredo por conexão", () => {
  const connections = [
    metaConnection("conn_a", SECRET_A),
    metaConnection("conn_b", SECRET_B),
    metaConnection("conn_env", null),
  ];

  it("duas conexões com segredos diferentes: cada uma valida só o próprio", async () => {
    const { receive } = ingestionFixture({ ...baseEnv, META_APP_SECRET: ENV_SECRET }, connections);

    await expect(receive("conn_a", SECRET_A)).resolves.toMatchObject({ status: "accepted" });
    await expect(receive("conn_b", SECRET_B)).resolves.toMatchObject({ status: "accepted" });
    await expect(receive("conn_a", SECRET_B)).rejects.toThrow();
    await expect(receive("conn_b", SECRET_A)).rejects.toThrow();
    // Com segredo próprio, o do ambiente não vale para a conexão.
    await expect(receive("conn_a", ENV_SECRET)).rejects.toThrow();
  });

  it("conexão sem segredo próprio continua conferida pelo META_APP_SECRET", async () => {
    const { receive } = ingestionFixture({ ...baseEnv, META_APP_SECRET: ENV_SECRET }, connections);
    await expect(receive("conn_env", ENV_SECRET)).resolves.toMatchObject({ status: "accepted" });
    await expect(receive("conn_env", SECRET_A)).rejects.toThrow();
  });

  it("produção sem META_APP_SECRET no ambiente: o segredo da conexão basta", async () => {
    const { receive } = ingestionFixture(baseEnv, connections);
    await expect(receive("conn_a", SECRET_A)).resolves.toMatchObject({ status: "accepted" });
    // Sem segredo nenhum, produção recusa (só observação aceitava sem assinatura).
    await expect(receive("conn_env", ENV_SECRET)).rejects.toThrow();
  });
});

describe("portões de envio usam o mesmo resolvedor", () => {
  it("assertMetaCloudSigningConfigured: conexão sem env passa; sem nenhum, recusa com a mensagem nova", () => {
    expect(() =>
      assertMetaCloudSigningConfigured(metaConnection("conn_a", SECRET_A), {}),
    ).not.toThrow();
    expect(() =>
      assertMetaCloudSigningConfigured(metaConnection("conn_env", null), {}),
    ).toThrow(missingMetaSigningSecretMessage);
    expect(missingMetaSigningSecretMessage).toContain("App do Meta desta conexão");
    expect(missingMetaSigningSecretMessage).toContain("META_APP_SECRET");
    expect(missingMetaSigningSecretMessage).toContain("PalmUP");
    expect(() =>
      assertMetaCloudSigningConfigured({ provider: "umbler", metaAppSecretEncrypted: null }, {}),
    ).not.toThrow();
  });

  function activationWorld(connection: Record<string, unknown>) {
    const tx = {
      inboundWebhookConnection: {
        findFirst: vi.fn(async () => connection),
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(connection, data);
          return { count: 1 };
        }),
      },
      inboundWebhookChannel: {
        findMany: vi.fn(async () => [{ id: "channel_1", status: "active", routes: [] }]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      inboundWebhookReplayBatch: {
        count: vi.fn(async () => 0),
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => null),
      },
      metaBusinessConnection: { findFirst: vi.fn(async () => null) },
      auditLog: { create: vi.fn(async () => undefined) },
    };
    return tx;
  }

  it("ativação (retomar) com segredo só na conexão e nenhum META_APP_SECRET é aceita", async () => {
    const connection = metaConnection("conn_a", SECRET_A, { status: "paused", productionActivatedAt: null });
    const tx = activationWorld(connection);
    const updated = await applyInboundWebhookConnectionStatus(tx as never, {
      workspaceId: "ws",
      connectionId: "conn_a",
      status: "production",
      actorUserId: "user_1",
      requireValidMetaRoute: true,
      seats: { enforcementEnabled: () => false, activateSeat: vi.fn() },
      productionDirectResume: true,
      env: {},
    });
    expect(updated.status).toBe("production");
  });

  it("ativação sem segredo na conexão nem no ambiente continua recusada", async () => {
    const connection = metaConnection("conn_env", null, { status: "paused", productionActivatedAt: null });
    const tx = activationWorld(connection);
    await expect(
      applyInboundWebhookConnectionStatus(tx as never, {
        workspaceId: "ws",
        connectionId: "conn_env",
        status: "production",
        actorUserId: "user_1",
        requireValidMetaRoute: true,
        seats: { enforcementEnabled: () => false, activateSeat: vi.fn() },
        productionDirectResume: true,
        env: {},
      }),
    ).rejects.toThrow(missingMetaSigningSecretMessage);
  });
});

/** Banco falso mínimo para o serviço de conexões (findFirst/updateMany/audit). */
function connectionsDb(rows: Array<Record<string, any>>) {
  const audits: Array<{ data: Record<string, unknown> }> = [];
  const matches = (row: Record<string, any>, where: Record<string, any>) =>
    Object.entries(where).every(([key, value]) =>
      value instanceof Date ? row[key]?.getTime?.() === value.getTime() : row[key] === value,
    );
  const prisma: any = {
    inboundWebhookConnection: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((row) => matches(row, where)) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((row) => matches(row, where)),
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = rows.find((candidate) => matches(candidate, where));
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    whatsappInstance: { findMany: vi.fn(async () => []) },
    auditLog: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        audits.push(args);
        return args.data;
      }),
    },
  };
  prisma.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  return { prisma, audits };
}

const apps: NestExpressApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
});

async function httpFixture(options: { env?: Env; locked?: boolean; rows?: Array<Record<string, any>> } = {}) {
  const rows = options.rows ?? [
    metaConnection("conn_meta", null, { status: "observation", productionActivatedAt: null }),
    { ...metaConnection("conn_umbler", null), provider: "umbler" },
  ];
  const db = connectionsDb(rows);
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
  const module = await Test.createTestingModule({
    controllers: [InboundWebhookConnectionsController],
    providers: [
      InboundWebhookConnectionsService,
      { provide: InboundWebhookChannelRoutesService, useValue: {} },
      { provide: InboundConversionAutomationIngestionService, useValue: {} },
      { provide: PrismaService, useValue: db.prisma },
      { provide: RUNTIME_ENV, useValue: options.env ?? baseEnv },
      { provide: AuthService, useValue: auth },
      { provide: WorkspacesService, useValue: new WorkspacesService({} as never) },
      { provide: LicenseClientService, useValue: license },
      { provide: APP_GUARD, useClass: LicenseSoftlockGuard },
    ],
  }).compile();
  const app = module.createNestApplication<NestExpressApplication>({ logger: false });
  apps.push(app);
  await app.init();
  return { ...db, rows, session, api: request(app.getHttpServer()) };
}

const bearer = "Bearer synthetic-session";
const appPath = "/integrations/inbound-webhooks/conn_meta/meta-cloud/app";
const credentials = { appId: APP_ID, appSecret: SECRET_A };

describe("PUT/DELETE /integrations/inbound-webhooks/:id/meta-cloud/app", () => {
  it("salva cifrado, devolve só metaApp e nunca o segredo (resposta, listagem, auditoria)", async () => {
    const h = await httpFixture();
    const res = await h.api.put(appPath).set("Authorization", bearer).send(credentials).expect(200);

    expect(res.body.metaApp).toEqual({
      appId: APP_ID,
      appSecretConfigured: true,
      appSecretSource: "connection",
      appSecretUpdatedAt: expect.any(String),
    });
    expect(res.body.status).toBe("observation");
    const row = h.rows.find((candidate) => candidate.id === "conn_meta")!;
    expect(row.metaAppSecretEncrypted).toEqual(expect.stringMatching(/^v1\./));
    expect(row.metaAppSecretEncrypted).not.toContain(SECRET_A);
    expect(resolveMetaCloudAppSecret(row as never, baseEnv).secret).toBe(SECRET_A);

    const list = await h.api.get("/integrations/inbound-webhooks").set("Authorization", bearer).expect(200);
    const one = await h.api.get("/integrations/inbound-webhooks/conn_meta").set("Authorization", bearer).expect(200);
    const everything = JSON.stringify([res.body, list.body, one.body, h.audits]);
    expect(everything).not.toContain(SECRET_A);
    expect(everything).not.toContain(row.metaAppSecretEncrypted);
    expect(everything).not.toContain("metaAppSecretEncrypted");
    expect(list.body.find((c: any) => c.id === "conn_umbler").metaApp).toBeNull();
    expect(h.audits.at(-1)!.data).toMatchObject({
      action: "inbound_webhook.meta_app_secret_set",
      afterSummary: expect.objectContaining({ metaAppSecretConfigured: true, metaAppSecretSource: "connection" }),
    });
  });

  it("DTO mostra a fonte: ambiente quando só há META_APP_SECRET, none sem nada", async () => {
    const withEnv = await httpFixture({ env: { ...baseEnv, META_APP_SECRET: ENV_SECRET } });
    const a = await withEnv.api.get("/integrations/inbound-webhooks/conn_meta").set("Authorization", bearer).expect(200);
    expect(a.body.metaApp).toMatchObject({ appSecretConfigured: false, appSecretSource: "environment", appId: null });
    expect(JSON.stringify(a.body)).not.toContain(ENV_SECRET);
    const bare = await httpFixture();
    const b = await bare.api.get("/integrations/inbound-webhooks/conn_meta").set("Authorization", bearer).expect(200);
    expect(b.body.metaApp).toMatchObject({ appSecretConfigured: false, appSecretSource: "none" });
  });

  it("valida o formato sem ecoar o corpo", async () => {
    const h = await httpFixture();
    for (const body of [
      { appId: "abc", appSecret: SECRET_A },
      { appId: APP_ID, appSecret: "   " },
      { appId: APP_ID, appSecret: "short" },
      { appId: APP_ID, appSecret: `${SECRET_A} x` },
      { appId: APP_ID },
      { ...credentials, workspaceId: "other" },
    ]) {
      const res = await h.api.put(appPath).set("Authorization", bearer).send(body).expect(400);
      expect(res.body.code).toBe("invalid_input");
      expect(JSON.stringify(res.body)).not.toContain(SECRET_A);
    }
    expect(h.prisma.inboundWebhookConnection.updateMany).not.toHaveBeenCalled();
  });

  it.each(["analyst", "viewer"])("membro %s não altera (403)", async (role) => {
    const h = await httpFixture();
    h.session.workspaces[0].role = role;
    await h.api.put(appPath).set("Authorization", bearer).send(credentials).expect(403);
    await h.api.delete(appPath).set("Authorization", bearer).expect(403);
    expect(h.prisma.inboundWebhookConnection.updateMany).not.toHaveBeenCalled();
  });

  it("admin pode salvar", async () => {
    const h = await httpFixture();
    h.session.workspaces[0].role = "admin";
    await h.api.put(appPath).set("Authorization", bearer).send(credentials).expect(200);
  });

  it("licença bloqueada: 423 nas duas escritas", async () => {
    const h = await httpFixture({ locked: true });
    await h.api.put(appPath).set("Authorization", bearer).send(credentials).expect(423);
    await h.api.delete(appPath).set("Authorization", bearer).expect(423);
    expect(h.prisma.inboundWebhookConnection.updateMany).not.toHaveBeenCalled();
  });

  it("conexão que não é Meta Cloud: 409; de outro workspace: 404", async () => {
    const h = await httpFixture();
    await h.api
      .put(appPath.replace("conn_meta", "conn_umbler"))
      .set("Authorization", bearer)
      .send(credentials)
      .expect(409);
    await h.api
      .put(appPath.replace("conn_meta", "conn_missing"))
      .set("Authorization", bearer)
      .send(credentials)
      .expect(404);
  });

  it("trocar o segredo de uma conexão em produção não muda o status", async () => {
    const h = await httpFixture({
      rows: [metaConnection("conn_meta", SECRET_A)],
    });
    const res = await h.api
      .put(appPath)
      .set("Authorization", bearer)
      .send({ appId: APP_ID, appSecret: SECRET_B })
      .expect(200);
    expect(res.body.status).toBe("production");
    expect(resolveMetaCloudAppSecret(h.rows[0] as never, baseEnv).secret).toBe(SECRET_B);
  });

  it("remover em produção sem META_APP_SECRET de reserva é recusado (409) e nada muda", async () => {
    const h = await httpFixture({ rows: [metaConnection("conn_meta", SECRET_A)] });
    const res = await h.api.delete(appPath).set("Authorization", bearer).expect(409);
    expect(res.body.message).toContain("Pause o envio");
    expect(h.rows[0].metaAppSecretEncrypted).toEqual(expect.any(String));
  });

  it("remover com META_APP_SECRET de reserva volta para o ambiente", async () => {
    const h = await httpFixture({
      env: { ...baseEnv, META_APP_SECRET: ENV_SECRET },
      rows: [metaConnection("conn_meta", SECRET_A)],
    });
    const res = await h.api.delete(appPath).set("Authorization", bearer).expect(200);
    expect(res.body.metaApp).toEqual({
      appId: null,
      appSecretConfigured: false,
      appSecretSource: "environment",
      appSecretUpdatedAt: null,
    });
    expect(res.body.status).toBe("production");
    expect(h.rows[0]).toMatchObject({ metaAppId: null, metaAppSecretEncrypted: null });
    expect(h.audits.at(-1)!.data.action).toBe("inbound_webhook.meta_app_secret_cleared");
  });

  it("remover de uma conexão fora de produção é permitido mesmo sem reserva", async () => {
    const h = await httpFixture({
      rows: [metaConnection("conn_meta", SECRET_A, { status: "paused", productionActivatedAt: null })],
    });
    const res = await h.api.delete(appPath).set("Authorization", bearer).expect(200);
    expect(res.body.metaApp.appSecretSource).toBe("none");
  });
});
