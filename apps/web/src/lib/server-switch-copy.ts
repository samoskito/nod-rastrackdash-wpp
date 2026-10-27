/**
 * 1.3.1: orientação exata quando um interruptor da API está desligado.
 * Exceção aprovada pelo Samuel à regra "sem nome de variável na tela": aqui o
 * nome é justamente o que o aluno (ou a IA dele) precisa procurar no Dokploy.
 * Caso real: INBOUND_CONVERSION_PRODUCTION_ENABLED=false copiado do
 * .env.example antigo.
 */

/** Envio de conversões desligado (INBOUND_CONVERSION_PRODUCTION_ENABLED=false). */
export const CONVERSION_SENDING_OFF_FIX =
  "No Dokploy, no serviço da API, troque INBOUND_CONVERSION_PRODUCTION_ENABLED=false por true (ou apague a linha), confira se INBOUND_CONVERSION_RULES_ENABLED=true e faça o deploy da API.";

/** Recebimento de webhooks ou regras de conversão desligados. */
export const CONVERSION_RULES_OFF_FIX =
  "No Dokploy, no serviço da API, defina INBOUND_WEBHOOKS_ENABLED=true e INBOUND_CONVERSION_RULES_ENABLED=true e faça o deploy da API.";

/** Envio automático dos webhooks de entrada desligado. */
export const WEBHOOK_PRODUCTION_OFF_FIX =
  "No Dokploy, no serviço da API, defina INBOUND_WEBHOOK_PRODUCTION_ENABLED=true e faça o deploy da API.";
