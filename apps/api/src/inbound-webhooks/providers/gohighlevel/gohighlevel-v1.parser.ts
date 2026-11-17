import { boundedString } from "../inbound-webhook-delivery-identity";
import {
  buildInboundWebhookEventDedupeKey,
  type InboundWebhookDeliveryNormalizedSummary,
  type InboundWebhookEventClassification,
  type InboundWebhookEventNormalizedSummary,
  type InboundWebhookParser,
  type InboundWebhookParserContext,
  type InboundWebhookParserResult,
  type ParsedInboundWebhookAd,
  type ParsedInboundWebhookEvent,
} from "../inbound-webhook-parser";

export const GOHIGHLEVEL_V1_PROVIDER = "gohighlevel";
export const GOHIGHLEVEL_V1_PARSER_VERSION = "v1";

const invalidPayloadError = {
  code: "gohighlevel_v1_invalid_payload",
  message: "Inbound webhook payload failed validation",
} as const;

type OptionalString = { valid: boolean; value: string | null };

type Attribution = {
  ctwaClid: string | null;
  adId: string | null;
  ad: ParsedInboundWebhookAd | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown, maximumLength: number): OptionalString {
  if (value === null || value === undefined) {
    return { valid: true, value: null };
  }
  if (typeof value !== "string") return { valid: false, value: null };
  const normalized = value.trim();
  if (normalized.length === 0) return { valid: true, value: null };
  const bounded = boundedString(normalized, maximumLength);
  return bounded
    ? { valid: true, value: bounded }
    : { valid: false, value: null };
}

function parseOccurredAt(value: unknown): { raw: string; date: Date } | null {
  const raw = boundedString(value, 80);
  if (!raw) return null;
  const milliseconds = Date.parse(raw);
  return Number.isFinite(milliseconds)
    ? { raw, date: new Date(milliseconds) }
    : null;
}

function parseAttribution(value: unknown): Attribution | null {
  if (value === null || value === undefined) {
    return { ctwaClid: null, adId: null, ad: null };
  }
  const source = asRecord(value);
  if (!source) return null;

  const ctwaClid = optionalString(source.ctwa_clid, 2_048);
  const adId = optionalString(source.adId, 255);
  const sourceUrl = optionalString(source.url, 4_096);
  const title = optionalString(source.adName, 512);
  if (![ctwaClid, adId, sourceUrl, title].every((field) => field.valid)) {
    return null;
  }

  // Attribution data is retained only when this exact nested source supplied CTWA.
  if (!ctwaClid.value) {
    return { ctwaClid: null, adId: null, ad: null };
  }

  return {
    ctwaClid: ctwaClid.value,
    adId: adId.value,
    ad: {
      sourceUrl: sourceUrl.value,
      description: null,
      title: title.value,
      thumbnailUrl: null,
      mediaUrl: null,
      sourceType: null,
    },
  };
}

function summary(input: {
  providerEventType: string | null;
  externalDeliveryId: string | null;
  classification: InboundWebhookEventClassification;
  classificationReason: string;
  eventCount: number;
}): InboundWebhookDeliveryNormalizedSummary {
  return {
    provider: GOHIGHLEVEL_V1_PROVIDER,
    parserVersion: GOHIGHLEVEL_V1_PARSER_VERSION,
    ...input,
  };
}

function invalidResult(
  classificationReason: string,
): InboundWebhookParserResult {
  return {
    provider: GOHIGHLEVEL_V1_PROVIDER,
    parserVersion: GOHIGHLEVEL_V1_PARSER_VERSION,
    providerEventType: null,
    externalDeliveryId: null,
    classification: "invalid_payload",
    classificationReason,
    events: [],
    normalizedSummary: summary({
      providerEventType: null,
      externalDeliveryId: null,
      classification: "invalid_payload",
      classificationReason,
      eventCount: 0,
    }),
    error: { ...invalidPayloadError },
  };
}

function unwrap(payload: unknown): Record<string, unknown> | null {
  const direct = asRecord(payload);
  if (direct) return direct;

  // n8n's captured webhook envelope wraps the original GHL JSON in array[0].body.
  if (!Array.isArray(payload) || payload.length !== 1) return null;
  const envelope = asRecord(payload[0]);
  return envelope ? asRecord(envelope.body) : null;
}

function externalMessageId(
  contactId: string,
  dateCreated: string,
  workflowId: string,
): string {
  return `${contactId}:${dateCreated}:${workflowId}`;
}

