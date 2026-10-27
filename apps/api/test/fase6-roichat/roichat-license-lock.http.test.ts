import "reflect-metadata";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { APP_GUARD } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../../src/auth/auth.service";
import { ConversionCatalogService } from "../../src/conversion-rules/conversion-catalog.service";
import { ConversionRulesController } from "../../src/conversion-rules/conversion-rules.controller";
import { ConversionRulesService } from "../../src/conversion-rules/conversion-rules.service";
import { FunnelConfigurationService } from "../../src/conversion-rules/funnel-configuration.service";
import { ProviderConversionRulesService } from "../../src/conversion-rules/provider-conversion-rules.service";
import { InboundConversionAutomationIngestionService } from "../../src/inbound-webhooks/inbound-conversion-automation-ingestion.service";
import { configureInboundWebhookBodyParser } from "../../src/inbound-webhooks/inbound-webhook-body-parser";
import { InboundWebhookChannelRoutesService } from "../../src/inbound-webhooks/inbound-webhook-channel-routes.service";
import { InboundWebhookConnectionsController } from "../../src/inbound-webhooks/inbound-webhook-connections.controller";
import { InboundWebhookConnectionsService } from "../../src/inbound-webhooks/inbound-webhook-connections.service";
import { InboundWebhookIngestionService } from "../../src/inbound-webhooks/inbound-webhook-ingestion.service";
import { InboundWebhookMetaCloudVerificationService } from "../../src/inbound-webhooks/inbound-webhook-meta-cloud-verification.service";
import { InboundWebhookPublicController } from "../../src/inbound-webhooks/inbound-webhook-public.controller";
import { IntegrationEndpointsService } from "../../src/inbound-webhooks/integration-endpoints.service";
import { LicenseClientService } from "../../src/licensing-client/license-client.service";
import { LicenseSoftlockGuard } from "../../src/licensing-client/license-softlock.guard";
import { WorkspacesService } from "../../src/workspaces/workspaces.service";

/**
 * Fase 6.8: with a blocked license every ROI Chat WRITE answers 423 at the
 * global guard (create the ROI Chat connection/number, create the rule
 * "Compra no ROI Chat", the number URL receiving an entry or a purchase) and
 * nothing reaches the services; READS keep working (connections and
 * capabilities). Dados fictícios.
 */

const apps: NestExpressApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

const purchase = JSON.parse(
  readFileSync(
    resolve(__dirname, "../fixtures/roichat/purchase.synthetic.json"),
    "utf8",
  ),
);

const roichatConnection = {
  provider: "roichat",
  displayName: "ROI Chat comercial",
  connectedPhone: "+5511900000001",
};

const roichatRule = {
  name: "Compra no ROI Chat",
  triggerType: "provider_automation",
  eventName: "Purchase",
  automationSource: "roichat",
  connectionId: "conn_roichat_1",
  scope: "all_numbers",
  channelIds: [],
  crossConnectionScope: true,
  perRuleUrl: false,
};

