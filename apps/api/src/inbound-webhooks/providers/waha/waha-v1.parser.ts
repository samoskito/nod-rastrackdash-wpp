import { boundedString } from "../inbound-webhook-delivery-identity";
import {
  buildInboundWebhookEventDedupeKey,
  type InboundWebhookDeliveryNormalizedSummary,
  type InboundWebhookEventClassification,
  type InboundWebhookEventNormalizedSummary,
  type InboundWebhookParser,
  type InboundWebhookParserResult,
  type ParsedInboundWebhookAd,
  type ParsedInboundWebhookMessageAuthorType,
  type ParsedInboundWebhookMessageDirection,
} from "../inbound-webhook-parser";

export const WAHA_V1_PROVIDER = "waha";
export const WAHA_V1_PARSER_VERSION = "v1";

const invalidPayloadError = {
  code: "waha_v1_invalid_payload",
  message: "Inbound webhook payload failed validation",
} as const;

type OptionalStringResult = {
  valid: boolean;
  value: string | null;
};

type ParsedCtwaFields = {
  valid: boolean;
  adId: string | null;
  ctwaClid: string | null;
  ad: ParsedInboundWebhookAd | null;
};

type ParsedJid = {
  valid: boolean;
  phone: string | null;
  isGroup: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function optionalString(
  value: unknown,
  maximumLength: number,
): OptionalStringResult {
  if (value === null || value === undefined) {
    return { valid: true, value: null };
  }

  if (typeof value !== "string") {
    return { valid: false, value: null };
  }

  if (value.trim().length === 0) {
    return { valid: true, value: null };
  }

  const normalized = boundedString(value, maximumLength);

  return normalized
    ? { valid: true, value: normalized }
    : { valid: false, value: null };
}

// Built from numeric char codes (rather than a \u escape literal in the
// source) to reject C0 control characters plus DEL in free-text fields.
const CONTROL_CHARACTER_CODES = [
  ...Array.from({ length: 9 }, (_unused, index) => index), // 0x00-0x08
  0x0b,
  0x0c,
  ...Array.from({ length: 18 }, (_unused, index) => index + 14), // 0x0e-0x1f
  0x7f,
];
const CONTROL_CHARACTER_PATTERN = new RegExp(
  `[${CONTROL_CHARACTER_CODES.map((code) => String.fromCharCode(code)).join("")}]`,
  "u",
);

function optionalText(
  value: unknown,
  maximumLength: number,
): OptionalStringResult {
  if (value === null || value === undefined) {
    return { valid: true, value: null };
  }

  if (typeof value !== "string") {
    return { valid: false, value: null };
  }

  const normalized = value.trim();

  if (normalized.length === 0) {
    return { valid: true, value: null };
  }

  if (
    normalized.length > maximumLength ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    return { valid: false, value: null };
  }

  return { valid: true, value: normalized };
}

// WAHA JIDs look like "5511999999999@c.us" (individual) or
// "120363...@g.us" (group). We only ever need the numeric part plus
// whether the chat is a group.
function parseWahaJid(value: unknown): ParsedJid {
  const jid = boundedString(value, 64);

  if (!jid) {
    return { valid: false, phone: null, isGroup: false };
  }

  const match = /^([0-9]{8,20})@(c\.us|g\.us|s\.whatsapp\.net|lid)$/u.exec(
    jid,
  );

  if (!match) {
    return { valid: false, phone: null, isGroup: false };
  }

  return { valid: true, phone: match[1], isGroup: match[2] === "g.us" };
}

// WAHA sends `id` either as a bare string or as `{ id, serialNumber }`
// depending on the underlying engine (NOWEB vs WEBJS).
function parseWahaMessageId(value: unknown): string | null {
  if (typeof value === "string") {
    return boundedString(value, 255);
  }

  const record = asRecord(value);

  if (!record) {
    return null;
  }

  return boundedString(record.id, 255);
}

// WAHA timestamps are epoch seconds in most engines, but some report
// milliseconds. Normalize defensively rather than trusting the field name.
function parseEpochTimestamp(value: unknown): Date | null {
  let numericValue: number | null = null;

  if (typeof value === "number" && Number.isFinite(value)) {
    numericValue = value;
  } else if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      numericValue = parsed;
    }
  }

  if (numericValue === null || numericValue <= 0) {
    return null;
  }

  const milliseconds =
    numericValue > 1e12 ? numericValue : numericValue * 1_000;
  const occurredAt = new Date(milliseconds);

  return Number.isFinite(occurredAt.getTime()) ? occurredAt : null;
}

