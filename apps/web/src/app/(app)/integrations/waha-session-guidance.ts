/**
 * Textos da tela da WAHA (motor GoWS). A WAHA é do aluno: servidor, sessão e
 * QR ficam no painel dele; o app só consulta o status e configura o webhook.
 */

export type WahaGuidanceTone = "ok" | "warn" | "error";

export type WahaSessionGuidance = {
  label: string;
  tone: WahaGuidanceTone;
  instruction: string;
};

const guidanceByStatus: Record<string, WahaSessionGuidance> = {
  WORKING: {
    label: "WORKING",
    tone: "ok",
    instruction:
      "Sessão conectada. Falta só configurar o webhook para as conversas dos anúncios chegarem aqui.",
  },
  SCAN_QR_CODE: {
    label: "SCAN_QR_CODE",
    tone: "warn",
    instruction:
      "Falta ler o QR. Abra o painel da sua WAHA, leia o QR da sessão com o celular do número e teste de novo.",
  },
  STARTING: {
    label: "STARTING",
    tone: "warn",
    instruction:
      "A sessão está subindo na sua WAHA. Aguarde alguns segundos e teste de novo.",
  },
  STOPPED: {
    label: "STOPPED",
    tone: "warn",
    instruction:
      "A sessão está parada. Inicie a sessão no painel da sua WAHA e teste de novo.",
  },
  FAILED: {
    label: "FAILED",
    tone: "error",
    instruction:
      "A sessão falhou na sua WAHA. Veja os logs no painel dela, reinicie a sessão e teste de novo.",
  },
};

const unknownGuidance: WahaSessionGuidance = {
  label: "Desconhecido",
  tone: "error",
  instruction:
    "A sua WAHA devolveu um status que o app não reconhece. Confira a sessão no painel dela e teste de novo.",
};

export const wahaUnreachableMessage =
  "Não foi possível consultar a sessão na sua WAHA. Confira a URL do servidor, a API key e o nome da sessão.";

/** Orientação para o status bruto da sessão (null quando não há status). */
export function wahaSessionGuidance(
  providerStatus: string | null | undefined,
): WahaSessionGuidance | null {
  if (!providerStatus) return null;
  return guidanceByStatus[providerStatus] ?? unknownGuidance;
}

const webhookFailureMessages: Record<string, string> = {
  invalid_config:
    "Faltam dados na conexão. Edite a conexão com a URL do servidor, a API key e a sessão da WAHA.",
  session_not_found:
    "A sessão não existe na sua WAHA. Crie a sessão no painel dela ou corrija o nome na conexão.",
  unauthorized:
    "A WAHA recusou a API key. Confira a chave na conexão (Editar).",
  engine_not_supported:
    "Essa sessão não usa o motor GoWS. Por enquanto o app só lê o motor GoWS.",
  masked_secrets:
    "A sua WAHA devolveu senhas mascaradas na configuração da sessão (proxy, HMAC ou cabeçalhos de outro webhook). Para não apagá-las, o app não gravou nada: use a configuração manual.",
  provider_error:
    "A WAHA recusou salvar o webhook. Tente de novo ou use a configuração manual.",
  unreachable:
    "Não foi possível alcançar o servidor da sua WAHA. Confira a URL e se o servidor está no ar, ou use a configuração manual.",
};

/** A API recusou (403): o usuário não pode gerenciar integrações. */
export const wahaWebhookForbiddenMessage =
  "Você não tem permissão para configurar o webhook desta conexão. Peça ao dono ou a um admin do workspace.";

export function wahaWebhookFailureMessage(
  reason: string | undefined,
  fallback?: string,
): string {
  return (
    (reason ? webhookFailureMessages[reason] : undefined) ??
    fallback ??
    "Não foi possível configurar o webhook na sua WAHA. Use a configuração manual."
  );
}
