"use server";

import {
  whatsappConnectionCreateInputSchema,
  whatsappConnectionEditInputSchema,
  whatsappConnectionEditMetadataSchema,
  whatsappConnectionTestResultSchema,
  whatsappConnectionWebhookConfigureResultSchema,
  whatsappConnectionWebhookTokenRotateResultSchema,
} from "@wpptrack/shared";
import type { WhatsappConnectionEditMetadataDto } from "@wpptrack/shared";
import { revalidatePath } from "next/cache";
import { licenseLockedMessageFor } from "../../../lib/license-locked-message";
import { ApiRequestError, serverApiFetch } from "../../../lib/server-api";
import {
  wahaSessionGuidance,
  wahaUnreachableMessage,
  wahaWebhookFailureMessage,
  wahaWebhookForbiddenMessage,
} from "./waha-session-guidance";

export type WhatsappReceiverSecret = {
  webhookUrl: string;
};

/** Resultado de "Configurar webhook" (só WAHA). Nunca leva token. */
export type WahaWebhookOutcome = {
  configured: boolean;
  events: string[];
  sessionStatus: string | null;
  reason?: string;
};

/** Passo a passo manual da WAHA; exibido só quando o aluno pede. */
export type WahaManualSetup = {
  /** URL sem token: o token vai no cabeçalho (opção principal). */
  webhookUrl: string;
  /** Alternativa: a URL com ?token= (pode aparecer em logs da WAHA/proxy). */
  webhookUrlWithToken: string;
  events: string[];
  tokenHeaderName: string;
  webhookToken: string;
};

export type WhatsappProviderActionResult = {
  ok: boolean;
  message: string;
  connectionId?: string;
  receiverSecret?: WhatsappReceiverSecret;
  /** Status bruto da sessão (WAHA: WORKING, SCAN_QR_CODE...). */
  providerStatus?: string;
  wahaWebhook?: WahaWebhookOutcome;
  wahaManualSetup?: WahaManualSetup;
  /** True quando a API recusou com 423 (licença bloqueada). */
  licenseLocked?: boolean;
};

export type WhatsappConnectionEditData = WhatsappConnectionEditMetadataDto;

export type WhatsappConnectionEditResult =
  | { ok: true; data: WhatsappConnectionEditData }
  | { ok: false; message: string };

type ProviderId = "uazapi_byo" | "nod_api" | "waha" | "zapi";

const integrationsPath = "/integrations";

export async function createWhatsappConnectionAction(
  formData: FormData,
): Promise<WhatsappProviderActionResult> {
  const input = whatsappConnectionCreateInputSchema.safeParse(
    connectionInput(formData),
  );

  if (!input.success) {
    return failure("Revise os dados da conexão e tente novamente.");
  }

  try {
    const connection = await serverApiFetch<{ id: string }>(
      "/integrations/whatsapp-connections",
      { method: "POST", body: JSON.stringify(input.data) },
    );
    revalidatePath(integrationsPath);
    return {
      ok: true,
      message:
        input.data.provider === "waha"
          ? "Conexão salva. Agora teste a conexão e configure o webhook."
          : "Conexão salva. Use Testar antes de configurar o receiver.",
      connectionId: connection.id,
    };
  } catch (error) {
    return failure(licenseLockedMessageFor(error) ?? "Não foi possível salvar a conexão WhatsApp.");
  }
}

export async function testWhatsappConnectionAction(
  formData: FormData,
): Promise<WhatsappProviderActionResult> {
  const connectionId = formText(formData, "connectionId");
  if (!connectionId) return failure("Conexão WhatsApp inválida.");

  try {
    const response = await serverApiFetch<unknown>(
      `/integrations/whatsapp-connections/${encodeURIComponent(connectionId)}/test`,
      { method: "POST", body: "{}" },
    );
    const result = whatsappConnectionTestResultSchema.safeParse(response);
    if (!result.success || result.data.connectionId !== connectionId) {
      return failure("Não foi possível testar a conexão WhatsApp.");
    }

    revalidatePath(integrationsPath);
    if (result.data.provider === "waha") {
      const guidance = wahaSessionGuidance(result.data.providerStatus);
      return {
        ok: result.data.status === "connected",
        message: guidance ? guidance.instruction : wahaUnreachableMessage,
        connectionId,
        ...(result.data.providerStatus
          ? { providerStatus: result.data.providerStatus }
          : {}),
      };
    }
    return {
      ok: result.data.status === "connected",
      message:
        result.data.message ??
        (result.data.status === "connected"
          ? "Conexão testada com sucesso."
          : `Teste concluído com status ${result.data.status}.`),
      connectionId,
    };
  } catch (error) {
    return failure(licenseLockedMessageFor(error) ?? "Não foi possível testar a conexão WhatsApp.");
  }
}

