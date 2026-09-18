import {
  buildInboundWebhookEventDedupeKey,
  type InboundWebhookParser,
  type InboundWebhookParserResult,
  type ParsedInboundWebhookEvent,
} from "../inbound-webhook-parser";
import { parseGupshupV1Webhook } from "../gupshup/gupshup-v1.parser";

export const META_CLOUD_V1_PROVIDER = "meta_cloud";
export const META_CLOUD_V1_PARSER_VERSION = "v1";

const invalidPayloadError = {
  code: "meta_cloud_v1_invalid_payload",
  message: "Inbound webhook payload failed validation",
} as const;

/**
 * Meta Cloud and Gupshup's WhatsApp Cloud forwarding use the same Cloud API
 * message envelope. Keep the strict field validation and CTWA-only policy in
 * one implementation, while this adapter gives Meta its own provider identity
 * and ensures WABA (`entry.id`) is always the organization identity.
 */
function withoutGupshupApplicationId(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  const envelope = payload as Record<string, unknown>;
  const { gs_app_id: _gsAppId, ...metaEnvelope } = envelope;

  return metaEnvelope;
}

function toMetaCloudEvent(
  event: ParsedInboundWebhookEvent,
): ParsedInboundWebhookEvent {
  return {
    ...event,
    provider: META_CLOUD_V1_PROVIDER,
    dedupeKey: buildInboundWebhookEventDedupeKey({
      provider: META_CLOUD_V1_PROVIDER,
      organizationId: event.organizationId,
      providerChannelId: event.channel.providerChannelId,
      externalMessageId: event.externalMessageId,
    }),
    normalizedSummary: {
      ...event.normalizedSummary,
      provider: META_CLOUD_V1_PROVIDER,
    },
  };
}

export function parseMetaCloudV1Webhook(
  payload: unknown,
): InboundWebhookParserResult {
  const parsed = parseGupshupV1Webhook(withoutGupshupApplicationId(payload));
  const events = parsed.events.map(toMetaCloudEvent);
  const error =
    parsed.classification === "invalid_payload"
      ? { ...invalidPayloadError }
      : null;

  return {
    ...parsed,
    provider: META_CLOUD_V1_PROVIDER,
    parserVersion: META_CLOUD_V1_PARSER_VERSION,
    events,
    normalizedSummary: {
      ...parsed.normalizedSummary,
      provider: META_CLOUD_V1_PROVIDER,
      parserVersion: META_CLOUD_V1_PARSER_VERSION,
    },
    error,
  };
}

export class MetaCloudV1Parser implements InboundWebhookParser {
  readonly provider = META_CLOUD_V1_PROVIDER;
  readonly parserVersion = META_CLOUD_V1_PARSER_VERSION;

  parse(payload: unknown): InboundWebhookParserResult {
    return parseMetaCloudV1Webhook(payload);
  }
}
