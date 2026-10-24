"use server";

import {
  metaCloudWabaErrorCodeSchema,
  metaCloudWabaSubscriptionLookupInputSchema,
  metaCloudWabaSubscriptionStatusSchema,
  metaCloudWabaSubscriptionSubscribeInputSchema,
  type MetaCloudWabaErrorCode,
  type MetaCloudWabaSubscriptionStatusDto,
} from "@wpptrack/shared";
import { isApiRequestError, serverApiFetch } from "../../../lib/server-api";

/**
 * Consulta e inscrição do app Meta da instalação na WABA do aluno. O token
 * passa direto para a API nesta requisição: não é gravado, logado nem
 * devolvido, e o resultado nunca o inclui.
 */
export type MetaCloudWabaActionResult =
  | { ok: true; data: MetaCloudWabaSubscriptionStatusDto }
  | {
      ok: false;
      message: string;
      code?: MetaCloudWabaErrorCode | "invalid_input";
      status?: number;
    };

const genericFailure =
  "Não foi possível consultar a WABA agora. Confira sua sessão, seu acesso de dono ou admin, a licença e a disponibilidade da API.";

function path(connectionId: string, suffix = ""): string {
  if (!connectionId) throw new Error("connection");
  return `/integrations/inbound-webhooks/${encodeURIComponent(connectionId)}/meta-cloud/waba-subscription${suffix}`;
}

function failure(error: unknown): MetaCloudWabaActionResult {
  if (isApiRequestError(error)) {
    const code = metaCloudWabaErrorCodeSchema.safeParse(error.code);
    const message =
      error.message && !error.message.startsWith("API request failed")
        ? error.message
        : genericFailure;
    return {
      ok: false,
      message,
      status: error.status,
      ...(code.success
        ? { code: code.data }
        : error.code === "invalid_input"
          ? { code: "invalid_input" as const }
          : {}),
    };
  }
  return { ok: false, message: genericFailure };
}

function invalid(error: { issues: Array<{ message: string }> }): MetaCloudWabaActionResult {
  return {
    ok: false,
    code: "invalid_input",
    message: error.issues[0]?.message ?? "Confira o WABA ID e o token.",
  };
}

export async function lookupMetaCloudWabaAction(
  connectionId: string,
  input: { wabaId: string; accessToken: string },
): Promise<MetaCloudWabaActionResult> {
  const parsed = metaCloudWabaSubscriptionLookupInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);

  try {
    const response = await serverApiFetch<unknown>(path(connectionId, "/lookup"), {
      method: "POST",
      body: JSON.stringify(parsed.data),
    });
    const status = metaCloudWabaSubscriptionStatusSchema.safeParse(response);
    if (!status.success) return { ok: false, message: genericFailure };
    return { ok: true, data: status.data };
  } catch (error) {
    return failure(error);
  }
}

export async function subscribeMetaCloudWabaAction(
  connectionId: string,
  input: { wabaId: string; accessToken: string; confirm: true },
): Promise<MetaCloudWabaActionResult> {
  const parsed = metaCloudWabaSubscriptionSubscribeInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);

  try {
    const response = await serverApiFetch<unknown>(path(connectionId), {
      method: "POST",
      body: JSON.stringify(parsed.data),
    });
    const status = metaCloudWabaSubscriptionStatusSchema.safeParse(response);
    if (!status.success) return { ok: false, message: genericFailure };
    return { ok: true, data: status.data };
  } catch (error) {
    return failure(error);
  }
}
