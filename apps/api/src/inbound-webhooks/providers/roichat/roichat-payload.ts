import { createHash } from "node:crypto";
import { normalizeCurrencyCode, type CurrencyCode } from "@wpptrack/shared";
import {
  normalizePhoneIdentity,
  normalizePhoneIdentityWithCountry,
  phoneIdentityKey,
} from "../../../common/phone/phone-identity";
import { boundedString } from "../inbound-webhook-delivery-identity";

/**
 * ROI Chat (WhatsApp API Oficial) — contrato unico de entrada e compra.
 *
 * Cada numero do cliente tem a PROPRIA URL nossa (uma conexao por numero), e
 * a MESMA URL recebe:
 *  - a entrada do lead (CTWA): dados do anuncio e do usuario, SEM
 *    `event_name`, `valor_venda` e `moeda`;
 *  - a compra: o mesmo corpo + `event_name: "Purchase"`, `valor_venda` e
 *    `moeda`.
 *
 * O leitor e tolerante: qualquer campo pode faltar (so o telefone do lead e
 * obrigatorio). `event_id` do ROI Chat (sempre o telefone) e IGNORADO: o
 * event_id enviado a Meta e gerado pela plataforma. Campos pessoais (nome,
 * telefone) nunca entram em resumo persistido; o corpo inteiro so fica no
 * payload cifrado da entrega.
 */

export const ROICHAT_PROVIDER = "roichat" as const;

/** Tolerancia de relogio antes de um horario contar como "no futuro". */
export const ROICHAT_FUTURE_SKEW_MS = 5 * 60_000;

const CONTACT_NAME_MAXIMUM_LENGTH = 120;
const TEXT_MAXIMUM_LENGTH = 2_048;
const URL_MAXIMUM_LENGTH = 2_048;

export type RoichatPayloadKind =
  /** Sem event_name: entrada do lead (CTWA ou nao). */
  | "entry"
  /** event_name = Purchase (ou "compra"). */
  | "purchase"
  /** Outro event_name: recebido e ignorado. */
  | "other_event";

export type RoichatAd = {
  sourceUrl: string | null;
  sourceType: string | null;
  /** `body`: texto do anuncio. */
  description: string | null;
  /** `headline`: titulo do anuncio. */
  title: string | null;
  mediaType: string | null;
  /** `video_url` (ou `image_url`). */
  mediaUrl: string | null;
  thumbnailUrl: string | null;
};

export type RoichatEventTime = {
  occurredAt: Date;
  /**
   * payload  = `event_time` do ROI Chat (segundos; 13 digitos = ms);
   * received = sem `event_time` (ou invalido): horario do recebimento;
   * future_capped = `event_time` depois do recebimento (+5 min): recebimento.
   */
  source: "payload" | "received" | "future_capped";
};

export type ParsedRoichatPayload = {
  kind: RoichatPayloadKind;
  /** event_name como veio (normalizado), so para auditoria. */
  eventName: string | null;
  /** Telefone do lead (digitos, E.164 sem +). PII. */
  phone: string;
  /** Nome exibido do lead (PII, so para o cadastro do lead). */
  contactName: string | null;
  ctwaClid: string | null;
  /** `source_id`: id do anuncio. */
  adId: string | null;
  ad: RoichatAd | null;
  time: RoichatEventTime;
  /** `valor_venda` em centavos (null = ausente ou ilegivel). */
  valueCents: number | null;
  /** `moeda` suportada (BRL/USD/EUR); null = ausente. */
  currency: CurrencyCode | null;
  /**
   * `valor_venda` ou `moeda` PRESENTE mas ilegivel/nao suportada (ex.:
   * "abc", "0,00", "MXN"): a compra e recusada como invalida, nunca enviada
   * com outro valor ou convertida. Ausente nao e erro (reserva da regra).
   */
  moneyInvalid: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const knownFields = [
  "anuncio",
  "telefone",
  "phone",
  "ctwa_clid",
  "source_id",
  "event_name",
  "nome",
];

/** Direct body, a single-item array (n8n) or `{ body: {...} }`. */
export function unwrapRoichatBody(
  payload: unknown,
): Record<string, unknown> | null {
  let candidate: unknown = payload;
  if (Array.isArray(candidate)) {
    if (candidate.length !== 1) return null;
    candidate = candidate[0];
  }
  const record = asRecord(candidate);
  if (!record) return null;
  const hasKnown = knownFields.some((field) => field in record);
  const nested = asRecord(record.body);
  if (!hasKnown && nested) return nested;
  return record;
}

function text(value: unknown, maximumLength: number): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return boundedString(String(value), maximumLength);
  }
  if (typeof value !== "string") return null;
  // Ad copy may carry line breaks: keep them readable, never control chars.
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/gu, " ")
    .replace(/\r\n?/gu, "\n")
    .trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, maximumLength);
}

