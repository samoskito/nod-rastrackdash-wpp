import { createHash } from "node:crypto";
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

export const ZAPI_V1_PROVIDER = "zapi";
export const ZAPI_V1_PARSER_VERSION = "v1";

// Z-API's inbound "on-message-received" webhook has no discriminator field
// for the event kind (unlike WAHA's `event` or Umbler's `Type`); every
// delivery this parser accepts is a message notification.
const PROVIDER_EVENT_TYPE = "message";

const invalidPayloadError = {
  code: "zapi_v1_invalid_payload",
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

function parsePhone(value: unknown): string | null {
  const phone = boundedString(value, 32);

  if (!phone || !/^\+?[0-9 ()-]+$/u.test(phone)) {
    return null;
  }

  const digits = phone.replace(/\D/gu, "");

  if (digits.length < 8 || digits.length > 20) {
    return null;
  }

  return phone;
}

// Z-API timestamps are epoch seconds in most instances, but some report
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

// Z-API only carries CTWA data when the student's automation layer injects
// a `ctwa` object into the payload; the stock Z-API webhook does not.
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

// Z-API's webhook has no messageId in some plans/events. Fall back to a
// deterministic hash of the stable identifying fields so retried/duplicate
// deliveries still dedupe rather than fanning out into distinct events.
function fallbackMessageId(envelope: Record<string, unknown>): string {
  const canonical = JSON.stringify([
    envelope.instanceId ?? null,
    envelope.phone ?? null,
    envelope.connectedPhone ?? null,
    envelope.timestamp ?? null,
    envelope.message ?? null,
  ]);

  return `hash:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function deliverySummary(input: {
  providerEventType: string | null;
  externalDeliveryId: string | null;
  classification: InboundWebhookEventClassification;
  classificationReason: string;
  eventCount: number;
}): InboundWebhookDeliveryNormalizedSummary {
  return {
    provider: ZAPI_V1_PROVIDER,
    parserVersion: ZAPI_V1_PARSER_VERSION,
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
    provider: ZAPI_V1_PROVIDER,
    parserVersion: ZAPI_V1_PARSER_VERSION,
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
  externalDeliveryId: string | null = null,
): InboundWebhookParserResult {
  return emptyResult({
    providerEventType: null,
    externalDeliveryId,
    classification: "invalid_payload",
    classificationReason: "payload_validation_failed",
  });
}

function unsupportedResult(
  externalDeliveryId: string | null,
  classificationReason: string,
): InboundWebhookParserResult {
  return emptyResult({
    providerEventType: PROVIDER_EVENT_TYPE,
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

  const instanceId = boundedString(envelope.instanceId, 255);
  const connectedPhone = parsePhone(envelope.connectedPhone);
  const phone = parsePhone(envelope.phone);
  const occurredAt = parseEpochTimestamp(envelope.timestamp);
  const fromMeRaw = envelope.fromMe;
  const fromMe = typeof fromMeRaw === "boolean" ? fromMeRaw : null;
  const isGroupRaw = envelope.isGroup;
  const isGroup = typeof isGroupRaw === "boolean" ? isGroupRaw : false;
  const messageText = optionalText(envelope.message, 16_384);
  const ctwa = parseCtwa(envelope.ctwa);
  const explicitMessageId = optionalString(envelope.messageId, 255);

  if (
    !instanceId ||
    !connectedPhone ||
    !phone ||
    !occurredAt ||
    fromMe === null ||
    !messageText.valid ||
    !ctwa.valid ||
    !explicitMessageId.valid
  ) {
    return invalidResult(explicitMessageId.value);
  }

  const messageId = explicitMessageId.value ?? fallbackMessageId(envelope);

  // Z-API groups have no single "contact" to attribute the lead to, so v1
  // declines to route them (mirrors the WAHA parser's group handling).
  if (isGroup) {
    return unsupportedResult(messageId, "group_not_supported_v1");
  }

  const hasCtwa = ctwa.adId !== null || ctwa.ctwaClid !== null;
  const classification: InboundWebhookEventClassification = fromMe
    ? "ignored_outbound"
    : hasCtwa
      ? "eligible_route_unresolved"
      : "ignored_no_ctwa";
  const classificationReason = fromMe
    ? "message_from_me"
    : hasCtwa
      ? "route_resolution_pending"
      : "ctwa_missing";
  const direction: ParsedInboundWebhookMessageDirection = fromMe
    ? "outbound"
    : "inbound";
  const authorType: ParsedInboundWebhookMessageAuthorType = fromMe
    ? "organization_member"
    : "contact";
  const messageType = "chat";

  // Z-API instances have no separate "organization/account" concept
  // distinct from the connected number itself, so instanceId doubles as
  // both providerChannelId and organizationId (see README).
  const providerChannelId = instanceId;
  const organizationId = instanceId;

  const normalizedSummary: InboundWebhookEventNormalizedSummary = {
    provider: ZAPI_V1_PROVIDER,
    providerEventType: PROVIDER_EVENT_TYPE,
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
    messageType,
    classification,
    classificationReason,
  };

  const event = {
    provider: ZAPI_V1_PROVIDER,
    providerEventType: PROVIDER_EVENT_TYPE,
    externalEventId: messageId,
    externalMessageId: messageId,
    dedupeKey: buildInboundWebhookEventDedupeKey({
      provider: ZAPI_V1_PROVIDER,
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
      externalContactId: phone,
      phoneNumber: phone,
      name: null,
    },
    message: {
      direction,
      authorType,
      messageType,
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
    provider: ZAPI_V1_PROVIDER,
    parserVersion: ZAPI_V1_PARSER_VERSION,
    providerEventType: PROVIDER_EVENT_TYPE,
    externalDeliveryId: messageId,
    classification,
    classificationReason,
    events: [event],
    normalizedSummary: deliverySummary({
      providerEventType: PROVIDER_EVENT_TYPE,
      externalDeliveryId: messageId,
      classification,
      classificationReason,
      eventCount: 1,
    }),
    error: null,
  };
}

export function parseZapiV1Webhook(
  payload: unknown,
): InboundWebhookParserResult {
  try {
    return parsePayload(payload);
  } catch {
    return invalidResult();
  }
}

export class ZapiV1Parser implements InboundWebhookParser {
  readonly provider = ZAPI_V1_PROVIDER;
  readonly parserVersion = ZAPI_V1_PARSER_VERSION;

  parse(payload: unknown): InboundWebhookParserResult {
    return parseZapiV1Webhook(payload);
  }
}
