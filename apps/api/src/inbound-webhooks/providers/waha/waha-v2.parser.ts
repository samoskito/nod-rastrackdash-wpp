import { boundedString } from "../inbound-webhook-delivery-identity";
import {
  buildInboundWebhookEventDedupeKey,
  type InboundWebhookDeliveryNormalizedSummary,
  type InboundWebhookEventClassification,
  type InboundWebhookEventNormalizedSummary,
  type InboundWebhookParser,
  type InboundWebhookParserResult,
  type ParsedInboundWebhookAd,
  type ParsedInboundWebhookEvent,
  type ParsedInboundWebhookMessageAuthorType,
  type ParsedInboundWebhookMessageDirection,
} from "../inbound-webhook-parser";

/**
 * WAHA v2: parser do motor GoWS (WAHA com engine "GOWS").
 *
 * Diferente do v1 (que só reconhecia um objeto `ctwa` injetado por uma
 * automação), o v2 lê o evento bruto do GoWS: `payload._data.Info` (quem
 * enviou, para quem, LID, endereçamento) e `payload._data.Message` (a
 * mensagem do WhatsApp, onde vive o `externalAdReply` do anúncio).
 *
 * Regras portadas do parser validado em produção no Rastrackapp:
 * - `message` traz só as mensagens recebidas; `message.any` traz todas.
 *   Recebidas são lidas apenas de `message`; mensagens do time
 *   (`fromMe=true`) apenas de `message.any`. Assim nada é contado duas vezes.
 * - O telefone do contato nunca é um LID. Quando o chat é `@lid`, o
 *   telefone real vem de `Info.SenderAlt` (recebida) ou `Info.RecipientAlt`
 *   (enviada pelo time). O LID fica guardado à parte em `contact.lid`.
 * - O sufixo de aparelho `:NN` (ex.: `5511...:12@s.whatsapp.net`) é removido.
 * - O próprio número da loja nunca vira contato (`isSelf`).
 * - Grupos, Status (`status@broadcast`), listas de transmissão e canais são
 *   descartados.
 * - CTWA: o `ctwa_clid` vem só de `externalAdReply.ctwaClid` (ou
 *   `ctwa_clid`), procurado em todos os tipos de mensagem, inclusive dentro
 *   de `ephemeralMessage` e `viewOnceMessage*`. O `ctwaPayload` NUNCA é
 *   usado como clid: a Meta o rejeita (erro 2804087).
 */
export const WAHA_V2_PROVIDER = "waha";
export const WAHA_V2_PARSER_VERSION = "v2";

const invalidPayloadError = {
  code: "waha_v2_invalid_payload",
  message: "Inbound webhook payload failed validation",
} as const;

type JsonRecord = Record<string, unknown>;

type ParsedJid = {
  user: string;
  server: string;
};

type CtwaContext = {
  adReply: JsonRecord | null;
  hasCtwaPayload: boolean;
};

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as JsonRecord;
}

// Texto livre (mensagem, título e corpo do anúncio): aceita quebra de linha
// e tabulação, recusa os demais caracteres de controle.
const TEXT_CONTROL_CHARACTERS = new RegExp(
  `[${[
    ...Array.from({ length: 9 }, (_unused, index) => index),
    0x0b,
    0x0c,
    ...Array.from({ length: 18 }, (_unused, index) => index + 14),
    0x7f,
  ]
    .map((code) => String.fromCharCode(code))
    .join("")}]`,
  "u",
);

function freeText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();

  if (
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    TEXT_CONTROL_CHARACTERS.test(normalized)
  ) {
    return null;
  }

  return normalized;
}

/**
 * Lê um JID do WhatsApp/WAHA: `user[:device]@server`. O sufixo de aparelho
 * `:NN` é descartado. Servidores: `c.us`/`s.whatsapp.net` (telefone),
 * `lid`, `g.us` (grupo), `broadcast` (Status e listas), `newsletter`.
 */
function parseJid(value: unknown): ParsedJid | null {
  const jid = boundedString(value, 128);

  if (!jid) {
    return null;
  }

  const match = /^([^@:\s]+)(?::\d{1,4})?@([a-z.]+)$/u.exec(jid);

  if (!match) {
    return null;
  }

  return { user: match[1], server: match[2] };
}

function isPhoneJid(jid: ParsedJid | null): jid is ParsedJid {
  return (
    jid !== null &&
    (jid.server === "c.us" || jid.server === "s.whatsapp.net") &&
    /^[0-9]{8,20}$/u.test(jid.user)
  );
}

