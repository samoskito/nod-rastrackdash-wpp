"use server";

import { revalidatePath } from "next/cache";
import type { BackofficeActionState } from "../../../components/backoffice-action-form";
import { isApiRequestError, serverApiFetch } from "../../../lib/server-api";

// Fase 6.9 (PR #91 do nod): ações da seção "Formulários Meta" (Lead Ads).
// Todas são escritas: com a licença bloqueada a API responde 423 e a mensagem
// da API aparece no aviso.

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
      "Conexão salva. Agora clique em Assinar Página para receber os leads.",
    );
  } catch (error) {
    return errorState(error, "Não foi possível salvar a conexão agora.");
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

    return state("success", "Página assinada: os novos leads chegam pelo webhook.");
  } catch (error) {
    return errorState(error, "A Meta não respondeu. Tente de novo.");
  }
}

export async function setMetaLeadFormConnectionActiveAction(
  _previousState: BackofficeActionState,
  formData: FormData,
): Promise<BackofficeActionState> {
  const id = text(formData, "connectionId");
  const active = text(formData, "active") === "true";

  // Desativar para de receber os leads da Página e guarda o histórico; é o
  // caminho quando a Página já recebeu formulários (remover responde 409).
  try {
    await serverApiFetch(
      `/integrations/meta-lead-forms/${encodeURIComponent(id)}/${
        active ? "reactivate" : "deactivate"
      }`,
      { method: "POST" },
    );
    revalidatePath("/integrations");

    return state(
      "success",
      active
        ? "Conexão reativada: os novos leads voltam a chegar."
        : "Conexão desativada: os novos leads são ignorados e o histórico fica guardado.",
    );
  } catch (error) {
    return errorState(error, "Não foi possível alterar a conexão.");
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

    return state("success", "Conexão removida.");
  } catch (error) {
    return errorState(error, "Não foi possível remover a conexão.");
  }
}

/**
 * Edita dataset, evento e tokens (só os campos preenchidos mudam). Depois de
 * corrigir o dataset ou o token, as etapas bloqueadas voltam por "Reenviar
 * bloqueados" em Eventos Meta.
 */
export async function updateMetaLeadFormConnectionAction(
  _previousState: BackofficeActionState,
  formData: FormData,
): Promise<BackofficeActionState> {
  const id = text(formData, "connectionId");
  const patch: Record<string, unknown> = {};
  for (const field of [
    "label",
    "crmDatasetId",
    "qualifiedEventName",
    "graphToken",
    "capiToken",
  ]) {
    const value = text(formData, field);
    if (value) patch[field] = value;
  }
  if (Object.keys(patch).length === 0)
    return state("error", "Preencha ao menos um campo para alterar.");

  try {
    await serverApiFetch(
      `/integrations/meta-lead-forms/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    revalidatePath("/integrations");

    return state(
      "success",
      "Conexão alterada. Etapas bloqueadas voltam por Reenviar bloqueados, em Eventos Meta.",
    );
  } catch (error) {
    return errorState(error, "Não foi possível alterar a conexão.");
  }
}
