/**
 * Conexões WhatsApp do próprio aluno (WhatsappInstance) que viram uma ponte
 * InboundWebhookConnection + InboundWebhookChannel para entrar nas regras de
 * frase da equipe: Uazapi (uazapi_byo, conexão "uazapi") e WAHA (GoWS,
 * conexão "waha").
 *
 * O que vale para as duas: o número é cadastrado automaticamente pela ponte,
 * o destino Meta é resolvido por anúncio no envio (sem rota salva no canal),
 * o número só envia enquanto a conexão WhatsApp estiver ativa e o telefone do
 * canal começa com um marcador (sessão/instância) até o número real chegar.
 */
export const BRIDGED_WHATSAPP_PROVIDERS = ["uazapi", "waha"] as const;

export type BridgedWhatsappProvider =
  (typeof BRIDGED_WHATSAPP_PROVIDERS)[number];

export function isBridgedWhatsappProvider(
  provider: string | null | undefined,
): provider is BridgedWhatsappProvider {
  return (
    typeof provider === "string" &&
    (BRIDGED_WHATSAPP_PROVIDERS as readonly string[]).includes(provider)
  );
}

/** Release do parser usada pela ponte de cada provedor. */
export const BRIDGE_PARSER_VERSION: Record<BridgedWhatsappProvider, string> = {
  uazapi: "v1",
  // A WAHA usa a release waha/v2 (GoWS) certificada pela migration
  // 20261022130100_waha_parser_release: a mesma do receptor.
  waha: "v2",
};

/** Evento durável gravado junto com a ponte (lido pela ativação automática). */
export const BRIDGE_PROVISIONED_EVENT: Record<BridgedWhatsappProvider, string> = {
  uazapi: "inbound_webhook.uazapi_bridge_provisioned",
  waha: "inbound_webhook.waha_bridge_provisioned",
};
