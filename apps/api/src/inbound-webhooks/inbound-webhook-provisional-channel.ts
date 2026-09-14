/**
 * Provisional channel identity strategy (P0.2).
 *
 * A student must be able to register a channel/number the moment a
 * Umbler/Gupshup connection exists, before any inbound webhook has arrived.
 * The InboundWebhookChannel schema requires organizationId + providerChannelId
 * (the provider's own identifiers), which do not exist yet at that point.
 *
 * Instead of a migration to make those columns nullable, manually created
 * channels get stable, clearly-marked placeholder identifiers derived from
 * the connection and the normalized phone. The unique index is
 * (connectionId, organizationId, providerChannelId), so these placeholders
 * never collide with a real provider identity or with another connection.
 *
 * When the real webhook later arrives for the same connection + normalized
 * phone, inbound-webhook-observation.service.ts looks up the channel by this
 * exact placeholder providerChannelId and updates it in place (same row id),
 * instead of inserting a second channel — see mergeProvisionalChannel there.
 */
const provisionalIdentityPrefix = "provisional:";

export function isProvisionalProviderChannelId(
  providerChannelId: string,
): boolean {
  return providerChannelId.startsWith(provisionalIdentityPrefix);
}

export function provisionalChannelOrganizationId(connectionId: string): string {
  return `${provisionalIdentityPrefix}${connectionId}`;
}

export function provisionalChannelProviderChannelId(
  normalizedPhone: string,
): string {
  return `${provisionalIdentityPrefix}${normalizedPhone}`;
}
