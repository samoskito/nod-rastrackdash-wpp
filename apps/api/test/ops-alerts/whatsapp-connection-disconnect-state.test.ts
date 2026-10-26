import { describe, expect, it, vi } from "vitest";
import { whatsappConnectionsSchema } from "@wpptrack/shared";
import { MetaTokenEncryptionService } from "../../src/integrations/meta/meta-token-encryption.service";
import { WhatsappConnectionsService } from "../../src/integrations/whatsapp-providers/whatsapp-connections.service";
import { WhatsappProviderRegistry } from "../../src/integrations/whatsapp-providers/whatsapp-provider.registry";
import { WorkspaceAccessPolicyService } from "../../src/workspaces/workspace-access-policy.service";

/**
 * Fase 6.1c (porte do SaaS #63): a leitura de status para o alerta usa a API
 * de status do provedor (WAHA: sessão; Uazapi: instância) e a lista de
 * conexões mostra a desconexão confirmada. Credenciais fictícias.
 */
const encryption = new MetaTokenEncryptionService({
  META_TOKEN_ENCRYPTION_KEY: "test-key",
});

function wahaRecord(id = "connection-waha") {
  const encrypted = encryption.encrypt(
    JSON.stringify({
      provider: "waha",
      config: {
        baseUrl: "https://waha.example.com",
        apiKey: "api-key-sintetica",
        session: "sessao-teste",
      },
    }),
  );
  return {
    id,
    workspaceId: "workspace-a",
    name: "WAHA do cliente",
    displayName: null,
    provider: "waha",
    providerInstanceId: "sessao-teste",
    configEncrypted: encrypted.encryptedAccessToken,
    configIv: encrypted.tokenIv,
    configTag: encrypted.tokenTag,
    webhookUrl: null,
    webhookTokenHash: null,
    status: "active" as const,
    lastHealthStatus: null,
    lastHealthCheckedAt: null,
    createdAt: new Date("2026-10-22T12:00:00.000Z"),
    updatedAt: new Date("2026-10-22T12:00:00.000Z"),
  };
}

function setup(deliveries: Array<Record<string, any>> = []) {
  const record = wahaRecord();
  const getHealth = vi.fn(async () => ({
    provider: "waha" as const,
    status: "disconnected" as const,
    checkedAt: new Date().toISOString(),
    providerStatus: "STOPPED",
  }));
  const registry = new WhatsappProviderRegistry();
  registry.register({ id: "waha", getHealth });
  const update = vi.fn();
  const auditCreate = vi.fn();
  const prisma = {
    whatsappInstance: {
      findFirst: vi.fn(async () => record),
      findMany: vi.fn(async () => [record]),
      update,
    },
    auditLog: { create: auditCreate },
    workspaceOpsAlertDelivery: {
      findFirst: vi.fn(async ({ where, orderBy }: Record<string, any>) => {
        const rows = deliveries.filter(
          (row) =>
            row.alertKey === where.alertKey &&
            (where.detail === undefined || typeof where.detail !== "string" || row.detail === where.detail) &&
            (!where.createdAt?.gt || row.createdAt > where.createdAt.gt) &&
            (!where.OR ||
              where.OR.some((part: Record<string, any>) =>
                typeof part.detail === "string"
                  ? row.detail === part.detail
                  : String(row.detail).startsWith(part.detail.startsWith),
              )),
        );
        const sorted = [...rows].sort((a, b) => +a.createdAt - +b.createdAt);
        return (orderBy?.createdAt === "desc" ? sorted.reverse() : sorted)[0] ?? null;
      }),
    },
  };
  const service = new WhatsappConnectionsService(
    prisma as never,
    encryption,
    registry,
    new WorkspaceAccessPolicyService(),
    { API_PUBLIC_URL: "https://api.example.com" },
  );
  return { service, getHealth, update, auditCreate };
}

describe("status da conexão para o alerta de desconexão", () => {
  it("lê a sessão da WAHA pela API de status, sem gravar saúde nem auditoria", async () => {
    const { service, getHealth, update, auditCreate } = setup();
    const reading = await service.readConnectionStatusForAlert(
      "workspace-a",
      "connection-waha",
    );
    expect(reading).toEqual({
      provider: "waha",
      status: "disconnected",
      providerStatus: "STOPPED",
    });
    expect(getHealth).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "waha" }),
    );
    expect(update).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("a lista de conexões mostra a desconexão confirmada (2 leituras)", async () => {
    const { service } = setup([
      {
        alertKey: "disconnect:connection-waha",
        detail: "disconnect_observed streak=1",
        createdAt: new Date("2026-10-26T12:00:00.000Z"),
      },
      {
        alertKey: "disconnect:connection-waha",
        detail: "disconnect_confirmed streak=2 notify_disabled",
        createdAt: new Date("2026-10-26T12:15:00.000Z"),
      },
    ]);
    const list = await service.listConnections("workspace-a");
    expect(list[0]).toMatchObject({
      disconnectAlert: {
        confirmedAt: "2026-10-26T12:15:00.000Z",
        lastCheckedAt: "2026-10-26T12:15:00.000Z",
      },
    });
    // O contrato compartilhado aceita o aviso.
    expect(whatsappConnectionsSchema.safeParse(list).success).toBe(true);
  });

  it("uma leitura só, ou conectada depois, não mostra alerta", async () => {
    const single = setup([
      {
        alertKey: "disconnect:connection-waha",
        detail: "disconnect_observed streak=1",
        createdAt: new Date("2026-10-26T12:00:00.000Z"),
      },
    ]);
    expect((await single.service.listConnections("workspace-a"))[0]).not.toHaveProperty(
      "disconnectAlert",
    );
    const reconnected = setup([
      {
        alertKey: "disconnect:connection-waha",
        detail: "sent=1 failed=0",
        createdAt: new Date("2026-10-26T12:15:00.000Z"),
      },
      {
        alertKey: "disconnect:connection-waha",
        detail: "connected_observed",
        createdAt: new Date("2026-10-26T12:30:00.000Z"),
      },
    ]);
    expect(
      (await reconnected.service.listConnections("workspace-a"))[0],
    ).not.toHaveProperty("disconnectAlert");
  });
});
