"use server";

import { revalidatePath } from "next/cache";
import type { BackofficeActionState } from "../../../components/backoffice-action-form";
import { serverApiFetch } from "../../../lib/server-api";
import { retryRejectedMessage } from "./retry-rejected-message";

export async function retryMetaEventAction(
  _previousState: BackofficeActionState,
  formData: FormData
): Promise<BackofficeActionState> {
  const eventId = String(formData.get("eventId") ?? "").trim();

  if (!eventId) {
    return {
      status: "error",
      message: "Evento Meta não identificado.",
      nonce: Date.now()
    };
  }

  try {
    await serverApiFetch(
      `/reports/conversions/audit/${encodeURIComponent(eventId)}/retry`,
      { method: "POST" }
    );
    revalidatePath("/events");

    return {
      status: "success",
      message: "Evento enfileirado para uma nova tentativa.",
      nonce: Date.now()
    };
  } catch {
    return {
      status: "error",
      message:
        "O evento não pode ser reenviado. Atualize a página e confira o motivo técnico.",
      nonce: Date.now()
    };
  }
}

type RetryBlockedResult = {
  claimed: number;
  enqueued: number;
  skipped: number;
  /** Part of skipped: older than Meta's 7-day window (absent on older APIs). */
  expired?: number;
  /**
   * Part of skipped (Reenviar recusados, 1.3.1): the current Meta route of the
   * number or of the ad is not ready (absent on older APIs).
   */
  notReady?: number;
  failed: number;
};

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

function retryBlockedMessage(result: RetryBlockedResult): string {
  const parts: string[] = [];

  if (result.enqueued > 0) {
    parts.push(
      `${result.enqueued} ${plural(result.enqueued, "evento enfileirado", "eventos enfileirados")} para nova tentativa.`
    );
  }

  const expired = Math.min(result.expired ?? 0, result.skipped);
  const otherSkipped = result.skipped - expired;

  if (otherSkipped > 0) {
    parts.push(
      `${otherSkipped} ${plural(otherSkipped, "já não estava bloqueado e ficou", "já não estavam bloqueados e ficaram")} de fora.`
    );
  }

  if (expired > 0) {
    parts.push(
      `${expired} ${plural(expired, "evento ficou", "eventos ficaram")} de fora por ter mais de 7 dias: a Meta não aceita mais.`
    );
  }

  if (result.failed > 0) {
    parts.push(
      `${result.failed} ${plural(result.failed, "não pode ser enfileirado", "não puderam ser enfileirados")} agora; tente de novo em instantes.`
    );
  }

  return parts.length
    ? parts.join(" ")
    : "Nenhum evento bloqueado para reenviar neste período.";
}

export async function retryBlockedMetaEventsAction(
  _previousState: BackofficeActionState,
  formData: FormData
): Promise<BackofficeActionState> {
  // Mesmos filtros da lista: o reenvio nunca alcanca eventos fora da tela atual.
  const params = new URLSearchParams();

  for (const key of ["since", "until", "eventName", "status", "source"]) {
    const value = String(formData.get(key) ?? "").trim();

    if (value) {
      params.set(key, value);
    }
  }

  try {
    const result = await serverApiFetch<RetryBlockedResult>(
      `/reports/conversions/audit/retry-blocked?${params.toString()}`,
      { method: "POST" }
    );
    revalidatePath("/events");

    return {
      status:
        result.failed > 0 && result.enqueued === 0 ? "error" : "success",
      message: retryBlockedMessage(result),
      nonce: Date.now()
    };
  } catch {
    return {
      status: "error",
      message:
        "Não foi possível reenviar os eventos bloqueados. Atualize a página e tente de novo.",
      nonce: Date.now()
    };
  }
}

/**
 * "Reenviar recusados" (1.3.1), um evento: recusa da Meta cuja causa o aluno
 * corrigiu. Mesmo identificador do evento; rota e destino recalculados.
 */
export async function retryRejectedMetaEventAction(
  _previousState: BackofficeActionState,
  formData: FormData
): Promise<BackofficeActionState> {
  const eventId = String(formData.get("eventId") ?? "").trim();

  if (!eventId) {
    return {
      status: "error",
      message: "Evento Meta não identificado.",
      nonce: Date.now()
    };
  }

  try {
    await serverApiFetch(
      `/reports/conversions/audit/${encodeURIComponent(eventId)}/retry-rejected`,
      { method: "POST" }
    );
    revalidatePath("/events");

    return {
      status: "success",
      message:
        "Evento enfileirado com a configuração atual. Se a Meta recusar de novo, ele volta a Falhou com o novo motivo.",
      nonce: Date.now()
    };
  } catch {
    return {
      status: "error",
      message:
        "O evento não pode ser reenviado (já foi reenviado, tem mais de 7 dias ou a recusa não é corrigível). Atualize a página.",
      nonce: Date.now()
    };
  }
}

export async function retryRejectedMetaEventsAction(
  _previousState: BackofficeActionState,
  formData: FormData
): Promise<BackofficeActionState> {
  // Mesmos filtros da lista: o reenvio nunca alcanca eventos fora da tela atual.
  const params = new URLSearchParams();

  for (const key of ["since", "until", "eventName", "status", "source"]) {
    const value = String(formData.get(key) ?? "").trim();

    if (value) {
      params.set(key, value);
    }
  }

  try {
    const result = await serverApiFetch<RetryBlockedResult>(
      `/reports/conversions/audit/retry-rejected?${params.toString()}`,
      { method: "POST" }
    );
    revalidatePath("/events");

    return {
      status:
        result.failed > 0 && result.enqueued === 0 ? "error" : "success",
      message: retryRejectedMessage(result),
      nonce: Date.now()
    };
  } catch {
    return {
      status: "error",
      message:
        "Não foi possível reenviar os eventos recusados. Atualize a página e tente de novo.",
      nonce: Date.now()
    };
  }
}
