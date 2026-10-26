"use server";

import {
  studentInboundReplayAuthorizeSchema,
  studentInboundReplayPreviewSchema,
  studentInboundReplayResultSchema,
  studentInboundReplayRetrySchema,
  type StudentInboundReplayPreviewDto,
  type StudentInboundReplayResultDto,
} from "@wpptrack/shared";
import { serverApiFetch } from "../../../lib/server-api";

export type RecoveryActionResult<T> =
  { ok: true; data: T } | { ok: false; message: string };
const safeErrors = new Set([
  "A prévia expirou ou mudou. Atualize a prévia antes de enviar",
  "A prévia não pertence a este owner, conexão e canal",
  "A conexão ou a rota mudou. Atualize a prévia antes de enviar",
  "Envie um de teste e aguarde a confirmação de entrega antes de recuperar os demais",
  "Esta conexão já possui um replay em andamento",
  "Nenhum evento possui rota completa e payload disponível",
  "Digite exatamente o nome da conexão para autorizar",
  "Não foi possível iniciar o replay; tente novamente",
  "Configure META_APP_SECRET do seu próprio app Meta no ambiente da API antes de enviar. Não use o segredo PalmUP nem cole segredos no chat.",
  "Replay de webhooks ainda não está habilitado",
  // Fase 6.1c (porte do SaaS #91): reenviar os que falharam.
  "Esta recuperação não tem itens com falha para reenviar",
  "Ative o canal e valide a rota Meta antes de reenviar",
  "Nenhuma falha possui payload disponível para reenviar",
  "Não foi possível reenviar agora; tente novamente",
  "A licença precisa estar utilizável antes de recuperar CTWAs",
]);
function failure(error: unknown): { ok: false; message: string } {
  return {
    ok: false,
    message:
      error instanceof Error && safeErrors.has(error.message)
        ? error.message
        : "Não foi possível consultar ou autorizar a recuperação. Confira sua sessão, acesso de owner, licença e disponibilidade da API.",
  };
}
function path(connectionId: string, channelId: string): string {
  if (!connectionId || !channelId) throw new Error();
  return `/integrations/inbound-webhooks/${encodeURIComponent(connectionId)}/channels/${encodeURIComponent(channelId)}/recovery`;
}
export async function previewInboundRecoveryAction(
  connectionId: string,
  channelId: string,
): Promise<RecoveryActionResult<StudentInboundReplayPreviewDto>> {
  try {
    const response = await serverApiFetch<unknown>(
      `${path(connectionId, channelId)}/preview`,
    );
    const parsed = studentInboundReplayPreviewSchema.safeParse(response);
    if (!parsed.success) throw new Error();
    return { ok: true, data: parsed.data };
  } catch (error) {
    return failure(error);
  }
}
export async function authorizeInboundRecoveryAction(
  connectionId: string,
  channelId: string,
  input: unknown,
): Promise<RecoveryActionResult<StudentInboundReplayResultDto>> {
  try {
    const parsed = studentInboundReplayAuthorizeSchema.safeParse(input);
    if (!parsed.success)
      return {
        ok: false,
        message: "Revise a prévia e digite o nome da conexão para confirmar.",
      };
    const response = await serverApiFetch<unknown>(
      `${path(connectionId, channelId)}/authorize`,
      { method: "POST", body: JSON.stringify(parsed.data) },
    );
    return { ok: true, data: studentInboundReplayResultSchema.parse(response) };
  } catch (error) {
    return failure(error);
  }
}
/** Fase 6.1c (porte do SaaS #91): reenvia os itens que falharam do lote. */
export async function retryInboundRecoveryAction(
  connectionId: string,
  channelId: string,
  batchId: string,
  input: unknown,
): Promise<RecoveryActionResult<StudentInboundReplayResultDto>> {
  try {
    if (!batchId) throw new Error();
    const parsed = studentInboundReplayRetrySchema.safeParse(input);
    if (!parsed.success)
      return {
        ok: false,
        message: "Digite o nome da conexão para confirmar o reenvio.",
      };
    const response = await serverApiFetch<unknown>(
      `${path(connectionId, channelId)}/batches/${encodeURIComponent(batchId)}/retry`,
      { method: "POST", body: JSON.stringify(parsed.data) },
    );
    return { ok: true, data: studentInboundReplayResultSchema.parse(response) };
  } catch (error) {
    return failure(error);
  }
}
export async function inboundRecoveryResultAction(
  connectionId: string,
  channelId: string,
  batchId: string,
): Promise<RecoveryActionResult<StudentInboundReplayResultDto>> {
  try {
    if (!batchId) throw new Error();
    const response = await serverApiFetch<unknown>(
      `${path(connectionId, channelId)}/batches/${encodeURIComponent(batchId)}`,
    );
    return { ok: true, data: studentInboundReplayResultSchema.parse(response) };
  } catch (error) {
    return failure(error);
  }
}
