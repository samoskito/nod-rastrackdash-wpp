import { createHash } from "node:crypto";
import {
  boundedString,
  rawBodyDeliveryIdentity,
  type InboundWebhookDeliveryIdentity,
} from "../inbound-webhook-delivery-identity";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

/**
 * Meta retries a messages notification with the same wamid. Prefer that
 * stable provider identity over a raw payload hash, which can differ when a
 * delivery bundles multiple changes. Invalid/unrecognized shapes retain the
 * safe raw-body fallback and are later classified by the parser.
 */
export function extractMetaCloudV1DeliveryIdentity(
  rawBody: Buffer,
): InboundWebhookDeliveryIdentity {
  try {
    const envelope = asRecord(JSON.parse(rawBody.toString("utf8")));

    if (envelope?.object !== "whatsapp_business_account") {
      return rawBodyDeliveryIdentity(rawBody);
    }

    const messageIds: string[] = [];
    const entries = Array.isArray(envelope.entry) ? envelope.entry : [];

    for (const entryValue of entries) {
      const entry = asRecord(entryValue);
      const changes =
        entry && Array.isArray(entry.changes) ? entry.changes : [];

      for (const changeValue of changes) {
        const change = asRecord(changeValue);

        if (change?.field !== "messages") {
          continue;
        }

        const value = asRecord(change.value);
        const messages =
          value && Array.isArray(value.messages) ? value.messages : [];

        for (const messageValue of messages) {
          const message = asRecord(messageValue);
          const messageId = message ? boundedString(message.id, 255) : null;

          if (messageId) {
            messageIds.push(messageId);
          }
        }
      }
    }

    const uniqueMessageIds = [...new Set(messageIds)].sort();

    if (uniqueMessageIds.length === 0) {
      return rawBodyDeliveryIdentity(rawBody, "messages");
    }

    if (uniqueMessageIds.length === 1) {
      return {
        ingressKey: `wamid:${uniqueMessageIds[0]}`,
        externalDeliveryId: uniqueMessageIds[0],
        providerEventType: "messages",
        identitySource: "provider_message_id",
      };
    }

    return {
      ingressKey: `wamids:${createHash("sha256")
        .update(JSON.stringify(uniqueMessageIds), "utf8")
        .digest("hex")}`,
      externalDeliveryId: null,
      providerEventType: "messages",
      identitySource: "provider_message_id",
    };
  } catch {
    return rawBodyDeliveryIdentity(rawBody);
  }
}
