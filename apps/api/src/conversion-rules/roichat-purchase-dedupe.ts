import type { ProviderConversionDecisionOccurrenceDto } from "@wpptrack/shared";
import { ROICHAT_PURCHASE_REPEAT_WINDOW_SECONDS } from "../inbound-webhooks/providers/roichat/roichat-automation-v1.parser";
import type { ProviderConversionDecisionInput } from "./provider-conversion-decision.types";

/**
 * Business dedupe of a ROI Chat purchase (owner decision, 25/10/2026).
 *
 * The ROI Chat contract has no order/product id and its `event_id` is always
 * the lead's phone (ignored). So:
 *  - REPURCHASE IS ALLOWED: the same person may buy more than once; the
 *    historical 24h "same lead, same number" Purchase window of the other
 *    WhatsApp automations would silence a real second sale, so it does not
 *    apply here;
 *  - a purchase is a DUPLICATE only when the same lead buys again on the same
 *    number with the same value and currency within 12 hours (the resend of
 *    one purchase). Another value/currency or more than 12h later is a new
 *    purchase.
 *
 * The scope key therefore adds the observed value and currency to the
 * per-number lead key, and the window is 12h. Production enforces it under
 * its advisory lock (provider-conversion-production.service.ts,
 * duplicateWhere); ingestion also drops a repeat within 12h before any
 * observation (findRoichatRepeatedPurchase).
 *
 * The lead lifetime guard (lead-lifetime-conversion-guard.ts, PR #153) only
 * covers once-per-lead events (LeadSubmitted, QualifiedLead): it never
 * blocks a Purchase, so it does not block a ROI Chat repurchase either.
 */
export function roichatPurchaseDedupePolicy(
  input: ProviderConversionDecisionInput,
): NonNullable<
  ProviderConversionDecisionOccurrenceDto["businessDedupePolicy"]
> | null {
  if (
    input.occurrence.source !== "automation" ||
    input.occurrence.provider !== "roichat" ||
    input.rule.eventName !== "Purchase" ||
    input.leadResolution.status !== "resolved"
  ) {
    return null;
  }
  const scopeKey = [
    input.rule.eventName,
    input.occurrence.workspaceId,
    input.occurrence.connectionId,
    input.occurrence.channelId ?? "unresolved-channel",
    input.leadResolution.lead.id,
    `value:${input.occurrence.observedValueCents ?? "none"}`,
    `currency:${input.occurrence.observedCurrency ?? "none"}`,
  ].join(":");
  return {
    mode: "rolling_window",
    scopeKey,
    windowSeconds: ROICHAT_PURCHASE_REPEAT_WINDOW_SECONDS,
  };
}
