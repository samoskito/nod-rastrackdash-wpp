"use server";

import { revalidatePath } from "next/cache";
import type {
  BackofficeWorkspaceActivationReissueResultDto,
  BackofficeWorkspaceCreateResultDto,
} from "@wpptrack/shared";
import { isApiRequestError, serverApiFetch } from "./server-api";

const CLIENTS_PATH = "/backoffice/clients";

export type BackofficeClientsActionState = {
  status: "idle" | "success" | "error";
  message: string;
  nonce: number;
  activationUrl?: string;
  activationExpiresAt?: string;
};

/**
 * Response of `POST .../activation-link`. Not part of `@wpptrack/shared`
 * (the API keeps it as a service-local type), so it is mirrored here to keep
 * this module the single place that knows the manual-link contract.
 */
type ClientOwnerActivationLinkResult = {
  ok: true;
  mode: "activation";
  delivery: "link_only";
  activationUrl: string;
  expiresAt: string;
  emailAttempted: false;
};

function actionState(
  status: BackofficeClientsActionState["status"],
  message: string,
  extra: Partial<BackofficeClientsActionState> = {},
): BackofficeClientsActionState {
  return { status, message, nonce: Date.now(), ...extra };
}

function apiErrorMessage(error: unknown, fallback: string): string {
  return isApiRequestError(error) && error.message.trim()
    ? error.message
    : fallback;
}

function formText(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function createBackofficeWorkspaceAction(
  _previousState: BackofficeClientsActionState,
  formData: FormData,
): Promise<BackofficeClientsActionState> {
  const workspaceName = formText(formData, "workspaceName");
  const responsibleName = formText(formData, "responsibleName");
  const responsibleEmail = formText(formData, "responsibleEmail");
  const reuseExistingUser = formData.get("reuseExistingUser") === "on";

  if (!workspaceName) {
    return actionState("error", "Informe o nome do workspace.");
  }

  if (!responsibleName) {
    return actionState("error", "Informe o nome do responsável.");
  }

  if (!responsibleEmail) {
    return actionState("error", "Informe o e-mail do responsável.");
  }

  try {
    const result = await serverApiFetch<BackofficeWorkspaceCreateResultDto>(
      "/backoffice/workspaces",
      {
        method: "POST",
        body: JSON.stringify({
          name: workspaceName,
          responsible: { name: responsibleName, email: responsibleEmail },
          reuseExistingUser,
        }),
      },
    );

    revalidatePath(CLIENTS_PATH);

    if (result.deliveryStatus === "failed") {
      return actionState(
        "success",
        `Workspace "${result.name}" criado, mas o e-mail de ativação não foi enfileirado. Gere um link de ativação manual para o responsável.`,
      );
    }

    return actionState("success", `Workspace "${result.name}" criado.`);
  } catch (error) {
    return actionState(
      "error",
      apiErrorMessage(error, "Não foi possível criar o workspace."),
    );
  }
}

export async function resendActivationEmailAction(
  _previousState: BackofficeClientsActionState,
  formData: FormData,
): Promise<BackofficeClientsActionState> {
  const workspaceId = formText(formData, "workspaceId");
  const ownerUserId = formText(formData, "ownerUserId");

  if (!workspaceId || !ownerUserId) {
    return actionState("error", "Responsável não identificado.");
  }

  try {
    await serverApiFetch<BackofficeWorkspaceActivationReissueResultDto>(
      `/backoffice/workspaces/${encodeURIComponent(workspaceId)}/owners/${encodeURIComponent(ownerUserId)}/activation/resend`,
      { method: "POST" },
    );

    return actionState("success", "Envio solicitado.");
  } catch (error) {
    return actionState(
      "error",
      apiErrorMessage(error, "Não foi possível reenviar o e-mail."),
    );
  }
}

export async function generateActivationLinkAction(
  _previousState: BackofficeClientsActionState,
  formData: FormData,
): Promise<BackofficeClientsActionState> {
  const workspaceId = formText(formData, "workspaceId");
  const ownerUserId = formText(formData, "ownerUserId");

  if (!workspaceId || !ownerUserId) {
    return actionState("error", "Responsável não identificado.");
  }

  try {
    const result = await serverApiFetch<ClientOwnerActivationLinkResult>(
      `/backoffice/workspaces/${encodeURIComponent(workspaceId)}/owners/${encodeURIComponent(ownerUserId)}/activation-link`,
      { method: "POST" },
    );

    return actionState("success", "Link de ativação gerado.", {
      activationUrl: result.activationUrl,
      activationExpiresAt: result.expiresAt,
    });
  } catch (error) {
    return actionState(
      "error",
      apiErrorMessage(error, "Não foi possível gerar o link de ativação."),
    );
  }
}
