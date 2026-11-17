import { createHash } from "node:crypto";
import { boundedString } from "../inbound-webhook-delivery-identity";

/**
 * GoHighLevel `automation-v1`: the Webhook action (POST) of a Workflow step
 * calls the rule's URL (one URL per rule/event, same model as the Unnichat
 * automation). Accepted bodies: the raw GHL JSON or the n8n capture envelope
 * `[ { headers, body } ]` (same unwrap as `gohighlevel/v1`).
 *
 * Read fields: lead `phone`, `contact_id`, the CTWA click (`ctwa_clid`) and
 * ad id (`adId`) of `contact.attributionSource` first, then
 * `contact.lastAttributionSource` (a source only counts when it carries the
 * click, exactly like the entry parser), `workflow.id`/`name` and
 * `location.id` (the client's GHL location = the connected number).
 *
 * Time: `date_created` is the CONTACT's creation date, never the event time.
 * The conversion time is the arrival of the call (`receivedAt`), never a
 * future time; Meta's 7-day window is enforced downstream as for every
 * automation.
 *
 * Deduplication (externalExecutionKey):
 *  - the same contact in the same workflow (same location) is the SAME
 *    conversion: a GHL retry or a second pass of the contact through that
 *    step never sends twice;
 *  - different workflows produce different conversions;
 *  - when the call carries a trigger identifier (`triggerData.id`, optional;
 *    PENDENTE: not seen in a real payload yet, where `triggerData` came
 *    empty) it is part of the key, so each distinct trigger is its own
 *    conversion.
 * Lifetime events (Lead, QualifiedLead) are still sent once per lead and
 * click by the production dedupe, whatever the workflow.
 */
export const GOHIGHLEVEL_AUTOMATION_V1_SCHEMA =
  "wpptrack.gohighlevel.automation.v1";
export const GOHIGHLEVEL_AUTOMATION_V1_PARSER_VERSION = "automation-v1";
export const GOHIGHLEVEL_AUTOMATION_V1_INVALID =
  "gohighlevel_automation_v1_invalid_payload" as const;

export type ParsedGoHighLevelAutomationV1 = {
  /** Lead phone (PII; never in a persisted summary). */
  phone: string;
  hasCtwa: boolean;
  ctwaClid: string | null;
  /** Ad id of the same attribution source; null = page/pixel fallback. */
  adId: string | null;
  contactId: string;
  /** GHL location.id: the connection/number the router binds the call to. */
  locationId: string;
  workflowId: string;
  workflowName: string | null;
  triggerId: string | null;
  /** Arrival of the call (never `date_created`, never in the future). */
  occurredAt: Date;
  externalExecutionKey: string;
};

export type GoHighLevelAutomationV1ParseResult =
  | { ok: true; value: ParsedGoHighLevelAutomationV1 }
  | { ok: false; errorCode: typeof GOHIGHLEVEL_AUTOMATION_V1_INVALID };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Raw GHL body, or the n8n envelope `[ { headers, body } ]`. */
export function unwrapGoHighLevelBody(
  payload: unknown,
): Record<string, unknown> | null {
  const direct = asRecord(payload);
  if (direct) return direct;
  if (!Array.isArray(payload) || payload.length !== 1) return null;
  const envelope = asRecord(payload[0]);
  return envelope ? asRecord(envelope.body) : null;
}

type Source = { valid: boolean; ctwaClid: string | null; adId: string | null };

function optional(value: unknown, maximumLength: number): {
  valid: boolean;
  value: string | null;
} {
  if (value === null || value === undefined) return { valid: true, value: null };
  if (typeof value !== "string") return { valid: false, value: null };
  if (value.trim().length === 0) return { valid: true, value: null };
  const bounded = boundedString(value.trim(), maximumLength);
  return bounded ? { valid: true, value: bounded } : { valid: false, value: null };
}

function attribution(value: unknown): Source {
  if (value === null || value === undefined)
    return { valid: true, ctwaClid: null, adId: null };
  const source = asRecord(value);
  if (!source) return { valid: false, ctwaClid: null, adId: null };
  const ctwaClid = optional(source.ctwa_clid, 2_048);
  const adId = optional(source.adId, 255);
  if (!ctwaClid.valid || !adId.valid)
    return { valid: false, ctwaClid: null, adId: null };
  // The ad id only counts together with the click of the SAME source.
  return ctwaClid.value
    ? { valid: true, ctwaClid: ctwaClid.value, adId: adId.value }
    : { valid: true, ctwaClid: null, adId: null };
}

function executionKey(input: {
  locationId: string;
  workflowId: string;
  contactId: string;
  triggerId: string | null;
}): string {
  const digest = createHash("sha256")
    .update(GOHIGHLEVEL_AUTOMATION_V1_SCHEMA, "utf8")
    .update("\0", "utf8")
    .update(input.locationId, "utf8")
    .update("\0", "utf8")
    .update(input.workflowId, "utf8")
    .update("\0", "utf8")
    .update(input.contactId, "utf8")
    .update("\0", "utf8")
    .update(input.triggerId ?? "", "utf8")
    .digest("hex");
  return `gohighlevel-automation:${digest}`;
}

export function parseGoHighLevelAutomationV1(
  payload: unknown,
  receivedAt: Date = new Date(),
): GoHighLevelAutomationV1ParseResult {
  const invalid = {
    ok: false as const,
    errorCode: GOHIGHLEVEL_AUTOMATION_V1_INVALID,
  };
  try {
    const body = unwrapGoHighLevelBody(payload);
    if (!body) return invalid;
    const phone = boundedString(body.phone, 256);
    const contactId = boundedString(body.contact_id, 255);
    const location = asRecord(body.location);
    const workflow = asRecord(body.workflow);
    const locationId = boundedString(location?.id, 255);
    const workflowId = boundedString(workflow?.id, 255);
    const workflowName = optional(workflow?.name, 160);
    const triggerId = optional(asRecord(body.triggerData)?.id, 255);
    const contact = asRecord(body.contact);
    const first = attribution(contact?.attributionSource);
    const last = attribution(contact?.lastAttributionSource);
    if (
      !phone ||
      !contactId ||
      !locationId ||
      !workflowId ||
      !workflowName.valid ||
      !triggerId.valid ||
      !first.valid ||
      !last.valid
    )
      return invalid;
    const source = first.ctwaClid ? first : last;
    // Never a future time (a clock skew of the stored arrival is clamped).
    const now = Date.now();
    const occurredAt = new Date(
      Number.isFinite(receivedAt.getTime())
        ? Math.min(receivedAt.getTime(), now)
        : now,
    );

    return {
      ok: true,
      value: {
        phone,
        hasCtwa: source.ctwaClid !== null,
        ctwaClid: source.ctwaClid,
        adId: source.adId,
        contactId,
        locationId,
        workflowId,
        workflowName: workflowName.value,
        triggerId: triggerId.value,
        occurredAt,
        externalExecutionKey: executionKey({
          locationId,
          workflowId,
          contactId,
          triggerId: triggerId.value,
        }),
      },
    };
  } catch {
    return invalid;
  }
}
