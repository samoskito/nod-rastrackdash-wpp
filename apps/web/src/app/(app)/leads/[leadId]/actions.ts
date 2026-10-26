"use server";

import {
  MANUAL_CONVERSION_RECENT_DUPLICATE_CODE,
  manualConversionInputSchema,
  type ManualConversionCancelResultDto,
  type ManualConversionInputDto,
  type ManualConversionPreviewDto,
  type ManualConversionResultDto,
} from "@wpptrack/shared";
import { revalidatePath } from "next/cache";
import { isApiRequestError, serverApiFetch } from "../../../../lib/server-api";

const GENERIC_ERROR =
  "Não foi possível registrar a conversão agora. Tente novamente em instantes.";

export type ManualConversionActionFailure = {
  ok: false;
  /**
   * already_converted: 409 (lead já convertido / pedido já registrado).
   * needs_confirmation: 409 do mesmo evento nas ±24h; reenviar com
   * confirmDuplicate=true ("Registrar mesmo assim").
   */
  state:
    | "already_converted"
    | "needs_confirmation"
    | "forbidden"
    | "rate_limited"
    | "license_locked"
    | "invalid"
    | "error";
  message: string;
};

function leadPath(leadId: string): string {
  return `/leads/${encodeURIComponent(leadId)}`;
}

function failure(error: unknown): ManualConversionActionFailure {
  if (isApiRequestError(error)) {
    if (error.status === 409)
      return {
        ok: false,
        state:
          error.code === MANUAL_CONVERSION_RECENT_DUPLICATE_CODE
            ? "needs_confirmation"
            : "already_converted",
        message: error.message,
      };
    if (error.status === 403)
      return {
        ok: false,
        state: "forbidden",
        message: "Só donos e administradores registram conversões manuais.",
      };
    if (error.status === 429)
      return { ok: false, state: "rate_limited", message: error.message };
    // nod: licença bloqueada, toda escrita é recusada (423).
    if (error.status === 423)
      return {
        ok: false,
        state: "license_locked",
        message:
          "Licença bloqueada: ative a licença em Backoffice → Licença para registrar conversões manuais.",
      };
    if (error.status === 400)
      return {
        ok: false,
        state: "invalid",
        message:
          error.message && !error.message.startsWith("API request failed")
            ? error.message
            : "Confira os campos do formulário.",
      };
  }
  return { ok: false, state: "error", message: GENERIC_ERROR };
}

function parseInput(
  input: ManualConversionInputDto,
): ManualConversionInputDto | null {
  const parsed = manualConversionInputSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export async function previewManualConversionAction(
  leadId: string,
  input: ManualConversionInputDto,
): Promise<
  { ok: true; preview: ManualConversionPreviewDto } | ManualConversionActionFailure
> {
  const parsed = parseInput(input);
  if (!parsed)
    return {
      ok: false,
      state: "invalid",
      message: "Confira os campos do formulário.",
    };
  try {
    const preview = await serverApiFetch<ManualConversionPreviewDto>(
      `${leadPath(leadId)}/manual-conversions/preview`,
      { method: "POST", body: JSON.stringify(parsed) },
    );
    return { ok: true, preview };
  } catch (error) {
    return failure(error);
  }
}

export async function createManualConversionAction(
  leadId: string,
  input: ManualConversionInputDto,
): Promise<
  { ok: true; result: ManualConversionResultDto } | ManualConversionActionFailure
> {
  const parsed = parseInput(input);
  if (!parsed)
    return {
      ok: false,
      state: "invalid",
      message: "Confira os campos do formulário.",
    };
  try {
    const result = await serverApiFetch<ManualConversionResultDto>(
      `${leadPath(leadId)}/manual-conversions`,
      { method: "POST", body: JSON.stringify(parsed) },
    );
    revalidatePath(leadPath(leadId));
    return { ok: true, result };
  } catch (error) {
    return failure(error);
  }
}

export async function cancelManualConversionAction(
  leadId: string,
  conversionEventLogId: string,
): Promise<
  | { ok: true; result: ManualConversionCancelResultDto }
  | ManualConversionActionFailure
> {
  try {
    const result = await serverApiFetch<ManualConversionCancelResultDto>(
      `${leadPath(leadId)}/manual-conversions/${encodeURIComponent(
        conversionEventLogId,
      )}/cancel`,
      { method: "POST" },
    );
    revalidatePath(leadPath(leadId));
    return { ok: true, result };
  } catch (error) {
    const result = failure(error);
    return result.state === "error"
      ? {
          ...result,
          message: "Não foi possível cancelar agora. Atualize a página.",
        }
      : result;
  }
}
