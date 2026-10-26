import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { InboundWebhookChannelRoutesService } from "../../src/inbound-webhooks/inbound-webhook-channel-routes.service";
import { InboundWebhookConnectionsService } from "../../src/inbound-webhooks/inbound-webhook-connections.service";
import { InboundWebhookObservationService } from "../../src/inbound-webhooks/inbound-webhook-observation.service";
import {
  bornChannelState,
  bornConnectionStatus,
  productionDirectEligible,
} from "../../src/inbound-webhooks/production-direct";
import { UazapiConversionBridgeService } from "../../src/inbound-webhooks/uazapi-conversion-bridge.service";

/**
 * Fase 6.1c — produção direta. O que foi validado no SaaS chega ao aluno em
 * produção: conexão, número e regra nascem enviando, sem a etapa de
 * observação. Só um leitor ainda não validado (ou retirado) fica fora.
 */

const now = new Date("2026-10-26T12:00:00.000Z");
type Row = Record<string, any>;

const release = (provider: string, version = "v1", status = "certified") => ({
  id: `release_${provider}_${version}`,
  provider,
  version,
  status,
  createdAt: now,
  updatedAt: now,
  certifiedAt: status === "certified" ? now : null,
  certifiedByUserId: null,
});

describe("produção direta: regra de nascimento", () => {
  it.each([
    ["umbler", "v1"],
    ["gupshup", "v1"],
    ["data_crazy", "v1"],
    ["unnichat", "v1"],
    ["payt", "v1"],
    ["uazapi", "v1"],
    ["waha", "v2"],
  ])("%s %s certificado nasce em produção", (provider, version) => {
    const r = release(provider, version);
    expect(productionDirectEligible(r)).toBe(true);
    expect(bornConnectionStatus(r)).toBe("production");
  });

  it("o leitor nativo do Meta Cloud v1 vale mesmo com a linha antiga em observation_only", () => {
    expect(
      bornConnectionStatus(release("meta_cloud", "v1", "observation_only")),
    ).toBe("production");
  });

  it.each([
    ["observation_only", "umbler"],
    ["retired", "umbler"],
    ["retired", "meta_cloud"],
  ])("leitor %s (%s) não nasce em produção", (status, provider) => {
    expect(bornConnectionStatus(release(provider, "v1", status))).toBe(
      "observation",
    );
  });

  it("o número nasce ativo e com a data de ativação numa conexão em produção", () => {
    expect(
      bornChannelState({ status: "production" }, release("umbler"), now),
    ).toEqual({ status: "active", productionActivatedAt: now });
  });

  it("numa conexão pausada pelo operador o número nasce ativo, mas só envia quando ela voltar", () => {
    expect(
      bornChannelState({ status: "paused" }, release("umbler"), now),
    ).toEqual({ status: "active", productionActivatedAt: null });
  });

  it("sem leitor validado (ou sem dados), fail-closed: nasce como antes", () => {
    expect(
      bornChannelState(
        { status: "production" },
        release("umbler", "v1", "observation_only"),
        now,
      ),
    ).toEqual({ status: "discovered", productionActivatedAt: null });
    expect(bornChannelState(undefined, undefined, now)).toEqual({
      status: "discovered",
      productionActivatedAt: null,
    });
    expect(
      bornChannelState({ status: "observation" }, release("umbler"), now),
    ).toEqual({ status: "discovered", productionActivatedAt: null });
  });
});

function connectionsFixture(parserRelease: Row, env: Row = {}) {
  const created: Row[] = [];
  const channels: Row[] = [];
  const prisma = {
    inboundWebhookParserRelease: {
      findMany: vi.fn(async () => [parserRelease]),
      findFirst: vi.fn(async () => parserRelease),
    },
    inboundWebhookConnection: {
      create: vi.fn(async ({ data }: Row) => {
        const row = {
          id: `connection_${created.length + 1}`,
          lastDeliveryAt: null,
          lastSuccessfulParseAt: null,
          removedAt: null,
          createdAt: now,
          updatedAt: now,
          ...data,
          parserRelease,
        };
        created.push(row);
        return row;
      }),
    },
    inboundWebhookChannel: {
      create: vi.fn(async ({ data }: Row) => {
        channels.push(data);
        return data;
      }),
    },
    auditLog: { create: vi.fn(async () => undefined) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(prisma),
    ),
  };
  const service = new InboundWebhookConnectionsService(prisma as never, {
    INBOUND_WEBHOOKS_ENABLED: "true",
    API_PUBLIC_URL: "https://api.example.test",
    INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
    ...env,
  });
  return { service, prisma, created, channels };
}

