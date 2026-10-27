import {
  isMetaAuthFailureConversionEvent,
  metaGraphErrorCodeFromResponse,
} from "./conversion-event-retry";

/**
 * Campos do erro da Meta que podem ser guardados e mostrados ao aluno.
 *
 * Só identificadores técnicos: code, error_subcode, type (categoria curta da
 * Meta, ex. "OAuthException") e fbtrace_id (identificador para o suporte da
 * Meta). message, error_user_title e error_user_msg nunca entram aqui, porque
 * podem repetir dados do lead (telefone, nome, e-mail).
 */
export type MetaCapiRejectionError = {
  code?: number;
  error_subcode?: number;
  type?: string;
  fbtrace_id?: string;
};

const META_ERROR_TYPE_PATTERN = /^[A-Za-z]{1,64}$/u;
const META_FBTRACE_ID_PATTERN = /^[A-Za-z0-9_+/=-]{1,256}$/u;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeInteger(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value === "string" && /^\d{1,9}$/u.test(value.trim()))
    return Number(value.trim());
  return undefined;
}

function safeFbtraceId(value: unknown): string | undefined {
  return typeof value === "string" && META_FBTRACE_ID_PATTERN.test(value)
    ? value
    : undefined;
}

/**
 * Lê o corpo de erro da Graph API ({"error":{...}}) e devolve só os campos
 * seguros. Corpo inválido, sem "error" ou com tudo fora do formato: null.
 */
