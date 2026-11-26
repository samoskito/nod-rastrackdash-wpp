import { createHash } from "node:crypto";
import {
  conversionEventCarriesValue,
  conversionEventDedupeMode,
  conversionEventNameSchema,
  conversionEventRequiresValue,
  normalizeCurrencyCode,
  type ConversionEventNameDto,
  type CurrencyCode,
  type WebhookFamilyProvider,
} from "@wpptrack/shared";
import {
  normalizePhoneIdentity,
  phoneIdentityKey,
} from "../../../common/phone/phone-identity";
import { boundedString } from "../inbound-webhook-delivery-identity";

/**
 * Webhook / n8n `automation-v1`: o n8n, o painel de atendimento ou o robo SDR
 * chama a URL de UMA regra (uma URL por regra; o segredo vai na URL). O evento
 * vem da regra; o corpo so identifica o lead. Contrato publicado em
 * docs/setup/n8n/README.md.
 *
 * Corpo JSON (puro ou embrulhado como item do n8n: `[ { headers, body } ]`,
 * `{ body }`, `{ json }` ou lista de um item):
 * - `phone` (obrigatorio): "55" + DDD + numero; a equivalencia 55/9o digito
 *   fica no resolvedor de lead.
 * - `value` (em reais, nunca centavos) + `currency`: so em evento com valor,
 *   quando a regra usa o valor recebido.
 * - `phone_number_id` (opcional): numero que atendeu; so desempata o numero de
 *   origem do lead (conversion-rules/webhook-lead-routing.ts).
 * - `message_id` (opcional): identifica a ocorrencia; reenvio com o mesmo id
 *   nunca conta de novo e outro id e outra ocorrencia.
 * Nao pede ctwa_clid, pixel nem token da Meta: o clique ja esta no lead.
 *
 * Ocorrencia (externalExecutionKey; a chave de entrada ainda inclui a URL da
 * regra):
 * - evento "uma vez por lead" (Lead qualificado...): lead, sem janela nem id;
 * - com `message_id`: lead + id, sem janela (duas compras no mesmo dia com ids
 *   diferentes sao duas compras);
 * - sem `message_id`: lead + chegada, com `fingerprint` (lead, valor e moeda).
 *   A mesma chamada de novo em ate 12h e reenvio (mesma regra da compra do ROI
 *   Chat): webhook-purchase-dedupe.ts.
 *
 * Sem dependencia de outra integracao: este arquivo e portavel sozinho.
 */
export const WEBHOOK_AUTOMATION_V1_SCHEMA = "wpptrack.webhook.automation.v1";
export const WEBHOOK_AUTOMATION_V1_PARSER_VERSION = "automation-v1";
export const WEBHOOK_AUTOMATION_V1_INVALID =
  "webhook_automation_v1_invalid_payload" as const;
export const WEBHOOK_PHONE_MISSING = "webhook_phone_missing" as const;
/** "Usar o valor recebido" sem valor e sem valor fixo na regra. */
export const WEBHOOK_VALUE_MISSING = "webhook_value_missing" as const;
/** "Usar o valor recebido" com valor/moeda invalidos e sem valor fixo. */
export const WEBHOOK_VALUE_INVALID = "webhook_value_invalid" as const;
/** Prefixo da chave de uma ocorrencia identificada por `message_id`. */
export const WEBHOOK_MESSAGE_KEY_PREFIX = "webhook-message:";
/** Sem `message_id`: a mesma chamada de novo dentro desta janela e reenvio. */
export const WEBHOOK_REPEAT_WINDOW_SECONDS = 12 * 60 * 60;

/** R$ 100 milhoes: acima disso o valor e tratado como invalido. */
const MAX_VALUE_CENTS = 10_000_000_000;
/** Expressao do n8n que nao foi resolvida: nao e um id. */
const UNRESOLVED_TEXT = /^(?:undefined|null|\[object Object\]|\{\{.*\}\})$/iu;

export type WebhookReceivedValue =
  | { status: "valid"; valueCents: number; currency: CurrencyCode | null }
  | { status: "missing" | "invalid" };

export type WebhookRuleValueSource = "received" | "fixed";

