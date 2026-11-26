import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LeadDetailDto } from "@wpptrack/shared";
import { crmCard } from "./support/crm-fixtures";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/leads/lead_1",
}));
vi.mock("../src/app/(app)/leads/[leadId]/observed-event-actions", () => ({
  deleteObservedEventAction: vi.fn(),
}));
vi.mock("../src/app/(app)/leads/[leadId]/actions", () => ({
  previewManualConversionAction: vi.fn(),
  createManualConversionAction: vi.fn(),
  cancelManualConversionAction: vi.fn(),
}));

import { LeadDetailView } from "../src/app/(app)/leads/[leadId]/lead-detail-view";
import { CrmCardBody } from "../src/app/(app)/crm/crm-card";

/**
 * Regra em observação (regra do Samuel, 23/11/2026): o teste aparece nas
 * telas reais do cliente, com a marca "Em observação", e dá para apagar.
 */

function detail(): LeadDetailDto {
  return {
    lead: {
      id: "lead_1",
      workspaceId: "workspace_1",
      name: "Lead Teste",
      phoneDisplay: "+55 11 99999-0001",
      phoneHash: "hash_1",
      status: "converted",
      source: "uazapi",
      labels: [],
      campaignId: "cmp_1",
      campaignName: "Campanha",
      adSetId: null,
      adId: null,
      lastEventName: "Purchase",
      stageObservation: true,
      firstMessageAt: "2026-11-26T12:00:00.000Z",
      lastMessageAt: "2026-11-26T12:05:00.000Z",
      createdAt: "2026-11-26T12:00:00.000Z",
      updatedAt: "2026-11-26T12:05:00.000Z",
    },
    attribution: {
      campaignName: "Campanha",
      adSetName: null,
      adName: null,
      creative: { thumbnailUrl: null, destinationUrl: null },
    },
    conversionEvents: [
      {
        id: "exec_obs_1",
        eventName: "Purchase",
        status: "provider_observation",
        sourceTrigger: "inbound_webhook:xmax:provider_automation",
        pixelId: null,
        campaignId: "cmp_1",
        adSetId: null,
        adId: null,
        errorCode: null,
        errorMessage: "Regra em observação: nada foi enviado à Meta.",
        occurredAt: "2026-11-26T12:10:00.000Z",
        sentAt: null,
        createdAt: "2026-11-26T12:10:01.000Z",
        manual: null,
        observation: { executionId: "exec_obs_1" },
      },
    ],
    webhookEvents: [],
  };
}

function render(canManage: boolean): string {
  return renderToStaticMarkup(
    createElement(LeadDetailView, {
      detail: detail(),
      manualAccess: { canManage, currency: "BRL", licenseLocked: false },
    }),
  );
}

describe("Em observação no front", () => {
  it("lead page lists the observed event with the mark, the rule origin and Excluir teste", () => {
    const html = render(true);
    expect(html).toContain("Em observação");
    expect(html).not.toContain(">Enviado<");
    expect(html).not.toContain("Descartado");
    expect(html).toContain("Regra · XMAX CRM");
    expect(html).toContain("Teste, sem envio à Meta");
    expect(html).toContain("Excluir teste");
  });

  it("without permission the mark stays and the delete button does not show", () => {
    const html = render(false);
    expect(html).toContain("Em observação");
    expect(html).not.toContain("Excluir teste");
  });

  it("CRM card shows Em observação only for an observed stage", () => {
    const options = { showWhatsappNumber: false, showValue: true, now: new Date() };
    const observed = renderToStaticMarkup(
      createElement(CrmCardBody, {
        card: crmCard(1, { observation: true, valueCents: 49_700, currency: "BRL" }),
        options,
      }),
    );
    const real = renderToStaticMarkup(
      createElement(CrmCardBody, { card: crmCard(2), options }),
    );
    expect(observed).toContain("Em observação");
    expect(real).not.toContain("Em observação");
  });
});