function isLidJid(jid: ParsedJid | null): jid is ParsedJid {
  return jid !== null && jid.server === "lid" && /^[0-9]{6,24}$/u.test(jid.user);
}

type UnsupportedChatReason =
  | "status_not_supported"
  | "group_not_supported"
  | "broadcast_not_supported"
  | "newsletter_not_supported";

function unsupportedChatReason(
  addresses: readonly unknown[],
  isGroupFlag: boolean,
): UnsupportedChatReason | null {
  const values = addresses.filter(
    (address): address is string => typeof address === "string",
  );

  if (values.some((address) => address.includes("status@broadcast"))) {
    return "status_not_supported";
  }

  if (isGroupFlag || values.some((address) => address.endsWith("@g.us"))) {
    return "group_not_supported";
  }

  if (values.some((address) => address.endsWith("@broadcast"))) {
    return "broadcast_not_supported";
  }

  if (values.some((address) => address.endsWith("@newsletter"))) {
    return "newsletter_not_supported";
  }

  return null;
}

// Tipos de mensagem cujo contextInfo pode trazer o externalAdReply do
// anúncio (mesma lista do findCtwaContext do Rastrackapp). `conversation`
// é texto puro no GoWS e nunca tem contextInfo, mas fica na lista para
// cobrir provedores que entregam um objeto.
const MESSAGE_TYPES_WITH_CONTEXT = [
  "extendedTextMessage",
  "conversation",
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "documentMessage",
  "stickerMessage",
  "buttonsResponseMessage",
  "listResponseMessage",
  "templateButtonReplyMessage",
  "locationMessage",
  "contactMessage",
  "reactionMessage",
  "interactiveResponseMessage",
  "ephemeralMessage",
] as const;

const WRAPPER_MESSAGE_TYPES = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
] as const;

const EMPTY_CTWA_CONTEXT: CtwaContext = { adReply: null, hasCtwaPayload: false };

function ctwaFromContextInfo(contextInfo: JsonRecord | null): CtwaContext {
  if (!contextInfo) {
    return EMPTY_CTWA_CONTEXT;
  }

  return {
    adReply: asRecord(contextInfo.externalAdReply),
    hasCtwaPayload:
      typeof contextInfo.ctwaPayload === "string" &&
      contextInfo.ctwaPayload.length > 0,
  };
}

function findCtwaContext(rawMessage: unknown, depth = 0): CtwaContext {
  const message = asRecord(rawMessage);

  if (!message || depth > 3) {
    return EMPTY_CTWA_CONTEXT;
  }

  for (const type of MESSAGE_TYPES_WITH_CONTEXT) {
    const sub = asRecord(message[type]);

    if (!sub) {
      continue;
    }

    const contextInfo =
      asRecord(sub.contextInfo) ?? asRecord(asRecord(sub.message)?.contextInfo);
    const found = ctwaFromContextInfo(contextInfo);

    if (found.adReply || found.hasCtwaPayload) {
      return found;
    }
  }

  // ephemeralMessage / viewOnceMessage* envolvem outra mensagem em `.message`.
  for (const wrapper of WRAPPER_MESSAGE_TYPES) {
    const inner = asRecord(asRecord(message[wrapper])?.message);

    if (inner) {
      const found = findCtwaContext(inner, depth + 1);

      if (found.adReply || found.hasCtwaPayload) {
        return found;
      }
    }
  }

  // Alguns provedores entregam o contextInfo na raiz.
  return ctwaFromContextInfo(asRecord(message.contextInfo));
}

function unwrapMessage(rawMessage: unknown, depth = 0): JsonRecord | null {
  const message = asRecord(rawMessage);

  if (!message || depth > 3) {
    return message;
  }

  for (const wrapper of WRAPPER_MESSAGE_TYPES) {
    const inner = asRecord(asRecord(message[wrapper])?.message);

    if (inner) {
      return unwrapMessage(inner, depth + 1);
    }
  }

  return message;
}

function messageText(payloadBody: unknown, rawMessage: unknown): string | null {
  const fromBody = freeText(payloadBody, 16_384);

  if (fromBody) {
    return fromBody;
  }

  const message = unwrapMessage(rawMessage);

  if (!message) {
    return null;
  }

  const candidates = [
    asRecord(message.extendedTextMessage)?.text,
    message.conversation,
    asRecord(message.imageMessage)?.caption,
    asRecord(message.videoMessage)?.caption,
    asRecord(message.documentMessage)?.caption,
  ];

  for (const candidate of candidates) {
    const text = freeText(candidate, 16_384);

    if (text) {
      return text;
    }
  }

  return null;
}

