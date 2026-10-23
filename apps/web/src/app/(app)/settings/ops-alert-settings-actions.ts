"use server";

import type { WorkspaceOpsAlertSettingsInput } from "@wpptrack/shared";
import { revalidatePath } from "next/cache";
import type { BackofficeActionState } from "../../../components/backoffice-action-form";
import { isApiRequestError, serverApiFetch } from "../../../lib/server-api";

function actionState(
  status: BackofficeActionState["status"],
  message: string,
): BackofficeActionState {
  return { status, message, nonce: Date.now() };
}

export async function saveOpsAlertSettingsAction(
  _previousState: BackofficeActionState,
  formData: FormData,
): Promise<BackofficeActionState> {
  const workspaceId = String(formData.get("workspaceId") ?? "").trim();
  const enabled = formData.get("enabled") === "on";
  const alertPhones = dedupePhones(
    formData
      .getAll("alertPhones")
      .map((value) => String(value).replace(/\D/g, ""))
      .filter((value) => value.length > 0),
  );
  const disconnectAlerts = formData.get("disconnectAlerts") === "on";
  const webhookSilenceAlerts = formData.get("webhookSilenceAlerts") === "on";
  const silenceThresholdHours =
    Number(formData.get("silenceThresholdHours") ?? 24) || 24;
  const debounceHours = Number(formData.get("debounceHours") ?? 6) || 6;

  if (!workspaceId) {
    return actionState("error", "Workspace não identificado.");
  }

  if (enabled && alertPhones.length === 0) {
    return actionState(
      "error",
      "Informe ao menos um telefone para ativar os alertas.",
    );
  }

  const payload: WorkspaceOpsAlertSettingsInput = {
    enabled,
    alertPhones,
    alertPhone: alertPhones[0] ?? "",
    disconnectAlerts,
    webhookSilenceAlerts,
    silenceThresholdHours,
    debounceHours,
  };

  try {
    await serverApiFetch(
      `/workspaces/${encodeURIComponent(workspaceId)}/ops-alerts/settings`,
      {
        method: "PUT",
        body: JSON.stringify(payload),
      },
    );
    revalidatePath("/settings");

    return actionState("success", "Alertas de operação atualizados.");
  } catch (error) {
    return actionState("error", opsAlertSettingsErrorMessage(error));
  }
}

function dedupePhones(phones: string[]): string[] {
  return Array.from(new Set(phones));
}

function opsAlertSettingsErrorMessage(error: unknown): string {
  if (isApiRequestError(error) && error.status === 403) {
    return "Sem permissão para gerenciar alertas operacionais.";
  }

  return "Não foi possível salvar os alertas.";
}