function parsePayload(
  payload: unknown,
  context: InboundWebhookParserContext | undefined,
): InboundWebhookParserResult {
  const organizationId = boundedString(context?.organizationId, 255);
  if (!organizationId) return invalidResult("organization_context_missing");

  // This value is a connection bind. Do not read a phone number from GHL JSON.
  const connectedPhone = boundedString(context?.connectedPhone, 256);
  if (!connectedPhone) return invalidResult("connected_phone_context_missing");

  const body = unwrap(payload);
  if (!body) return invalidResult("payload_envelope_unsupported");

  const contactId = boundedString(body.contact_id, 255);
  const contactPhone = boundedString(body.phone, 256);
  const occurred = parseOccurredAt(body.date_created);
  const location = asRecord(body.location);
  const workflow = asRecord(body.workflow);
  const providerChannelId = boundedString(location?.id, 255);
  const channelName = optionalString(location?.name, 160);
  const workflowId = boundedString(workflow?.id, 255);
  const contactName = optionalString(body.full_name, 160);
  const contact = asRecord(body.contact);
  const attributionSource = parseAttribution(contact?.attributionSource);
  const lastAttributionSource = parseAttribution(
    contact?.lastAttributionSource,
  );

  if (
    !contactId ||
    !contactPhone ||
    !occurred ||
    !providerChannelId ||
    !workflowId ||
    !contact ||
    !channelName.valid ||
    !contactName.valid ||
    !attributionSource ||
    !lastAttributionSource
  ) {
    return invalidResult("payload_validation_failed");
  }

  const attribution = attributionSource.ctwaClid
    ? attributionSource
    : lastAttributionSource;
  const hasCtwa = attribution.ctwaClid !== null;
  const classification: InboundWebhookEventClassification = hasCtwa
    ? "eligible_route_unresolved"
    : "ignored_no_ctwa";
  const classificationReason = hasCtwa
    ? "route_resolution_pending"
    : "ctwa_missing";
  const eventId = externalMessageId(contactId, occurred.raw, workflowId);
  const normalizedSummary: InboundWebhookEventNormalizedSummary = {
    provider: GOHIGHLEVEL_V1_PROVIDER,
    providerEventType: "workflow_contact",
    externalEventId: eventId,
    externalMessageId: eventId,
    organizationId,
    providerChannelId,
    connectedPhoneSuffix: connectedPhone.slice(-4),
    occurredAt: occurred.date.toISOString(),
    adId: attribution.adId,
    hasCtwa,
    messageDirection: "inbound",
    messageAuthorType: "contact",
    messageType: null,
    classification,
    classificationReason,
  };
  const event: ParsedInboundWebhookEvent = {
    provider: GOHIGHLEVEL_V1_PROVIDER,
    providerEventType: "workflow_contact",
    externalEventId: eventId,
    externalMessageId: eventId,
    dedupeKey: buildInboundWebhookEventDedupeKey({
      provider: GOHIGHLEVEL_V1_PROVIDER,
      organizationId,
      providerChannelId,
      externalMessageId: eventId,
    }),
    organizationId,
    occurredAt: occurred.date,
    channel: {
      providerChannelId,
      connectedPhone,
      name: channelName.value,
    },
    contact: {
      externalContactId: contactId,
      phoneNumber: contactPhone,
      name: contactName.value,
    },
    message: {
      direction: "inbound",
      authorType: "contact",
      messageType: null,
      text: null,
      isPrivate: false,
    },
    adId: attribution.adId,
    ad: attribution.ad,
    ctwaClid: attribution.ctwaClid,
    hasCtwa,
    classification,
    classificationReason,
    normalizedSummary,
  };

  return {
    provider: GOHIGHLEVEL_V1_PROVIDER,
    parserVersion: GOHIGHLEVEL_V1_PARSER_VERSION,
    providerEventType: "workflow_contact",
    externalDeliveryId: eventId,
    classification,
    classificationReason,
    events: [event],
    normalizedSummary: summary({
      providerEventType: "workflow_contact",
      externalDeliveryId: eventId,
      classification,
      classificationReason,
      eventCount: 1,
    }),
    error: null,
  };
}

export function parseGoHighLevelV1Webhook(
  payload: unknown,
  context?: InboundWebhookParserContext,
): InboundWebhookParserResult {
  try {
    return parsePayload(payload, context);
  } catch {
    return invalidResult("payload_validation_failed");
  }
}

export class GoHighLevelV1Parser implements InboundWebhookParser {
  readonly provider = GOHIGHLEVEL_V1_PROVIDER;
  readonly parserVersion = GOHIGHLEVEL_V1_PARSER_VERSION;

  parse(
    payload: unknown,
    context?: InboundWebhookParserContext,
  ): InboundWebhookParserResult {
    return parseGoHighLevelV1Webhook(payload, context);
  }
}
