"use server";

import { integrationEventPayloadSchema } from "@wpptrack/shared";
import type { SingleUrlActionResult } from "../../../../(app)/integrations/single-url/single-url-actions";
import {
  isApiRequestError,
  serverApiFetch,
} from "../../../../../lib/server-api";

const openFailure = "Não deu para abrir os dados deste recebimento.";

function eventIdFrom(formData: FormData): string | null {
  const value = formData.get("eventId");
  return typeof value === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/u.test(value.trim())
    ? value.trim()
    : null;
}

/**
 * "Ver dados recebidos" no Backoffice (qualquer workspace; só
 * administradores da plataforma). Chaves de conta, tokens e segredos
 * ocultos; a API registra quem viu. Leitura: funciona com a licença
 * bloqueada.
 */
export async function loadBackofficeIntegrationEventPayloadAction(
  formData: FormData,
): Promise<SingleUrlActionResult> {
  const eventId = eventIdFrom(formData);
  if (!eventId) return { ok: false, message: openFailure };
  try {
    const response = await serverApiFetch<unknown>(
      `/backoffice/integration-events/${encodeURIComponent(eventId)}/payload`,
    );
    const parsed = integrationEventPayloadSchema.safeParse(response);
    if (!parsed.success || parsed.data.eventId !== eventId) {
      return { ok: false, message: openFailure };
    }
    return {
      ok: true,
      eventPayload: parsed.data,
      message: parsed.data.payloadAvailable
        ? "Dados recebidos abertos."
        : (parsed.data.payloadMessage ?? "Os dados recebidos já foram apagados."),
    };
  } catch (error) {
    const status = isApiRequestError(error) ? error.status : null;
    if (status === 401)
      return { ok: false, message: "Sua sessão expirou. Entre de novo." };
    if (status === 403)
      return {
        ok: false,
        message: "Só administradores da plataforma podem ver estes dados.",
      };
    if (status === 404)
      return { ok: false, message: "Recebimento não encontrado." };
    return { ok: false, message: openFailure };
  }
}