function parseMessageId(payloadId: unknown, infoId: unknown): string | null {
  if (typeof payloadId === "string") {
    return boundedString(payloadId, 255);
  }

  const record = asRecord(payloadId);
  const nested = record ? boundedString(record._serialized ?? record.id, 255) : null;

  return nested ?? boundedString(infoId, 255);
}

// Segundos na maioria dos motores; milissegundos em alguns. Na falta, o
// `Info.Timestamp` do GoWS (ISO 8601).
function parseOccurredAt(value: unknown, infoTimestamp: unknown): Date | null {
  let numericValue: number | null = null;

  if (typeof value === "number" && Number.isFinite(value)) {
    numericValue = value;
  } else if (typeof value === "string" && /^[0-9]+$/u.test(value.trim())) {
    numericValue = Number(value);
  }

  if (numericValue !== null && numericValue > 0) {
    const occurredAt = new Date(
      numericValue > 1e12 ? numericValue : numericValue * 1_000,
    );

    if (Number.isFinite(occurredAt.getTime())) {
      return occurredAt;
    }
  }

  const iso = boundedString(infoTimestamp, 64);

  if (iso && !iso.startsWith("0001-")) {
    const occurredAt = new Date(iso);

    if (Number.isFinite(occurredAt.getTime())) {
      return occurredAt;
    }
  }

  return null;
}

function parseAd(adReply: JsonRecord | null): {
  adId: string | null;
  ctwaClid: string | null;
  ad: ParsedInboundWebhookAd | null;
} {
  if (!adReply) {
    return { adId: null, ctwaClid: null, ad: null };
  }

  // Nunca o ctwaPayload: só o clid real do externalAdReply.
  const ctwaClid =
    boundedString(adReply.ctwaClid, 2_048) ??
    boundedString(adReply.ctwa_clid, 2_048);
  const adId =
    boundedString(adReply.sourceID, 255) ?? boundedString(adReply.sourceId, 255);

  if (!ctwaClid && !adId) {
    return { adId: null, ctwaClid: null, ad: null };
  }

  return {
    adId,
    ctwaClid,
    ad: {
      sourceUrl:
        boundedString(adReply.sourceURL, 4_096) ??
        boundedString(adReply.sourceUrl, 4_096),
      description: freeText(adReply.body, 4_096),
      title: freeText(adReply.title, 512),
      thumbnailUrl:
        boundedString(adReply.thumbnailURL, 4_096) ??
        boundedString(adReply.thumbnailUrl, 4_096),
      mediaUrl:
        boundedString(adReply.mediaURL, 4_096) ??
        boundedString(adReply.mediaUrl, 4_096),
      sourceType: boundedString(adReply.sourceType, 120),
    },
  };
}

/** Contexto do anúncio em _data.Message; na falta, em _data.RawMessage. */
function messageCtwaContext(data: JsonRecord | null): CtwaContext {
  const fromMessage = findCtwaContext(data?.Message ?? data?.RawMessage ?? null);

  return fromMessage.adReply || !data?.RawMessage
    ? fromMessage
    : findCtwaContext(data.RawMessage);
}

function connectedPhoneSuffix(phone: string): string {
  return phone.replace(/\D/gu, "").slice(-4);
}

function deliverySummary(input: {
  providerEventType: string | null;
  externalDeliveryId: string | null;
  classification: InboundWebhookEventClassification;
  classificationReason: string;
  eventCount: number;
}): InboundWebhookDeliveryNormalizedSummary {
  return {
    provider: WAHA_V2_PROVIDER,
    parserVersion: WAHA_V2_PARSER_VERSION,
    ...input,
  };
}

function emptyResult(input: {
  providerEventType: string | null;
  externalDeliveryId: string | null;
  classification: "unsupported_event" | "invalid_payload";
  classificationReason: string;
}): InboundWebhookParserResult {
  return {
    provider: WAHA_V2_PROVIDER,
    parserVersion: WAHA_V2_PARSER_VERSION,
    providerEventType: input.providerEventType,
    externalDeliveryId: input.externalDeliveryId,
    classification: input.classification,
    classificationReason: input.classificationReason,
    events: [],
    normalizedSummary: deliverySummary({ ...input, eventCount: 0 }),
    error:
      input.classification === "invalid_payload"
        ? { ...invalidPayloadError }
        : null,
  };
}

