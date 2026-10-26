import "reflect-metadata";
import { UnauthorizedException } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../../src/auth/auth.service";
import { WorkspacesService } from "../../src/workspaces/workspaces.service";
import { StudentInboundReplayController } from "../../src/inbound-webhook-replay/student-inbound-replay.controller";
import { InboundWebhookReplayService } from "../../src/inbound-webhook-replay/inbound-webhook-replay.service";
import { LicenseSoftlockGuard } from "../../src/licensing-client/license-softlock.guard";
import { LicenseClientService } from "../../src/licensing-client/license-client.service";
import { studentReplayFixture } from "../support/student-replay-fixture";

/**
 * Fase 6.1c — porte do SaaS #91 (f7c61c07) na recuperação do aluno:
 * "Reenviar os que falharam" reenvia os itens com falha de um lote enquanto o
 * payload original continua retido. Armazenamento fictício (sem PostgreSQL).
 */

async function failedBatch() {
  const h = studentReplayFixture();
  const batch = await h.authorize();
  // A rota cai durante o processamento: o item falha sem gravar evento.
  h.route.active = false;
  await h.replay.processBatch({ workspaceId: "ws", batchId: batch.batchId });
  h.route.active = true;
  expect(h.items[0]).toMatchObject({ status: "failed" });
  expect(h.conversions.recordExternalConversion).not.toHaveBeenCalled();
  return { h, batchId: batch.batchId };
}

describe("reenviar os itens de recuperação que falharam (SaaS #91)", () => {
  it("mostra quantas falhas ainda podem ser reenviadas", async () => {
    const { h, batchId } = await failedBatch();
    const result = await h.replay.getStudentReplayResult(
      h.actor,
      "connection",
      "channel",
      batchId,
    );
    expect(result).toMatchObject({ state: "failed", retryableFailed: 1 });
  });

  it("reenvia a falha com o payload retido, renova a autorização e envia uma vez", async () => {
    const { h, batchId } = await failedBatch();
    h.replayQueue.enqueueBatch.mockClear();
    const queued = await h.replay.retryStudentFailedItems(
      h.actor,
      "connection",
      "channel",
      batchId,
      "fixture",
    );
    expect(queued).toMatchObject({ total: 1, retryableFailed: 0 });
    expect(h.items[0]).toMatchObject({ status: "queued", errorCode: null });
    expect(h.batches[0]).toMatchObject({
      status: "queued",
      retryCount: 1,
      lastRetriedAt: expect.any(Date),
    });
    expect(h.replayQueue.enqueueBatch).toHaveBeenCalledOnce();
    const renewed = h.audits.filter(
      (audit) =>
        audit.action === "inbound_webhook.replay.authorize" &&
        audit.afterSummary?.retryOfFailedItems === true,
    );
    expect(renewed).toHaveLength(1);
    // A autorização nova cobre o item reenviado e mantém as impressões dos
    // itens já autorizados do lote (o envio à Meta confere cada uma).
    const original = h.audits.find(
      (audit) =>
        audit.action === "inbound_webhook.replay.authorize" &&
        !audit.afterSummary?.retryOfFailedItems,
    )!;
    expect(renewed[0]!.afterSummary.studentEventHashes).toEqual(
      expect.objectContaining(original.afterSummary.studentEventHashes),
    );

    await h.replay.processBatch({ workspaceId: "ws", batchId });
    expect(h.items[0]).toMatchObject({ status: "materialized" });
    expect(h.conversions.recordExternalConversion).toHaveBeenCalledTimes(1);
    expect(h.conversionQueue.enqueueSend).toHaveBeenCalledTimes(1);
  });

  it("item sem payload retido não é reenviado", async () => {
    const { h, batchId } = await failedBatch();
    h.event.delivery.payloadExpiresAt = new Date(Date.now() - 1000);
    h.replayQueue.enqueueBatch.mockClear();
    await expect(
      h.replay.retryStudentFailedItems(
        h.actor,
        "connection",
        "channel",
        batchId,
        "fixture",
      ),
    ).rejects.toThrow("Nenhuma falha possui payload disponível para reenviar");
    expect(h.items[0]).toMatchObject({ status: "failed" });
    expect(h.replayQueue.enqueueBatch).not.toHaveBeenCalled();
    expect(
      (
        await h.replay.getStudentReplayResult(
          h.actor,
          "connection",
          "channel",
          batchId,
        )
      ).retryableFailed,
    ).toBe(0);
  });

  it("CTWA que já gerou evento nunca é reenviado (não duplica envio)", async () => {
    const { h, batchId } = await failedBatch();
    h.logs.push({
      id: "conversion-existing",
      workspaceId: "ws",
      dedupeKey: `inbound-webhook:connection:${h.event.dedupeKey}`,
      status: "sent",
      sentAt: new Date(),
    });
    await expect(
      h.replay.retryStudentFailedItems(
        h.actor,
        "connection",
        "channel",
        batchId,
        "fixture",
      ),
    ).rejects.toThrow("Nenhuma falha possui payload disponível para reenviar");
    expect(h.conversions.recordExternalConversion).not.toHaveBeenCalled();
  });

  it("exige o nome da conexão e um lote com falha", async () => {
    const { h, batchId } = await failedBatch();
    await expect(
      h.replay.retryStudentFailedItems(
        h.actor,
        "connection",
        "channel",
        batchId,
        "outro nome",
      ),
    ).rejects.toThrow("Digite exatamente o nome da conexão");
    await expect(
      h.replay.retryStudentFailedItems(
        h.actor,
        "connection",
        "channel",
        "batch-inexistente",
        "fixture",
      ),
    ).rejects.toThrow("Esta recuperação não tem itens com falha para reenviar");
  });

  it("com a rota ainda inválida, não reenvia", async () => {
    const { h, batchId } = await failedBatch();
    h.route.active = false;
    await expect(
      h.replay.retryStudentFailedItems(
        h.actor,
        "connection",
        "channel",
        batchId,
        "fixture",
      ),
    ).rejects.toThrow();
    expect(h.items[0]).toMatchObject({ status: "failed" });
  });

  it("com a licença bloqueada, o serviço recusa", async () => {
    const { h, batchId } = await failedBatch();
    h.license.getLockState.mockResolvedValue({ inert: false, locked: true });
    await expect(
      h.replay.retryStudentFailedItems(
        h.actor,
        "connection",
        "channel",
        batchId,
        "fixture",
      ),
    ).rejects.toThrow("A licença precisa estar utilizável");
    expect(h.items[0]).toMatchObject({ status: "failed" });
  });
});

