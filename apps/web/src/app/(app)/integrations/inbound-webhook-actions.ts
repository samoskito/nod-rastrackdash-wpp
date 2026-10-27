"use server";

import {
  inboundWebhookChannelCreateInputSchema,
  inboundWebhookChannelRoutesUpdateInputSchema,
  inboundWebhookChannelStatusUpdateInputSchema,
  inboundWebhookConnectionCreateInputSchema,
  inboundWebhookConnectionCreateResultSchema,
  inboundWebhookConnectionRotateSecretResultSchema,
  inboundWebhookConnectionStatusUpdateInputSchema,
  type InboundWebhookChannelRoutesUpdateInputDto,
  type InboundWebhookProviderDto,
} from "@wpptrack/shared";
import { revalidatePath } from "next/cache";
import { licenseLockedMessageFor } from "../../../lib/license-locked-message";
import { serverApiFetch } from "../../../lib/server-api";

export type InboundWebhookOneTimeSecret = {
  connectionId: string;
  provider: InboundWebhookProviderDto;
  webhookUrl: string;
  verifyToken?: string;
};

export type InboundWebhookActionResult = {
  ok: boolean;
  message: string;
  oneTimeSecret?: InboundWebhookOneTimeSecret;
};

const integrationsPath = "/integrations";
const invalidFormMessage = "Revise os dados informados e tente novamente.";
const connectionStatusOperationalErrors = new Set([
  "Configure o segredo do seu próprio app Meta (App Secret) na configuração da API antes de enviar. Não use o segredo PalmUP nem cole segredos no chat.",
  "Certifique o parser antes de ativar o envio automático. Esta versão da integração não é nativa validada ou foi retirada.",
  "Ative ao menos um canal validado antes da produção",
  "Certifique o parser antes de ativar o envio automático",
  "Controle de vagas dos canais externos indisponível",
  "Envio automatico de webhooks ainda nao esta habilitado",
  "Finalize o replay em andamento antes de ativar a produção",
  "Todas as vagas do pacote estão ocupadas",
  "Todo canal ativo precisa de uma rota Meta valida",
  "Workspace sem contrato com acesso ativo",
]);
const connectionCreateOperationalErrors = new Set([
  "Conexões Unnichat exigem o número de WhatsApp do cliente",
  "Conexões ROI Chat exigem o número de WhatsApp do cliente",
]);
const providerObservationUnavailableApiMessage =
  "Versão do leitor do provedor indisponível";

function providerObservationUnavailableMessage(provider: string): string {
  const name =
    provider === "unnichat"
      ? "O Unnichat"
      : provider === "roichat"
        ? "O ROI Chat"
        : "Este provedor";

  return `${name} ainda não está liberado nesta instalação: rode as migrations da API e tente de novo.`;
}
const channelStatusOperationalErrors = new Set([
  "Configure a Meta deste número (página e pixel do workspace ou rotas próprias) antes de ativar o canal",
  "Configure uma rota Meta valida antes de ativar o canal",
  "Controle de vagas dos canais externos indisponível",
  "Todas as vagas do pacote estão ocupadas",
  "Workspace sem contrato com acesso ativo",
]);

function oneTimeSecretForProvider(input: {
  connectionId: string;
  provider: InboundWebhookProviderDto;
  webhookUrl: string;
  secret: string;
}): InboundWebhookOneTimeSecret {
  const credential = {
    connectionId: input.connectionId,
    provider: input.provider,
    webhookUrl: input.webhookUrl,
  };

  return input.provider === "meta_cloud"
    ? { ...credential, verifyToken: input.secret }
    : credential;
}

export async function createInboundWebhookConnectionAction(
  formData: FormData,
): Promise<InboundWebhookActionResult> {
  const provider = formText(formData, "provider");
  // Unnichat e ROI Chat: o webhook de entrada não traz o canal, então a
  // conexão nasce com o número de WhatsApp do cliente (nunca o telefone do
  // lead).
  const bindsPhone = provider === "unnichat" || provider === "roichat";
  const input = inboundWebhookConnectionCreateInputSchema.safeParse(
    bindsPhone
      ? {
          provider,
          displayName: formText(formData, "displayName"),
          connectedPhone: formText(formData, "connectedPhone"),
        }
      : { provider, displayName: formText(formData, "displayName") },
  );

  if (!input.success) {
    return failure(
      bindsPhone && formText(formData, "displayName")
        ? `Informe o número de WhatsApp do cliente atendido pelo ${provider === "roichat" ? "ROI Chat" : "Unnichat"}, com DDI e DDD.`
        : invalidFormMessage,
    );
  }

  try {
    const response = await serverApiFetch<unknown>(
      "/integrations/inbound-webhooks",
      {
        method: "POST",
        body: JSON.stringify(input.data),
      },
    );
    const result =
      inboundWebhookConnectionCreateResultSchema.safeParse(response);

    if (!result.success) {
      return failure("Não foi possível criar a conexão de webhook.");
    }

    revalidatePath(integrationsPath);
    return {
      ok: true,
      message:
        "Conexão de webhook criada. Copie a URL agora; ela não será exibida novamente.",
      oneTimeSecret: oneTimeSecretForProvider({
        connectionId: result.data.connection.id,
        provider: result.data.connection.provider,
        webhookUrl: result.data.webhookUrl,
        secret: result.data.secret,
      }),
    };
  } catch (error) {
    if (
      !licenseLockedMessageFor(error) &&
      error instanceof Error &&
      error.message.trim() === providerObservationUnavailableApiMessage
    ) {
      return failure(
        providerObservationUnavailableMessage(String(input.data.provider)),
      );
    }

    return failure(
      knownOperationalError(error, connectionCreateOperationalErrors) ??
        "Não foi possível criar a conexão de webhook.",
    );
  }
}

