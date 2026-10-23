"use server";

import { randomUUID } from "node:crypto";
import type { ClientSwapResult } from "@wpptrack/shared";
import { isApiRequestError, serverApiFetch } from "../../../lib/server-api";

export type ClientSwapActionResult =
  | {
      ok: true;
      wipedCounts: Record<string, number>;
      replayed: boolean;
    }
  | {
      ok: false;
      message: string;
    };

export async function clientSwapAction(
  workspaceId: string,
  currentWorkspaceName: string,
  confirmationName: string,
  newClientName: string,
): Promise<ClientSwapActionResult> {
  if (
    !workspaceId ||
    confirmationName.trim() !== currentWorkspaceName.trim()
  ) {
    return { ok: false, message: "Confirmação inválida." };
  }

  const trimmedNewClientName = newClientName.trim();

  try {
    const result = await serverApiFetch<ClientSwapResult>(
      `/workspaces/${encodeURIComponent(workspaceId)}/client-swap`,
      {
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          confirm: true,
          ...(trimmedNewClientName
            ? { newClientName: trimmedNewClientName }
            : {}),
        }),
      },
    );

    return {
      ok: true,
      wipedCounts: result.wipedCounts,
      replayed: result.replayed === true,
    };
  } catch (error) {
    return { ok: false, message: clientSwapErrorMessage(error) };
  }
}

function clientSwapErrorMessage(error: unknown): string {
  if (!isApiRequestError(error)) {
    return "Não foi possível concluir a troca de cliente.";
  }

  if (error.status === 429) {
    return "Você só pode trocar de cliente 1 vez a cada 24 horas.";
  }

  if (error.status === 403) {
    return "Apenas o responsável da conta pode fazer isso.";
  }

  if (error.status === 409) {
    return "Esta solicitação já foi processada ou o nome gerou conflito. Tente novamente.";
  }

  if (error.status === 400) {
    return "Confirmação inválida.";
  }

  return "Não foi possível concluir a troca de cliente.";
}
