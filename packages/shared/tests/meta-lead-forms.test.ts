import { describe, expect, it } from "vitest";
import {
  leadSourceLabel,
  manualConversionPreviewSchema,
  manualConversionResultSchema,
  metaLeadFormConnectionCreateInputSchema,
  metaLeadFormConnectionUpdateInputSchema,
} from "../src";

// Fase 6.9 (PR #91/#92 do nod): contratos dos formulários Meta (Lead Ads) e
// da etapa de CRM na conversão manual. Dados fictícios.

const token = "t".repeat(40);

describe("meta lead form contracts", () => {
  it("accepts a Page connection and defaults the qualified event", () => {
    const parsed = metaLeadFormConnectionCreateInputSchema.parse({
      label: "Página Exemplo",
      pageId: "100000000000001",
      graphToken: token,
    });
    expect(parsed).toMatchObject({
      formIds: [],
      qualifiedEventName: "LeadQualificado",
    });
  });

  it("refuses the events Meta already receives and non-numeric ids", () => {
    for (const qualifiedEventName of ["Lead", "LeadSubmitted"])
      expect(
        metaLeadFormConnectionCreateInputSchema.safeParse({
          label: "x",
          pageId: "100000000000001",
          graphToken: token,
          qualifiedEventName,
        }).success,
      ).toBe(false);
    expect(
      metaLeadFormConnectionCreateInputSchema.safeParse({
        label: "x",
        pageId: "pagina",
        graphToken: token,
      }).success,
    ).toBe(false);
    expect(
      metaLeadFormConnectionUpdateInputSchema.safeParse({ capiToken: null })
        .success,
    ).toBe(true);
  });

  it("labels the lead origins", () => {
    expect(leadSourceLabel("meta_lead_form", null)).toBe("Formulário Meta");
    expect(leadSourceLabel("dashboard_leads", null)).toBe(
      "Dashboard Leads (importado)",
    );
  });
});

describe("manual conversion: CRM stage (Fase 6.9)", () => {
  const preview = {
    eventName: "QualifiedLead",
    eventLabel: "Lead qualificado",
    willSendToMeta: false,
    notSentReason: "missing_click",
    notSentReasonLabel: "Sem clique",
    destination: { kind: "ad", pixelId: "1", destinationName: null },
    attribution: { campaignId: null, campaignName: null, adId: null, adName: null },
    duplicate: null,
    recentDuplicate: null,
    mayExpireBeforeSend: false,
  };

  it("is optional on the preview and on the result (older APIs)", () => {
    expect(manualConversionPreviewSchema.safeParse(preview).success).toBe(true);
    expect(
      manualConversionPreviewSchema.parse({
        ...preview,
        crmStage: { eventName: "LeadQualificado", willSend: true, reason: null },
      }).crmStage,
    ).toEqual({ eventName: "LeadQualificado", willSend: true, reason: null });
    const result = {
      outcome: "local_only",
      conversionEventLogId: "log_1",
      status: "not_eligible",
      message: "Conversão registrada só no painel.",
      replayed: false,
    };
    expect(manualConversionResultSchema.safeParse(result).success).toBe(true);
    expect(
      manualConversionResultSchema.safeParse({
        ...result,
        crmStage: {
          outcome: "queued",
          eventName: "LeadQualificado",
          conversionEventLogId: "log_2",
          message: "A etapa foi enfileirada.",
        },
      }).success,
    ).toBe(true);
  });
});