/** Uma chamada lida para UMA regra: o evento e o valor vem dela. */
export type ParsedWebhookRuleAutomation = {
  /** Webhook / n8n, ou a XMAX CRM (mesmo modelo, outro corpo). */
  provider: WebhookFamilyProvider;
  automation: "crm_automation";
  eventName: ConversionEventNameDto;
  /** Telefone do lead, digitos com DDI (PII; nunca vai para log). */
  phone: string;
  phoneCandidates: string[];
  /** Id do numero que atendeu, como veio (nao e PII do lead). */
  phoneNumberId: string | null;
  hasMessageId: boolean;
  receivedValue: WebhookReceivedValue;
  /** Valor observado para esta regra (null = o valor da regra, se houver). */
  valueCents: number | null;
  currency: CurrencyCode | null;
  /** Chegada da chamada (nunca no futuro). */
  occurredAt: Date;
  /** Identidade do reenvio sem `message_id` (digest, sem PII); null em evento uma vez por lead. */
  fingerprint: string | null;
  externalExecutionKey: string;
  /** XMAX CRM: a oportunidade lida (sem dados do contato). */
  xmax?: {
    opportunityId: string;
    /** Etapa_oportunidade: so para consulta, nunca decide o evento. */
    stage: string | null;
    contactLinked: boolean;
  };
};

export type WebhookForRuleParseResult =
  | { ok: true; value: ParsedWebhookRuleAutomation }
  | {
      ok: false;
      errorCode:
        | typeof WEBHOOK_AUTOMATION_V1_INVALID
        | typeof WEBHOOK_PHONE_MISSING
        | typeof WEBHOOK_VALUE_MISSING
        | typeof WEBHOOK_VALUE_INVALID;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function looksLikeWebhookBody(record: Record<string, unknown>): boolean {
  return (
    "phone" in record ||
    "value" in record ||
    "message_id" in record ||
    "phone_number_id" in record
  );
}

/**
 * Corpo puro ou embrulhado como item do n8n: `[ { headers, body } ]`,
 * `[ { json } ]`, `{ body }`, `{ json }`, `{ json: { body } }` ou lista de um
 * item. Lista com mais de um item nao e adivinhada: fica invalida.
 */
export function unwrapWebhookBody(
  payload: unknown,
): Record<string, unknown> | null {
  let current: unknown = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (Array.isArray(current)) {
      if (current.length !== 1) return null;
      current = current[0];
      continue;
    }
    const record = asRecord(current);
    if (!record) return null;
    if (looksLikeWebhookBody(record)) return record;
    const inner = asRecord(record.body) ?? asRecord(record.json);
    if (!inner) return null;
    current = inner;
  }
  const record = asRecord(current);
  return record && looksLikeWebhookBody(record) ? record : null;
}

/** Texto: strings (sem espacos nas pontas, vazio = null) e inteiros seguros. */
function text(value: unknown, max: number): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value)
      ? boundedString(String(value), max)
      : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || UNRESOLVED_TEXT.test(trimmed)) return null;
  return boundedString(trimmed, max);
}

/** Telefone do lead: digitos com DDI. */
export function webhookPhone(value: unknown): string | null {
  const raw =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : "";
  if (!raw || raw.length > 40) return null;
  const digits = raw.replace(/^00/u, "").replace(/\D/gu, "");
  return normalizePhoneIdentity(digits) ?? null;
}

/**
 * `value` em REAIS (2000 = R$ 2.000,00): numero ou texto decimal simples
 * ("2000", "2000.5", "2000,50"). Separador de milhar, negativo, zero e valores
 * absurdos sao invalidos (nunca adivinhados). `currency` precisa ser um codigo
 * suportado; ausente = a moeda da regra ou da conta (decidida adiante).
 */
export function webhookReceivedValue(
  value: unknown,
  currency: unknown,
): WebhookReceivedValue {
  if (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return { status: "missing" };
  }
  let amount: number | null = null;
  if (typeof value === "number") {
    amount = Number.isFinite(value) ? value : null;
  } else if (typeof value === "string") {
    const normalized = value.trim();
    amount = /^\d{1,12}(?:[.,]\d{1,2})?$/u.test(normalized)
      ? Number(normalized.replace(",", "."))
      : null;
  }
  if (amount === null || !(amount > 0)) return { status: "invalid" };
  const valueCents = Math.round(amount * 100);
  if (valueCents <= 0 || valueCents > MAX_VALUE_CENTS) {
    return { status: "invalid" };
  }
  const rawCurrency =
    typeof currency === "string" && currency.trim() ? currency : null;
  const code = rawCurrency ? normalizeCurrencyCode(rawCurrency) : null;
  if (rawCurrency && !code) return { status: "invalid" };
  return { status: "valid", valueCents, currency: code };
}

