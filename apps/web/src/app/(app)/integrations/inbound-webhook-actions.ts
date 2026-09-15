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
  "Ative ao menos um canal validado antes da producao",
  "Certifique o parser antes de ativar o envio automatico",
  "Controle de vagas dos canais externos indisponivel",
  "Envio automatico de webhooks ainda nao esta habilitado",
  "Finalize o replay em andamento antes de ativar a producao",
  "Todas as vagas do pacote estao ocupadas",
  "Todo canal ativo precisa de uma rota Meta valida",
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
  const input = inboundWebhookConnectionCreateInputSchema.safeParse({
    provider: formText(formData, "provider"),
    displayName: formText(formData, "displayName"),
  });

  if (!input.success) {
    return failure(invalidFormMessage);
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
      return failure("Nao foi possivel criar a conexao de webhook.");
    }

    revalidatePath(integrationsPath);
    return {
      ok: true,
      message:
        "Conexao de webhook criada. Copie a URL agora; ela nao sera exibida novamente.",
      oneTimeSecret: oneTimeSecretForProvider({
        connectionId: result.data.connection.id,
        provider: result.data.connection.provider,
        webhookUrl: result.data.webhookUrl,
        secret: result.data.secret,
      }),
    };
  } catch {
    return failure("Nao foi possivel criar a conexao de webhook.");
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
      return failure("Nao foi possivel rotacionar o segredo desta conexao.");
    }

    revalidatePath(integrationsPath);
    return {
      ok: true,
      message:
        "Segredo rotacionado. Copie a nova URL agora; ela nao sera exibida novamente.",
      oneTimeSecret: oneTimeSecretForProvider({
        connectionId: result.data.connectionId,
        provider: result.data.provider,
        webhookUrl: result.data.webhookUrl,
        secret: result.data.secret,
      }),
    };
  } catch {
    return failure("Nao foi possivel rotacionar o segredo desta conexao.");
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
          ? "Conexao pausada. Novas entregas nao serao processadas."
          : input.data.status === "production"
            ? "Envio automatico ativado nos canais habilitados."
            : "Conexao mantida em modo de observacao.",
    };
  } catch (error) {
    return failure(
      knownOperationalError(error, connectionStatusOperationalErrors) ??
        "Nao foi possivel alterar o status desta conexao.",
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
      message: "Conexao removida. O historico de observacao foi preservado.",
    };
  } catch {
    return failure("Nao foi possivel remover esta conexao.");
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
        "Canal cadastrado. Ja e possivel criar regras de conversao para ele antes de qualquer mensagem chegar.",
    };
  } catch {
    return failure("Nao foi possivel cadastrar o canal.");
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
          : "Canal habilitado para envio quando a conexao estiver em producao.",
    };
  } catch {
    return failure("Nao foi possivel alterar o status deste canal.");
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
      message: "Rotas do canal salvas e validadas.",
    };
  } catch {
    return failure("Nao foi possivel salvar as rotas deste canal.");
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
  } catch {
    return failure("Nao foi possivel remover esta rota.");
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

  if (!value || value.length > 100_000) {
    return null;
  }

  try {
    const input = inboundWebhookChannelRoutesUpdateInputSchema.safeParse({
      routes: JSON.parse(value),
    });

    return input.success ? input.data : null;
  } catch {
    return null;
  }
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
  if (!(error instanceof Error)) {
    return null;
  }

  const message = error.message.trim();

  return allowedMessages.has(message) ? message : null;
}
