import { createHash } from "node:crypto";
import { boundedString } from "../inbound-webhook-delivery-identity";
import {
  buildInboundWebhookEventDedupeKey,
  type InboundWebhookDeliveryNormalizedSummary,
  type InboundWebhookEventClassification,
  type InboundWebhookEventNormalizedSummary,
  type InboundWebhookParser,
  type InboundWebhookParserContext,
  type InboundWebhookParserResult,
  type ParsedInboundWebhookEvent,
} from "../inbound-webhook-parser";
import {
  parseRoichatPayload,
  ROICHAT_PROVIDER,
  unwrapRoichatBody,
} from "./roichat-payload";

export const ROICHAT_V1_PROVIDER = ROICHAT_PROVIDER;
export const ROICHAT_V1_PARSER_VERSION = "v1";
/** Provider event type of a lead entry (the payload has no event field). */
export const ROICHAT_ENTRY_EVENT_TYPE = "lead.entry";
/** A purchase that reached the number URL without a rule to own it. */
export const ROICHAT_PURCHASE_WITHOUT_RULE_REASON =
  "roichat_purchase_without_rule";
export const ROICHAT_EVENT_NOT_SUPPORTED_REASON = "roichat_event_not_supported";

const invalidPayloadError = {
  code: "roichat_v1_invalid_payload",
  message: "Inbound webhook payload failed validation",
} as const;

function sha256(...parts: string[]): string {
  const hash = createHash("sha256");
  parts.forEach((part, index) => {
    if (index > 0) hash.update("\0", "utf8");
    hash.update(part, "utf8");
  });
  return hash.digest("hex");
}

function summary(input: {
  providerEventType: string | null;
  externalDeliveryId: string | null;
  classification: InboundWebhookEventClassification;
  classificationReason: string;
  eventCount: number;
}): InboundWebhookDeliveryNormalizedSummary {
  return {
    provider: ROICHAT_V1_PROVIDER,
    parserVersion: ROICHAT_V1_PARSER_VERSION,
    ...input,
  };
}

function deliveryOnly(input: {
  providerEventType: string | null;
  classification: InboundWebhookEventClassification;
  classificationReason: string;
  error?: typeof invalidPayloadError;
}): InboundWebhookParserResult {
  return {
    provider: ROICHAT_V1_PROVIDER,
    parserVersion: ROICHAT_V1_PARSER_VERSION,
    providerEventType: input.providerEventType,
    externalDeliveryId: null,
    classification: input.classification,
    classificationReason: input.classificationReason,
    events: [],
    normalizedSummary: summary({
      providerEventType: input.providerEventType,
      externalDeliveryId: null,
      classification: input.classification,
      classificationReason: input.classificationReason,
      eventCount: 0,
    }),
    error: input.error ? { ...input.error } : null,
  };
}

function invalidResult(reason: string): InboundWebhookParserResult {
  return deliveryOnly({
    providerEventType: null,
    classification: "invalid_payload",
    classificationReason: reason,
    error: invalidPayloadError,
  });
}

