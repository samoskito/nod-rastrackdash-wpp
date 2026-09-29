import { normalizePhoneIdentity } from "../../../common/phone/phone-identity";
import { boundedString } from "../inbound-webhook-delivery-identity";
import {
  buildInboundWebhookEventDedupeKey,
  type InboundWebhookDeliveryNormalizedSummary,
  type InboundWebhookEventClassification,
  type InboundWebhookEventNormalizedSummary,
  type InboundWebhookParser,
  type InboundWebhookParserContext,
  type InboundWebhookParserError,
  type InboundWebhookParserResult,
  type ParsedInboundWebhookAd,
  type ParsedInboundWebhookEvent,
} from "../inbound-webhook-parser";

export const DATA_CRAZY_V1_PROVIDER = "data_crazy";
export const DATA_CRAZY_V1_PARSER_VERSION = "v1";

const MAX_NESTED_JSON_BYTES = 512 * 1024;
const MAX_ITEMS = 1_000;
const MESSAGE_TYPE = "message";

const errorMessages = {
  root_array_required: "Data Crazy payload must be an array",
  root_array_too_large: "Data Crazy payload contains too many items",
  item_object_required: "Data Crazy array item must be an object",
  body_required: "Data Crazy item.body must be a JSON string",
  body_too_large: "Data Crazy item.body exceeds the parser limit",
  body_json_invalid: "Data Crazy item.body JSON is invalid",
  mensagem_required: "Data Crazy body.mensagem must be a JSON string",
  mensagem_too_large: "Data Crazy body.mensagem exceeds the parser limit",
  mensagem_json_invalid: "Data Crazy body.mensagem JSON is invalid",
  item_invalid: "Data Crazy item does not satisfy the inbound event contract",
} as const;

type DataCrazyParserErrorCode = keyof typeof errorMessages;
type ParseFailure = { error: InboundWebhookParserError };
type ItemParseResult =
  { event: ParsedInboundWebhookEvent } | { event: null; failure: ParseFailure };
type OptionalString = { valid: boolean; value: string | null };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function optionalString(value: unknown, maximumLength: number): OptionalString {
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

function optionalText(value: unknown, maximumLength: number): OptionalString {
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
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  ) {
    return { valid: false, value: null };
  }

  return { valid: true, value: normalized };
}

function requiredIdentifier(value: unknown): string | null {
  return boundedString(value, 255);
}

function parsePhone(value: unknown): string | null {
  const raw = boundedString(value, 64);
  return raw ? (normalizePhoneIdentity(raw) ?? null) : null;
}

function parseOccurredAt(value: unknown): Date | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    const result = new Date(milliseconds);
    return Number.isFinite(result.getTime()) ? result : null;
  }

  const raw = boundedString(value, 80);
  if (!raw) {
    return null;
  }

  if (/^\d{9,13}$/u.test(raw)) {
    return parseOccurredAt(Number(raw));
  }

  const milliseconds = Date.parse(raw);
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
}

function failure(code: DataCrazyParserErrorCode): ParseFailure {
  return {
    error: { code: `data_crazy_v1_${code}`, message: errorMessages[code] },
  };
}

function parseNestedJson(
  value: unknown,
  field: "body" | "mensagem",
): { value: Record<string, unknown> } | ParseFailure {
  if (typeof value !== "string") {
    return failure(`${field}_required` as DataCrazyParserErrorCode);
  }

  if (Buffer.byteLength(value, "utf8") > MAX_NESTED_JSON_BYTES) {
    return failure(`${field}_too_large` as DataCrazyParserErrorCode);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return failure(`${field}_json_invalid` as DataCrazyParserErrorCode);
  }

  const record = asRecord(parsed);
  return record
    ? { value: record }
    : failure(`${field}_json_invalid` as DataCrazyParserErrorCode);
}

function deliverySummary(input: {
  providerEventType: string | null;
  externalDeliveryId: string | null;
  classification: InboundWebhookEventClassification;
  classificationReason: string;
  eventCount: number;
}): InboundWebhookDeliveryNormalizedSummary {
  return {
    provider: DATA_CRAZY_V1_PROVIDER,
    parserVersion: DATA_CRAZY_V1_PARSER_VERSION,
    ...input,
  };
}

function invalidResult(
  code: DataCrazyParserErrorCode,
  classificationReason = "payload_validation_failed",
): InboundWebhookParserResult {
  return {
    provider: DATA_CRAZY_V1_PROVIDER,
    parserVersion: DATA_CRAZY_V1_PARSER_VERSION,
    providerEventType: null,
    externalDeliveryId: null,
    classification: "invalid_payload",
    classificationReason,
    events: [],
    normalizedSummary: deliverySummary({
      providerEventType: null,
      externalDeliveryId: null,
      classification: "invalid_payload",
      classificationReason,
      eventCount: 0,
    }),
    error: failure(code).error,
  };
}

