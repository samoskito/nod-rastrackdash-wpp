import { Test } from "@nestjs/testing";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { AuthService } from "../../src/auth/auth.service";
import { ManualConversionService } from "../../src/leads/manual-conversion.service";
import { ManualConversionsController } from "../../src/leads/manual-conversions.controller";
import { MetaReportingService } from "../../src/reporting/meta-reporting.service";
import { WorkspacesService } from "../../src/workspaces/workspaces.service";

async function createApp(role: "owner" | "admin" | "member") {
  const manual = {
    preview: vi.fn(async () => ({ willSendToMeta: true })),
    create: vi.fn(async () => ({ outcome: "queued" })),
    cancel: vi.fn(async () => ({ status: "skipped" })),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [ManualConversionsController],
    providers: [
      {
        provide: AuthService,
        useValue: {
          getSession: vi.fn(async () => ({
            user: { id: "user_1", email: "ana@example.test", name: "Ana" },
          })),
        },
      },
      {
        provide: WorkspacesService,
        useValue: {
          getCurrentWorkspace: vi.fn(() => ({
            id: "workspace_1",
            role,
            permissions: { canManageIntegrations: role !== "member" },
          })),
        },
      },
      { provide: ManualConversionService, useValue: manual },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, manual };
}

const body = {
  eventName: "QualifiedLead",
  occurredAt: new Date(Date.now() - 60_000).toISOString(),
  sendToMeta: true,
  idempotencyKey: "4b0c5a3e-8f43-4a8f-9c55-0d3a9f1d2e11",
};

describe("manual conversions controller", () => {
  it("member gets 403 on every manual conversion route", async () => {
    const { app, manual } = await createApp("member");
    const server = app.getHttpServer();
    await request(server)
      .post("/leads/lead_1/manual-conversions/preview")
      .set("Authorization", "Bearer token")
      .send(body)
      .expect(403);
    await request(server)
      .post("/leads/lead_1/manual-conversions")
      .set("Authorization", "Bearer token")
      .send(body)
      .expect(403);
    await request(server)
      .post("/leads/lead_1/manual-conversions/log_1/cancel")
      .set("Authorization", "Bearer token")
      .expect(403);
    expect(manual.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("admin creates with the session user as actor; invalid input is a 400", async () => {
    const { app, manual } = await createApp("admin");
    const server = app.getHttpServer();
    await request(server)
      .post("/leads/lead_1/manual-conversions")
      .set("Authorization", "Bearer token")
      .send(body)
      .expect(201);
    expect(manual.create).toHaveBeenCalledWith(
      "workspace_1",
      "lead_1",
      expect.objectContaining({ eventName: "QualifiedLead", note: null }),
      { userId: "user_1", name: "Ana" },
    );
    await request(server)
      .post("/leads/lead_1/manual-conversions/preview")
      .set("Authorization", "Bearer token")
      .send(body)
      .expect(200);
    // The CRM Kanban sends source "kanban" through the same route.
    await request(server)
      .post("/leads/lead_1/manual-conversions")
      .set("Authorization", "Bearer token")
      .send({ ...body, source: "kanban" })
      .expect(201);
    expect(manual.create).toHaveBeenLastCalledWith(
      "workspace_1",
      "lead_1",
      expect.objectContaining({ source: "kanban" }),
      { userId: "user_1", name: "Ana" },
    );
    await request(server)
      .post("/leads/lead_1/manual-conversions")
      .set("Authorization", "Bearer token")
      .send({ ...body, source: "crm_v2" })
      .expect(400);
    // Purchase without value/currency/order number.
    await request(server)
      .post("/leads/lead_1/manual-conversions")
      .set("Authorization", "Bearer token")
      .send({ ...body, eventName: "Purchase" })
      .expect(400);
    await request(server)
      .post("/leads/lead_1/manual-conversions/log_1/cancel")
      .set("Authorization", "Bearer token")
      .expect(200);
    expect(manual.cancel).toHaveBeenCalledWith(
      "workspace_1",
      "lead_1",
      "log_1",
      { userId: "user_1", name: "Ana" },
    );
    await app.close();
  });
});

describe("Eventos Meta audit origin of a manual conversion", () => {
  const service = Object.create(MetaReportingService.prototype) as any;

  it("labels it 'Manual por <usuario>' and filters it as its own origin", () => {
    expect(service.conversionAuditSource("manual_conversion")).toBe("manual");
    expect(
      service.conversionAuditSourceLabel("manual", {
        processingMode: "manual_conversion",
        createdByUserId: "user_1",
        createdByName: "Ana Dona",
        idempotencyKey: "key",
      }),
    ).toBe("Manual por Ana Dona");
    expect(service.conversionAuditSourceLabel("manual", null)).toBe("Manual");
    // CRM Kanban: same manual origin, labeled by where it was registered.
    expect(
      service.conversionAuditSourceLabel("manual", {
        processingMode: "manual_conversion",
        createdByUserId: "user_1",
        createdByName: "Ana Dona",
        idempotencyKey: "key",
        origin: "kanban",
      }),
    ).toBe("Manual (Kanban) por Ana Dona");
    expect(service.conversionAuditSourceWhere("manual")).toEqual({
      sourceTrigger: "manual_conversion",
    });
    expect(
      JSON.stringify(service.conversionAuditSourceWhere("other")),
    ).toContain("manual_conversion");
  });

  it("shows the sender statuses in Portuguese (never raw codes)", () => {
    expect(service.conversionAuditStatusLabel("delivery_unknown")).toBe(
      "Envio não confirmado",
    );
    expect(service.conversionAuditStatusLabel("dispatching")).toBe("Enviando");
    expect(service.conversionAuditStatusDetail("delivery_unknown")).toContain(
      "sem reenvio automático",
    );
    expect(service.conversionAuditDeliveryState("delivery_unknown")).toBe(
      "failed",
    );
    expect(service.conversionAuditDeliveryState("dispatching")).toBe("queued");
  });
});
