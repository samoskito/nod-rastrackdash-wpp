import "reflect-metadata";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WebhooksController } from "../src/webhooks/webhooks.controller";

type Instance = {
  id: string;
  workspaceId: string;
  provider: string;
  providerInstanceId: string | null;
  webhookTokenHash: string | null;
  status: "active" | "suspended";
};

const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

function controllerFor(instance: Instance) {
  const prisma = {
    whatsappInstance: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === instance.id ? instance : null,
      ),
    },
  };
  const controller = new WebhooksController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    prisma as never,
  );
  return { controller, prisma };
}

describe("POST /webhooks/whatsapp/:id", () => {
  it("rejects missing and invalid tokens before any ingestion", async () => {
    const { controller } = controllerFor({
      id: "connection-a",
      workspaceId: "workspace-a",
      provider: "uazapi_byo",
      providerInstanceId: "provider-a",
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });
    const receiver = vi.spyOn(
      controller as never,
      "recordUazapiWebhook" as never,
    );

    await expect(
      controller.recordWhatsappConnection(
        "connection-a",
        {},
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(receiver).not.toHaveBeenCalled();

    await expect(
      controller.recordWhatsappConnection(
        "connection-a",
        {},
        undefined,
        undefined,
        "invalid-token",
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(receiver).not.toHaveBeenCalled();
  });

  it("rejects an inactive connection before any ingestion", async () => {
    const inactive = controllerFor({
      id: "connection-b",
      workspaceId: "workspace-a",
      provider: "uazapi_byo",
      providerInstanceId: "provider-a",
      webhookTokenHash: hash("valid-token"),
      status: "suspended",
    }).controller;
    await expect(
      inactive.recordWhatsappConnection(
        "connection-b",
        {},
        "valid-token",
        undefined,
        undefined,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a malformed stored hash without attempting an unsafe comparison", async () => {
    const { controller } = controllerFor({
      id: "connection-malformed-hash",
      workspaceId: "workspace-a",
      provider: "uazapi_byo",
      providerInstanceId: "provider-a",
      webhookTokenHash: "not-a-sha256-hash",
      status: "active",
    });

    await expect(
      controller.recordWhatsappConnection(
        "connection-malformed-hash",
        {},
        "valid-token",
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("accepts header, Bearer, and query tokens and binds ingestion to the stored workspace and connection", async () => {
    const { controller } = controllerFor({
      id: "connection-a",
      workspaceId: "workspace-a",
      provider: "uazapi_byo",
      providerInstanceId: "provider-a",
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });
    const receiver = vi
      .spyOn(controller as never, "recordUazapiWebhook" as never)
      .mockResolvedValue({ accepted: true } as never);

    await expect(
      controller.recordWhatsappConnection(
        "connection-a",
        {},
        undefined,
        "Bearer valid-token",
        undefined,
      ),
    ).resolves.toEqual({ accepted: true });
    await expect(
      controller.recordWhatsappConnection(
        "connection-a",
        {},
        "valid-token",
        undefined,
        undefined,
      ),
    ).resolves.toEqual({ accepted: true });
    await expect(
      controller.recordWhatsappConnection(
        "connection-a",
        {},
        undefined,
        undefined,
        "valid-token",
      ),
    ).resolves.toEqual({ accepted: true });
    expect(receiver).toHaveBeenLastCalledWith(
      {},
      expect.objectContaining({
        workspaceId: "workspace-a",
        whatsappInstanceId: "connection-a",
        providerInstanceId: "provider-a",
      }),
    );
  });

  it("uses dedicated header and Bearer tokens before the query token", async () => {
    const { controller } = controllerFor({
      id: "connection-a",
      workspaceId: "workspace-a",
      provider: "uazapi_byo",
      providerInstanceId: "provider-a",
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });

    await expect(
      controller.recordWhatsappConnection(
        "connection-a",
        {},
        "invalid-token",
        "Bearer valid-token",
        "valid-token",
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      controller.recordWhatsappConnection(
        "connection-a",
        {},
        undefined,
        "Bearer invalid-token",
        "valid-token",
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a payload that claims another workspace or connection", async () => {
    const { controller } = controllerFor({
      id: "connection-a",
      workspaceId: "workspace-a",
      provider: "uazapi_byo",
      providerInstanceId: "provider-a",
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });

    await expect(
      controller.recordWhatsappConnection(
        "connection-a",
        { workspaceId: "workspace-b" },
        "valid-token",
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      controller.recordWhatsappConnection(
        "connection-a",
        { whatsappInstanceId: "connection-b" },
        "valid-token",
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("does not acknowledge a provider without a wired receiver", async () => {
    const { controller } = controllerFor({
      id: "connection-waha",
      workspaceId: "workspace-a",
      provider: "waha",
      providerInstanceId: null,
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });

    await expect(
      controller.recordWhatsappConnection(
        "connection-waha",
        { event: "message" },
        "valid-token",
      ),
    ).rejects.toMatchObject({ status: 501 });
  });

  it("does not forward NOD API without a documented compatible parser", async () => {
    const { controller } = controllerFor({
      id: "connection-nod",
      workspaceId: "workspace-a",
      provider: "nod_api",
      providerInstanceId: "provider-a",
      webhookTokenHash: hash("valid-token"),
      status: "active",
    });
    const receiver = vi.spyOn(
      controller as never,
      "recordUazapiWebhook" as never,
    );

    await expect(
      controller.recordWhatsappConnection("connection-nod", {}, "valid-token"),
    ).rejects.toMatchObject({ status: 501 });
    expect(receiver).not.toHaveBeenCalled();
  });
});