function invalidResult(
  providerEventType: string | null = null,
  externalDeliveryId: string | null = null,
): InboundWebhookParserResult {
  return emptyResult({
    providerEventType,
    externalDeliveryId,
    classification: "invalid_payload",
    classificationReason: "payload_validation_failed",
  });
}

function unsupportedResult(
  providerEventType: string,
  externalDeliveryId: string | null,
  classificationReason: string,
): InboundWebhookParserResult {
  return emptyResult({
    providerEventType,
    externalDeliveryId,
    classification: "unsupported_event",
    classificationReason,
  });
}

/** Primeiro telefone válido da lista que não seja o número da loja. */
function firstPhone(
  candidates: readonly unknown[],
  selfPhones: ReadonlySet<string>,
): string | null {
  for (const candidate of candidates) {
    const jid = parseJid(candidate);

    if (isPhoneJid(jid) && !selfPhones.has(jid.user)) {
      return jid.user;
    }
  }

  return null;
}

function firstLid(
  candidates: readonly unknown[],
  selfLids: ReadonlySet<string>,
): string | null {
  for (const candidate of candidates) {
    const jid = parseJid(candidate);

    if (isLidJid(jid) && !selfLids.has(jid.user)) {
      return jid.user;
    }
  }

  return null;
}

function collectSelf(
  candidates: readonly unknown[],
  accept: (jid: ParsedJid | null) => jid is ParsedJid,
): Set<string> {
  const values = new Set<string>();

  for (const candidate of candidates) {
    const jid = parseJid(candidate);

    if (accept(jid)) {
      values.add(jid.user);
    }
  }

  return values;
}

