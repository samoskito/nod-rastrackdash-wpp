import { isXmaxProvider, type WebhookFamilyProvider } from "@wpptrack/shared";
import {
  WEBHOOK_AUTOMATION_V1_PARSER_VERSION,
  parseWebhookForRule,
  type WebhookForRuleParseResult,
} from "./webhook-automation-v1.parser";
import {
  XMAX_AUTOMATION_V1_PARSER_VERSION,
  parseXmaxForRule,
  type XmaxForRuleParseResult,
} from "../xmax/xmax-automation-v1.parser";

/**
 * Origens no modelo do Webhook / n8n (URL da regra, todos os numeros, uma
 * regra por evento, so lead pago de qualquer conexao): o Webhook / n8n e a
 * XMAX CRM. So o leitor do corpo muda; ingestao, observacao e producao leem
 * a chamada por aqui, entao sempre concordam.
 */
export function webhookFamilyParserVersion(provider: WebhookFamilyProvider): string {
  return isXmaxProvider(provider)
    ? XMAX_AUTOMATION_V1_PARSER_VERSION
    : WEBHOOK_AUTOMATION_V1_PARSER_VERSION;
}

export function parseWebhookFamilyForRule(
  provider: WebhookFamilyProvider,
  payload: unknown,
  receivedAt: Date,
  rule: {
    eventName: string;
    defaultValueCents: number | null;
    defaultItems: unknown;
  },
): WebhookForRuleParseResult | XmaxForRuleParseResult {
  return isXmaxProvider(provider)
    ? parseXmaxForRule(payload, receivedAt, rule)
    : parseWebhookForRule(payload, receivedAt, rule);
}
