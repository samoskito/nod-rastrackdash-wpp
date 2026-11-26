"use server";

import { revalidatePath } from "next/cache";
import { isApiRequestError, serverApiFetch } from "../../../../lib/server-api";

export type DeleteObservedEventResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Apaga um evento de teste (regra em observação) do lead. A API confere a
 * permissão e só apaga o que nunca foi para a Meta.
 */
export async function deleteObservedEventAction(
  leadId: string,
  executionId: string,
): Promise<DeleteObservedEventResult> {
  try {
    await serverApiFetch(
      `/leads/${encodeURIComponent(leadId)}/observed-events/${encodeURIComponent(executionId)}`,
      { method: "DELETE" },
    );
    revalidatePath(`/leads/${encodeURIComponent(leadId)}`);
    revalidatePath("/leads");
    revalidatePath("/crm");
    return { ok: true };
  } catch (error) {
    if (isApiRequestError(error)) {
      if (error.status === 403)
        return {
          ok: false,
          message: "Só quem gerencia as regras de conversão exclui eventos de teste.",
        };
      if (error.status === 423)
        return { ok: false, message: "Licença bloqueada: só leitura." };
      if (error.status === 409 || error.status === 404)
        return { ok: false, message: error.message };
    }
    return {
      ok: false,
      message: "Não foi possível excluir agora. Tente novamente em instantes.",
    };
  }
}