function unsupportedResult(
  classificationReason: string,
): InboundWebhookParserResult {
  return {
    provider: DATA_CRAZY_V1_PROVIDER,
    parserVersion: DATA_CRAZY_V1_PARSER_VERSION,
    providerEventType: null,
    externalDeliveryId: null,
    classification: "unsupported_event",
    classificationReason,
    events: [],
    normalizedSummary: deliverySummary({
      providerEventType: null,
      externalDeliveryId: null,
      classification: "unsupported_event",
      classificationReason,
      eventCount: 0,
    }),
    error: null,
  };
}

function parseReferral(value: unknown): {
  valid: boolean;
  adId: string | null;
  ctwaClid: string | null;
  ad: ParsedInboundWebhookAd | null;
} {
  if (value === undefined || value === null) {
    return { valid: true, adId: null, ctwaClid: null, ad: null };
  }

  const referral = asRecord(value);
  if (!referral) {
    return { valid: false, adId: null, ctwaClid: null, ad: null };
  }

  const adId = optionalString(referral.source_id, 255);
  const ctwaClid = optionalString(referral.ctwa_clid, 2_048);
  const sourceUrl = optionalString(referral.source_url, 4_096);
  const description = optionalText(referral.body, 4_096);
  const title = optionalString(referral.headline, 512);
  const thumbnailUrl = optionalString(referral.thumbnail_url, 4_096);
  const imageUrl = optionalString(referral.image_url, 4_096);
  const videoUrl = optionalString(referral.video_url, 4_096);
  const sourceType = optionalString(referral.source_type, 120);
  const fields = [
    adId,
    ctwaClid,
    sourceUrl,
    description,
    title,
    thumbnailUrl,
    imageUrl,
    videoUrl,
    sourceType,
  ];

  if (fields.some((field) => !field.valid)) {
    return { valid: false, adId: null, ctwaClid: null, ad: null };
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
      mediaUrl: imageUrl.value ?? videoUrl.value,
      sourceType: sourceType.value,
    },
  };
}

function parseItem(
  item: Record<string, unknown>,
  context: Readonly<InboundWebhookParserContext> | undefined,
): ItemParseResult {
  const bodyResult = parseNestedJson(item.body, "body");
  if ("error" in bodyResult) {
    return { event: null, failure: bodyResult };
  }

  const body = bodyResult.value;
  const mensagemResult = parseNestedJson(body.mensagem, "mensagem");
  if ("error" in mensagemResult) {
    return { event: null, failure: mensagemResult };
  }

  const mensagem = mensagemResult.value;
  const instanceData = asRecord(mensagem.instanceData);
  const messageData = asRecord(mensagem.messageData);
  const messageContact = asRecord(messageData?.contact);
  if (!instanceData || !messageData) {
    return { event: null, failure: failure("item_invalid") };
  }

  const leadId = requiredIdentifier(item.leadId);
  const organizationId = requiredIdentifier(context?.organizationId);
  const providerChannelId = requiredIdentifier(instanceData.id);
  // body.telefone is the lead's declared phone, not the business number.
  // Data Crazy does not send the business number, so the instance id is the
  // stable channel identifier.
  const declaredPhone = parsePhone(body.telefone);
  const externalMessageId = requiredIdentifier(messageData.id);
  const externalEventId = externalMessageId;
  const occurredAt = parseOccurredAt(messageData.date);
  const messageType = optionalString(mensagem.type, 120);
  const messageText = optionalText(messageData.text, 16_384);
  const senderPhone = parsePhone(mensagem.from);
  const contactPhone = parsePhone(messageContact?.phoneNumber);
  const phoneNumber = contactPhone;
  const phonesAgree =
    senderPhone !== null &&
    contactPhone !== null &&
    senderPhone === contactPhone;
  const phoneDivergenceDetected =
    declaredPhone !== null &&
    (senderPhone === null ||
      contactPhone === null ||
      declaredPhone !== senderPhone ||
      declaredPhone !== contactPhone);
  const contactName = optionalText(messageContact?.name, 160);
  const channelName = optionalString(instanceData.name, 160);
  const referral = parseReferral(mensagem.referral);

  if (
    !leadId ||
    !organizationId ||
    !providerChannelId ||
    !declaredPhone ||
    !externalMessageId ||
    !externalEventId ||
    !occurredAt ||
    !messageType.valid ||
    !messageText.valid ||
    !phoneNumber ||
    !phonesAgree ||
    !contactName.valid ||
    !channelName.valid ||
    !referral.valid
  ) {
    return { event: null, failure: failure("item_invalid") };
  }

  const hasCtwa = referral.ctwaClid !== null;
  const classification: InboundWebhookEventClassification = hasCtwa
    ? "eligible_route_unresolved"
    : "ignored_no_ctwa";
  const classificationReason = hasCtwa
    ? "route_resolution_pending"
    : "ctwa_missing";
  const normalizedSummary: InboundWebhookEventNormalizedSummary = {
    provider: DATA_CRAZY_V1_PROVIDER,
    providerEventType: MESSAGE_TYPE,
    externalEventId,
    externalMessageId,
    organizationId,
    providerChannelId,
    connectedPhoneSuffix: "",
    occurredAt: occurredAt.toISOString(),
    adId: hasCtwa ? referral.adId : null,
    hasCtwa,
    messageDirection: "inbound",
    messageAuthorType: "contact",
    messageType: messageType.value,
    ...(phoneDivergenceDetected ? { phoneDivergenceDetected: true } : {}),
    classification,
    classificationReason,
  };

  return {
    event: {
      provider: DATA_CRAZY_V1_PROVIDER,
      providerEventType: MESSAGE_TYPE,
      externalEventId,
      externalMessageId,
      dedupeKey: buildInboundWebhookEventDedupeKey({
        provider: DATA_CRAZY_V1_PROVIDER,
        organizationId,
        providerChannelId,
        externalMessageId,
      }),
      organizationId,
      occurredAt,
      channel: {
        providerChannelId,
        connectedPhone: providerChannelId,
        name: channelName.value,
      },
      contact: {
        externalContactId: leadId,
        phoneNumber,
        name: contactName.value,
      },
      message: {
        direction: "inbound",
        authorType: "contact",
        messageType: messageType.value,
        text: messageText.value,
        isPrivate: false,
      },
      adId: hasCtwa ? referral.adId : null,
      ad: hasCtwa ? referral.ad : null,
      ctwaClid: hasCtwa ? referral.ctwaClid : null,
      hasCtwa,
      classification,
      classificationReason,
      normalizedSummary,
    },
  };
}

