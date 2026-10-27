import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  configurationBlockedConversionEventWhere,
  isConfigurationBlockedConversionEvent,
  isMetaAuthFailureConversionEvent,
  RETIRED_LEAD_FORM_CRM_TRIGGER,
  rejectedRetryExcludedSourceTriggers,
} from "../../src/conversion-events/conversion-event-retry";
import { ConversionEventsService } from "../../src/conversion-events/conversion-events.service";

/**
 * 1.3.1: os formulários Meta (Lead Ads) da 1.3.0 foram retirados. Uma etapa
 * de CRM que sobrou no banco (fila, "Reenviar bloqueados", nova tentativa)
 * nunca vai para a rota comum de mensagens: encerra como skipped.
 */
describe("etapa de CRM dos formulários Meta retirada", () => {
  it("sendReadyEvent encerra como skipped sem enviar", async () => {
    const log = {
      id: "log_crm_1",
      workspaceId: "workspace_1",
      sourceTrigger: RETIRED_LEAD_FORM_CRM_TRIGGER,
      status: "ready_to_send",
      eventId: "lead_1:LeadQualificado",
      dedupeKey: "dedupe_crm_1",
      eventOccurredAt: new Date(),
    };
    const prisma = {
      conversionEventLog: {
        findUnique: vi.fn(async () => ({ ...log })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const adapter = { sendEvent: vi.fn(), sendEvents: vi.fn() };
    const service = new ConversionEventsService(
      prisma as never,
      adapter as never,
      {} as never,
      undefined,
      {} as never,
    );

    await expect(service.sendReadyEvent("log_crm_1")).resolves.toEqual({
      conversionEventLogId: "log_crm_1",
      workspaceId: "workspace_1",
      status: "skipped",
    });
    expect(prisma.conversionEventLog.updateMany).toHaveBeenCalledWith({
      where: { id: "log_crm_1", status: "ready_to_send" },
      data: expect.objectContaining({ status: "skipped", errorCode: null }),
    });
    expect(adapter.sendEvent).not.toHaveBeenCalled();
    expect(adapter.sendEvents).not.toHaveBeenCalled();
  });

  it("fica fora do Reenviar recusados e do Reenviar bloqueados", () => {
    expect(rejectedRetryExcludedSourceTriggers).toContain("meta_lead_form_crm");
    const blocked = {
      status: "not_configured",
      errorCode: "MissingMetaDestination",
      sourceTrigger: "meta_lead_form_crm",
    };
    expect(isConfigurationBlockedConversionEvent(blocked)).toBe(false);
    expect(
      isConfigurationBlockedConversionEvent({ ...blocked, sourceTrigger: "manual_conversion" }),
    ).toBe(true);
    expect(configurationBlockedConversionEventWhere.sourceTrigger).toEqual({
      not: "meta_lead_form_crm",
    });
    expect(
      isMetaAuthFailureConversionEvent({
        status: "error",
        errorCode: "MetaCapiRejected",
        sourceTrigger: "meta_lead_form_crm",
        providerResponseSummary: { error: { code: 190 } },
      }),
    ).toBe(false);
  });
});
