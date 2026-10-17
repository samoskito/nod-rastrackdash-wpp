"use server";

import { revalidatePath } from "next/cache";
import type { BackofficeActionState } from "../../../components/backoffice-action-form";
import { isApiRequestError, serverApiFetch } from "../../../lib/server-api";

function state(
  status: "success" | "error",
  message: string,
): BackofficeActionState {
  return { status, message, nonce: Date.now() };
}

function errorState(error: unknown, fallback: string): BackofficeActionState {
  return state(
    "error",
    isApiRequestError(error) && error.status < 500 ? error.message : fallback,
  );
}

function text(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

function ids(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function createMetaLeadFormConnectionAction(
  _previousState: BackofficeActionState,
  formData: FormData,
): Promise<BackofficeActionState> {
  const capiToken = text(formData, "capiToken");
  const crmDatasetId = text(formData, "crmDatasetId");

  try {
    await serverApiFetch("/integrations/meta-lead-forms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: text(formData, "label"),
        pageId: text(formData, "pageId"),
        formIds: ids(text(formData, "formIds")),
        crmDatasetId: crmDatasetId || null,
        qualifiedEventName: text(formData, "qualifiedEventName") || undefined,
        graphToken: text(formData, "graphToken"),
        capiToken: capiToken || null,
      }),
    });
    revalidatePath("/integrations");

    return state(
      "success",
      "Conexao salva. Agora clique em Assinar Pagina para receber os leads.",
    );
  } catch (error) {
    return errorState(error, "Nao foi possivel salvar a conexao agora.");
  }
}

export async function subscribeMetaLeadFormPageAction(
  _previousState: BackofficeActionState,
  formData: FormData,
): Promise<BackofficeActionState> {
  const id = text(formData, "connectionId");

  try {
    await serverApiFetch(
      `/integrations/meta-lead-forms/${encodeURIComponent(id)}/subscribe`,
      { method: "POST" },
    );
    revalidatePath("/integrations");

    return state("success", "Pagina assinada: novos leads chegam por webhook.");
  } catch (error) {
    return errorState(error, "A Meta nao respondeu. Tente de novo.");
  }
}

export async function setMetaLeadFormConnectionActiveAction(
  _previousState: BackofficeActionState,
  formData: FormData,
): Promise<BackofficeActionState> {
  const id = text(formData, "connectionId");
  const active = text(formData, "active") === "true";

  try {
    await serverApiFetch(
      `/integrations/meta-lead-forms/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      },
    );
    revalidatePath("/integrations");

    return state("success", active ? "Conexao ativada." : "Conexao pausada.");
  } catch (error) {
    return errorState(error, "Nao foi possivel alterar a conexao.");
  }
}

export async function deleteMetaLeadFormConnectionAction(
  _previousState: BackofficeActionState,
  formData: FormData,
): Promise<BackofficeActionState> {
  const id = text(formData, "connectionId");

  try {
    await serverApiFetch(
      `/integrations/meta-lead-forms/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    revalidatePath("/integrations");

    return state("success", "Conexao removida.");
  } catch (error) {
    return errorState(error, "Nao foi possivel remover a conexao.");
  }
}
