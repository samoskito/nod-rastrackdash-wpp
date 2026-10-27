import { describe, expect, it } from "vitest";
import {
  campaignOptionsResponseSchema,
  leadListQuerySchema,
  reportCampaignIdsSchema,
  whatsappInstanceActivitySchema,
} from "../src";

// Fase 6.3b: contratos dos filtros da Visão Geral, Relatórios e Leads
// (porte do SaaS #114, #117, #125). A atividade fica no schema de
// integrações do nod, sem schemas/billing.
describe("Fase 6.3b filter contracts", () => {
  it("validates nullable connection activity timestamps", () => {
    expect(
      whatsappInstanceActivitySchema.parse({
        leads24h: 0,
        leads7d: 3,
        leadsTotal: 12,
        lastLeadAt: null,
        lastWebhookAt: "2026-07-02T03:00:00.000Z",
      }),
    ).toMatchObject({ leadsTotal: 12, lastLeadAt: null });
    expect(
      whatsappInstanceActivitySchema.safeParse({
        leads24h: -1,
        leads7d: 0,
        leadsTotal: 0,
        lastLeadAt: null,
        lastWebhookAt: null,
      }).success,
    ).toBe(false);
  });

  it("accepts the WhatsApp number filter on the Leads list and export", () => {
    expect(
      leadListQuerySchema.parse({ whatsappInstanceId: " wpp_1 " }),
    ).toMatchObject({ whatsappInstanceId: "wpp_1" });
    expect(leadListQuerySchema.safeParse({ whatsappInstanceId: "" }).success).toBe(
      false,
    );
  });

  it("limits the campaign selection to 10 and parses campaign options", () => {
    expect(
      reportCampaignIdsSchema.safeParse(
        Array.from({ length: 10 }, (_, index) => `cmp_${index}`),
      ).success,
    ).toBe(true);
    expect(
      reportCampaignIdsSchema.safeParse(
        Array.from({ length: 11 }, (_, index) => `cmp_${index}`),
      ).success,
    ).toBe(false);
    expect(
      campaignOptionsResponseSchema.parse({
        campaigns: [
          {
            id: "cmp_1",
            name: "Promo",
            status: "active",
            businessId: "bm_1",
            adAccountId: "act_1",
            leadsByInstance: { wpp_1: 2 },
          },
        ],
      }).campaigns[0],
    ).toMatchObject({ leadsByInstance: { wpp_1: 2 } });
  });
});
