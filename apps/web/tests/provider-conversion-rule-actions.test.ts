import { afterEach, describe, expect, it, vi } from "vitest";

const { isApiRequestError, revalidatePath, serverApiFetch } = vi.hoisted(
  () => ({
    isApiRequestError: vi.fn(
      (error: unknown) =>
        error instanceof Error && error.name === "ApiRequestError",
    ),
    revalidatePath: vi.fn(),
    serverApiFetch: vi.fn(),
  }),
);

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/lib/server-api", () => ({
  isApiRequestError,
  serverApiFetch,
}));

import {
  createProviderConversionRuleAction,
  loadProviderConversionAutomationAuditAction,
  loadProviderConversionAutomationPayloadAction,
  loadProviderConversionExecutionAuditAction,
  loadProviderConversionPurchaseAuditAction,
  removeProviderConversionRuleAction,
  reprocessProviderConversionAutomationCallbacksAction,
  reprocessLatestProviderConversionAutomationAction,
  rotateProviderConversionRuleEndpointAction,
  testProviderCatalogMessageAction,
  updateProviderConversionRuleAction,
} from "../src/app/(app)/integrations/provider-conversion-rule-actions";

const endpoint = {
  id: "endpoint_1",
  workspaceId: "workspace_1",
  providerRuleId: "provider_rule_1",
  secretVersion: 1,
  lastDeliveryAt: null,
  lastSuccessfulParseAt: null,
  rotatedAt: null,
  removedAt: null,
  createdAt: "2026-07-21T12:00:00.000Z",
  updatedAt: "2026-07-21T12:00:00.000Z",
};

const providerRule = {
  id: "provider_rule_1",
  workspaceId: "workspace_1",
  conversionRule: {
    id: "conversion_rule_1",
    workspaceId: "workspace_1",
    name: "Lead qualificado por tag",
    triggerType: "provider_automation",
    triggerValue: "provider_automation",
    matchMode: "exact",
    eventName: "QualifiedLead",
    pixelId: null,
    defaultValueCents: null,
    defaultCurrency: null,
    defaultContentName: null,
    defaultItems: null,
    active: true,
    createdAt: "2026-07-21T12:00:00.000Z",
    updatedAt: "2026-07-21T12:00:00.000Z",
  },
  connectionId: "connection_1",
  mode: "observation",
  parserReleaseId: "parser_automation_v1",
  productionActivatedAt: null,
  channelIds: ["channel_1"],
  triggerPhrases: [],
  messageAuthorScope: null,
  endpoint,
  catalog: null,
  lastExecution: null,
  createdAt: "2026-07-21T12:00:00.000Z",
  updatedAt: "2026-07-21T12:00:00.000Z",
} as const;

afterEach(() => {
  revalidatePath.mockReset();
  serverApiFetch.mockReset();
});