function httpsUrl(value: unknown): string | null {
  const url = boundedString(value, URL_MAXIMUM_LENGTH);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? url
      : null;
  } catch {
    return null;
  }
}

/** Token as supplied (never trimmed into another identifier). */
function token(value: unknown, maximumLength: number): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > maximumLength ||
    /[\s\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

/**
 * Lead phone. With an explicit international prefix (`+` or `00`) the digits
 * are used as received (foreign numbers are never given a 55). Without it, a
 * Brazilian national number (DDD + number) receives 55, like the rest of the
 * platform; the 9th digit equivalence stays in the lead resolver.
 */
export function roichatLeadPhone(value: unknown): string | null {
  const raw =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : "";
  if (!raw || raw.length > 40) return null;
  if (/^(?:\+|00)/u.test(raw)) {
    const digits = raw.replace(/^00/u, "").replace(/\D/gu, "");
    return normalizePhoneIdentity(digits) ?? null;
  }
  return normalizePhoneIdentityWithCountry(raw, "55") ?? null;
}

function contactDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (name.length === 0 || name.length > CONTACT_NAME_MAXIMUM_LENGTH) {
    return null;
  }
  if (/\{\{|\}\}/u.test(name)) return null;
  if (/^(?:null|undefined|none|n\/a)$/iu.test(name)) return null;
  if (!/\p{L}/u.test(name)) return null;
  return name;
}

/** "Purchase"/"purchase"/"compra" -> purchase; ausente -> entry. */
function payloadKind(eventName: string | null): RoichatPayloadKind {
  if (!eventName) return "entry";
  const normalized = eventName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase();
  return normalized === "purchase" || normalized === "compra"
    ? "purchase"
    : "other_event";
}

/**
 * `valor_venda`: "20.00", "20,00", "1.234,56", "1,234.56" or a number.
 * Zero, negative or unreadable -> null (the rule's value is the fallback).
 */
export function roichatValueCents(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    const cents = Math.round(value * 100);
    return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
  }
  if (typeof value !== "string") return null;
  let normalized = value.replace(/[^\d.,-]/gu, "").trim();
  if (!normalized || normalized.startsWith("-")) return null;
  const lastComma = normalized.lastIndexOf(",");
  const lastDot = normalized.lastIndexOf(".");
  if (lastComma > lastDot) {
    // BR: "1.234,56" / "20,00"
    normalized = normalized.replace(/\./gu, "").replace(",", ".");
  } else {
    // US/plain: "1,234.56" / "20.00" / "20"
    normalized = normalized.replace(/,/gu, "");
  }
  if (!/^\d+(?:\.\d{1,2})?$/u.test(normalized)) return null;
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/** `moeda`: BRL/USD/EUR (sem caixa); "R$" = BRL. Outra coisa -> null. */
export function roichatCurrency(value: unknown): CurrencyCode | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  if (trimmed === "R$") return "BRL";
  return normalizeCurrencyCode(trimmed);
}

function present(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return typeof value !== "string" || value.trim().length > 0;
}

/**
 * `event_time` em segundos (13 digitos = milissegundos). Ausente/invalido ->
 * recebimento. Nunca no futuro: depois do recebimento (+5 min) vira o
 * recebimento (correcao da Payt, PR #173). Um horario antigo e mantido: a
 * janela de 7 dias da Meta e aplicada no envio (evento fora da janela fica
 * "nao elegivel", nunca e enviado com outro horario).
 */
