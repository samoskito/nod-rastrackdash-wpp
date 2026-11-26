import { createHash } from "node:crypto";
import {
  conversionEventNameSchema,
  conversionEventRequiresValue,
  type CurrencyCode,
} from "@wpptrack/shared";
import { boundedString } from "../inbound-webhook-delivery-identity";
import {
  webhookPhone,
  type ParsedWebhookRuleAutomation,
} from "../webhook/webhook-automation-v1.parser";

/**
 * XMAX CRM `automation-v1`: a automacao "a oportunidade entrou na etapa X" do
 * CRM da XMAX chama a URL de UMA regra (uma URL por evento; o token vai na URL
 * ou no header). Porte do leitor do SaaS (apps/api/src/xmax/
 * xmax-opportunity.parser.ts, docs/integrations/xmax-crm-opportunity.md), no
 * modelo do Webhook / n8n desta edicao: o evento vem da regra, o corpo so
 * identifica a oportunidade e o lead.
 *
 * Campos lidos:
 * - `ID_oportunidade` (obrigatorio): a oportunidade;
 * - `Telefone_oportunidade`: o telefone do lead; vazio = o `contact_number`
 *   do primeiro contato de `Contatos_oportunidade` (que pode vir como texto
 *   JSON);
 * - `Contatos_oportunidade[0].contact_id`: opcional, so registro;
 * - `Etapa_oportunidade`: so para consulta; NUNCA decide o evento.
 * `Queue_id` / `Queue_id_v2` sao ignorados (a automacao fica presa a uma
 * fila). E-mail, endereco, documento e os demais campos nunca sao lidos.
 *
 * Ocorrencia: uma vez por oportunidade e evento (a chave e a oportunidade +
 * o evento da regra, sem janela nem horario). Eventos uma vez por lead (Lead,
 * Lead qualificado) continuam uma vez por lead pela trava vitalicia.
 *
 * A XMAX nao cria lead: so conta o lead pago (clique em anuncio) que ja chegou
 * por uma conexao de WhatsApp do aluno (mesma resolucao do Webhook / n8n).
 */
export const XMAX_AUTOMATION_V1_SCHEMA = "wpptrack.xmax.automation.v1";
export const XMAX_AUTOMATION_V1_PARSER_VERSION = "automation-v1";
export const XMAX_AUTOMATION_V1_INVALID =
  "xmax_automation_v1_invalid_payload" as const;
export const XMAX_MISSING_OPPORTUNITY_ID = "xmax_missing_opportunity_id" as const;
export const XMAX_MISSING_PHONE = "xmax_missing_phone" as const;
/** Evento que exige valor numa regra sem valor fixo. */
export const XMAX_VALUE_MISSING = "xmax_value_missing" as const;
/** Prefixo da chave de uma ocorrencia (oportunidade + evento). */
export const XMAX_OPPORTUNITY_KEY_PREFIX = "xmax-opportunity:";

export type XmaxForRuleParseResult =
  | { ok: true; value: ParsedWebhookRuleAutomation }
  | {
      ok: false;
      errorCode:
        | typeof XMAX_AUTOMATION_V1_INVALID
        | typeof XMAX_MISSING_OPPORTUNITY_ID
        | typeof XMAX_MISSING_PHONE
        | typeof XMAX_VALUE_MISSING;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Texto: strings (sem espacos nas pontas, vazio = null) e inteiros seguros. */
function text(value: unknown, max: number): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? boundedString(String(value), max) : null;
  }
  return boundedString(value, max);
}

/**
 * O corpo como a XMAX envia, ou embrulhado por uma captura/encaminhamento do
 * n8n (`[ { headers, body } ]`, `{ body }`, `{ json }`).
 */