describe("provider conversion rule server actions", () => {
  it("creates an automation rule and returns its URL only in the ephemeral result", async () => {
    const webhookUrl =
      "https://api.wpptrack.test/webhooks/inbound/conversions/endpoint_1?token=secret";
    serverApiFetch.mockResolvedValueOnce({ rule: providerRule, webhookUrl });
    const payload = {
      name: "Lead qualificado por tag",
      connectionId: "connection_1",
      channelIds: ["channel_1"],
      mode: "observation",
      triggerType: "provider_automation",
      eventName: "QualifiedLead",
    };

    const result = await createProviderConversionRuleAction(
      form({ payload: JSON.stringify(payload) }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith("/conversion-rules/providers", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(result).toEqual({
      ok: true,
      message:
        "Regra criada. Copie a URL da automacao agora; ela nao sera exibida novamente.",
      oneTimeSecret: {
        ruleId: "provider_rule_1",
        webhookUrl,
      },
    });
    expect(result.message).not.toContain("secret");
    expect(revalidatePath).toHaveBeenCalledWith("/integrations");
    expect(revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("updates, rotates and removes only through provider-rule endpoints", async () => {
    serverApiFetch
      .mockResolvedValueOnce({
        ...providerRule,
        conversionRule: { ...providerRule.conversionRule, active: false },
      })
      .mockResolvedValueOnce({
        endpoint: { ...endpoint, secretVersion: 2 },
        webhookUrl:
          "https://api.wpptrack.test/webhooks/inbound/conversions/endpoint_1?token=rotated",
      })
      .mockResolvedValueOnce(undefined);

    const updateResult = await updateProviderConversionRuleAction(
      form({
        ruleId: "provider_rule_1",
        payload: JSON.stringify({ active: false }),
      }),
    );
    const rotateResult = await rotateProviderConversionRuleEndpointAction(
      form({ ruleId: "provider_rule_1" }),
    );
    const removeResult = await removeProviderConversionRuleAction(
      form({ ruleId: "provider_rule_1" }),
    );

    expect(serverApiFetch.mock.calls.map(([path]) => path)).toEqual([
      "/conversion-rules/providers/provider_rule_1",
      "/conversion-rules/providers/provider_rule_1/rotate-endpoint",
      "/conversion-rules/providers/provider_rule_1",
    ]);
    expect(updateResult.message).toBe("Regra de conversao pausada.");
    expect(rotateResult.oneTimeSecret?.webhookUrl).toContain("token=rotated");
    expect(removeResult).toEqual({
      ok: true,
      message: "Regra removida. O historico observado foi preservado.",
    });
  });

  it("reprocesses the latest observed automation callback with explicit confirmation", async () => {
    serverApiFetch.mockResolvedValueOnce({
      executionId: "execution_1",
      sourceDeliveryId: "delivery_1",
      queueStatus: "queued",
    });

    const result = await reprocessLatestProviderConversionAutomationAction(
      form({ ruleId: "provider_rule_1" }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/integrations/inbound-webhooks/provider-rules/provider_rule_1/reprocess-latest",
      {
        method: "POST",
        body: JSON.stringify({
          confirmation: "REPROCESSAR_CALLBACK_OBSERVADO",
        }),
      },
    );
    expect(result).toEqual({
      ok: true,
      message: "Callback observado encaminhado para processamento.",
    });
    expect(revalidatePath.mock.calls.map(([path]) => path)).toEqual([
      "/integrations",
      "/settings",
    ]);
  });

  it("shows the API reason when an observed callback cannot be reprocessed", async () => {
    const error = new Error("Nenhum callback observado foi encontrado");
    error.name = "ApiRequestError";
    serverApiFetch.mockRejectedValueOnce(error);

    const result = await reprocessLatestProviderConversionAutomationAction(
      form({ ruleId: "provider_rule_1" }),
    );

    expect(result).toEqual({
      ok: false,
      message: "Nenhum callback observado foi encontrado",
    });
  });

  it("loads callback history and a selected payload through scoped endpoints", async () => {
    serverApiFetch
      .mockResolvedValueOnce({
        providerRuleId: "provider_rule_1",
        summary: {
          total: 1,
          observed: 1,
          blocked: 0,
          queued: 0,
          materialized: 0,
          failed: 0,
          invalid: 0,
          recoverable: 1,
        },
        items: [automationAuditItem],
      })
      .mockResolvedValueOnce({
        providerRuleId: "provider_rule_1",
        deliveryId: "delivery_1",
        receivedAt: "2026-07-22T15:37:00.000Z",
        payloadExpiresAt: "2026-07-29T15:37:00.000Z",
        payload: { schema: "wpptrack.umbler.automation.v1" },
      });

    const audit = await loadProviderConversionAutomationAuditAction(
      form({ ruleId: "provider_rule_1" }),
    );
    const payload = await loadProviderConversionAutomationPayloadAction(
      form({ ruleId: "provider_rule_1", deliveryId: "delivery_1" }),
    );

    expect(serverApiFetch.mock.calls.map(([path]) => path)).toEqual([
      "/integrations/inbound-webhooks/provider-rules/provider_rule_1/callbacks",
      "/integrations/inbound-webhooks/provider-rules/provider_rule_1/callbacks/delivery_1/payload",
    ]);
    expect(audit.automationAudit?.summary.recoverable).toBe(1);
    expect(payload.automationPayload?.deliveryId).toBe("delivery_1");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("loads purchase reviews scoped to the selected provider rule", async () => {
    serverApiFetch.mockResolvedValueOnce({
      reviews: [
        {
          id: "review_1",
          workspaceId: "workspace_1",
          providerRuleId: "provider_rule_1",
          ruleName: "Compra por mensagem",
          sourceDeliveryId: "delivery_1",
          channelId: "channel_1",
          channelName: "Comercial",
          occurredAt: "2026-07-22T18:00:00.000Z",
          sourceType: "provider_message",
          messageAuthorType: "team",
          matchedTriggerPhrase: "aviso de compra",
          status: "recognized",
          classificationCode: "message_matched",
          reasonCode: null,
          leadId: "lead_1",
          leadName: "Cliente",
          phoneDisplay: "+5511999990000",
          items: [],
          calculatedValueCents: 9990,
          effectiveValueCents: 9990,
          observedPaymentValueCents: null,
          currency: "BRL",
          conversionEventLogId: null,
          decisionReason: null,
          decidedAt: null,
          createdAt: "2026-07-22T18:00:00.000Z",
          updatedAt: "2026-07-22T18:00:00.000Z",
        },
      ],
      pendingCount: 1,
      pagination: {
        page: 1,
        pageSize: 50,
        totalItems: 1,
        totalPages: 1,
      },
    });

    const result = await loadProviderConversionPurchaseAuditAction(
      form({ ruleId: "provider_rule_1" }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/purchase-reviews?providerRuleId=provider_rule_1&page=1&pageSize=50&view=all",
    );
    expect(result.purchaseAudit?.pagination.totalItems).toBe(1);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("loads executions scoped to the selected provider rule", async () => {
    serverApiFetch.mockResolvedValueOnce({
      providerRuleId: "provider_rule_1",
      eventName: "QualifiedLead",
      summary: {
        total: 1,
        observed: 1,
        eligible: 0,
        materialized: 0,
        duplicate: 0,
        blocked: 0,
        failed: 0,
      },
      items: [
        {
          executionId: "execution_1",
          sourceDeliveryId: "delivery_1",
          occurredAt: "2026-07-22T18:00:00.000Z",
          status: "observed",
          reasonCode: "message_matched_observation",
          matchedTriggerPhrase: "quero saber mais",
          channel: null,
          leadId: null,
          leadName: null,
          phoneDisplay: null,
          valueCents: null,
          currency: null,
          conversionEventLogId: null,
          purchaseReviewId: null,
          attemptCount: 0,
          processedAt: null,
        },
      ],
      pagination: { page: 1, pageSize: 50, totalItems: 1, totalPages: 1 },
    });

    const result = await loadProviderConversionExecutionAuditAction(
      form({ ruleId: "provider_rule_1" }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/conversion-rules/providers/provider_rule_1/executions?page=1&pageSize=50",
    );
    expect(result).toEqual({
      ok: true,
      message: "Auditoria de execucoes atualizada.",
      executionAudit: expect.anything(),
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("reprocesses explicitly selected callbacks as an independent batch", async () => {
    serverApiFetch.mockResolvedValueOnce({
      providerRuleId: "provider_rule_1",
      requested: 2,
      queued: 1,
      blocked: 1,
      skipped: 0,
      items: [
        {
          deliveryId: "delivery_1",
          executionId: "execution_1",
          status: "queued",
          reasonCode: "automation_manual_reprocess_approved",
          message: "Callback encaminhado para a fila da Meta",
        },
        {
          deliveryId: "delivery_2",
          executionId: "execution_2",
          status: "blocked",
          reasonCode: "automation_paid_lead_missing",
          message: "Lead pago nao localizado",
        },
      ],
    });
    const payload = {
      confirmation: "REPROCESSAR_CALLBACKS_SELECIONADOS",
      deliveryIds: ["delivery_1", "delivery_2"],
    };

    const result = await reprocessProviderConversionAutomationCallbacksAction(
      form({
        ruleId: "provider_rule_1",
        payload: JSON.stringify(payload),
      }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/integrations/inbound-webhooks/provider-rules/provider_rule_1/callbacks/reprocess",
      { method: "POST", body: JSON.stringify(payload) },
    );
    expect(result).toMatchObject({
      ok: true,
      message: "1 encaminhado(s), 1 bloqueado(s) e 0 ignorado(s).",
    });
    expect(revalidatePath.mock.calls.map(([path]) => path)).toEqual([
      "/integrations",
      "/settings",
    ]);
  });

  it("returns a side-effect-free catalog test result without revalidation", async () => {
    serverApiFetch.mockResolvedValueOnce({
      matched: true,
      reasonCode: "matched",
      classification: "recognized",
      matchedTriggerPhrase: null,
      parsedAttributes: [
        { key: "tamanho", label: "Tamanho", value: "4,90" },
        { key: "modelo", label: "Modelo", value: "Nacional" },
      ],
      items: [
        {
          position: 1,
          catalogVariantId: "variant_1",
          parsedAttributes: [
            { key: "tamanho", label: "Tamanho", value: "4,90" },
            { key: "modelo", label: "Modelo", value: "Nacional" },
          ],
          quantity: 1,
          unitValueCents: 359700,
          subtotalValueCents: 359700,
          contentName: "Cama elastica Nacional 4,90",
          reasonCode: "matched",
        },
      ],
      parsedValueCents: 359700,
      calculatedValueCents: 359700,
      observedPaymentValueCents: 359700,
      catalogVariantId: "variant_1",
      contentName: "Cama elastica Nacional 4,90",
      currency: "BRL",
    });

    const result = await testProviderCatalogMessageAction(
      form({
        ruleId: "provider_rule_1",
        messageText: "Tamanho: 4,90\nModelo: Nacional\n3.597,00",
      }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/conversion-rules/providers/provider_rule_1/test-message",
      {
        method: "POST",
        body: JSON.stringify({
          messageText: "Tamanho: 4,90\nModelo: Nacional\n3.597,00",
        }),
      },
    );
    expect(result.testResult?.matched).toBe(true);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before calling the API", async () => {
    const result = await createProviderConversionRuleAction(
      form({ payload: "{" }),
    );

    expect(result.ok).toBe(false);
    expect(serverApiFetch).not.toHaveBeenCalled();
  });
});

function form(values: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) {
    formData.set(key, value);
  }
  return formData;
}

const automationAuditItem = {
  deliveryId: "delivery_1",
  executionId: "execution_1",
  receivedAt: "2026-07-22T15:37:00.000Z",
  lastReceivedAt: "2026-07-22T15:37:00.000Z",
  providerEventType: "lead_qualificado",
  eventName: "QualifiedLead",
  automation: "lead_qualificado",
  status: "observed",
  reasonCode: "automation_matched_observation",
  attemptCount: 1,
  executionAttemptCount: 0,
  channel: {
    id: "channel_1",
    name: "Comercial",
    connectedPhone: "+5511999999999",
  },
  leadResolved: true,
  payloadAvailable: true,
  payloadExpiresAt: "2026-07-29T15:37:00.000Z",
  reprocessable: true,
} as const;