function parsePayload(payload: unknown): InboundWebhookParserResult {
  const envelope = asRecord(payload);

  if (!envelope) {
    return invalidResult();
  }

  const providerEventType = boundedString(envelope.event, 120);
  const session = boundedString(envelope.session, 255);
  const inner = asRecord(envelope.payload);
  const data = asRecord(inner?.["_data"]);
  const info = asRecord(data?.Info) ?? {};
  const bestEffortMessageId = parseMessageId(inner?.id, info.ID);

  if (!providerEventType || !session || !inner) {
    return invalidResult(providerEventType, bestEffortMessageId);
  }

  if (providerEventType === "session.status") {
    return unsupportedResult(providerEventType, null, "session_status");
  }

  if (providerEventType !== "message" && providerEventType !== "message.any") {
    return unsupportedResult(
      providerEventType,
      bestEffortMessageId,
      "event_type_unsupported",
    );
  }

  // Direção: payload.fromMe; na falta, o Info.IsFromMe do GoWS. Um texto
  // como "false" nunca vale (no Rastrackapp, Boolean("false") viraria
  // mensagem do time).
  const fromMeRaw =
    typeof inner.fromMe === "boolean" ? inner.fromMe : info.IsFromMe;

  if (typeof fromMeRaw !== "boolean") {
    return invalidResult(providerEventType, bestEffortMessageId);
  }

  const fromMe = fromMeRaw;
  const chatReason = unsupportedChatReason(
    [inner.from, inner.to, info.Chat],
    info.IsGroup === true,
  );

  if (chatReason) {
    return unsupportedResult(providerEventType, bestEffortMessageId, chatReason);
  }

  // Recebidas só via "message"; do time só via "message.any". A outra cópia
  // é a mesma mensagem entregue duas vezes pela WAHA.
  if (providerEventType === "message.any" && !fromMe) {
    return unsupportedResult(
      providerEventType,
      bestEffortMessageId,
      "inbound_copy_handled_by_message_event",
    );
  }

  if (providerEventType === "message" && fromMe) {
    return unsupportedResult(
      providerEventType,
      bestEffortMessageId,
      "team_message_handled_by_message_any",
    );
  }

  const messageId = bestEffortMessageId;
  // Hora da mensagem; na falta, a do envelope da WAHA (ms). Nunca "agora".
  const occurredAt =
    parseOccurredAt(inner.timestamp, info.Timestamp) ??
    parseOccurredAt(envelope.timestamp, null);

  if (!messageId || !occurredAt) {
    return invalidResult(providerEventType, messageId);
  }

  const me = asRecord(envelope.me);
  // O número da loja: `me.id` e, em mensagens do time, o próprio remetente
  // (`Info.Sender`/`Info.SenderAlt`, às vezes com sufixo `:NN`).
  const selfPhones = collectSelf(
    fromMe ? [me?.id, info.Sender, info.SenderAlt, inner.from] : [me?.id],
    isPhoneJid,
  );
  const selfLids = collectSelf(
    fromMe ? [me?.lid, info.Sender, info.SenderAlt] : [me?.lid],
    isLidJid,
  );
  const contactCandidates = fromMe
    ? [info.RecipientAlt, inner.to, info.Chat, inner.from]
    : [inner.from, info.Sender, info.SenderAlt, info.Chat];
  const contactPhone = firstPhone(contactCandidates, selfPhones);
  const contactLid = firstLid(contactCandidates, selfLids);

  if (!contactPhone) {
    // Sem telefone real (só LID e sem SenderAlt/RecipientAlt) ou conversa
    // com o próprio número: nunca usar o LID como telefone, para não criar
    // um lead que depois duplicaria o do telefone verdadeiro.
    const chatIsSelf = contactCandidates.some((candidate) => {
      const jid = parseJid(candidate);
      return isPhoneJid(jid) && selfPhones.has(jid.user);
    });

    if (chatIsSelf && !contactLid) {
      return unsupportedResult(
        providerEventType,
        messageId,
        "self_chat_not_supported",
      );
    }

    // A métrica do anúncio não se perde: o clique fica com motivo próprio
    // e o resumo leva hasCtwa/adId (sem LID nem telefone).
    const unresolvedAd = fromMe
      ? { adId: null, ctwaClid: null }
      : parseAd(messageCtwaContext(data).adReply);
    const unresolved = unsupportedResult(
      providerEventType,
      messageId,
      unresolvedAd.ctwaClid
        ? "ctwa_contact_phone_unresolved"
        : "contact_phone_unresolved",
    );
    unresolved.normalizedSummary = {
      ...unresolved.normalizedSummary,
      hasCtwa: unresolvedAd.ctwaClid !== null,
      adId: unresolvedAd.adId,
    };

    return unresolved;
  }

  const connectedPhone =
    [...selfPhones][0] ??
    (fromMe ? null : firstPhone([inner.to], new Set<string>())) ??
    "";
  const rawMessage = data?.Message ?? data?.RawMessage ?? null;
  const ctwa = parseAd(messageCtwaContext(data).adReply);
  const messageType =
    boundedString(info.MediaType, 120) ??
    boundedString(info.Type, 120) ??
    boundedString(inner.type, 120);
  const text = messageText(inner.body, rawMessage);
  const hasCtwa = !fromMe && ctwa.ctwaClid !== null;
  const classification: InboundWebhookEventClassification = fromMe
    ? "ignored_outbound"
    : hasCtwa
      ? "eligible_route_unresolved"
      : "ignored_no_ctwa";
  const classificationReason = fromMe
    ? "message_from_me"
    : hasCtwa
      ? "route_resolution_pending"
      : ctwa.adId
        ? "ctwa_clid_missing"
        : "ctwa_missing";
  const direction: ParsedInboundWebhookMessageDirection = fromMe
    ? "outbound"
    : "inbound";
  const authorType: ParsedInboundWebhookMessageAuthorType = fromMe
    ? "organization_member"
    : "contact";
  // Como no v1: a sessão da WAHA é ao mesmo tempo canal e organização.
  const providerChannelId = session;
  const organizationId = session;
  // O nome do remetente só é o do contato quando a mensagem é recebida.
  const contactName = fromMe
    ? null
    : (freeText(info.PushName, 255) ??
      freeText(inner.pushName, 255) ??
      freeText(inner.notifyName, 255));
  const adId = fromMe ? null : ctwa.adId;

  const normalizedSummary: InboundWebhookEventNormalizedSummary = {
    provider: WAHA_V2_PROVIDER,
    providerEventType,
    externalEventId: messageId,
    externalMessageId: messageId,
    organizationId,
    providerChannelId,
    connectedPhoneSuffix: connectedPhoneSuffix(connectedPhone),
    occurredAt: occurredAt.toISOString(),
    adId,
    hasCtwa,
    messageDirection: direction,
    messageAuthorType: authorType,
    messageType,
    classification,
    classificationReason,
  };

  const event: ParsedInboundWebhookEvent = {
    provider: WAHA_V2_PROVIDER,
    providerEventType,
    externalEventId: messageId,
    externalMessageId: messageId,
    dedupeKey: buildInboundWebhookEventDedupeKey({
      provider: WAHA_V2_PROVIDER,
      organizationId,
      providerChannelId,
      externalMessageId: messageId,
    }),
    organizationId,
    occurredAt,
    channel: {
      providerChannelId,
      connectedPhone,
      name: null,
    },
    contact: {
      externalContactId: contactPhone,
      phoneNumber: contactPhone,
      name: contactName,
      lid: contactLid,
    },
    message: {
      direction,
      authorType,
      messageType,
      text,
      isPrivate: false,
    },
    adId,
    ad: fromMe ? null : ctwa.ad,
    ctwaClid: hasCtwa ? ctwa.ctwaClid : null,
    hasCtwa,
    classification,
    classificationReason,
    normalizedSummary,
  };

  return {
    provider: WAHA_V2_PROVIDER,
    parserVersion: WAHA_V2_PARSER_VERSION,
    providerEventType,
    externalDeliveryId: messageId,
    classification,
    classificationReason,
    events: [event],
    normalizedSummary: deliverySummary({
      providerEventType,
      externalDeliveryId: messageId,
      classification,
      classificationReason,
      eventCount: 1,
    }),
    error: null,
  };
}

