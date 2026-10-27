import type { IntegrationEventParsedSaleDto } from "@wpptrack/shared";
import type { InboundWebhookPayloadEncryptionService } from "./inbound-webhook-payload-encryption.service";
import {
  isSalesPlatformProvider,
  parseSaleEventV1,
} from "./providers/sales-platform-sale";

/**
 * Fase 6.5 (porte do SaaS #169/#170, sem a certificação): o que um recibo
 * guardado de uma URL única (IntegrationEndpointEvent) realmente trouxe e o
 * que o leitor leu dele. Usado por "Ver dados recebidos" (Conversões e
 * Integrações) e pelos Recebimentos do Backoffice. Só leitura: nada aqui muda
 * o envio. No nod o leitor de uma plataforma validada já entra certificado
 * (produção direta); o aluno não libera nem certifica nada.
 */

/** Stored receipt fields this module reads. */
export type IntegrationEventRecord = {
  id: string;
  workspaceId: string;
  integrationEndpointId: string;
  provider: string;
  status: string;
  reasonCode: string | null;
  currency: string | null;
  encryptedPayload: string | null;
  payloadIv: string | null;
  payloadTag: string | null;
  encryptionKeyVersion: number | null;
  payloadExpiresAt: Date;
};

export const integrationEventPayloadExpiredMessage =
  "Os dados recebidos já foram apagados (ficam guardados com criptografia por tempo limitado). O resumo lido continua abaixo.";
export const integrationEventPayloadUnreadableMessage =
  "Os dados recebidos não puderam ser abertos.";

/**
 * Keys never shown, at any depth: account keys of the platforms (Braip
 * `basic_authentication` is already dropped before storage; Payt
 * `integration_key`; Yampi `x-yampi-hmac-sha256` and the whole `login_url`,
 * fase 6.7; Hotmart keys for the next phase) and any credential-like field.
 */
const sensitiveKeyPattern =
  /^(basic_authentication|hottok|x-hotmart-hottok|x-yampi-hmac-sha256|integration_key|integrationkey|chave_unica|token|access_token|refresh_token|api_key|apikey|api_token|secret|client_secret|webhook_secret|password|senha|authorization|signature|hmac|card_number|cvv|login_url)$/iu;
export const maskedValue = "[oculto]";

/**
 * Credentials carried inside URLs (`token`, `customerToken`, `store_token`,
 * `access_token`, `api_key`): the link could open the buyer's account or the
 * store, so the value is hidden.
 */
const sensitiveUrlParamPattern =
  /([?&](?:token|customerToken|customer_token|store_token|access_token|api_key|apikey)=)[^&#\s"]+/giu;

function maskSensitiveString(value: string): string {
  return value.replace(sensitiveUrlParamPattern, `$1${maskedValue}`);
}

export function maskSensitivePayload(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return maskSensitiveString(value);
  if (!value || typeof value !== "object" || depth > 12) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => maskSensitivePayload(entry, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      sensitiveKeyPattern.test(key)
        ? maskedValue
        : maskSensitivePayload(entry, depth + 1),
    ]),
  );
}

function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/gu, " "));
  } catch {
    return value;
  }
}

/** Last segment of a form key: `data[basic_authentication]` -> the key. */
function formKeyName(rawKey: string): string {
  const key = decodeSafely(rawKey);
  const segments = key.split(/[[\]]+/u).filter(Boolean);
  return segments.at(-1) ?? key;
}

/** Credentials of a percent-encoded URL inside a value (`%3Ftoken%3D...`). */
const encodedUrlParamPattern =
  /((?:%3F|%26)(?:token|customerToken|customer_token|store_token|access_token|api_key|apikey)%3D)[^&%\s"]+/giu;

/**
 * Non-JSON body (form-urlencoded, multipart, plain text): hide the value of
 * credential-like keys, same key list as the JSON masking, also when the key
 * is bracketed (`data[token]=`) or percent-encoded, and URL tokens (plain or
 * percent-encoded). Multipart parts named like a credential are hidden too.
 */
export function maskSensitiveText(text: string): string {
  const multipart = text.replace(
    /(name="([^"]+)"[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n)([^\r\n]*)/gu,
    (match, head: string, name: string) =>
      sensitiveKeyPattern.test(formKeyName(name))
        ? `${head}${maskedValue}`
        : match,
  );
  const pairs = multipart.replace(
    /([^&=\s?"]+)=([^&\s]*)/gu,
    (match, key: string) =>
      sensitiveKeyPattern.test(formKeyName(key))
        ? `${key}=${maskedValue}`
        : match,
  );
  return maskSensitiveString(pairs).replace(
    encodedUrlParamPattern,
    `$1${maskedValue}`,
  );
}

/** "••••1020": only the last 4 digits stay readable. */
export function maskPhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/gu, "");
  if (digits.length < 4) return null;
  return `••••${digits.slice(-4)}`;
}