export async function rotateInboundWebhookSecretAction(
  formData: FormData,
): Promise<InboundWebhookActionResult> {
  const connectionId = formId(formData, "connectionId");

  if (!connectionId) {
    return failure(invalidFormMessage);
  }

  try {
    const response = await serverApiFetch<unknown>(
      `/integrations/inbound-webhooks/${encodeURIComponent(connectionId)}/rotate-secret`,
      {
        method: "POST",
        body: "{}",
      },
    );
    const result =
      inboundWebhookConnectionRotateSecretResultSchema.safeParse(response);

    if (!result.success || result.data.connectionId !== connectionId) {
      return failure("Não foi possível rotacionar o segredo desta conexão.");
    }

    revalidatePath(integrationsPath);
    return {
      ok: true,
      message:
        "Segredo rotacionado. Copie a nova URL agora; ela não será exibida novamente.",
      oneTimeSecret: oneTimeSecretForProvider({
        connectionId: result.data.connectionId,
        provider: result.data.provider,
        webhookUrl: result.data.webhookUrl,
        secret: result.data.secret,
      }),
    };
  } catch (error) {
    return failure(licenseLockedMessageFor(error) ?? "Não foi possível rotacionar o segredo desta conexão.");
  }
}

export async function setInboundWebhookConnectionStatusAction(
  formData: FormData,
): Promise<InboundWebhookActionResult> {
  const connectionId = formId(formData, "connectionId");
  const input = inboundWebhookConnectionStatusUpdateInputSchema.safeParse({
    status: formText(formData, "status"),
  });

  if (!connectionId || !input.success) {
    return failure(invalidFormMessage);
  }

  try {
    await serverApiFetch<unknown>(
      `/integrations/inbound-webhooks/${encodeURIComponent(connectionId)}/status`,
      {
        method: "PUT",
        body: JSON.stringify(input.data),
      },
    );

    revalidatePath(integrationsPath);
    return {
      ok: true,
      message:
        input.data.status === "paused"
          ? "Conexão pausada. Novas entregas não serão processadas."
          : input.data.status === "production"
            ? "Envio automático ativado nos canais habilitados."
            : "Envio da conexão desligado.",
    };
  } catch (error) {
    return failure(
      knownOperationalError(error, connectionStatusOperationalErrors) ??
        "Não foi possível alterar o status desta conexão.",
    );
  }
}

export async function removeInboundWebhookConnectionAction(
  formData: FormData,
): Promise<InboundWebhookActionResult> {
  const connectionId = formId(formData, "connectionId");

  if (!connectionId) {
    return failure(invalidFormMessage);
  }

  try {
    await deleteApiResource(
      `/integrations/inbound-webhooks/${encodeURIComponent(connectionId)}`,
    );

    revalidatePath(integrationsPath);
    return {
      ok: true,
      message: "Conexão removida. O histórico foi preservado.",
    };
  } catch (error) {
    return failure(licenseLockedMessageFor(error) ?? "Não foi possível remover esta conexão.");
  }
}

export async function createInboundWebhookChannelAction(
  formData: FormData,
): Promise<InboundWebhookActionResult> {
  const connectionId = formId(formData, "connectionId");
  const input = inboundWebhookChannelCreateInputSchema.safeParse({
    connectedPhone: formText(formData, "connectedPhone"),
    channelName: formText(formData, "channelName"),
  });

  if (!connectionId || !input.success) {
    return failure(invalidFormMessage);
  }

  try {
    await serverApiFetch<unknown>(
      `/integrations/inbound-webhooks/${encodeURIComponent(connectionId)}/channels`,
      {
        method: "POST",
        body: JSON.stringify(input.data),
      },
    );

    revalidatePath(integrationsPath);
    return {
      ok: true,
      message:
        "Canal cadastrado. Já é possível criar regras de conversão para ele antes de qualquer mensagem chegar.",
    };
  } catch (error) {
    return failure(licenseLockedMessageFor(error) ?? "Não foi possível cadastrar o canal.");
  }
}

