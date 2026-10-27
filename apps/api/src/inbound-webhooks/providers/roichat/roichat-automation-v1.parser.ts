import { createHash } from "node:crypto";
import type { CurrencyCode } from "@wpptrack/shared";
import {
  parseRoichatPayload,
  roichatPurchaseFingerprint,
  type RoichatEventTime,
} from "./roichat-payload";

export const ROICHAT_AUTOMATION_V1_SCHEMA = "wpptrack.roichat.purchase.v1";
export const ROICHAT_AUTOMATION_V1_PARSER_VERSION = "automation-v1";
export const ROICHAT_AUTOMATION_V1_INVALID = "roichat_automation_v1_invalid_payload";
export const ROICHAT_AUTOMATION_V1_NOT_PURCHASE =
  "roichat_automation_v1_not_purchase";
/** Production duplicate reason: same lead, number, value and currency < 12h. */
export const ROICHAT_PURCHASE_REPEATED_REASON = "purchase_repeated_within_12h";
/** Repeat window of a ROI Chat purchase (owner decision, 25/10/2026). */
export const ROICHAT_PURCHASE_REPEAT_WINDOW_SECONDS = 12 * 60 * 60;

export type ParsedRoichatAutomationV1 = {
  provider: "roichat";
  automation: "purchase";
  eventName: "Purchase";
  /** Lead phone (PII; never in a persisted summary). */
  phone: string;
  hasCtwa: boolean;
  ctwaClid: string | null;
  /** `source_id` (ad id), for audit only: the lead's own ad attribution wins. */
  adId: string | null;
  /** `valor_venda` in cents; null = the rule's value is the fallback. */
  valueCents: number | null;
  currency: CurrencyCode | null;
  occurredAt: Date;
  eventTimeSource: RoichatEventTime["source"];
  /** Lead + value + currency digest (12h repeat guard; the number is added by the router). */
  purchaseFingerprint: string;
  externalExecutionKey: string;
};

export type RoichatAutomationV1ParseResult =
  | { ok: true; value: ParsedRoichatAutomationV1 }
  | {
      ok: false;
      errorCode:
        | typeof ROICHAT_AUTOMATION_V1_INVALID
        | typeof ROICHAT_AUTOMATION_V1_NOT_PURCHASE;
    };

/**
 * Occurrence key of a purchase. The ROI Chat `event_id` (always the phone)
 * is ignored and the contract has no order id: a purchase is the lead, the
 * value, the currency and its time. With `event_time` the time is the
 * payload's (a resend is the same occurrence forever); without it, the
 * arrival of the delivery (each arrival is a new occurrence and the 12h
 * repeat guard decides whether it is a repeat).
 */
function executionKey(input: {
  phone: string;
  valueCents: number | null;
  currency: string | null;
  time: RoichatEventTime;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        ROICHAT_AUTOMATION_V1_SCHEMA,
        input.phone,
        input.valueCents ?? null,
        input.currency ?? null,
        input.time.source === "payload" ? "event_time" : "received",
        input.time.occurredAt.toISOString(),
      ]),
      "utf8",
    )
    .digest("hex");
  return `roichat-purchase:${digest}`;
}

/**
 * Purchase of the ROI Chat number URL. `receivedAt` must be the delivery's
 * first arrival (live ingestion and every re-evaluation of the stored body),
 * so the occurrence key is stable.
 */
export function parseRoichatAutomationV1(
  payload: unknown,
  receivedAt: Date = new Date(),
): RoichatAutomationV1ParseResult {
  try {
    const body = parseRoichatPayload(payload, receivedAt);
    if (!body) return { ok: false, errorCode: ROICHAT_AUTOMATION_V1_INVALID };
    if (body.kind !== "purchase") {
      return { ok: false, errorCode: ROICHAT_AUTOMATION_V1_NOT_PURCHASE };
    }
    // A value/currency that is present but unreadable or unsupported is
    // never replaced by another value nor converted.
    if (body.moneyInvalid) {
      return { ok: false, errorCode: ROICHAT_AUTOMATION_V1_INVALID };
    }
    return {
      ok: true,
      value: {
        provider: "roichat",
        automation: "purchase",
        eventName: "Purchase",
        phone: body.phone,
        hasCtwa: body.ctwaClid !== null,
        ctwaClid: body.ctwaClid,
        adId: body.adId,
        valueCents: body.valueCents,
        currency: body.currency,
        occurredAt: body.time.occurredAt,
        eventTimeSource: body.time.source,
        purchaseFingerprint: roichatPurchaseFingerprint(body),
        externalExecutionKey: executionKey({
          phone: body.phone,
          valueCents: body.valueCents,
          currency: body.currency,
          time: body.time,
        }),
      },
    };
  } catch {
    return { ok: false, errorCode: ROICHAT_AUTOMATION_V1_INVALID };
  }
}