export async function rotateWhatsappWebhookTokenAction(
  formData: FormData,
): Promise<WhatsappProviderActionResult> {
  const connectionId = formText(formData, "connectionId");
  if (!connectionId) return failure("Conexão WhatsApp inválida.");

  try {
    const response = await serverApiFetch<unknown>(
      `/integrations/whatsapp-connections/${encodeURIComponent(connectionId)}/rotate-webhook-token`,
      { method: "POST", body: "{}" },
    );
    const result =
      whatsappConnectionWebhookTokenRotateResultSchema.safeParse(response);
    if (!result.success || result.data.connection.id !== connectionId) {
      return failure("Não foi possível gerar o receiver desta conexão.");
    }

    revalidatePath(integrationsPath);
    const manual = result.data.wahaManualSetup;
    if (result.data.connection.provider === "waha" && manual) {
      return {
        ok: true,
        message:
          "Novo token gerado. Copie a configuração agora: ela não será exibida novamente e a anterior deixou de valer.",
        connectionId,
        wahaManualSetup: {
          webhookUrl: manual.webhookUrl,
          webhookUrlWithToken: manual.webhookUrlWithToken,
          events: manual.events,
          tokenHeaderName: manual.tokenHeaderName,
          webhookToken: result.data.webhookToken,
        },
      };
    }
    return {
      ok: true,
      message:
        "Receiver rotacionado. Copie a URL completa agora; ela não será exibida novamente.",
      connectionId,
      receiverSecret: {
        webhookUrl: `${result.data.webhookEndpoint}?token=${encodeURIComponent(result.data.webhookToken)}`,
      },
    };
  } catch (error) {
    return failure(licenseLockedMessageFor(error) ?? "Não foi possível gerar o receiver desta conexão.");
  }
}

export async function configureWahaWebhookAction(
  formData: FormData,
): Promise<WhatsappProviderActionResult> {
  const connectionId = formText(formData, "connectionId");
  if (!connectionId) return failure("Conexão WhatsApp inválida.");

  try {
    const response = await serverApiFetch<unknown>(
      `/integrations/whatsapp-connections/${encodeURIComponent(connectionId)}/configure-webhook`,
      { method: "POST", body: "{}" },
    );
    const result =
      whatsappConnectionWebhookConfigureResultSchema.safeParse(response);
    if (!result.success || result.data.connectionId !== connectionId) {
      return failure("Não foi possível configurar o webhook na sua WAHA.");
    }

    const data = result.data;
    const outcome: WahaWebhookOutcome = {
      configured: data.configured,
      events: data.events,
      sessionStatus: data.sessionStatus,
      ...(data.reason ? { reason: data.reason } : {}),
    };
    if (data.configured) {
      revalidatePath(integrationsPath);
      return {
        ok: true,
        message:
          "Webhook configurado na sua WAHA. O token anterior deixou de valer.",
        connectionId,
        wahaWebhook: outcome,
        ...(data.sessionStatus ? { providerStatus: data.sessionStatus } : {}),
      };
    }
    return {
      ok: false,
      message: wahaWebhookFailureMessage(data.reason, data.message),
      connectionId,
      wahaWebhook: outcome,
    };
  } catch (error) {
    const locked = licenseLockedMessageFor(error);
    if (locked) return { ok: false, message: locked, licenseLocked: true };
    if (error instanceof ApiRequestError && error.status === 403) {
      return failure(wahaWebhookForbiddenMessage);
    }
    return failure("Não foi possível configurar o webhook na sua WAHA.");
  }
}

export async function deleteWhatsappConnectionAction(
  formData: FormData,
): Promise<WhatsappProviderActionResult> {
  const connectionId = formText(formData, "connectionId");
  if (!connectionId) return failure("Conexão WhatsApp inválida.");

  try {
    await serverApiFetch(
      `/integrations/whatsapp-connections/${encodeURIComponent(connectionId)}`,
      { method: "DELETE" },
    );
    revalidatePath(integrationsPath);
    return { ok: true, message: "Conexão excluída.", connectionId };
  } catch (error) {
    return failure(licenseLockedMessageFor(error) ?? "Não foi possível excluir a conexão WhatsApp.");
  }
}

