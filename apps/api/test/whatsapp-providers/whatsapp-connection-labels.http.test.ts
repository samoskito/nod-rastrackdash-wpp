import "reflect-metadata";
import { Logger } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../../src/auth/auth.service";
import { MetaTokenEncryptionService } from "../../src/integrations/meta/meta-token-encryption.service";
import { UazapiAdapter } from "../../src/integrations/uazapi/uazapi.adapter";
import { UazapiByoAdapter } from "../../src/integrations/whatsapp-providers/uazapi-byo.adapter";
import { WhatsappConnectionsController } from "../../src/integrations/whatsapp-providers/whatsapp-connections.controller";
import { WhatsappConnectionsService } from "../../src/integrations/whatsapp-providers/whatsapp-connections.service";
import { WhatsappProviderRegistry } from "../../src/integrations/whatsapp-providers/whatsapp-provider.registry";
import { WorkspaceAccessPolicyService } from "../../src/workspaces/workspace-access-policy.service";
import { WorkspacesService } from "../../src/workspaces/workspaces.service";

/**
 * Rota que o seletor de etiquetas do painel chama (regras com "Números
 * específicos"). Antes desta correção ela não existia (404) e a regra era
 * salva sem a lista de etiquetas. Dados fictícios.
 */
const studentToken = "token-ficticio-da-instancia";
const studentBaseUrl = "https://aluno.uazapi.example.test";
const encryption = new MetaTokenEncryptionService({
  META_TOKEN_ENCRYPTION_KEY: "chave-de-teste",
});

function connectionRecord(overrides: Record<string, unknown> = {}) {
  const encrypted = encryption.encrypt(
    JSON.stringify({
      provider: "uazapi_byo",
      config: { baseUrl: studentBaseUrl, token: studentToken },
    }),
  );
  const now = new Date("2026-11-01T12:00:00.000Z");
  return {
    id: "conexao_1",
    workspaceId: "workspace_a",
    name: "Vendas",
    displayName: null,
    provider: "uazapi_byo",
    providerInstanceId: "instancia_1",
    configEncrypted: encrypted.encryptedAccessToken,
    configIv: encrypted.tokenIv,
    configTag: encrypted.tokenTag,
    webhookUrl: null,
    status: "active",
    lastHealthStatus: null,
    lastHealthCheckedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const apps: NestExpressApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

async function appFor(input: {
  records: Array<Record<string, unknown>>;
  uazapiResponse: () => Response | Promise<Response>;
}) {
  const calls: Array<{ url: string; token: string | null }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), token: headers.token ?? null });
    return input.uazapiResponse();
  }) as typeof fetch;
  const prisma = {
    whatsappInstance: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; workspaceId: string } }) =>
          input.records.find(
            (record) =>
              record.id === where.id && record.workspaceId === where.workspaceId,
          ) ?? null,
      ),
    },
  };
  const service = new WhatsappConnectionsService(
    prisma as never,
    encryption,
    new WhatsappProviderRegistry(),
    new WorkspaceAccessPolicyService(),
    { NODE_ENV: "test" },
    new UazapiByoAdapter(new UazapiAdapter({}, fetchImpl)),
  );
  const module = await Test.createTestingModule({
    controllers: [WhatsappConnectionsController],
    providers: [
      { provide: WhatsappConnectionsService, useValue: service },
      {
        provide: AuthService,
        useValue: {
          getSession: vi.fn(async () => ({ user: { id: "usuario_1" } })),
        },
      },
      {
        provide: WorkspacesService,
        useValue: {
          getCurrentWorkspace: vi.fn(() => ({
            id: "workspace_a",
            role: "member",
            permissions: { canManageMembers: false },
          })),
        },
      },
    ],
  }).compile();
  const app = module.createNestApplication<NestExpressApplication>();
  apps.push(app);
  await app.init();
  return { api: request(app.getHttpServer()), calls };
}

const auth = { Authorization: "Bearer sessao_1" };
const labelsOk = () =>
  new Response(
    JSON.stringify([
      { id: "7", name: "Comprou", colorHex: "#22c55e", labelid: "7", token: studentToken },
    ]),
  );

describe("GET /integrations/whatsapp-connections/:id/labels", () => {
  it("lists the labels from the student's own Uazapi URL, never returning the token", async () => {
    const { api, calls } = await appFor({
      records: [connectionRecord()],
      uazapiResponse: labelsOk,
    });

    const response = await api
      .get("/integrations/whatsapp-connections/conexao_1/labels")
      .set(auth)
      .expect(200);

    expect(response.body).toEqual([
      { id: "7", name: "Comprou", colorHex: "#22c55e", labelId: "7" },
    ]);
    expect(JSON.stringify(response.body)).not.toContain(studentToken);
    expect(calls).toEqual([
      { url: `${studentBaseUrl}/labels`, token: studentToken },
    ]);
  });

  it("requires a session", async () => {
    const { api, calls } = await appFor({
      records: [connectionRecord()],
      uazapiResponse: labelsOk,
    });

    await api.get("/integrations/whatsapp-connections/conexao_1/labels").expect(401);
    expect(calls).toEqual([]);
  });

  it("answers another workspace's connection the same as a missing one", async () => {
    const { api, calls } = await appFor({
      records: [connectionRecord({ workspaceId: "workspace_b" })],
      uazapiResponse: labelsOk,
    });

    const foreign = await api
      .get("/integrations/whatsapp-connections/conexao_1/labels")
      .set(auth)
      .expect(404);
    const missing = await api
      .get("/integrations/whatsapp-connections/nao_existe/labels")
      .set(auth)
      .expect(404);

    expect(foreign.body.message).toBe(missing.body.message);
    expect(calls).toEqual([]);
  });

  it("explains in Portuguese when Uazapi refuses the token", async () => {
    const { api } = await appFor({
      records: [connectionRecord()],
      uazapiResponse: () => new Response("{}", { status: 401 }),
    });

    const response = await api
      .get("/integrations/whatsapp-connections/conexao_1/labels")
      .set(auth)
      .expect(502);

    expect(response.body.message).toContain("A Uazapi recusou o token");
    expect(response.body.message).toContain("HTTP 401");
    expect(JSON.stringify(response.body)).not.toContain(studentToken);
  });

  it("explains in Portuguese when the Uazapi server is unreachable", async () => {
    const { api } = await appFor({
      records: [connectionRecord()],
      uazapiResponse: () => {
        throw new TypeError("fetch failed");
      },
    });

    const response = await api
      .get("/integrations/whatsapp-connections/conexao_1/labels")
      .set(auth)
      .expect(502);

    expect(response.body.message).toContain(
      "Não foi possível falar com o servidor da Uazapi",
    );
  });

  it("refuses a connection that is not Uazapi", async () => {
    const { api, calls } = await appFor({
      records: [
        connectionRecord({
          provider: "waha",
          configEncrypted: null,
          configIv: null,
          configTag: null,
        }),
      ],
      uazapiResponse: labelsOk,
    });

    const response = await api
      .get("/integrations/whatsapp-connections/conexao_1/labels")
      .set(auth)
      .expect(400);
    expect(response.body.message).toContain("só a Uazapi lista etiquetas");
    expect(calls).toEqual([]);
  });
});