export function roichatEventTime(
  value: unknown,
  receivedAt: Date,
): RoichatEventTime {
  const reference = receivedAt.getTime();
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{9,13}$/u.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(raw) || raw <= 0 || !Number.isInteger(raw)) {
    return { occurredAt: new Date(reference), source: "received" };
  }
  const milliseconds = raw >= 1e12 ? raw : raw * 1_000;
  // Before 2020 is not a ROI Chat purchase/entry time: a wrong clock.
  if (milliseconds < Date.UTC(2020, 0, 1)) {
    return { occurredAt: new Date(reference), source: "received" };
  }
  if (milliseconds > reference + ROICHAT_FUTURE_SKEW_MS) {
    return { occurredAt: new Date(reference), source: "future_capped" };
  }
  return { occurredAt: new Date(milliseconds), source: "payload" };
}

/**
 * Ad fields. The real ROI Chat body nests them in `anuncio`
 * ({ nome, telefone, anuncio: { source_id, ctwa_clid, ... } }); the first
 * example had them at the top level. The nested object wins, the top level is
 * kept as a fallback.
 */
function adSource(body: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(body.anuncio);
  return nested ? { ...body, ...nested } : body;
}

function readAd(body: Record<string, unknown>): RoichatAd | null {
  const source = adSource(body);
  const ad: RoichatAd = {
    sourceUrl: httpsUrl(source.source_url),
    sourceType: boundedString(source.source_type, 120),
    description: text(source.body, TEXT_MAXIMUM_LENGTH),
    title: text(source.headline, 500),
    mediaType: boundedString(source.media_type, 60),
    mediaUrl: httpsUrl(source.video_url) ?? httpsUrl(source.image_url),
    thumbnailUrl: httpsUrl(source.thumbnail_url),
  };
  return Object.values(ad).some((value) => value !== null) ? ad : null;
}

/**
 * Reads a ROI Chat body (entry or purchase). Null only when there is no body
 * or no usable lead phone: every other field is optional.
 */
export function parseRoichatPayload(
  payload: unknown,
  receivedAt: Date = new Date(),
): ParsedRoichatPayload | null {
  const body = unwrapRoichatBody(payload);
  if (!body) return null;
  const phone = roichatLeadPhone(body.telefone ?? body.phone);
  if (!phone) return null;
  const eventName = boundedString(body.event_name, 120);
  const kind = payloadKind(eventName);
  const adFields = adSource(body);
  const ctwaClid = token(adFields.ctwa_clid, 2_048);
  const adId = token(adFields.source_id, 255);
  const valueCents =
    kind === "purchase" ? roichatValueCents(body.valor_venda) : null;
  const currency = kind === "purchase" ? roichatCurrency(body.moeda) : null;
  const moneyInvalid =
    kind === "purchase" &&
    ((present(body.valor_venda) && valueCents === null) ||
      (present(body.moeda) && currency === null));

  return {
    kind,
    eventName,
    phone,
    contactName:
      contactDisplayName(body.nome) ??
      contactDisplayName(body.name) ??
      contactDisplayName(body.first_name),
    ctwaClid,
    adId,
    ad: readAd(body),
    time: roichatEventTime(body.event_time, receivedAt),
    valueCents,
    currency,
    moneyInvalid,
  };
}

/** True when the body is a purchase (`event_name` Purchase/compra). */
export function isRoichatPurchasePayload(payload: unknown): boolean {
  const body = unwrapRoichatBody(payload);
  if (!body) return false;
  return payloadKind(boundedString(body.event_name, 120)) === "purchase";
}

/**
 * Identity of "the same purchase" for the 12h repeat guard: lead (canonical
 * phone line, so +55/9th-digit forms are the same person), value and
 * currency. The number is added by the caller (the URL's channel). No PII:
 * a SHA-256 digest only.
 */
export function roichatPurchaseFingerprint(input: {
  phone: string;
  valueCents: number | null;
  currency: string | null;
}): string {
  return `roichat-purchase-fp:${createHash("sha256")
    .update(
      JSON.stringify([
        "v1",
        phoneIdentityKey(input.phone) ?? input.phone,
        input.valueCents ?? null,
        input.currency ?? null,
      ]),
    )
    .digest("hex")}`;
}
