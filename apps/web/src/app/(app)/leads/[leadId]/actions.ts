"use server";

import {
  leadStatuses,
  type LeadManualMetaSendDto,
  type LeadStatusUpdateResultDto,
} from "@wpptrack/shared";
import { revalidatePath } from "next/cache";
import type { BackofficeActionState } from "../../../../components/backoffice-action-form";
import { isApiRequestError, serverApiFetch } from "../../../../lib/server-api";

function sendReason(send: LeadManualMetaSendDto): string {
  const reasons: Record<string, string> = {
    MissingAdId: "o anuncio de origem nao foi identificado",
    MissingCtwaClid: "a conversa nao tem o identificador do anuncio (ctwa_clid)",
  };

  return (
    send.errorMessage ??
    (send.errorCode ? reasons[send.errorCode] : undefined) ??
    "faltam dados do anuncio"
  );
}

function sendSentence(label: string, send: LeadManualMetaSendDto): string | null {
  if (send.outcome === "queued") return `${label}: evento na fila de envio para a Meta.`;
  if (send.outcome === "already_recorded")
    return `${label}: o evento ja tinha sido registrado; nada foi reenviado.`;
  if (send.outcome === "not_eligible")
    return `${label}: a Meta nao recebe o evento (${sendReason(send)}).`;
  return null;
}

function metaSendMessage(result: LeadStatusUpdateResultDto): string {
  const sentences = [
    sendSentence("WhatsApp", result.metaSend),
    result.crmSend ? sendSentence("Formulario", result.crmSend) : null,
  ].filter((item): item is string => Boolean(item));

  return sentences.length
    ? `Lead qualificado. ${sentences.join(" ")}`
    : "Status atualizado.";
}

export async function updateLeadStatusAction(
  _previousState: BackofficeActionState,
  formData: FormData,
): Promise<BackofficeActionState> {
  const leadId = String(formData.get("leadId") ?? "").trim();
  const status = String(formData.get("status") ?? "").trim();

  if (!leadId || !(leadStatuses as readonly string[]).includes(status)) {
    return {
      status: "error",
      message: "Status ou lead nao identificado.",
      nonce: Date.now(),
    };
  }

  try {
    const result = await serverApiFetch<LeadStatusUpdateResultDto>(
      `/leads/${encodeURIComponent(leadId)}/status`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      },
    );
    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/leads");

    return {
      status: "success",
      message: metaSendMessage(result),
      nonce: Date.now(),
    };
  } catch (error) {
    return {
      status: "error",
      message:
        isApiRequestError(error) && error.status < 500
          ? error.message
          : "Nao foi possivel atualizar o status. Tente de novo em instantes.",
      nonce: Date.now(),
    };
  }
}