export function unwrapXmaxBody(payload: unknown): Record<string, unknown> | null {
  let current: unknown = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (Array.isArray(current)) {
      if (current.length !== 1) return null;
      current = current[0];
      continue;
    }
    const record = asRecord(current);
    if (!record) return null;
    if ("ID_oportunidade" in record) return record;
    const inner = asRecord(record.body) ?? asRecord(record.json);
    if (!inner) return record;
    current = inner;
  }
  return asRecord(current);
}

function firstContact(value: unknown): Record<string, unknown> | null {
  let list: unknown = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return Array.isArray(list) ? asRecord(list[0]) : null;
}

/**
 * Valor do evento: por enquanto SEMPRE o valor fixo da regra (a XMAX ainda nao
 * mandou um campo de valor). Quando houver um "campo do valor", ele entra so
 * aqui. null = o valor da regra (decidido adiante, como no Webhook / n8n).
 */
export function xmaxObservedValue(
  _body: Record<string, unknown>,
  _rule: { defaultValueCents: number | null },
): { valueCents: number | null; currency: CurrencyCode | null } {
  return { valueCents: null, currency: null };
}

function digest(parts: readonly (string | number | null)[]): string {
  return createHash("sha256")
    .update(JSON.stringify([XMAX_AUTOMATION_V1_SCHEMA, ...parts]), "utf8")
    .digest("hex");
}

/**
 * Le uma chamada da XMAX para a sua regra (ingestao, reavaliacao e conferencia
 * da producao passam por aqui, entao sempre concordam). `receivedAt` precisa
 * ser a PRIMEIRA chegada da entrega.
 */
export function parseXmaxForRule(
  payload: unknown,
  receivedAt: Date,
  rule: {
    eventName: string;
    defaultValueCents: number | null;
    defaultItems?: unknown;
  },
): XmaxForRuleParseResult {
  try {
    const eventName = conversionEventNameSchema.parse(rule.eventName);
    const body = unwrapXmaxBody(payload);
    if (!body) return { ok: false, errorCode: XMAX_AUTOMATION_V1_INVALID };
    const opportunityId = text(body.ID_oportunidade, 128);
    if (!opportunityId) {
      return {
        ok: false,
        errorCode:
          "ID_oportunidade" in body
            ? XMAX_MISSING_OPPORTUNITY_ID
            : XMAX_AUTOMATION_V1_INVALID,
      };
    }
    const contact = firstContact(body.Contatos_oportunidade);
    const phone =
      webhookPhone(body.Telefone_oportunidade) ??
      webhookPhone(contact?.contact_number);
    if (!phone) return { ok: false, errorCode: XMAX_MISSING_PHONE };

    const observed = xmaxObservedValue(body, rule);
    if (
      conversionEventRequiresValue(eventName) &&
      observed.valueCents === null &&
      !rule.defaultValueCents
    ) {
      return { ok: false, errorCode: XMAX_VALUE_MISSING };
    }

    const now = Date.now();
    const arrival = Number.isFinite(receivedAt.getTime())
      ? Math.min(receivedAt.getTime(), now)
      : now;
    // Uma vez por oportunidade e evento: a etapa e o horario nao entram.
    const externalExecutionKey = `${XMAX_OPPORTUNITY_KEY_PREFIX}${digest([
      "opportunity",
      opportunityId,
      eventName,
    ])}`;

    return {
      ok: true,
      value: {
        provider: "xmax",
        automation: "crm_automation",
        eventName,
        phone,
        phoneCandidates: [phone],
        phoneNumberId: null,
        // A oportunidade identifica a ocorrencia (como o message_id).
        hasMessageId: true,
        receivedValue: { status: "missing" },
        ...observed,
        occurredAt: new Date(arrival),
        fingerprint: null,
        externalExecutionKey,
        xmax: {
          opportunityId,
          stage: text(body.Etapa_oportunidade, 120),
          contactLinked: text(contact?.contact_id, 128) !== null,
        },
      },
    };
  } catch {
    return { ok: false, errorCode: XMAX_AUTOMATION_V1_INVALID };
  }
}
