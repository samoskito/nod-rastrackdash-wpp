"use server";

import {
  whatsappConnectionCreateInputSchema,
  whatsappConnectionTestResultSchema,
  whatsappConnectionWebhookTokenRotateResultSchema,
} from "@wpptrack/shared";
import { revalidatePath } from "next/cache";
import { serverApiFetch } from "../../../lib/server-api";

export type WhatsappReceiverSecret = {
  endpoint: string;
  token: string;
};

export type WhatsappProviderActionResult = {
  ok: boolean;
  message: string;
  connectionId?: string;
  receiverSecret?: WhatsappReceiverSecret;
};

const integrationsPath = "/integrations";

export async function createWhatsappConnectionAction(
  formData: FormData,
): Promise<WhatsappProviderActionResult> {
  const input = whatsappConnectionCreateInputSchema.safeParse(
    connectionInput(formData),
  );

  if (!input.success) {
    return failure("Revise os dados da conexao e tente novamente.");
  }

  try {
    const connection = await serverApiFetch<{ id: string }>(
      "/integrations/whatsapp-connections",
      { method: "POST", body: JSON.stringify(input.data) },
    );
    revalidatePath(integrationsPath);
    return {
      ok: true,
      message: "Conexao salva. Use Testar antes de configurar o receiver.",
      connectionId: connection.id,
    };
  } catch {
    return failure("Nao foi possivel salvar a conexao WhatsApp.");
  }
}

export async function testWhatsappConnectionAction(
  formData: FormData,
): Promise<WhatsappProviderActionResult> {
  const connectionId = formText(formData, "connectionId");
  if (!connectionId) return failure("Conexao WhatsApp invalida.");

  try {
    const response = await serverApiFetch<unknown>(
      `/integrations/whatsapp-connections/${encodeURIComponent(connectionId)}/test`,
      { method: "POST", body: "{}" },
    );
    const result = whatsappConnectionTestResultSchema.safeParse(response);
    if (!result.success || result.data.connectionId !== connectionId) {
      return failure("Nao foi possivel testar a conexao WhatsApp.");
    }

    revalidatePath(integrationsPath);
    return {
      ok: result.data.status === "connected",
      message:
        result.data.message ??
        (result.data.status === "connected"
          ? "Conexao testada com sucesso."
          : `Teste concluido com status ${result.data.status}.`),
      connectionId,
    };
  } catch {
    return failure("Nao foi possivel testar a conexao WhatsApp.");
  }
}

export async function rotateWhatsappWebhookTokenAction(
  formData: FormData,
): Promise<WhatsappProviderActionResult> {
  const connectionId = formText(formData, "connectionId");
  if (!connectionId) return failure("Conexao WhatsApp invalida.");

  try {
    const response = await serverApiFetch<unknown>(
      `/integrations/whatsapp-connections/${encodeURIComponent(connectionId)}/rotate-webhook-token`,
      { method: "POST", body: "{}" },
    );
    const result =
      whatsappConnectionWebhookTokenRotateResultSchema.safeParse(response);
    if (!result.success || result.data.connection.id !== connectionId) {
      return failure("Nao foi possivel gerar o receiver desta conexao.");
    }

    revalidatePath(integrationsPath);
    return {
      ok: true,
      message:
        "Receiver rotacionado. Copie o endpoint e o token agora; o token nao sera exibido novamente.",
      connectionId,
      receiverSecret: {
        endpoint: result.data.webhookEndpoint,
        token: result.data.webhookToken,
      },
    };
  } catch {
    return failure("Nao foi possivel gerar o receiver desta conexao.");
  }
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
