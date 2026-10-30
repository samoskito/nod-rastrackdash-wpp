"use server";

import {
  inboundWebhookConnectionSchema,
  metaCloudAppCredentialsInputSchema,
  type InboundWebhookMetaAppDto,
} from "@wpptrack/shared";
import { revalidatePath } from "next/cache";
import { licenseLockedMessageFor } from "../../../lib/license-locked-message";
import { isApiRequestError, serverApiFetch } from "../../../lib/server-api";

/**
 * App ID e App Secret do app Meta de uma conexão Meta Cloud. O segredo vai
 * só no corpo desta requisição para a API, que o cifra; a resposta nunca o
 * inclui (só se ele existe e de onde vem).
 */
export type MetaCloudAppActionResult =
  | { ok: true; message: string; metaApp: InboundWebhookMetaAppDto | null }
  | { ok: false; message: string };

const genericFailure =
  "Não foi possível salvar o app Meta desta conexão agora. Confira sua sessão, seu acesso de dono ou admin, a licença e a disponibilidade da API.";
const genericRemoveFailure =
  "Não foi possível remover o app Meta desta conexão agora. Confira sua sessão, seu acesso de dono ou admin, a licença e a disponibilidade da API.";

function path(connectionId: string): string {
  if (!connectionId || connectionId.length > 255) throw new Error("connection");
  return `/integrations/inbound-webhooks/${encodeURIComponent(connectionId)}/meta-cloud/app`;
}

function failure(error: unknown, fallback: string): MetaCloudAppActionResult {
  const licenseMessage = licenseLockedMessageFor(error);
  if (licenseMessage) return { ok: false, message: licenseMessage };
  if (
    isApiRequestError(error) &&
    error.message &&
    !error.message.startsWith("API request failed") &&
    // Recusas da API para esta ação (validação 400 e conflitos 409/503),
    // sempre em português e sem dados do segredo.
    [400, 409, 503].includes(error.status)
  ) {
    return { ok: false, message: error.message };
  }
  return { ok: false, message: fallback };
}

function metaAppFrom(response: unknown): InboundWebhookMetaAppDto | null {
  const parsed = inboundWebhookConnectionSchema.safeParse(response);
  return parsed.success ? (parsed.data.metaApp ?? null) : null;
}

export async function saveMetaCloudAppAction(
  connectionId: string,
  input: { appId: string; appSecret: string },
): Promise<MetaCloudAppActionResult> {
  const parsed = metaCloudAppCredentialsInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message:
        parsed.error.issues[0]?.message ??
        "Informe o App ID e o App Secret do app Meta desta conexão.",
    };
  }

  try {
    const response = await serverApiFetch<unknown>(path(connectionId), {
      method: "PUT",
      body: JSON.stringify(parsed.data),
    });
    revalidatePath("/integrations");
    return {
      ok: true,
      message:
        "App Secret salvo nesta conexão. As assinaturas da Meta desta conexão passam a ser conferidas com ele.",
      metaApp: metaAppFrom(response),
    };
  } catch (error) {
    return failure(error, genericFailure);
  }
}

export async function removeMetaCloudAppAction(
  connectionId: string,
): Promise<MetaCloudAppActionResult> {
  try {
    const response = await serverApiFetch<unknown>(path(connectionId), {
      method: "DELETE",
    });
    revalidatePath("/integrations");
    return {
      ok: true,
      message:
        "App Meta removido desta conexão. Ela volta a usar o META_APP_SECRET do servidor, se houver.",
      metaApp: metaAppFrom(response),
    };
  } catch (error) {
    return failure(error, genericRemoveFailure);
  }
}