export async function setInboundWebhookChannelStatusAction(
  formData: FormData,
): Promise<InboundWebhookActionResult> {
  const channelId = formId(formData, "channelId");
  const input = inboundWebhookChannelStatusUpdateInputSchema.safeParse({
    status: formText(formData, "status"),
  });

  if (!channelId || !input.success) {
    return failure(invalidFormMessage);
  }

  try {
    await serverApiFetch<unknown>(
      `/integrations/inbound-webhooks/channels/${encodeURIComponent(channelId)}/status`,
      {
        method: "PUT",
        body: JSON.stringify(input.data),
      },
    );

    revalidatePath(integrationsPath);
    return {
      ok: true,
      message:
        input.data.status === "paused"
          ? "Canal pausado. Os demais canais continuam inalterados."
          : "Canal com o envio ativo. Ele envia enquanto a conexão estiver enviando.",
    };
  } catch (error) {
    return failure(
      knownOperationalError(error, channelStatusOperationalErrors) ??
        "Não foi possível alterar o status deste canal.",
    );
  }
}

export async function saveInboundWebhookChannelRoutesAction(
  formData: FormData,
): Promise<InboundWebhookActionResult> {
  const channelId = formId(formData, "channelId");
  const input = channelRoutesInput(formData);

  if (!channelId || !input) {
    return failure(invalidFormMessage);
  }

  try {
    await serverApiFetch<unknown>(
      `/integrations/inbound-webhooks/channels/${encodeURIComponent(channelId)}/routes`,
      {
        method: "PUT",
        body: JSON.stringify(input),
      },
    );

    revalidatePath(integrationsPath);
    return {
      ok: true,
      message: "Rotas do canal salvas é validadas.",
    };
  } catch (error) {
    return failure(
      knownRouteError(error) ?? "Não foi possível salvar as rotas deste canal.",
    );
  }
}

export async function removeInboundWebhookChannelRouteAction(
  formData: FormData,
): Promise<InboundWebhookActionResult> {
  const channelId = formId(formData, "channelId");
  const routeId = formId(formData, "routeId");

  if (!channelId || !routeId) {
    return failure(invalidFormMessage);
  }

  try {
    await deleteApiResource(
      `/integrations/inbound-webhooks/channels/${encodeURIComponent(channelId)}/routes/${encodeURIComponent(routeId)}`,
    );

    revalidatePath(integrationsPath);
    return {
      ok: true,
      message: "Rota removida do canal.",
    };
  } catch (error) {
    return failure(licenseLockedMessageFor(error) ?? "Não foi possível remover esta rota.");
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

function channelRoutesInput(
  formData: FormData,
): InboundWebhookChannelRoutesUpdateInputDto | null {
  const value = formText(formData, "routes");
  const routingMode = formText(formData, "routingMode");

  if (!value || value.length > 100_000) {
    return null;
  }

  try {
    // O modo só existe para o Unnichat: os demais provedores não o enviam
    // (a API recusa o campo).
    const input = inboundWebhookChannelRoutesUpdateInputSchema.safeParse({
      routes: JSON.parse(value),
      ...(routingMode ? { routingMode } : {}),
    });

    if (
      !input.success ||
      (input.data.routingMode === "inherit_workspace" &&
        input.data.routes.length > 0)
    ) {
      return null;
    }

    return input.data;
  } catch {
    return null;
  }
}

// Recusas 409 do modo de roteamento (Unnichat) em português claro.
const routeConflictMessages: ReadonlyArray<readonly [string, string]> = [
  [
    "Modo de herança disponível apenas para Unnichat",
    "O modo “Herdar do workspace” existe só para números do Unnichat.",
  ],
  [
    "Informe o modo de roteamento",
    "Escolha o modo de roteamento deste número (Herdar do workspace ou Configurar neste número) e salve.",
  ],
  [
    "Herança não aceita rotas locais",
    "No modo “Herdar do workspace” o número não tem rotas próprias. Remova as rotas ou escolha “Configurar neste número”.",
  ],
  [
    "Informe routingMode channel_override",
    "Para salvar rotas próprias, escolha “Configurar neste número”.",
  ],
];

function knownRouteError(error: unknown): string | null {
  const licenseMessage = licenseLockedMessageFor(error);

  if (licenseMessage) {
    return licenseMessage;
  }

  if (!(error instanceof Error)) {
    return null;
  }

  const message = error.message.trim();

  return (
    routeConflictMessages.find(([prefix]) => message.startsWith(prefix))?.[1] ??
    null
  );
}

async function deleteApiResource(path: string): Promise<void> {
  await serverApiFetch<void>(path, { method: "DELETE" });
}

function failure(message: string): InboundWebhookActionResult {
  return { ok: false, message };
}

function knownOperationalError(
  error: unknown,
  allowedMessages: ReadonlySet<string>,
): string | null {
  const licenseMessage = licenseLockedMessageFor(error);

  if (licenseMessage) {
    return licenseMessage;
  }

  if (!(error instanceof Error)) {
    return null;
  }

  const message = error.message.trim();

  return allowedMessages.has(message) ? message : null;
}
