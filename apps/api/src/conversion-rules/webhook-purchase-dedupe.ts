import { createHash } from "node:crypto";
import {
  conversionEventDedupeMode,
  type ProviderConversionDecisionOccurrenceDto,
} from "@wpptrack/shared";
import {
  WEBHOOK_MESSAGE_KEY_PREFIX,
  WEBHOOK_REPEAT_WINDOW_SECONDS,
} from "../inbound-webhooks/providers/webhook/webhook-automation-v1.parser";
import { XMAX_OPPORTUNITY_KEY_PREFIX } from "../inbound-webhooks/providers/xmax/xmax-automation-v1.parser";
import type { ProviderConversionDecisionInput } from "./provider-conversion-decision.types";

/**
 * Janela de uma ocorrencia com `message_id`: a chave ja identifica a mensagem,
 * a janela so limita a busca. Bem maior que os 7 dias aceitos pela Meta.
 */
const WEBHOOK_MESSAGE_WINDOW_SECONDS = 30 * 24 * 60 * 60;

/**
 * Dedupe de negocio dos eventos com janela (Compra...) de uma regra Webhook /
 * n8n. A janela historica de 24h "mesmo lead, mesmo numero" perderia uma
 * segunda compra de verdade no mesmo dia, entao nao vale aqui:
 *
 * - com `message_id`: cada id e uma ocorrencia. Duas compras no mesmo dia com
 *   ids diferentes vao as duas; o mesmo id nunca vai de novo;
 * - sem `message_id`: nao ha como separar uma compra igual de um reenvio. Vale
 *   a regra ja decidida para o ROI Chat: mesmo lead, mesmo numero, mesmo valor
 *   e moeda em ate 12h e a mesma compra; outro valor ou depois de 12h e outra.
 *
 * Eventos uma vez por lead (Lead qualificado) ficam fora: seguem a chave
 * vitalicia e a trava de lead-lifetime-conversion-guard.ts.
 *
 * XMAX CRM: a oportunidade + o evento identificam a ocorrencia (como o
 * `message_id`): a mesma oportunidade no mesmo evento nunca vai de novo.
 */
export function webhookDedupePolicy(
  input: ProviderConversionDecisionInput,
): NonNullable<
  ProviderConversionDecisionOccurrenceDto["businessDedupePolicy"]
> | null {
  if (
    input.occurrence.source !== "automation" ||
    (input.occurrence.provider !== "webhook" &&
      input.occurrence.provider !== "xmax") ||
    conversionEventDedupeMode(input.rule.eventName) === "lifetime" ||
    input.leadResolution.status !== "resolved"
  ) {
    return null;
  }
  const base = [
    input.rule.eventName,
    input.occurrence.workspaceId,
    input.occurrence.connectionId,
    input.occurrence.channelId ?? "unresolved-channel",
    input.leadResolution.lead.id,
  ];
  if (
    input.occurrence.occurrenceKey.startsWith(WEBHOOK_MESSAGE_KEY_PREFIX) ||
    input.occurrence.occurrenceKey.startsWith(XMAX_OPPORTUNITY_KEY_PREFIX)
  ) {
    return {
      mode: "rolling_window",
      scopeKey: [...base, input.occurrence.occurrenceKey].join(":"),
      windowSeconds: WEBHOOK_MESSAGE_WINDOW_SECONDS,
    };
  }
  return {
    mode: "rolling_window",
    scopeKey: [
      ...base,
      `value:${input.occurrence.observedValueCents ?? "none"}`,
      `currency:${input.occurrence.observedCurrency ?? "none"}`,
    ].join(":"),
    windowSeconds: WEBHOOK_REPEAT_WINDOW_SECONDS,
  };
}

/**
 * Identidade Meta de um evento com janela: vem da ocorrencia, nao da execucao,
 * entao o mesmo `message_id` gera o mesmo event_id mesmo se a regra mudar de
 * conexao ancora entre o envio e o reenvio. A Meta tambem deduplica.
 */
export function webhookAutomationConversionIdentity(input: {
  workspaceId: string;
  eventName: string;
  occurrenceKey: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "webhook-automation-v1",
        input.workspaceId,
        input.eventName,
        input.occurrenceKey,
      ]),
    )
    .digest("hex");
}

/** Webhook / n8n: duplicate of a window event, in the words of the receipt. */
export const WEBHOOK_EVENT_REPEATED_REASON = "webhook_event_repeated";