export function parseWahaV2Webhook(payload: unknown): InboundWebhookParserResult {
  try {
    return parsePayload(payload);
  } catch {
    return invalidResult();
  }
}

/**
 * Contato só com LID num clique de anúncio (motivo
 * ctwa_contact_phone_unresolved): o LID a resolver na WAHA do aluno.
 */
export function wahaV2UnresolvedContactLid(payload: unknown): string | null {
  const inner = asRecord(asRecord(payload)?.payload);
  const info = asRecord(asRecord(inner?.["_data"])?.Info) ?? {};

  for (const candidate of [inner?.from, info.Sender, info.SenderAlt, info.Chat]) {
    const jid = parseJid(candidate);

    if (isLidJid(jid)) {
      return jid.user;
    }
  }

  return null;
}

/**
 * Cópia do evento com o telefone resolvido pela WAHA no lugar em que o GoWS
 * o traria (Info.SenderAlt da mensagem recebida). O original não muda.
 */
export function withWahaResolvedContactPhone(
  payload: unknown,
  phone: string,
): unknown {
  const copy = JSON.parse(JSON.stringify(payload)) as JsonRecord;
  const inner = asRecord(copy.payload);
  const data = asRecord(inner?.["_data"]);

  if (!inner || !data) {
    return copy;
  }

  data.Info = { ...(asRecord(data.Info) ?? {}), SenderAlt: `${phone}@s.whatsapp.net` };

  return copy;
}

export type WahaSessionStatus =
  | "STARTING"
  | "SCAN_QR_CODE"
  | "WORKING"
  | "FAILED"
  | "STOPPED";

const WAHA_SESSION_STATUSES: readonly WahaSessionStatus[] = [
  "STARTING",
  "SCAN_QR_CODE",
  "WORKING",
  "FAILED",
  "STOPPED",
];

/**
 * Lê um evento `session.status` da WAHA. Devolve null para qualquer outro
 * evento ou status desconhecido.
 */
export function parseWahaSessionStatusEvent(
  payload: unknown,
): {
  session: string;
  status: WahaSessionStatus;
  /** Hora do evento no envelope da WAHA (ms); null se ausente. */
  occurredAt: Date | null;
} | null {
  const envelope = asRecord(payload);

  if (!envelope || envelope.event !== "session.status") {
    return null;
  }

  const session = boundedString(envelope.session, 255);
  const status = boundedString(asRecord(envelope.payload)?.status, 40);

  if (
    !session ||
    !status ||
    !(WAHA_SESSION_STATUSES as readonly string[]).includes(status)
  ) {
    return null;
  }

  return {
    session,
    status: status as WahaSessionStatus,
    occurredAt: parseOccurredAt(envelope.timestamp, null),
  };
}

export class WahaV2Parser implements InboundWebhookParser {
  readonly provider = WAHA_V2_PROVIDER;
  readonly parserVersion = WAHA_V2_PARSER_VERSION;

  parse(payload: unknown): InboundWebhookParserResult {
    return parseWahaV2Webhook(payload);
  }
}
