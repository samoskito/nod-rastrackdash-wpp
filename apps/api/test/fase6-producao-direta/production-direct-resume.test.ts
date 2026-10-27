import { describe, expect, it, vi } from "vitest";
import { applyInboundWebhookConnectionStatus } from "../../src/inbound-webhooks/inbound-webhook-production-activation";

/**
 * Fase 6.1c — com a produção direta, números nascem ativos sem exigir rota
 * (a rota é conferida no envio). Por isso "Retomar conexão" de uma
 * integração validada não pode travar por número sem rota; as outras travas
 * (leitor validado, META_APP_SECRET no Meta Cloud, replay em curso) seguem.
 */
const now = new Date("2026-10-26T12:00:00.000Z");
type Row = Record<string, any>;

function world(input: {
  status?: "paused" | "observation";
  provider?: string;
  channels?: Row[];
  replay?: number;
}) {
  const connection: Row = {
    id: "connection_1",
    workspaceId: "workspace_1",
    provider: input.provider ?? "umbler",
    displayName: "Umbler",
    status: input.status ?? "paused",
    productionActivatedAt: null,
    removedAt: null,
    updatedAt: now,
    parserRelease: {
      id: "release",
      provider: input.provider ?? "umbler",
      version: "v1",
      status: "certified",
    },
  };
  const channels = input.channels ?? [
    { id: "channel_1", status: "active", routes: [] },
  ];
  const tx = {
    inboundWebhookConnection: {
      findFirst: vi.fn(async () => connection),
      updateMany: vi.fn(async ({ data }: Row) => {
        Object.assign(connection, data);
        return { count: 1 };
      }),
    },
    inboundWebhookChannel: {
      findMany: vi.fn(async () => channels),
      updateMany: vi.fn(async () => ({ count: channels.length })),
    },
    inboundWebhookReplayBatch: {
      count: vi.fn(async () => input.replay ?? 0),
    },
    metaBusinessConnection: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => undefined) },
  };
  const seats = { enforcementEnabled: () => false, activateSeat: vi.fn() };
  return { tx, connection, seats };
}

describe("produção direta: retomar conexão pausada", () => {
  it("volta a enviar mesmo com um número sem rota (a rota é conferida no envio)", async () => {
    const w = world({});
    const updated = await applyInboundWebhookConnectionStatus(w.tx as never, {
      workspaceId: "workspace_1",
      connectionId: "connection_1",
      status: "production",
      actorUserId: "user_1",
      requireValidMetaRoute: true,
      seats: w.seats,
      productionDirectResume: true,
    });
    expect(updated.status).toBe("production");
    expect(w.connection.productionActivatedAt).toEqual(expect.any(Date));
  });

  it("também sem nenhum número ainda", async () => {
    const w = world({ channels: [] });
    const updated = await applyInboundWebhookConnectionStatus(w.tx as never, {
      workspaceId: "workspace_1",
      connectionId: "connection_1",
      status: "production",
      actorUserId: "user_1",
      requireValidMetaRoute: true,
      seats: w.seats,
      productionDirectResume: true,
    });
    expect(updated.status).toBe("production");
  });

  it("a ativação explícita de fora da pausa mantém as travas de sempre", async () => {
    const w = world({ status: "observation" });
    await expect(
      applyInboundWebhookConnectionStatus(w.tx as never, {
        workspaceId: "workspace_1",
        connectionId: "connection_1",
        status: "production",
        actorUserId: "user_1",
        requireValidMetaRoute: true,
        seats: w.seats,
        productionDirectResume: true,
      }),
    ).rejects.toThrow("Todo canal ativo precisa de uma rota Meta valida");
  });

  it("replay em curso continua impedindo a retomada", async () => {
    const w = world({ replay: 1 });
    await expect(
      applyInboundWebhookConnectionStatus(w.tx as never, {
        workspaceId: "workspace_1",
        connectionId: "connection_1",
        status: "production",
        actorUserId: "user_1",
        requireValidMetaRoute: true,
        seats: w.seats,
        productionDirectResume: true,
      }),
    ).rejects.toThrow("Finalize o replay em andamento");
  });

  it("Meta Cloud sem META_APP_SECRET continua recusada ao retomar", async () => {
    const w = world({ provider: "meta_cloud" });
    await expect(
      applyInboundWebhookConnectionStatus(w.tx as never, {
        workspaceId: "workspace_1",
        connectionId: "connection_1",
        status: "production",
        actorUserId: "user_1",
        requireValidMetaRoute: true,
        seats: w.seats,
        productionDirectResume: true,
        env: {},
      }),
    ).rejects.toThrow("App Secret");
  });
});