function aggregateResult(
  events: ParsedInboundWebhookEvent[],
  externalDeliveryId: string | null,
  firstFailure: ParseFailure | null,
): InboundWebhookParserResult {
  if (events.length === 0) {
    return firstFailure
      ? {
          ...invalidResult(
            firstFailure.error.code.replace(
              "data_crazy_v1_",
              "",
            ) as DataCrazyParserErrorCode,
          ),
          error: firstFailure.error,
        }
      : unsupportedResult("message_event_not_found");
  }

  const hasCtwa = events.some(
    (event) => event.classification === "eligible_route_unresolved",
  );
  const classification: InboundWebhookEventClassification = hasCtwa
    ? "eligible_route_unresolved"
    : "ignored_no_ctwa";
  const classificationReason = hasCtwa
    ? "route_resolution_pending"
    : "ctwa_missing";

  return {
    provider: DATA_CRAZY_V1_PROVIDER,
    parserVersion: DATA_CRAZY_V1_PARSER_VERSION,
    providerEventType: MESSAGE_TYPE,
    externalDeliveryId,
    classification,
    classificationReason,
    events,
    normalizedSummary: deliverySummary({
      providerEventType: MESSAGE_TYPE,
      externalDeliveryId,
      classification,
      classificationReason,
      eventCount: events.length,
    }),
    error: null,
  };
}

function parsePayload(
  payload: unknown,
  context: Readonly<InboundWebhookParserContext> | undefined,
): InboundWebhookParserResult {
  if (!Array.isArray(payload)) {
    return invalidResult("root_array_required");
  }
  if (payload.length === 0) {
    return unsupportedResult("empty_batch");
  }
  if (payload.length > MAX_ITEMS) {
    return invalidResult("root_array_too_large");
  }

  const events: ParsedInboundWebhookEvent[] = [];
  let firstFailure: ParseFailure | null = null;
  for (const item of payload) {
    if (!asRecord(item)) {
      firstFailure ??= failure("item_object_required");
      continue;
    }

    const parsed = parseItem(item, context);
    if ("failure" in parsed) {
      firstFailure ??= parsed.failure;
      continue;
    }
    events.push(parsed.event);
  }

  return aggregateResult(
    events,
    events[0]?.externalEventId ?? null,
    firstFailure,
  );
}

export function parseDataCrazyV1Webhook(
  payload: unknown,
  context?: Readonly<InboundWebhookParserContext>,
): InboundWebhookParserResult {
  try {
    return parsePayload(payload, context);
  } catch {
    return invalidResult("item_invalid");
  }
}

export class DataCrazyV1Parser implements InboundWebhookParser {
  readonly provider = DATA_CRAZY_V1_PROVIDER;
  readonly parserVersion = DATA_CRAZY_V1_PARSER_VERSION;

  parse(
    payload: unknown,
    context?: Readonly<InboundWebhookParserContext>,
  ): InboundWebhookParserResult {
    return parseDataCrazyV1Webhook(payload, context);
  }
}
