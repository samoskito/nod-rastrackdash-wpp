"use server";

import {
  leadStatuses,
  type LeadStatusUpdateResultDto,
} from "@wpptrack/shared";
import { revalidatePath } from "next/cache";
import type { BackofficeActionState } from "../../../../components/backoffice-action-form";
import { isApiRequestError, serverApiFetch } from "../../../../lib/server-api";

function metaSendMessage(result: LeadStatusUpdateResultDto): string {
  const { metaSend } = result;

  if (metaSend.outcome === "queued") {
    return "Lead qualificado. Evento na fila de envio para a Meta.";
  }

  if (metaSend.outcome === "already_recorded") {
    return "Lead qualificado. O evento ja tinha sido registrado; nada foi reenviado.";
  }

  if (metaSend.outcome === "not_eligible") {
    const reasons: Record<string, string> = {
      MissingAdId: "o anuncio de origem nao foi identificado",
      MissingCtwaClid: "a conversa nao tem o identificador do anuncio (ctwa_clid)",
    };
    const reason =
      (metaSend.errorCode && reasons[metaSend.errorCode]) ??
      "faltam dados do anuncio";

    return `Lead qualificado, mas a Meta nao recebe o evento: ${reason}.`;
  }

  return "Status atualizado.";
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