function digest(parts: readonly (string | number | null)[]): string {
  return createHash("sha256")
    .update(JSON.stringify([WEBHOOK_AUTOMATION_V1_SCHEMA, ...parts]), "utf8")
    .digest("hex");
}

/**
 * Guardado em ConversionRule.defaultItems como `{ webhookValueSource }` (a
 * mesma coluna Json das outras origens). Ausente = "received".
 */
export function webhookRuleConfig(source: WebhookRuleValueSource): {
  webhookValueSource: WebhookRuleValueSource;
} {
  return { webhookValueSource: source };
}

export function readWebhookValueSource(value: unknown): WebhookRuleValueSource {
  return asRecord(value)?.webhookValueSource === "fixed" ? "fixed" : "received";
}

/**
 * Le uma chamada para a sua regra (ingestao, reavaliacao e conferencia da
 * producao passam por aqui, entao sempre concordam). `receivedAt` precisa ser a
 * PRIMEIRA chegada da entrega, para a chave ficar estavel. Evento com valor
 * obrigatorio cuja regra usa o valor recebido recusa a chamada sem valor valido
 * quando a regra nao tem valor fixo de reserva (motivo claro no recibo).
 */
export function parseWebhookForRule(
  payload: unknown,
  receivedAt: Date,
  rule: {
    eventName: string;
    defaultValueCents: number | null;
    defaultItems: unknown;
  },
): WebhookForRuleParseResult {
  try {
    const eventName = conversionEventNameSchema.parse(rule.eventName);
    const body = unwrapWebhookBody(payload);
    if (!body) return { ok: false, errorCode: WEBHOOK_AUTOMATION_V1_INVALID };
    const phone = webhookPhone(body.phone);
    if (!phone) return { ok: false, errorCode: WEBHOOK_PHONE_MISSING };

    const source = readWebhookValueSource(rule.defaultItems);
    const receivedValue = webhookReceivedValue(body.value, body.currency);
    const observed =
      conversionEventCarriesValue(eventName) &&
      source === "received" &&
      receivedValue.status === "valid"
        ? { valueCents: receivedValue.valueCents, currency: receivedValue.currency }
        : { valueCents: null, currency: null };
    if (
      conversionEventRequiresValue(eventName) &&
      observed.valueCents === null &&
      !rule.defaultValueCents
    ) {
      return {
        ok: false,
        errorCode:
          receivedValue.status === "invalid" && source === "received"
            ? WEBHOOK_VALUE_INVALID
            : WEBHOOK_VALUE_MISSING,
      };
    }

    // A chave nao muda entre as formas 55/9o digito do mesmo telefone.
    const identity = phoneIdentityKey(phone) ?? phone;
    const messageId = text(body.message_id, 255);
    const now = Date.now();
    const arrival = Number.isFinite(receivedAt.getTime())
      ? Math.min(receivedAt.getTime(), now)
      : now;
    const oncePerLead = conversionEventDedupeMode(eventName) === "lifetime";
    const externalExecutionKey = oncePerLead
      ? `webhook-automation:${digest(["lead", identity])}`
      : messageId
        ? `${WEBHOOK_MESSAGE_KEY_PREFIX}${digest(["message", identity, messageId])}`
        : `webhook-automation:${digest(["arrival", identity, new Date(arrival).toISOString()])}`;

    return {
      ok: true,
      value: {
        provider: "webhook",
        automation: "crm_automation",
        eventName,
        phone,
        phoneCandidates: [phone],
        phoneNumberId: text(body.phone_number_id, 64),
        hasMessageId: messageId !== null,
        receivedValue,
        ...observed,
        occurredAt: new Date(arrival),
        fingerprint: oncePerLead
          ? null
          : digest([
              "fingerprint",
              identity,
              observed.valueCents,
              observed.currency,
            ]),
        externalExecutionKey,
      },
    };
  } catch {
    return { ok: false, errorCode: WEBHOOK_AUTOMATION_V1_INVALID };
  }
}