export function pickMetaCapiRejectionError(
  body: unknown,
): MetaCapiRejectionError | null {
  const error = asRecord(asRecord(body)?.error);
  if (!error) return null;

  const code = metaGraphErrorCodeFromResponse({ error });
  const subcode = safeInteger(error.error_subcode);
  const type =
    typeof error.type === "string" && META_ERROR_TYPE_PATTERN.test(error.type)
      ? error.type
      : undefined;
  const fbtraceId = safeFbtraceId(error.fbtrace_id);

  const picked: MetaCapiRejectionError = {
    ...(code !== null ? { code } : {}),
    ...(subcode !== undefined ? { error_subcode: subcode } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(fbtraceId !== undefined ? { fbtrace_id: fbtraceId } : {}),
  };
  return Object.keys(picked).length ? picked : null;
}

/**
 * Lê o erro guardado em providerResponseSummary e o higieniza de novo (linhas
 * antigas ou de outros caminhos podem ter mais campos). O caminho dos
 * formulários Meta guarda o fbtrace_id fora de "error" (fbtraceId).
 */
export function storedMetaCapiRejectionError(
  providerResponseSummary: unknown,
): MetaCapiRejectionError | null {
  const summary = asRecord(providerResponseSummary);
  if (!summary) return null;
  const picked = pickMetaCapiRejectionError(summary);
  const topLevelTrace = safeFbtraceId(summary.fbtraceId);
  if (picked?.fbtrace_id || !topLevelTrace) return picked;
  return { ...(picked ?? {}), fbtrace_id: topLevelTrace };
}

type MetaRejectionReason = { reason: string; action: string };

const RECONNECT_ACTION =
  "Reconecte a Meta em Integrações (Trocar token no card do BM).";
const PERMISSION_ACTION =
  "No Gerenciador de Negócios, dê ao usuário do sistema (ou ao app) acesso ao conjunto de dados do pixel e confira se o token tem as permissões pedidas na conexão.";
const RATE_LIMIT_ACTION =
  "Aguarde alguns minutos; os próximos eventos devem passar sozinhos.";
const TEMPORARY_ACTION =
  "Aguarde alguns minutos; se repetir nos próximos eventos, leve o identificador para suporte ao suporte da Meta.";

/**
 * Subcódigos de login (códigos 190 e 102), da página "Graph API: Handling
 * Errors" (seção "Authentication Error Subcodes").
 */
const AUTH_SUBCODE_REASONS: Record<number, string> = {
  458: "o app não está mais autorizado na conta do Facebook que fez a conexão",
  459: "a conta do Facebook que fez a conexão precisa entrar em facebook.com e resolver um aviso de segurança",
  460: "a senha da conta do Facebook que fez a conexão foi alterada",
  463: "o token de acesso da Meta expirou",
  464: "a conta do Facebook que fez a conexão precisa entrar em facebook.com e confirmar a conta",
  467: "o token de acesso da Meta é inválido ou foi revogado",
};

/**
 * Motivos legíveis por código da Graph API. Fontes (todas oficiais da Meta):
 * - "Graph API: Handling Errors": 1, 2, 3, 4, 10, 17, 102, 190, 200-299, 341,
 *   368 e os subcódigos de login 458-467.
 * - "Graph API: Rate Limiting": 4, 17, 32, 613 e os limites por caso de uso
 *   80000-80014 (o SaaS trata a mesma faixa como limite em isRateLimitCode).
 * - "Marketing API: Error Reference": 100 (parâmetro inválido) e 294.
 * Subcódigos da família 2804xxx (parâmetros da CAPI) não estão documentados
 * pela Meta e por isso não têm texto próprio: caem no código 100 ou no texto
 * genérico com código, subcódigo e identificador.
 */
function metaRejectionReason(
  error: MetaCapiRejectionError,
): MetaRejectionReason | null {
  const code = error.code;
  if (code === undefined) return null;

  if (code === 190 || code === 102) {
    const subcodeReason =
      error.error_subcode !== undefined
        ? AUTH_SUBCODE_REASONS[error.error_subcode]
        : undefined;
    return {
      reason:
        subcodeReason ??
        "o login ou o token da conexão Meta expirou ou foi revogado",
      action: RECONNECT_ACTION,
    };
  }
  if (code === 10 || code === 3 || (code >= 200 && code <= 299))
    return {
      reason:
        code === 294
          ? "o token não tem a permissão de gerenciar anúncios (ads_management)"
          : "o token da conexão Meta não tem permissão sobre este conjunto de dados (pixel)",
      action: PERMISSION_ACTION,
    };
  if (
    code === 4 ||
    code === 17 ||
    code === 32 ||
    code === 341 ||
    code === 613 ||
    (code >= 80000 && code <= 80014)
  )
    return {
      reason: "o limite de chamadas da Meta foi atingido",
      action: RATE_LIMIT_ACTION,
    };
  if (code === 1 || code === 2)
    return {
      reason: "a Meta teve um erro temporário",
      action: TEMPORARY_ACTION,
    };
  if (code === 368)
    return {
      reason:
        "a Meta bloqueou temporariamente a conta por violação de política",
      action:
        "Aguarde; se continuar, confira os avisos da conta no Gerenciador de Negócios.",
    };
  if (code === 100)
    return {
      reason: "a Meta considerou um parâmetro do evento inválido",
      action:
        "Confira se o pixel e a página do destino são os mesmos do anúncio, se o identificador do clique (ctwa_clid) veio de um anúncio dessa página e se o evento tem menos de 7 dias.",
    };
  return null;
}

function codesLabel(error: MetaCapiRejectionError): string | null {
  if (error.code === undefined) return null;
  return error.error_subcode !== undefined
    ? `código ${error.code}, subcódigo ${error.error_subcode}`
    : `código ${error.code}`;
}

function traceSentence(error: MetaCapiRejectionError): string {
  return error.fbtrace_id
    ? ` Identificador para suporte da Meta: ${error.fbtrace_id}`
    : "";
}

/** Texto para o aluno a partir do erro já higienizado. */
export function metaCapiRejectionText(error: MetaCapiRejectionError): string {
  const codes = codesLabel(error);
  const known = metaRejectionReason(error);
  if (known && codes)
    return `A Meta recusou o evento (${codes}): ${known.reason}. ${known.action}${traceSentence(error)}`;
  if (codes)
    return `A Meta recusou o evento (${codes}).${traceSentence(error)}`;
  return `A Meta recusou o evento.${traceSentence(error)}`;
}

/**
 * Texto da recusa de um evento guardado. Falha de login (190/102) que o
 * "Reenviar bloqueados" reenvia mantém o texto de antes; sem nenhum dado da
 * Meta guardado, devolve null (quem chama usa o rótulo genérico).
 */
export const META_AUTH_FAILURE_RETRY_TEXT =
  "A Meta recusou por falha de login da conexão; reconecte a Meta e reenvie";

export function conversionEventRejectionText(event: {
  status: string;
  errorCode: string | null;
  sourceTrigger?: string | null;
  providerResponseSummary?: unknown;
}): string | null {
  if (event.errorCode !== "MetaCapiRejected") return null;
  if (isMetaAuthFailureConversionEvent(event))
    return META_AUTH_FAILURE_RETRY_TEXT;
  const error = storedMetaCapiRejectionError(event.providerResponseSummary);
  return error ? metaCapiRejectionText(error) : null;
}

/**
 * Motivos do resolvedor de rota e do pré-envio (errorMessage de
 * MissingMetaDestination) que podem aparecer na tela: nenhum contém token, ID
 * de lead ou dado pessoal. Texto fora desta lista continua escondido atrás do
 * rótulo genérico.
 */
const SAFE_DESTINATION_REASONS: Record<string, string> = {
  "Conta Meta inativa": "Conta Meta inativa",
  "Conta Meta ativa não encontrada": "Conta Meta ativa não encontrada",
  "Conexão Meta não encontrada": "Conexão Meta não encontrada",
  "Rota Meta não encontrada": "Rota Meta não encontrada",
  "Meta não conectada": "Meta não conectada",
  "Nenhum destino de conversão foi associado a esta conta Meta":
    "Nenhum destino de conversão foi associado a esta conta Meta",
  "O destino de conversão desta conta precisa ser validado":
    "O destino de conversão desta conta precisa ser validado",
  "O destino explícito difere da rota do anúncio":
    "O destino explícito difere da rota do anúncio",
  "Destino não autorizado para esta conta Meta":
    "Destino não autorizado para esta conta Meta",
  "O destino legado precisa ser validado":
    "O destino legado precisa ser validado",
  "A conta atribuída ao evento não possui uma rota Meta ativa":
    "A conta atribuída ao evento não possui uma rota Meta ativa",
  "Não foi possível determinar com segurança qual conexão Meta deve enviar este evento":
    "Não foi possível determinar com segurança qual conexão Meta deve enviar este evento",
  "A conexão Meta desta conta está pausada ou requer validação":
    "A conexão Meta desta conta está pausada ou requer validação",
  "O token desta conexão Meta está pausado ou requer validação":
    "O token desta conexão Meta está pausado ou requer validação",
  "Não foi possível abrir a credencial Meta armazenada":
    "Não foi possível abrir a credencial Meta armazenada",
  "A sincronização configurada exige a conta e a conexão Meta exatas":
    "A sincronização configurada exige a conta e a conexão Meta exatas",
  "Não foi possível resolver a rota Meta deste evento":
    "Não foi possível resolver a rota Meta deste evento",
  "Rota Kommo autorizada indisponível": "Rota Kommo autorizada indisponível",
  "Rota Pipedrive autorizada indisponível":
    "Rota Pipedrive autorizada indisponível",
  "Rota Meta normalizada indisponível": "Rota Meta normalizada indisponível",
  "Meta CAPI pixel id or page id not configured":
    "Pixel ou página do destino Meta não configurados",
  "CTWA page/pixel intent mismatch":
    "O pixel e a página autorizados para o clique do anúncio não conferem com o destino",
  "CTWA authorization unavailable before dispatch":
    "A autorização do destino do anúncio expirou ou foi revogada antes do envio",
  "CTWA destination or context revoked before dispatch":
    "O destino ou o contexto do anúncio foi revogado antes do envio",
  "CTWA destination unavailable": "Destino do anúncio indisponível",
  "CTWA credential revoked": "A credencial Meta do destino foi revogada",
  "CTWA authorization expired": "A autorização Meta do destino expirou",
  "CTWA access token unavailable": "Token Meta do destino indisponível",
};

export function safeMetaDestinationReason(
  errorMessage: string | null | undefined,
): string | null {
  const key = errorMessage?.trim();
  return key ? (SAFE_DESTINATION_REASONS[key] ?? null) : null;
}
