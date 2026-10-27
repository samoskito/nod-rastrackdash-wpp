import "reflect-metadata";
import { APP_GUARD } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../../src/auth/auth.service";
import { PlatformAdminService } from "../../src/auth/platform-admin.service";
import { ConversionCatalogService } from "../../src/conversion-rules/conversion-catalog.service";
import { ConversionRulesController } from "../../src/conversion-rules/conversion-rules.controller";
import { ConversionRulesService } from "../../src/conversion-rules/conversion-rules.service";
import { FunnelConfigurationService } from "../../src/conversion-rules/funnel-configuration.service";
import { ProviderConversionRulesService } from "../../src/conversion-rules/provider-conversion-rules.service";
import { BackofficeIntegrationEventsController } from "../../src/inbound-webhooks/backoffice-integration-events.controller";
import { BackofficeIntegrationEventsService } from "../../src/inbound-webhooks/backoffice-integration-events.service";
import { InboundConversionAutomationIngestionService } from "../../src/inbound-webhooks/inbound-conversion-automation-ingestion.service";
import { configureInboundWebhookBodyParser } from "../../src/inbound-webhooks/inbound-webhook-body-parser";
import { InboundWebhookIngestionService } from "../../src/inbound-webhooks/inbound-webhook-ingestion.service";
import { InboundWebhookMetaCloudVerificationService } from "../../src/inbound-webhooks/inbound-webhook-meta-cloud-verification.service";
import { InboundWebhookPublicController } from "../../src/inbound-webhooks/inbound-webhook-public.controller";
import { IntegrationEndpointsController } from "../../src/inbound-webhooks/integration-endpoints.controller";
import { IntegrationEndpointsService } from "../../src/inbound-webhooks/integration-endpoints.service";
import { LicenseClientService } from "../../src/licensing-client/license-client.service";
import { LicenseSoftlockGuard } from "../../src/licensing-client/license-softlock.guard";
import { WorkspacesService } from "../../src/workspaces/workspaces.service";

/**
 * Fase 6.7: with a blocked license every Yampi WRITE answers 423 at the
 * global guard (create/edit a Yampi rule, the Yampi webhook on the single
 * URL, "Gerar URL única") and nothing reaches the services; READS keep
 * working ("Ver dados recebidos", Backoffice > Recebimentos das URLs únicas).
 */

const apps: NestExpressApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

const yampiRule = {
  name: "Pedido pago Yampi",
  triggerType: "provider_automation",
  eventName: "Purchase",
  automationSource: "yampi",
  connectionId: "conn_1",
  scope: "all_numbers",
  channelIds: [],
  perRuleUrl: false,
};

async function appFor(locked: boolean) {
  const rules = {
    createRule: vi.fn(async () => ({ id: "rule_1" })),
    updateRule: vi.fn(async () => ({ id: "rule_1" })),
  };
  const endpoints = {
    ingest: vi.fn(async () => ({ status: "accepted" })),
    ensure: vi.fn(async () => ({ id: "endpoint_1" })),
    readEventPayload: vi.fn(async () => ({ eventId: "event_1" })),
  };
  const receipts = {
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    readPayload: vi.fn(async () => ({ eventId: "event_1" })),
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
      ConversionRulesController,
      IntegrationEndpointsController,
      InboundWebhookPublicController,
      BackofficeIntegrationEventsController,
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
            permissions: { canManageIntegrations: true },
          })),
        },
      },
      { provide: ConversionRulesService, useValue: {} },
      { provide: FunnelConfigurationService, useValue: {} },
      { provide: ConversionCatalogService, useValue: {} },
      { provide: ProviderConversionRulesService, useValue: rules },
      { provide: IntegrationEndpointsService, useValue: endpoints },
      {
        provide: InboundConversionAutomationIngestionService,
        useValue: { ingest: vi.fn() },
      },
      { provide: InboundWebhookIngestionService, useValue: { ingest: vi.fn() } },
      {
        provide: InboundWebhookMetaCloudVerificationService,
        useValue: { matches: vi.fn(async () => false) },
      },
      {
        provide: PlatformAdminService,
        useValue: {
          assertPlatformAdmin: vi.fn(async () => ({
            id: "user_1",
            email: "owner@example.test",
            role: "platform_owner",
          })),
        },
      },
      { provide: BackofficeIntegrationEventsService, useValue: receipts },
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
  const api = {
    get: (path: string) => server.get(path).set("Cookie", cookie),
    post: (path: string) => server.post(path).set("Cookie", cookie),
    patch: (path: string) => server.patch(path).set("Cookie", cookie),
  };
  return { rules, endpoints, receipts, api };
}

describe("Yampi with a blocked license", () => {
  it("answers 423 when creating or editing a Yampi rule; the service is never called", async () => {
    const { rules, api } = await appFor(true);
    const created = await api
      .post("/conversion-rules/providers")
      .set("Content-Type", "application/json")
      .send(yampiRule);
    expect(created.status).toBe(423);
    const edited = await api
      .patch("/conversion-rules/providers/rule_1")
      .set("Content-Type", "application/json")
      .send({ productFilterCodes: ["SKU-FICT-01"] });
    expect(edited.status).toBe(423);
    expect(rules.createRule).not.toHaveBeenCalled();
    expect(rules.updateRule).not.toHaveBeenCalled();
  });

  it("answers 423 on the Yampi webhook and on 'Gerar URL única', recording nothing", async () => {
    const { endpoints, api } = await appFor(true);
    const postback = await api
      .post("/webhooks/inbound/integrations/endpoint_1?token=secret")
      .set("Content-Type", "application/json")
      .set("X-Yampi-Hmac-SHA256", "hmac-ficticio")
      .send({ event: "order.paid", resource: { id: 70000001 } });
    expect(postback.status).toBe(423);
    const ensure = await api
      .post("/integrations/endpoints")
      .set("Content-Type", "application/json")
      .send({ provider: "yampi" });
    expect(ensure.status).toBe(423);
    expect(endpoints.ingest).not.toHaveBeenCalled();
    expect(endpoints.ensure).not.toHaveBeenCalled();
  });

  it("keeps the reads: 'Ver dados recebidos' and the Backoffice receipts", async () => {
    const { endpoints, receipts, api } = await appFor(true);
    expect(
      (await api.get("/integrations/endpoints/events/event_1/payload")).status,
    ).toBe(200);
    expect((await api.get("/backoffice/integration-events")).status).toBe(200);
    expect(
      (await api.get("/backoffice/integration-events/event_1/payload")).status,
    ).toBe(200);
    expect(endpoints.readEventPayload).toHaveBeenCalledWith(
      "ws_1",
      "event_1",
      "user_1",
    );
    expect(receipts.list).toHaveBeenCalled();
  });

  it("creates the Yampi rule normally with a usable license (no mode: the API decides)", async () => {
    const { rules, api } = await appFor(false);
    const created = await api
      .post("/conversion-rules/providers")
      .set("Content-Type", "application/json")
      .send(yampiRule);
    expect(created.status).toBe(201);
    expect(rules.createRule).toHaveBeenCalledWith(
      "ws_1",
      expect.objectContaining({ automationSource: "yampi" }),
      "user_1",
    );
    const input = (rules.createRule.mock.calls[0] as unknown[])[1] as Record<
      string,
      unknown
    >;
    expect(input.mode).toBeUndefined();
  });
});
