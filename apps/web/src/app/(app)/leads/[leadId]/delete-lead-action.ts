"use server";

import { LEAD_DELETE_CONFIRMATION } from "@wpptrack/shared";
import { revalidatePath } from "next/cache";
import { isApiRequestError, serverApiFetch } from "../../../../lib/server-api";

export type DeleteLeadActionResult =
  | { ok: true }
  | { ok: false; message: string };

/** "Excluir lead" (porte do SaaS #292): a API confere a permissão e audita. */
export async function deleteLeadAction(
  leadId: string,
): Promise<DeleteLeadActionResult> {
  try {
    await serverApiFetch(`/leads/${encodeURIComponent(leadId)}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmation: LEAD_DELETE_CONFIRMATION }),
    });
    revalidatePath("/leads");
    revalidatePath("/crm");
    return { ok: true };
  } catch (error) {
    if (isApiRequestError(error)) {
      if (error.status === 403)
        return { ok: false, message: "Só gestores do workspace excluem leads." };
      if (error.status === 409 || error.status === 404)
        return { ok: false, message: error.message };
    }
    return {
      ok: false,
      message: "Não foi possível excluir agora. Tente novamente em instantes.",
    };
  }
}
