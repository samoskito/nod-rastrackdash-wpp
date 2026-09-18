import { createHash } from "node:crypto";

export type InboundWebhookDeliveryIdentity = {
  ingressKey: string;
  externalDeliveryId: string | null;
  providerEventType: string | null;
  identitySource:
    "provider_event_id" | "provider_message_id" | "raw_body_sha256";
};

export function rawBodyDeliveryIdentity(
  rawBody: Buffer,
  providerEventType: string | null = null,
): InboundWebhookDeliveryIdentity {
  return {
    ingressKey: `raw:${createHash("sha256").update(rawBody).digest("hex")}`,
    externalDeliveryId: null,
    providerEventType,
    identitySource: "raw_body_sha256",
  };
}

export function boundedString(
  value: unknown,
  maximumLength: number,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();

  if (
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    return null;
  }

  return normalized;
}