async function appFor(locked: boolean) {
  const connections = {
    createConnection: vi.fn(async () => ({
      connection: { id: "conn_roichat_1" },
      webhookUrl: "http://localhost:3333/webhooks/inbound/conn_roichat_1?token=x",
    })),
    listConnections: vi.fn(async () => []),
    getCapabilities: vi.fn(async () => ({ enabled: true, providers: [] })),
  };
  const rules = {
    createRule: vi.fn(async () => ({ id: "rule_1" })),
  };
  const entryIngestion = {
    ingest: vi.fn(async () => ({ status: "accepted", duplicate: false })),
  };
  const license = {
    getLockState: vi.fn(async () =>
      locked
        ? {
            inert: false,
            locked: true,
            reason: "revoked",
            state: { status: "blocked" },
          }
        : {
            inert: false,
            locked: false,
            reason: null,
            state: { status: "active" },
          },
    ),
  };
  const session = { user: { id: "user_1", platformRole: "platform_owner" } };
  const module = await Test.createTestingModule({
    controllers: [
      InboundWebhookConnectionsController,
      ConversionRulesController,
      InboundWebhookPublicController,
    ],
    providers: [
      {
        provide: AuthService,
        useValue: { getSession: vi.fn(async () => session) },
      },
      {
        provide: WorkspacesService,
        useValue: {
          getCurrentWorkspace: vi.fn(() => ({
            id: "ws_1",
            role: "owner",
            permissions: { canManageIntegrations: true },
          })),
        },
      },
      { provide: InboundWebhookConnectionsService, useValue: connections },
      { provide: InboundWebhookChannelRoutesService, useValue: {} },
      {
        provide: InboundConversionAutomationIngestionService,
        useValue: { ingest: vi.fn() },
      },
      { provide: ConversionRulesService, useValue: {} },
      { provide: FunnelConfigurationService, useValue: {} },
      { provide: ConversionCatalogService, useValue: {} },
      { provide: ProviderConversionRulesService, useValue: rules },
      { provide: IntegrationEndpointsService, useValue: { ingest: vi.fn() } },
      { provide: InboundWebhookIngestionService, useValue: entryIngestion },
      {
        provide: InboundWebhookMetaCloudVerificationService,
        useValue: { matches: vi.fn(async () => false) },
      },
      { provide: LicenseClientService, useValue: license },
      { provide: APP_GUARD, useClass: LicenseSoftlockGuard },
    ],
  }).compile();
  const app = module.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  configureInboundWebhookBodyParser(app);
  apps.push(app);
  await app.init();
  const server = request(app.getHttpServer());
  const cookie = "wpptrack_session=refresh-token";
  return {
    connections,
    rules,
    entryIngestion,
    server,
    get: (path: string) => server.get(path).set("Cookie", cookie),
    post: (path: string) => server.post(path).set("Cookie", cookie),
  };
}

const numberUrl = "/webhooks/inbound/conn_roichat_1?token=ficticio";

describe("ROI Chat with a blocked license", () => {
  it("answers 423 when creating a ROI Chat connection; the service is never called", async () => {
    const harness = await appFor(true);
    const response = await harness
      .post("/integrations/inbound-webhooks")
      .send(roichatConnection)
      .expect(423);
    expect(response.body).toMatchObject({
      statusCode: 423,
      error: "License Locked",
    });
    expect(harness.connections.createConnection).not.toHaveBeenCalled();
  });

  it("answers 423 when creating the rule \"Compra no ROI Chat\"", async () => {
    const harness = await appFor(true);
    await harness
      .post("/conversion-rules/providers")
      .send(roichatRule)
      .expect(423);
    expect(harness.rules.createRule).not.toHaveBeenCalled();
  });

  it("answers 423 on the number URL (entry or purchase) and records nothing", async () => {
    const harness = await appFor(true);
    await harness.server
      .post(numberUrl)
      .set("Content-Type", "application/json")
      .send(JSON.stringify(purchase))
      .expect(423);
    expect(harness.entryIngestion.ingest).not.toHaveBeenCalled();
  });

  it("keeps the reads working (connections and capabilities)", async () => {
    const harness = await appFor(true);
    await harness.get("/integrations/inbound-webhooks").expect(200);
    await harness.get("/integrations/inbound-webhooks/capabilities").expect(200);
  });

  it("creates the connection and accepts the number URL once unlocked", async () => {
    const harness = await appFor(false);
    await harness
      .post("/integrations/inbound-webhooks")
      .send(roichatConnection)
      .expect(201);
    expect(harness.connections.createConnection).toHaveBeenCalledWith(
      "ws_1",
      expect.objectContaining({ provider: "roichat", connectedPhone: "+5511900000001" }),
      "user_1",
    );
    await harness.server
      .post(numberUrl)
      .set("Content-Type", "application/json")
      .send(JSON.stringify(purchase))
      .expect(202);
    expect(harness.entryIngestion.ingest).toHaveBeenCalledTimes(1);
  });
});