export async function loadWhatsappConnectionForEditAction(
  connectionId: string,
): Promise<WhatsappConnectionEditResult> {
  const id = connectionId.trim();
  if (!id) {
    return { ok: false, message: "Conexão WhatsApp inválida." };
  }

  try {
    const response = await serverApiFetch<unknown>(
      `/integrations/whatsapp-connections/${encodeURIComponent(id)}/edit`,
    );
    const result = whatsappConnectionEditMetadataSchema.safeParse(response);
    if (!result.success || result.data.id !== id) {
      return {
        ok: false,
        message: "Não foi possível carregar os dados da conexão.",
      };
    }
    return { ok: true, data: result.data };
  } catch {
    return {
      ok: false,
      message: "Não foi possível carregar os dados da conexão.",
    };
  }
}

export async function updateWhatsappConnectionAction(
  formData: FormData,
): Promise<WhatsappProviderActionResult> {
  const connectionId = formText(formData, "connectionId");
  const provider = formText(formData, "provider");
  if (!connectionId || !isProviderId(provider)) {
    return failure("Conexão WhatsApp inválida.");
  }

  const input = whatsappConnectionEditInputSchema.safeParse(
    editConnectionInput(provider, formData),
  );
  if (!input.success) {
    return failure("Revise os dados da conexão e tente novamente.");
  }

  try {
    await serverApiFetch(
      `/integrations/whatsapp-connections/${encodeURIComponent(connectionId)}/edit`,
      { method: "PATCH", body: JSON.stringify(input.data) },
    );
    revalidatePath(integrationsPath);
    return { ok: true, message: "Conexão atualizada.", connectionId };
  } catch (error) {
    return failure(licenseLockedMessageFor(error) ?? "Não foi possível atualizar a conexão WhatsApp.");
  }
}

function editConnectionInput(
  provider: ProviderId,
  formData: FormData,
): unknown {
  const name = formText(formData, "name");
  const displayName = formText(formData, "displayName") ?? null;
  const secret = formText(formData, "secret");

  switch (provider) {
    case "uazapi_byo":
      return {
        provider,
        name,
        displayName,
        credentials: {
          baseUrl: formText(formData, "baseUrl"),
          instanceId: formText(formData, "instanceId"),
          token: secret,
        },
      };
    case "waha":
      return {
        provider,
        name,
        displayName,
        credentials: {
          baseUrl: formText(formData, "baseUrl"),
          session: formText(formData, "session"),
          apiKey: secret,
        },
      };
    case "zapi":
      return {
        provider,
        name,
        displayName,
        credentials: {
          baseUrl: formText(formData, "baseUrl"),
          instanceId: formText(formData, "instanceId"),
          token: secret,
        },
      };
    case "nod_api":
      return {
        provider,
        name,
        displayName,
        credentials: {
          instanceId: formText(formData, "instanceId"),
          instanceToken: secret,
        },
      };
  }
}

function isProviderId(value: string | undefined): value is ProviderId {
  return (
    value === "uazapi_byo" ||
    value === "waha" ||
    value === "zapi" ||
    value === "nod_api"
  );
}

function connectionInput(formData: FormData): unknown {
  const provider = formText(formData, "provider");
  const name = formText(formData, "name");
  const displayName = formText(formData, "displayName") ?? undefined;

  switch (provider) {
    case "uazapi_byo":
      return {
        provider,
        name,
        displayName,
        credentials: {
          baseUrl: formText(formData, "baseUrl"),
          token: formText(formData, "token"),
          instanceId: formText(formData, "instanceId") ?? undefined,
        },
      };
    case "waha":
      return {
        provider,
        name,
        displayName,
        credentials: {
          baseUrl: formText(formData, "baseUrl"),
          apiKey: formText(formData, "apiKey"),
          session: formText(formData, "session") ?? undefined,
        },
      };
    case "zapi":
      return {
        provider,
        name,
        displayName,
        credentials: {
          baseUrl: formText(formData, "baseUrl"),
          instanceId: formText(formData, "instanceId"),
          token: formText(formData, "token"),
        },
      };
    case "nod_api":
      return {
        provider,
        name,
        displayName,
        credentials: {
          instanceId: formText(formData, "instanceId"),
          instanceToken: formText(formData, "instanceToken"),
        },
      };
    default:
      return { provider, name, displayName };
  }
}

function formText(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function failure(message: string): WhatsappProviderActionResult {
  return { ok: false, message };
}