function connectedPhoneSuffix(phone: string): string {
  return phone.replace(/\D/gu, "").slice(-4);
}

// WAHA does not natively carry Meta's CTWA referral. We only recognize it
// when the student's automation layer injects a `ctwa` object (or a bare
// `ad_id`) into the payload before it reaches us.
function parseCtwa(value: unknown): ParsedCtwaFields {
  if (value === null || value === undefined) {
    return { valid: true, adId: null, ctwaClid: null, ad: null };
  }

  const record = asRecord(value);

  if (!record) {
    return { valid: false, adId: null, ctwaClid: null, ad: null };
  }

  const adId = optionalString(record.ad_id ?? record.adId, 255);
  const ctwaClid = optionalString(
    record.clid ?? record.ctwa_clid ?? record.ctwaClid,
    2_048,
  );
  const sourceUrl = optionalString(record.source_url ?? record.sourceUrl, 4_096);
  const description = optionalText(record.body ?? record.description, 4_096);
  const title = optionalString(record.title ?? record.headline, 512);
  const thumbnailUrl = optionalString(
    record.thumbnail_url ?? record.thumbnailUrl,
    4_096,
  );
  const mediaUrl = optionalString(
    record.media_url ?? record.mediaUrl ?? record.image_url,
    4_096,
  );
  const sourceType = optionalString(record.source_type ?? record.sourceType, 120);
  const fields = [
    adId,
    ctwaClid,
    sourceUrl,
    description,
    title,
    thumbnailUrl,
    mediaUrl,
    sourceType,
  ];

  if (fields.some((field) => !field.valid)) {
    return { valid: false, adId: null, ctwaClid: null, ad: null };
  }

  if (adId.value === null && ctwaClid.value === null) {
    return { valid: true, adId: null, ctwaClid: null, ad: null };
  }

  return {
    valid: true,
    adId: adId.value,
    ctwaClid: ctwaClid.value,
    ad: {
      sourceUrl: sourceUrl.value,
      description: description.value,
      title: title.value,
      thumbnailUrl: thumbnailUrl.value,
      mediaUrl: mediaUrl.value,
      sourceType: sourceType.value,
    },
  };
}

function deliverySummary(input: {
  providerEventType: string | null;
  externalDeliveryId: string | null;
  classification: InboundWebhookEventClassification;
  classificationReason: string;
  eventCount: number;
}): InboundWebhookDeliveryNormalizedSummary {
  return {
    provider: WAHA_V1_PROVIDER,
    parserVersion: WAHA_V1_PARSER_VERSION,
    providerEventType: input.providerEventType,
    externalDeliveryId: input.externalDeliveryId,
    classification: input.classification,
    classificationReason: input.classificationReason,
    eventCount: input.eventCount,
  };
}