describe("produção direta: conexões de webhook nascem em produção", () => {
  it.each(["umbler", "gupshup", "data_crazy"] as const)(
    "%s nasce em produção com a data de ativação",
    async (provider) => {
      const { service, created } = connectionsFixture(release(provider));
      const result = await service.createConnection(
        "workspace_1",
        { provider, displayName: `Conexão ${provider}` },
        "user_1",
      );
      expect(created[0]).toMatchObject({
        status: "production",
        productionActivatedAt: expect.any(Date),
      });
      expect(result.connection.status).toBe("production");
    },
  );

  it("Meta Cloud WABA nasce em produção com o META_APP_SECRET do aluno", async () => {
    const { service, created } = connectionsFixture(
      release("meta_cloud", "v1", "observation_only"),
      { META_APP_SECRET: "segredo-ficticio" },
    );
    await service.createConnection(
      "workspace_1",
      { provider: "meta_cloud", displayName: "WABA" },
      "user_1",
    );
    expect(created[0]).toMatchObject({
      status: "production",
      productionActivatedAt: expect.any(Date),
    });
  });

  it("Meta Cloud sem META_APP_SECRET fica fora de produção (a assinatura seria exigida e as entregas recusadas)", async () => {
    const { service, created } = connectionsFixture(
      release("meta_cloud", "v1", "observation_only"),
    );
    await service.createConnection(
      "workspace_1",
      { provider: "meta_cloud", displayName: "WABA" },
      "user_1",
    );
    expect(created[0]).toMatchObject({
      status: "observation",
      productionActivatedAt: null,
    });
  });

  it("Unnichat nasce em produção e o número dela já com o envio ativo", async () => {
    const { service, created, channels } = connectionsFixture(
      release("unnichat"),
    );
    await service.createConnection(
      "workspace_1",
      {
        provider: "unnichat",
        displayName: "Unnichat Loja",
        connectedPhone: "5511999990000",
      } as never,
      "user_1",
    );
    expect(created[0]).toMatchObject({ status: "production" });
    expect(channels[0]).toMatchObject({
      status: "active",
      productionActivatedAt: created[0]!.productionActivatedAt,
      connectedPhone: "5511999990000",
    });
  });

  it("um leitor ainda não validado mantém a conexão em observação", async () => {
    const { service, created } = connectionsFixture(
      release("gupshup", "v1", "observation_only"),
    );
    await service.createConnection(
      "workspace_1",
      { provider: "gupshup", displayName: "Gupshup" },
      "user_1",
    );
    expect(created[0]).toMatchObject({
      status: "observation",
      productionActivatedAt: null,
    });
  });
});

function bridgeFixture(existingRelease: Row | null) {
  const connections: Row[] = [];
  const channels: Row[] = [];
  const audits: Row[] = [];
  const prisma = {
    inboundWebhookChannel: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: Row) => {
        const row = { id: `channel_${channels.length + 1}`, ...data };
        channels.push(row);
        return { id: row.id };
      }),
    },
    inboundWebhookParserRelease: {
      upsert: vi.fn(async ({ create }: Row) => existingRelease ?? { id: "r", ...create }),
    },
    inboundWebhookConnection: {
      create: vi.fn(async ({ data }: Row) => {
        const row = { id: `connection_${connections.length + 1}`, ...data };
        connections.push(row);
        return { id: row.id, status: row.status };
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: Row) => {
        audits.push(data);
        return data;
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(prisma),
    ),
  };
  return {
    bridge: new UazapiConversionBridgeService(prisma as never),
    connections,
    channels,
    audits,
  };
}

