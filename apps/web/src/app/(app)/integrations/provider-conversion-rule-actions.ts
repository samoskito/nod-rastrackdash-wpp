"use server";

import {
  providerConversionAutomationAuditSchema,
  providerConversionAutomationPayloadSchema,
  providerConversionAutomationReprocessBatchInputSchema,
  providerConversionAutomationReprocessBatchResultSchema,
  providerConversionAutomationReprocessResultSchema,
  providerConversionEndpointSecretResultSchema,
  providerConversionRuleCreateInputSchema,
  providerConversionRuleCreateResultSchema,
  providerConversionRuleExecutionAuditSchema,
  providerConversionRuleSchema,
  providerConversionRuleUpdateInputSchema,
  purchaseReviewListSchema,
  structuredCatalogTestMessageInputSchema,
  structuredCatalogTestMessageResultSchema,
  type ProviderConversionAutomationAuditDto,
  type ProviderConversionAutomationPayloadDto,
  type ProviderConversionAutomationReprocessBatchResultDto,
  type ProviderConversionRuleExecutionAuditDto,
  type PurchaseReviewListDto,
  type StructuredCatalogTestMessageResultDto,
} from "@wpptrack/shared";
import { revalidatePath } from "next/cache";
import { isApiRequestError, serverApiFetch } from "../../../lib/server-api";

export type ProviderConversionRuleOneTimeSecret = {
  ruleId: string;
  webhookUrl: string;
};

export type ProviderConversionRuleActionResult = {
  ok: boolean;
  message: string;
  oneTimeSecret?: ProviderConversionRuleOneTimeSecret;
  testResult?: StructuredCatalogTestMessageResultDto;
  automationAudit?: ProviderConversionAutomationAuditDto;
  automationPayload?: ProviderConversionAutomationPayloadDto;
  automationReprocess?: ProviderConversionAutomationReprocessBatchResultDto;
  purchaseAudit?: PurchaseReviewListDto;
  executionAudit?: ProviderConversionRuleExecutionAuditDto;
};

const integrationsPath = "/integrations";
const settingsPath = "/settings";
const invalidFormMessage = "Revise os dados informados e tente novamente.";

function revalidateConversionRulePaths() {
  revalidatePath(integrationsPath);
  revalidatePath(settingsPath);
}