function emptyResult(input: {
  providerEventType: string | null;
  externalDeliveryId: string | null;
  classification: "unsupported_event" | "invalid_payload";
  classificationReason: string;
}): InboundWebhookParserResult {
  return {
    provider: WAHA_V1_PROVIDER,
    parserVersion: WAHA_V1_PARSER_VERSION,
    providerEventType: input.providerEventType,
    externalDeliveryId: input.externalDeliveryId,
    classification: input.classification,
    classificationReason: input.classificationReason,
    events: [],
    normalizedSummary: deliverySummary({
      ...input,
      eventCount: 0,
    }),
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

function parsePayload(payload: unknown): InboundWebhookParserResult {
  const envelope = asRecord(payload);

  if (!envelope) {
    return invalidResult();
  }

  const providerEventType = boundedString(envelope.event, 120);
  const session = boundedString(envelope.session, 255);
  const innerPayload = asRecord(envelope.payload);
  const bestEffortMessageId = parseWahaMessageId(innerPayload?.id);

  if (!providerEventType || !session || !innerPayload) {
    return invalidResult(providerEventType, bestEffortMessageId);
  }

  // Only "message" carries an actual inbound message. Everything else
  // (message ACKs, presence updates, group membership changes, ...) has no
  // contact/message content to route, so we treat it like Umbler/Gupshup
  // treat non-"Message" event types: unsupported at the delivery level with
  // zero parsed events.
  if (providerEventType !== "message") {
    return unsupportedResult(
      providerEventType,
      bestEffortMessageId,
      "event_type_unsupported",
    );
  }

  const from = parseWahaJid(innerPayload.from);
  const to = parseWahaJid(innerPayload.to);
  const messageId = parseWahaMessageId(innerPayload.id);
  const occurredAt = parseEpochTimestamp(innerPayload.timestamp);
  const fromMeRaw = innerPayload.fromMe;
  const fromMe = typeof fromMeRaw === "boolean" ? fromMeRaw : null;
  const messageType = optionalString(innerPayload.type, 120);
  const messageText = optionalText(innerPayload.body, 16_384);
  const ctwaSource =
    innerPayload.ctwa ??
    (innerPayload.ad_id !== undefined && innerPayload.ad_id !== null
      ? { ad_id: innerPayload.ad_id }
      : null);
  const ctwa = parseCtwa(ctwaSource);

  if (
    !from.valid ||
    !to.valid ||
    !messageId ||
    !occurredAt ||
    fromMe === null ||
    !messageType.valid ||
    !messageText.valid ||
    !ctwa.valid
  ) {
    return invalidResult(providerEventType, messageId ?? bestEffortMessageId);
  }

  // Group chats have no single "contact" to attribute the lead to. Rather
  // than guessing (participant vs. chat id), v1 declines to route them.
  if (from.isGroup) {
    return unsupportedResult(
      providerEventType,
      messageId,
      "group_messages_not_supported_in_v1",
    );
  }

  const providerChannelId = session;
  const connectedPhone = to.phone as string;
  const contactPhone = from.phone as string;
  const hasCtwa = ctwa.adId !== null || ctwa.ctwaClid !== null;
  const classification: InboundWebhookEventClassification = fromMe
    ? "ignored_outbound"
    : "eligible_route_unresolved";
  const classificationReason = fromMe
    ? "message_from_me"
    : hasCtwa
      ? "route_resolution_pending"
      : "no_ctwa_in_waha_payload";
  const direction: ParsedInboundWebhookMessageDirection = fromMe
    ? "outbound"
    : "inbound";
  const authorType: ParsedInboundWebhookMessageAuthorType = fromMe
    ? "organization_member"
    : "contact";

  // WAHA connections have no separate "organization/account" concept
  // distinct from the WhatsApp session itself, so the session id doubles
  // as both providerChannelId and organizationId (see README).
  const organizationId = providerChannelId;

  const normalizedSummary: InboundWebhookEventNormalizedSummary = {
    provider: WAHA_V1_PROVIDER,
    providerEventType,
    externalEventId: messageId,
    externalMessageId: messageId,
    organizationId,
    providerChannelId,
    connectedPhoneSuffix: connectedPhoneSuffix(connectedPhone),
    occurredAt: occurredAt.toISOString(),
    adId: ctwa.adId,
    hasCtwa,
    messageDirection: direction,
    messageAuthorType: authorType,
    messageType: messageType.value,
    classification,
    classificationReason,
  };

  const event = {
    provider: WAHA_V1_PROVIDER,
    providerEventType,
    externalEventId: messageId,
    externalMessageId: messageId,
    dedupeKey: buildInboundWebhookEventDedupeKey({
      provider: WAHA_V1_PROVIDER,
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
      name: null,
    },
    message: {
      direction,
      authorType,
      messageType: messageType.value,
      text: messageText.value,
      isPrivate: false,
    },
    adId: ctwa.adId,
    ad: ctwa.ad,
    ctwaClid: ctwa.ctwaClid,
    hasCtwa,
    classification,
    classificationReason,
    normalizedSummary,
  };

  return {
    provider: WAHA_V1_PROVIDER,
    parserVersion: WAHA_V1_PARSER_VERSION,
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

export function parseWahaV1Webhook(
  payload: unknown,
): InboundWebhookParserResult {
  try {
    return parsePayload(payload);
  } catch {
    return invalidResult();
  }
}

export class WahaV1Parser implements InboundWebhookParser {
  readonly provider = WAHA_V1_PROVIDER;
  readonly parserVersion = WAHA_V1_PARSER_VERSION;

  parse(payload: unknown): InboundWebhookParserResult {
    return parseWahaV1Webhook(payload);
  }
}