const apps: NestExpressApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
const base =
  "/integrations/inbound-webhooks/connection/channels/channel/recovery";
const bearer = "Bearer synthetic-session";

async function http(locked: boolean, role = "owner") {
  const { h, batchId } = await failedBatch();
  const session: any = {
    user: { id: "actor", platformRole: "user" },
    activeWorkspaceId: "ws",
    workspaces: [
      {
        id: "ws",
        name: "synthetic",
        slug: "synthetic",
        role,
        operationalStatus: "active",
      },
    ],
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
      locked,
      reason: "revoked",
      state: { status: "blocked" },
    })),
  };
  const module = await Test.createTestingModule({
    controllers: [StudentInboundReplayController],
    providers: [
      { provide: AuthService, useValue: auth },
      { provide: WorkspacesService, useValue: new WorkspacesService(h.prisma) },
      { provide: InboundWebhookReplayService, useValue: h.replay },
      { provide: LicenseClientService, useValue: license },
      { provide: APP_GUARD, useClass: LicenseSoftlockGuard },
    ],
  }).compile();
  const app = module.createNestApplication<NestExpressApplication>();
  apps.push(app);
  await app.init();
  return { h, batchId, api: request(app.getHttpServer()) };
}

describe("reenviar falhas pela API (owner, licença)", () => {
  it("o owner reenvia pelo endpoint do lote", async () => {
    const { h, batchId, api } = await http(false);
    h.replayQueue.enqueueBatch.mockClear();
    const response = await api
      .post(`${base}/batches/${batchId}/retry`)
      .set("Authorization", bearer)
      .send({ confirmation: "fixture" })
      .expect(200);
    expect(response.body).toMatchObject({ batchId, total: 1 });
    expect(h.replayQueue.enqueueBatch).toHaveBeenCalledOnce();
  });

  it("responde 423 com a licença bloqueada e nada muda", async () => {
    const { h, batchId, api } = await http(true);
    h.replayQueue.enqueueBatch.mockClear();
    await api
      .post(`${base}/batches/${batchId}/retry`)
      .set("Authorization", bearer)
      .send({ confirmation: "fixture" })
      .expect(423);
    expect(h.items[0]).toMatchObject({ status: "failed" });
    expect(h.replayQueue.enqueueBatch).not.toHaveBeenCalled();
  });

  it.each(["admin", "analyst"])("nega %s", async (role) => {
    const { h, batchId, api } = await http(false, role);
    await api
      .post(`${base}/batches/${batchId}/retry`)
      .set("Authorization", bearer)
      .send({ confirmation: "fixture" })
      .expect(403);
    expect(h.items[0]).toMatchObject({ status: "failed" });
  });

  it("entrada estrita: campos extras são recusados", async () => {
    const { batchId, api } = await http(false);
    await api
      .post(`${base}/batches/${batchId}/retry`)
      .set("Authorization", bearer)
      .send({ confirmation: "fixture", workspaceId: "other" })
      .expect(400);
  });
});