describe("produção direta: Uazapi BYO e WAHA (URL do servidor + token, um número por conexão)", () => {
  it.each([
    ["uazapi", null],
    ["waha", release("waha", "v2")],
  ] as const)(
    "a ponte %s nasce em produção e o número com o envio ativo",
    async (provider, existing) => {
      const f = bridgeFixture(existing);
      await f.bridge.ensureBridge(
        {
          id: "instance_1",
          workspaceId: "workspace_1",
          name: "Loja",
          providerInstanceId: "session",
          connectedPhone: "5511988887777",
        },
        provider,
      );
      expect(f.connections[0]).toMatchObject({
        provider,
        status: "production",
        productionActivatedAt: expect.any(Date),
      });
      expect(f.channels[0]).toMatchObject({
        status: "active",
        productionActivatedAt: f.connections[0]!.productionActivatedAt,
        whatsappInstanceId: "instance_1",
      });
      expect(f.audits[0]).toMatchObject({ resultStatus: "production" });
    },
  );

  it("uma release retirada pelo operador continua fora de produção", async () => {
    const f = bridgeFixture(release("waha", "v2", "retired"));
    await f.bridge.ensureBridge(
      {
        id: "instance_2",
        workspaceId: "workspace_1",
        name: "Loja",
        providerInstanceId: "session",
      },
      "waha",
    );
    expect(f.connections[0]).toMatchObject({
      status: "observation",
      productionActivatedAt: null,
    });
    expect(f.channels[0]).toMatchObject({
      status: "discovered",
      productionActivatedAt: null,
    });
  });
});

describe("produção direta: números descobertos ou cadastrados nascem enviando", () => {
  it("o número revelado pela primeira entrega já envia desde essa entrega", async () => {
    const service = new InboundWebhookObservationService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const firstReceivedAt = new Date("2026-10-26T11:59:00.000Z");
    const upsert = vi.fn(async (_args: Row) => ({ id: "channel_new" }));
    const tx = {
      inboundWebhookChannel: {
        findUnique: vi.fn(async () => null),
        upsert,
      },
    };
    await (
      service as unknown as {
        upsertChannelForEvent: (...args: unknown[]) => Promise<unknown>;
      }
    ).upsertChannelForEvent(
      tx,
      {
        workspaceId: "workspace_1",
        connectionId: "connection_1",
        provider: "umbler",
        firstReceivedAt,
        connection: { status: "production", parserRelease: release("umbler") },
      },
      {
        organizationId: "org",
        channel: {
          providerChannelId: "pc",
          connectedPhone: "5511977776666",
          name: "Comercial",
        },
      },
      now,
    );
    expect(upsert.mock.calls[0]![0].create).toMatchObject({
      status: "active",
      productionActivatedAt: firstReceivedAt,
    });
  });

  it("o número cadastrado à mão numa conexão em produção nasce ativo", async () => {
    const created: Row[] = [];
    const prisma = {
      inboundWebhookConnection: {
        findFirst: vi.fn(async () => ({
          id: "connection_1",
          provider: "umbler",
          status: "production",
          parserRelease: { provider: "umbler", version: "v1", status: "certified" },
        })),
      },
      inboundWebhookChannel: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: Row) => {
          const row = {
            id: "channel_manual",
            whatsappInstanceId: null,
            createdAt: now,
            updatedAt: now,
            ...data,
            connection: {
              id: "connection_1",
              workspaceId: "workspace_1",
              provider: "umbler",
              status: "production",
              removedAt: null,
            },
            routes: [],
          };
          created.push(row);
          return row;
        }),
      },
      inboundWebhookEvent: { findMany: vi.fn(async () => []) },
      inboundWebhookDelivery: { findMany: vi.fn(async () => []) },
      auditLog: { create: vi.fn(async () => undefined) },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
    };
    const service = new InboundWebhookChannelRoutesService(
      prisma as never,
      {} as never,
    );
    const dto = await service.createProvisionalChannel(
      "workspace_1",
      "connection_1",
      { connectedPhone: "(11) 97777-6666" },
      "user_1",
    );
    expect(created[0]).toMatchObject({
      status: "active",
      productionActivatedAt: expect.any(Date),
    });
    expect(dto.status).toBe("active");
  });
});