export async function createProviderConversionRuleAction(
  formData: FormData,
): Promise<ProviderConversionRuleActionResult> {
  const input = parsePayload(
    formData,
    providerConversionRuleCreateInputSchema.safeParse,
  );

  if (!input) {
    return failure(invalidFormMessage);
  }

  try {
    const response = await serverApiFetch<unknown>(
      "/conversion-rules/providers",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
    const result = providerConversionRuleCreateResultSchema.safeParse(response);

    if (!result.success) {
      return failure("Nao foi possivel criar a regra de conversao.");
    }

    revalidateConversionRulePaths();
    return {
      ok: true,
      message: result.data.webhookUrl
        ? "Regra criada. Copie a URL da automacao agora; ela nao sera exibida novamente."
        : result.data.rule.conversionRule.triggerType === "message_phrase"
          ? "Regra criada em modo de observacao."
          : "Catalogo criado em modo de observacao.",
      ...(result.data.webhookUrl
        ? {
            oneTimeSecret: {
              ruleId: result.data.rule.id,
              webhookUrl: result.data.webhookUrl,
            },
          }
        : {}),
    };
  } catch (error) {
    if (isApiRequestError(error) && error.message.trim()) {
      return failure(error.message);
    }
    return failure("Nao foi possivel criar a regra de conversao.");
  }
}

export async function updateProviderConversionRuleAction(
  formData: FormData,
): Promise<ProviderConversionRuleActionResult> {
  const ruleId = formId(formData, "ruleId");
  const input = parsePayload(
    formData,
    providerConversionRuleUpdateInputSchema.safeParse,
  );

  if (!ruleId || !input) {
    return failure(invalidFormMessage);
  }

  try {
    const response = await serverApiFetch<unknown>(
      `/conversion-rules/providers/${encodeURIComponent(ruleId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    );
    const result = providerConversionRuleSchema.safeParse(response);

    if (!result.success || result.data.id !== ruleId) {
      return failure("Nao foi possivel atualizar a regra de conversao.");
    }

    revalidateConversionRulePaths();
    return {
      ok: true,
      message: result.data.conversionRule.active
        ? "Regra de conversao atualizada."
        : "Regra de conversao pausada.",
    };
  } catch (error) {
    return failure(
      isApiRequestError(error)
        ? error.message
        : "Nao foi possivel atualizar a regra de conversao.",
    );
  }
}

export async function rotateProviderConversionRuleEndpointAction(
  formData: FormData,
): Promise<ProviderConversionRuleActionResult> {
  const ruleId = formId(formData, "ruleId");

  if (!ruleId) {
    return failure(invalidFormMessage);
  }

  try {
    const response = await serverApiFetch<unknown>(
      `/conversion-rules/providers/${encodeURIComponent(ruleId)}/rotate-endpoint`,
      {
        method: "POST",
        body: "{}",
      },
    );
    const result =
      providerConversionEndpointSecretResultSchema.safeParse(response);

    if (!result.success || result.data.endpoint.providerRuleId !== ruleId) {
      return failure("Nao foi possivel gerar uma nova URL de automacao.");
    }

    revalidateConversionRulePaths();
    return {
      ok: true,
      message:
        "URL rotacionada. Copie a nova URL agora; a anterior foi invalidada.",
      oneTimeSecret: {
        ruleId,
        webhookUrl: result.data.webhookUrl,
      },
    };
  } catch {
    return failure("Nao foi possivel gerar uma nova URL de automacao.");
  }
}

export async function reprocessLatestProviderConversionAutomationAction(
  formData: FormData,
): Promise<ProviderConversionRuleActionResult> {
  const ruleId = formId(formData, "ruleId");

  if (!ruleId) {
    return failure(invalidFormMessage);
  }

  try {
    const response = await serverApiFetch<unknown>(
      `/integrations/inbound-webhooks/provider-rules/${encodeURIComponent(ruleId)}/reprocess-latest`,
      {
        method: "POST",
        body: JSON.stringify({
          confirmation: "REPROCESSAR_CALLBACK_OBSERVADO",
        }),
      },
    );
    const result =
      providerConversionAutomationReprocessResultSchema.safeParse(response);

    if (!result.success) {
      return failure("Nao foi possivel reprocessar o callback observado.");
    }

    revalidateConversionRulePaths();
    return {
      ok: true,
      message:
        result.data.queueStatus === "queued"
          ? "Callback observado encaminhado para processamento."
          : "O callback ja estava aguardando processamento.",
    };
  } catch (error) {
    return failure(
      isApiRequestError(error)
        ? error.message
        : "Nao foi possivel reprocessar o callback observado.",
    );
  }
}

export async function loadProviderConversionAutomationAuditAction(
  formData: FormData,
): Promise<ProviderConversionRuleActionResult> {
  const ruleId = formId(formData, "ruleId");
  if (!ruleId) return failure(invalidFormMessage);

  try {
    const response = await serverApiFetch<unknown>(
      `/integrations/inbound-webhooks/provider-rules/${encodeURIComponent(ruleId)}/callbacks`,
    );
    const result = providerConversionAutomationAuditSchema.safeParse(response);
    if (!result.success || result.data.providerRuleId !== ruleId) {
      return failure("Nao foi possivel carregar os callbacks desta regra.");
    }

    return {
      ok: true,
      message: "Historico de callbacks atualizado.",
      automationAudit: result.data,
    };
  } catch (error) {
    return failure(
      isApiRequestError(error)
        ? error.message
        : "Nao foi possivel carregar os callbacks desta regra.",
    );
  }
}

export async function loadProviderConversionPurchaseAuditAction(
  formData: FormData,
): Promise<ProviderConversionRuleActionResult> {
  const ruleId = formId(formData, "ruleId");
  if (!ruleId) return failure(invalidFormMessage);

  try {
    const query = new URLSearchParams({
      providerRuleId: ruleId,
      page: "1",
      pageSize: "50",
      view: "all",
    });
    const response = await serverApiFetch<unknown>(
      `/purchase-reviews?${query.toString()}`,
    );
    const result = purchaseReviewListSchema.safeParse(response);
    if (!result.success) {
      return failure("Nao foi possivel carregar as compras desta regra.");
    }

    return {
      ok: true,
      message: "Auditoria de compras atualizada.",
      purchaseAudit: result.data,
    };
  } catch (error) {
    return failure(
      isApiRequestError(error)
        ? error.message
        : "Nao foi possivel carregar as compras desta regra.",
    );
  }
}

export async function loadProviderConversionExecutionAuditAction(
  formData: FormData,
): Promise<ProviderConversionRuleActionResult> {
  const ruleId = formId(formData, "ruleId");
  if (!ruleId) return failure(invalidFormMessage);

  try {
    const query = new URLSearchParams({ page: "1", pageSize: "50" });
    const response = await serverApiFetch<unknown>(
      `/conversion-rules/providers/${encodeURIComponent(ruleId)}/executions?${query.toString()}`,
    );
    const result = providerConversionRuleExecutionAuditSchema.safeParse(response);
    if (!result.success || result.data.providerRuleId !== ruleId) {
      return failure("Nao foi possivel carregar as execucoes desta regra.");
    }

    return {
      ok: true,
      message: "Auditoria de execucoes atualizada.",
      executionAudit: result.data,
    };
  } catch (error) {
    return failure(
      isApiRequestError(error)
        ? error.message
        : "Nao foi possivel carregar as execucoes desta regra.",
    );
  }
}

export async function loadProviderConversionAutomationPayloadAction(
  formData: FormData,
): Promise<ProviderConversionRuleActionResult> {
  const ruleId = formId(formData, "ruleId");
  const deliveryId = formId(formData, "deliveryId");
  if (!ruleId || !deliveryId) return failure(invalidFormMessage);

  try {
    const response = await serverApiFetch<unknown>(
      `/integrations/inbound-webhooks/provider-rules/${encodeURIComponent(ruleId)}/callbacks/${encodeURIComponent(deliveryId)}/payload`,
    );
    const result =
      providerConversionAutomationPayloadSchema.safeParse(response);
    if (
      !result.success ||
      result.data.providerRuleId !== ruleId ||
      result.data.deliveryId !== deliveryId
    ) {
      return failure("Nao foi possivel abrir o payload deste callback.");
    }

    return {
      ok: true,
      message: "Payload carregado para auditoria.",
      automationPayload: result.data,
    };
  } catch (error) {
    return failure(
      isApiRequestError(error)
        ? error.message
        : "Nao foi possivel abrir o payload deste callback.",
    );
  }
}

export async function reprocessProviderConversionAutomationCallbacksAction(
  formData: FormData,
): Promise<ProviderConversionRuleActionResult> {
  const ruleId = formId(formData, "ruleId");
  const input = parsePayload(
    formData,
    providerConversionAutomationReprocessBatchInputSchema.safeParse,
  );
  if (!ruleId || !input) return failure(invalidFormMessage);

  try {
    const response = await serverApiFetch<unknown>(
      `/integrations/inbound-webhooks/provider-rules/${encodeURIComponent(ruleId)}/callbacks/reprocess`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
    const result =
      providerConversionAutomationReprocessBatchResultSchema.safeParse(
        response,
      );
    if (!result.success || result.data.providerRuleId !== ruleId) {
      return failure("Nao foi possivel reprocessar os callbacks selecionados.");
    }

    revalidateConversionRulePaths();
    return {
      ok: true,
      message: `${result.data.queued} encaminhado(s), ${result.data.blocked} bloqueado(s) e ${result.data.skipped} ignorado(s).`,
      automationReprocess: result.data,
    };
  } catch (error) {
    return failure(
      isApiRequestError(error)
        ? error.message
        : "Nao foi possivel reprocessar os callbacks selecionados.",
    );
  }
}

export async function removeProviderConversionRuleAction(
  formData: FormData,
): Promise<ProviderConversionRuleActionResult> {
  const ruleId = formId(formData, "ruleId");

  if (!ruleId) {
    return failure(invalidFormMessage);
  }

  try {
    await serverApiFetch<void>(
      `/conversion-rules/providers/${encodeURIComponent(ruleId)}`,
      { method: "DELETE" },
    );

    revalidateConversionRulePaths();
    return {
      ok: true,
      message: "Regra removida. O historico observado foi preservado.",
    };
  } catch {
    return failure("Nao foi possivel remover a regra de conversao.");
  }
}

export async function testProviderCatalogMessageAction(
  formData: FormData,
): Promise<ProviderConversionRuleActionResult> {
  const ruleId = formId(formData, "ruleId");
  const input = structuredCatalogTestMessageInputSchema.safeParse({
    messageText: formText(formData, "messageText"),
  });

  if (!ruleId || !input.success) {
    return failure(invalidFormMessage);
  }

  try {
    const response = await serverApiFetch<unknown>(
      `/conversion-rules/providers/${encodeURIComponent(ruleId)}/test-message`,
      {
        method: "POST",
        body: JSON.stringify(input.data),
      },
    );
    const result = structuredCatalogTestMessageResultSchema.safeParse(response);

    if (!result.success) {
      return failure("Nao foi possivel testar esta mensagem.");
    }

    return {
      ok: true,
      message: result.data.matched
        ? "Mensagem reconhecida pelo catalogo."
        : "A mensagem foi bloqueada pelo catalogo.",
      testResult: result.data,
    };
  } catch {
    return failure("Nao foi possivel testar esta mensagem.");
  }
}

function parsePayload<T>(
  formData: FormData,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
): T | null {
  const value = formText(formData, "payload");

  if (!value || value.length > 500_000) {
    return null;
  }

  try {
    const parsed = parse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function formText(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formId(formData: FormData, key: string): string | null {
  const value = formText(formData, key);

  if (!value || value.length > 255 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return null;
  }

  return value;
}

function failure(message: string): ProviderConversionRuleActionResult {
  return { ok: false, message };
}
