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

// Fase 6.3a: ported from the SaaS reporting-controller suite (e4139c4c:
// "valor corrigido (antes R$ X)" only for the backoffice; #157: the default
// period is the São Paulo report day). Reads only: no license lock involved.

const apps: INestApplication[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function harness(
  workspace: Record<string, unknown> = {
    id: "workspace_1",
    role: "owner",
    accessMode: "membership",
  },
) {
  const reporting = {
    getCampaignReportOverview: vi.fn(
      async (_input: Record<string, unknown>) => ({}),
    ),
    getConversionEventAuditDetail: vi.fn(async () => ({
      id: "conversion_1",
      canRetry: false,
      valueCorrection: {
        previousValueCents: 29760,
        valueCents: 24700,
        currency: "BRL",
      },
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
            ...workspace,
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

describe("reports: números corretos (Fase 6.3a)", () => {
  it("shows the corrected value (before R$ X) only to the backoffice", async () => {
    const owner = await harness();
    await get(owner.app, "/reports/conversions/audit/conversion_1")
      .expect(200)
      .expect(({ body }) => {
        expect(body.valueCorrection).toBeNull();
      });

    const support = await harness({
      id: "workspace_1",
      role: "owner",
      accessMode: "platform_support",
      platformRole: "platform_operator",
    });
    await get(support.app, "/reports/conversions/audit/conversion_1")
      .expect(200)
      .expect(({ body }) => {
        expect(body.valueCorrection).toEqual({
          previousValueCents: 29760,
          valueCents: 24700,
          currency: "BRL",
        });
      });
  });

  it.each([
    ["2026-10-21T01:30:00.000Z", "2026-10-14", "2026-10-20"],
    ["2026-10-21T15:00:00.000Z", "2026-10-15", "2026-10-21"],
  ])(
    "defaults the period to the Sao Paulo report day at %s",
    async (now, since, until) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(now));
      const { app, reporting } = await harness();

      await get(app, "/reports/campaigns").expect(200);

      expect(reporting.getCampaignReportOverview).toHaveBeenCalledWith(
        expect.objectContaining({ since, until }),
      );
    },
  );
});
