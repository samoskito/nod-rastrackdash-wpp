import "reflect-metadata";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../../src/auth/auth.service";
import { DiagnosticsService } from "../../src/diagnostics/diagnostics.service";
import { MetaInitialSyncPeriodService } from "../../src/reporting/meta-initial-sync-period";
import { MetaReportSyncQueueService } from "../../src/reporting/meta-report-sync-queue.service";
import { MetaReportingService } from "../../src/reporting/meta-reporting.service";
import { ReportingController } from "../../src/reporting/reporting.controller";
import { WorkspacesService } from "../../src/workspaces/workspaces.service";

// Fase 6.3b: ported from the SaaS reporting-controller suite (#106, #114,
// #117, #119): campaign options, several campaigns and the WhatsApp number
// filter. Reads only: they stay open with a locked license.

const apps: INestApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function harness() {
  const reporting = {
    getCampaignOptions: vi.fn(async (_input: Record<string, unknown>) => ({
      campaigns: [
        {
          id: "cmp_1",
          name: "Black Friday WhatsApp",
          status: "active",
          businessId: "business_1",
          adAccountId: "act_123",
          leadsByInstance: { instance_123: 2 },
        },
      ],
    })),
    getCampaignReportOverview: vi.fn(
      async (_input: Record<string, unknown>) => ({}),
    ),
    getAdSetReportOverview: vi.fn(
      async (_input: Record<string, unknown>) => ({}),
    ),
    getAdReportOverview: vi.fn(async (_input: Record<string, unknown>) => ({})),
    getCampaignReportCsv: vi.fn(async (_input: Record<string, unknown>) => ({
      filename: "campanhas.csv",
      content: "Campanha;",
    })),
  };
  const module = await Test.createTestingModule({
    controllers: [ReportingController],
    providers: [
      { provide: MetaReportingService, useValue: reporting },
      { provide: DiagnosticsService, useValue: {} },
      {
        provide: AuthService,
        useValue: { getSession: vi.fn(async () => ({ user: { id: "u" } })) },
      },
      {
        provide: WorkspacesService,
        useValue: {
          getCurrentWorkspace: () => ({
            id: "workspace_1",
            role: "owner",
            accessMode: "membership",
            permissions: { canViewReports: true, canExportReports: true },
          }),
        },
      },
      { provide: MetaReportSyncQueueService, useValue: {} },
      { provide: MetaInitialSyncPeriodService, useValue: {} },
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  apps.push(app);
  await app.init();
  return { app, reporting };
}

const get = (app: INestApplication, path: string) =>
  request(app.getHttpServer())
    .get(path)
    .set("Cookie", "wpptrack_session=refresh-token");

describe("reports: filtros da Visão Geral e Relatórios (Fase 6.3b)", () => {
  it("returns campaign options for the current workspace and requested scope", async () => {
    const { app, reporting } = await harness();

    await get(
      app,
      "/reports/campaign-options?since=2026-07-01&until=2026-07-02&businessId=business_1&adAccountId=act_123",
    )
      .expect(200)
      .expect(({ body }) => {
        expect(body.campaigns[0]).toMatchObject({
          id: "cmp_1",
          leadsByInstance: { instance_123: 2 },
        });
      });

    expect(reporting.getCampaignOptions).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      since: "2026-07-01",
      until: "2026-07-02",
      businessId: "business_1",
      adAccountId: "act_123",
    });
  });

  it("keeps several ad accounts on the campaign options (adAccountIds)", async () => {
    const { app, reporting } = await harness();

    await get(
      app,
      "/reports/campaign-options?since=2026-07-01&until=2026-07-02&adAccountIds=act_1,act_2",
    ).expect(200);

    expect(reporting.getCampaignOptions).toHaveBeenCalledWith(
      expect.objectContaining({ adAccountIds: ["act_1", "act_2"] }),
    );
  });

  it("passes one WhatsApp number filter to every report level", async () => {
    const { app, reporting } = await harness();

    for (const path of ["campaigns", "adsets", "ads"]) {
      await get(app, `/reports/${path}?whatsappInstanceId=instance_123`).expect(
        200,
      );
    }

    for (const method of [
      reporting.getCampaignReportOverview,
      reporting.getAdSetReportOverview,
      reporting.getAdReportOverview,
    ]) {
      expect(method).toHaveBeenCalledWith(
        expect.objectContaining({ whatsappInstanceId: "instance_123" }),
      );
    }
  });

  it("nod: the campaigns CSV follows the WhatsApp number filter", async () => {
    const { app, reporting } = await harness();

    await get(app, "/reports/campaigns/export.csv?whatsappInstanceId=instance_123").expect(
      200,
    );

    expect(reporting.getCampaignReportCsv).toHaveBeenCalledWith(
      expect.objectContaining({ whatsappInstanceId: "instance_123" }),
    );
  });

  it("parses comma-separated campaignIds and merges the legacy campaignId", async () => {
    const { app, reporting } = await harness();

    await get(
      app,
      "/reports/campaigns?campaignId=cmp_1&campaignIds=cmp_2,cmp_1",
    ).expect(200);

    expect(reporting.getCampaignReportOverview).toHaveBeenCalledWith(
      expect.objectContaining({ campaignIds: ["cmp_1", "cmp_2"] }),
    );
  });

  it("rejects repeated and oversized campaignIds query parameters", async () => {
    const { app, reporting } = await harness();

    await get(app, "/reports/campaigns?campaignIds=cmp_1&campaignIds=cmp_2")
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toBe("Filtro campaignIds inválido");
      });

    await get(
      app,
      `/reports/campaigns?campaignIds=${Array.from(
        { length: 11 },
        (_, index) => `cmp_${index + 1}`,
      ).join(",")}`,
    )
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toBe(
          "No máximo 10 campanhas podem ser selecionadas",
        );
      });

    expect(reporting.getCampaignReportOverview).not.toHaveBeenCalled();
  });

  it("rejects an empty WhatsApp number filter", async () => {
    const { app, reporting } = await harness();

    await get(app, "/reports/campaigns?whatsappInstanceId=%20%20")
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toBe("Instância WhatsApp inválida");
      });

    expect(reporting.getCampaignReportOverview).not.toHaveBeenCalled();
  });
});
