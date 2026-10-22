import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  whatsappConnectionTestResultSchema,
  whatsappConnectionWebhookConfigureResultSchema,
  whatsappConnectionWebhookTokenRotateResultSchema,
} from "@wpptrack/shared";
import { MetaTokenEncryptionService } from "../../src/integrations/meta/meta-token-encryption.service";
import { WhatsappConnectionsService } from "../../src/integrations/whatsapp-providers/whatsapp-connections.service";
import { WhatsappProviderRegistry } from "../../src/integrations/whatsapp-providers/whatsapp-provider.registry";
import type {
  WhatsappProviderAdapter,
  WhatsappWebhookConfigureResult,
} from "../../src/integrations/whatsapp-providers/whatsapp-provider.types";
import { WorkspaceAccessPolicyService } from "../../src/workspaces/workspace-access-policy.service";

const owner = { workspaceId: "workspace-a", userId: "user-a", role: "owner" as const };
const encryption = new MetaTokenEncryptionService({
  META_TOKEN_ENCRYPTION_KEY: "test-key",
});

function connectionRecord(provider: "waha" | "zapi" = "waha") {
  const config =
    provider === "waha"
      ? {
          provider,
          config: {
            baseUrl: "https://waha.example.com",
            apiKey: "api-key-sintetica",
            session: "aluno-sessao-teste",
          },
        }
      : {
          provider,
          config: { baseUrl: "https://z.example.com", instanceId: "i", token: "t" },
        };
  const encrypted = encryption.encrypt(JSON.stringify(config));
  return {
    id: "connection-waha",
    workspaceId: owner.workspaceId,
    name: "WAHA do cliente",
    displayName: null,
    provider,
    providerInstanceId: provider === "waha" ? "aluno-sessao-teste" : "i",
    configEncrypted: encrypted.encryptedAccessToken,
    configIv: encrypted.tokenIv,
    configTag: encrypted.tokenTag,
    webhookUrl: null,
    webhookTokenHash: "hash-antigo",
    status: "active" as const,
    lastHealthStatus: null,
    lastHealthCheckedAt: null,
    createdAt: new Date("2026-10-22T12:00:00.000Z"),
    updatedAt: new Date("2026-10-22T12:00:00.000Z"),
  };
}

function setup(
  result: WhatsappWebhookConfigureResult | Error,
  provider: "waha" | "zapi" = "waha",
  health?: Awaited<ReturnType<WhatsappProviderAdapter["getHealth"]>>,
) {
  const record = connectionRecord(provider);
  const updates: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const prisma = {
    whatsappInstance: {
      findFirst: async () => record,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { ...record, ...data };
      },
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
      },
    },
  };
  const configureWebhook = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  const registry = new WhatsappProviderRegistry();
  registry.register({
    id: "waha",
    getHealth: async () =>
      health ?? {
        provider: "waha",
        status: "connected",
        checkedAt: new Date().toISOString(),
        providerStatus: "WORKING",
      },
    configureWebhook,
  });
  const service = new WhatsappConnectionsService(
    prisma as never,
    encryption,
    registry,
    new WorkspaceAccessPolicyService(),
    { API_PUBLIC_URL: "https://api.example.com" },
  );
  return { service, updates, audits, configureWebhook };
}

describe("POST /integrations/whatsapp-connections/:id/configure-webhook (WAHA)", () => {
  it("saves the webhook on the student's WAHA with a new token and only then stores its hash", async () => {
    const { service, updates, audits, configureWebhook } = setup({
      configured: true,
      events: ["message", "message.any", "session.status"],
      sessionStatus: "WORKING",
    });

    const result = await service.configureWebhook(owner, "connection-waha");

    expect(whatsappConnectionWebhookConfigureResultSchema.parse(result)).toEqual({
      connectionId: "connection-waha",
      provider: "waha",
      configured: true,
      webhookEndpoint: "https://api.example.com/webhooks/whatsapp/connection-waha",
      events: ["message", "message.any", "session.status"],
      sessionStatus: "WORKING",
    });
    const [configArg, input] = configureWebhook.mock.calls[0] as unknown as [
      { provider: string; config: { session: string } },
      { url: string; token: string },
    ];
    expect(configArg.config.session).toBe("aluno-sessao-teste");
    expect(input.url).toBe("https://api.example.com/webhooks/whatsapp/connection-waha");
    expect(input.token.length).toBeGreaterThanOrEqual(43);
    expect(updates).toEqual([
      {
        providerInstanceId: "aluno-sessao-teste",
        webhookTokenHash: createHash("sha256").update(input.token, "utf8").digest("hex"),
        webhookUrl: "https://api.example.com/webhooks/whatsapp/connection-waha",
      },
    ]);
    // The token never comes back in the automatic mode nor in the audit.
    expect(JSON.stringify([result, audits])).not.toContain(input.token);
    expect(audits.at(-1)?.action).toBe("whatsapp_connection.webhook_configured");
  });

  it("changes nothing in the app when the WAHA refuses (old token keeps working)", async () => {
    const { service, updates, audits } = setup({
      configured: false,
      reason: "session_not_found",
      message:
        "A sessão não existe nessa WAHA. Crie a sessão no painel da sua WAHA e confira o nome.",
    });

    const result = await service.configureWebhook(owner, "connection-waha");

    expect(whatsappConnectionWebhookConfigureResultSchema.parse(result)).toMatchObject({
      configured: false,
      reason: "session_not_found",
      sessionStatus: null,
    });
    expect(updates).toEqual([]);
    expect(audits.at(-1)?.action).toBe("whatsapp_connection.webhook_configure_failed");
  });

  it("treats an adapter exception as unreachable without persisting", async () => {
    const { service, updates } = setup(new Error("boom api-key-sintetica"));

    const result = await service.configureWebhook(owner, "connection-waha");

    expect(result).toMatchObject({ configured: false, reason: "unreachable" });
    expect(JSON.stringify(result)).not.toContain("api-key-sintetica");
    expect(updates).toEqual([]);
  });

  it("is available only for WAHA connections", async () => {
    const { service } = setup(
      { configured: true, events: [], sessionStatus: null },
      "zapi",
    );

    await expect(service.configureWebhook(owner, "connection-waha")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("manual mode: rotate-webhook-token returns the URL with ?token= and the events to tick", async () => {
    const { service } = setup({ configured: true, events: [], sessionStatus: null });

    const result = await service.rotateWebhookToken(owner, "connection-waha");

    const parsed = whatsappConnectionWebhookTokenRotateResultSchema.parse(result);
    expect(parsed.wahaManualSetup).toEqual({
      webhookUrl: "https://api.example.com/webhooks/whatsapp/connection-waha",
      webhookUrlWithToken: `https://api.example.com/webhooks/whatsapp/connection-waha?token=${parsed.webhookToken}`,
      events: ["message", "message.any", "session.status"],
      tokenHeaderName: "X-Wpptrack-Webhook-Token",
    });
  });

  it("Testar conexão returns the raw WAHA session status for the screen", async () => {
    const { service } = setup(
      { configured: true, events: [], sessionStatus: null },
      "waha",
      {
        provider: "waha",
        status: "needs_reconnect",
        checkedAt: new Date().toISOString(),
        message: "WAHA session requires QR reconnection",
        providerStatus: "SCAN_QR_CODE",
      },
    );

    const result = await service.testConnection(owner, "connection-waha");

    expect(whatsappConnectionTestResultSchema.parse(result)).toMatchObject({
      provider: "waha",
      status: "needs_reconnect",
      providerStatus: "SCAN_QR_CODE",
    });
  });
});