export type DecryptedIntegrationEvent =
  | { ok: true; rawBody: Buffer; payload: unknown }
  | { ok: false; kind: "expired" | "unreadable" };

export function decryptIntegrationEvent(
  encryption: Pick<InboundWebhookPayloadEncryptionService, "decrypt">,
  event: IntegrationEventRecord,
  now = new Date(),
): DecryptedIntegrationEvent {
  if (
    event.payloadExpiresAt <= now ||
    !event.encryptedPayload ||
    !event.payloadIv ||
    !event.payloadTag ||
    event.encryptionKeyVersion === null
  ) {
    return { ok: false, kind: "expired" };
  }
  try {
    const rawBody = encryption.decrypt(
      {
        encryptedPayload: event.encryptedPayload,
        payloadIv: event.payloadIv,
        payloadTag: event.payloadTag,
        encryptionKeyVersion: event.encryptionKeyVersion,
      },
      {
        workspaceId: event.workspaceId,
        connectionId: `integration:${event.integrationEndpointId}`,
        deliveryId: event.id,
      },
    );
    return {
      ok: true,
      rawBody,
      payload: JSON.parse(rawBody.toString("utf8")) as unknown,
    };
  } catch {
    return { ok: false, kind: "unreadable" };
  }
}

/**
 * Backoffice viewer: like decryptIntegrationEvent, but a stored body that is
 * not JSON (a refused call: wrong Content-Type, broken JSON) comes back as
 * masked text instead of "unreadable".
 */
export function decryptIntegrationEventForViewer(
  encryption: Pick<InboundWebhookPayloadEncryptionService, "decrypt">,
  event: IntegrationEventRecord,
  now = new Date(),
):
  | { ok: true; payload: unknown; json: boolean }
  | { ok: false; kind: "expired" | "unreadable" | "absent" } {
  const neverStored =
    !event.encryptedPayload &&
    !event.payloadIv &&
    !event.payloadTag &&
    event.encryptionKeyVersion === null &&
    event.payloadExpiresAt > now;
  if (neverStored) return { ok: false, kind: "absent" };
  const decrypted = decryptIntegrationEvent(encryption, event, now);
  if (decrypted.ok) return { ok: true, payload: decrypted.payload, json: true };
  if (decrypted.kind === "expired") return decrypted;
  try {
    const rawBody = encryption.decrypt(
      {
        encryptedPayload: event.encryptedPayload!,
        payloadIv: event.payloadIv!,
        payloadTag: event.payloadTag!,
        encryptionKeyVersion: event.encryptionKeyVersion!,
      },
      {
        workspaceId: event.workspaceId,
        connectionId: `integration:${event.integrationEndpointId}`,
        deliveryId: event.id,
      },
    );
    return {
      ok: true,
      payload: maskSensitiveText(rawBody.toString("utf8").slice(0, 200_000)),
      json: false,
    };
  } catch {
    return { ok: false, kind: "unreadable" };
  }
}

export type ParsedIntegrationSale =
  | { ok: true; parsed: IntegrationEventParsedSaleDto }
  | { ok: false; errorCode: string; providerStatus: string | null };

/** Re-parse a stored sale payload with the current sales-platform parser. */
export function parseIntegrationSale(
  event: Pick<IntegrationEventRecord, "provider" | "currency">,
  payload: unknown,
): ParsedIntegrationSale {
  if (!isSalesPlatformProvider(event.provider)) {
    return {
      ok: false,
      errorCode: "integration_provider_unsupported",
      providerStatus: null,
    };
  }
  const result = parseSaleEventV1(event.provider, payload);
  if (!result.ok) {
    return {
      ok: false,
      errorCode: result.errorCode,
      providerStatus: result.providerStatus ?? null,
    };
  }
  const sale = result.value;
  return {
    ok: true,
    parsed: {
      eventName: sale.eventName,
      valueCents: sale.valueCents,
      // Same currency the receipt shows: the sale's own, else the one
      // recorded on the receipt (workspace "Moeda das conversões").
      currency: sale.currency ?? event.currency ?? null,
      valueSent: true,
      productCode: sale.product?.code ?? null,
      productName: sale.product?.name ?? null,
      offerCode: sale.offer?.code ?? null,
      offerName: sale.offer?.name ?? null,
      orderRef: sale.orderRef || null,
      occurredAt:
        sale.occurredAt instanceof Date &&
        !Number.isNaN(sale.occurredAt.getTime())
          ? sale.occurredAt.toISOString()
          : null,
      phoneMasked: maskPhone(sale.phone),
      providerStatus: sale.providerStatus ?? null,
      test: sale.test === true,
    },
  };
}