function parsePayload(
  payload: unknown,
  context: InboundWebhookParserContext | undefined,
): InboundWebhookParserResult {
  const organizationId = boundedString(context?.organizationId, 255);
  if (!organizationId) return invalidResult("organization_context_missing");
  // The number is bound by the connection (one URL per number), never read
  // from the provider JSON: a URL can only ever attribute to its own number.
  const connectedPhone = boundedString(context?.connectedPhone, 256);
  if (!connectedPhone) return invalidResult("connected_phone_context_missing");
  if (!unwrapRoichatBody(payload)) {
    return invalidResult("payload_envelope_unsupported");
  }

  const receivedAt =
    context?.receivedAt instanceof Date &&
    Number.isFinite(context.receivedAt.getTime())
      ? context.receivedAt
      : new Date();
  const body = parseRoichatPayload(payload, receivedAt);
  if (!body) return invalidResult("payload_validation_failed");

  // A purchase is owned by the rule "Compra no ROI Chat" (routed before this
  // parser). One that reaches it had no active rule: kept for audit only,
  // never a lead entry (it would send a LeadSubmitted at purchase time).
  if (body.kind === "purchase") {
    return deliveryOnly({
      providerEventType: "purchase",
      classification: "unsupported_event",
      classificationReason: ROICHAT_PURCHASE_WITHOUT_RULE_REASON,
    });
  }
  if (body.kind === "other_event") {
    return deliveryOnly({
      providerEventType: "other_event",
      classification: "unsupported_event",
      classificationReason: ROICHAT_EVENT_NOT_SUPPORTED_REASON,
    });
  }

  const hasCtwa = body.ctwaClid !== null;
  const classification: InboundWebhookEventClassification = hasCtwa
    ? "eligible_route_unresolved"
    : "ignored_no_ctwa";
  const classificationReason = hasCtwa
    ? "route_resolution_pending"
    : "ctwa_missing";
  // No message id in the contract: the click (ctwa_clid) of the lead is the
  // entry identity, so a resent entry is the same event. Without a click the
  // entry is only counted as "sem anuncio" (never sent).
  const ctwaEntryIdentityHash = body.ctwaClid
    ? sha256(body.ctwaClid)
    : undefined;
  const externalId = body.ctwaClid
    ? `ctwa:${sha256(body.phone, body.ctwaClid)}`
    : `noctwa:${sha256(body.phone, JSON.stringify(unwrapRoichatBody(payload)))}`;
  const contactId = `contact:${sha256(body.phone)}`;
  const occurredAt = body.time.occurredAt;
  const normalizedSummary: InboundWebhookEventNormalizedSummary = {
    provider: ROICHAT_V1_PROVIDER,
    providerEventType: ROICHAT_ENTRY_EVENT_TYPE,
    externalEventId: externalId,
    externalMessageId: externalId,
    organizationId,
    providerChannelId: connectedPhone,
    connectedPhoneSuffix: connectedPhone.replace(/\D/gu, "").slice(-4),
    occurredAt: occurredAt.toISOString(),
    adId: body.adId,
    hasCtwa,
    ...(ctwaEntryIdentityHash ? { ctwaEntryIdentityHash } : {}),
    messageDirection: "inbound",
    messageAuthorType: "contact",
    messageType: null,
    classification,
    classificationReason,
  };
  const event: ParsedInboundWebhookEvent = {
    provider: ROICHAT_V1_PROVIDER,
    providerEventType: ROICHAT_ENTRY_EVENT_TYPE,
    externalEventId: externalId,
    externalMessageId: externalId,
    dedupeKey: buildInboundWebhookEventDedupeKey({
      provider: ROICHAT_V1_PROVIDER,
      organizationId,
      providerChannelId: connectedPhone,
      externalMessageId: externalId,
    }),
    organizationId,
    occurredAt,
    channel: {
      providerChannelId: connectedPhone,
      connectedPhone,
      name: null,
    },
    contact: {
      externalContactId: contactId,
      phoneNumber: body.phone,
      name: body.contactName,
    },
    message: {
      direction: "inbound",
      authorType: "contact",
      messageType: null,
      text: null,
      isPrivate: false,
    },
    adId: body.adId,
    ad: body.ad
      ? {
          sourceUrl: body.ad.sourceUrl,
          description: body.ad.description,
          title: body.ad.title,
          thumbnailUrl: body.ad.thumbnailUrl,
          mediaUrl: body.ad.mediaUrl,
          sourceType: body.ad.sourceType,
        }
      : null,
    ctwaClid: body.ctwaClid,
    hasCtwa,
    classification,
    classificationReason,
    normalizedSummary,
  };

  return {
    provider: ROICHAT_V1_PROVIDER,
    parserVersion: ROICHAT_V1_PARSER_VERSION,
    providerEventType: ROICHAT_ENTRY_EVENT_TYPE,
    externalDeliveryId: externalId,
    classification,
    classificationReason,
    events: [event],
    normalizedSummary: summary({
      providerEventType: ROICHAT_ENTRY_EVENT_TYPE,
      externalDeliveryId: externalId,
      classification,
      classificationReason,
      eventCount: 1,
    }),
    error: null,
  };
}

export function parseRoichatV1Webhook(
  payload: unknown,
  context?: InboundWebhookParserContext,
): InboundWebhookParserResult {
  try {
    return parsePayload(payload, context);
  } catch {
    return invalidResult("payload_validation_failed");
  }
}

export class RoichatV1Parser implements InboundWebhookParser {
  readonly provider = ROICHAT_V1_PROVIDER;
  readonly parserVersion = ROICHAT_V1_PARSER_VERSION;

  parse(
    payload: unknown,
    context?: InboundWebhookParserContext,
  ): InboundWebhookParserResult {
    return parseRoichatV1Webhook(payload, context);
  }
}
