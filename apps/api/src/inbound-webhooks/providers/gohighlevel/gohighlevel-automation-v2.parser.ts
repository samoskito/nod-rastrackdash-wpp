import { createHash } from "node:crypto";
import {
  conversionEventCarriesValue,
  conversionEventDedupeMode,
  conversionEventNameSchema,
  conversionEventRequiresValue,
  type ConversionEventNameDto,
  type CurrencyCode,
} from "@wpptrack/shared";
import { boundedString } from "../inbound-webhook-delivery-identity";
import {
  webhookReceivedValue,
  type WebhookReceivedValue,
} from "../webhook/webhook-automation-v1.parser";
import {
  GOHIGHLEVEL_AUTOMATION_V1_INVALID,
  GOHIGHLEVEL_AUTOMATION_V1_SCHEMA,
  parseGoHighLevelAutomationV1,
  unwrapGoHighLevelBody,
  type ParsedGoHighLevelAutomationV1,
} from "./gohighlevel-automation-v1.parser";

/**
 * GoHighLevel `automation-v2`: the same Workflow Webhook action as v1, now
 * reading an OPPORTUNITY that changed pipeline stage (one URL per rule/event).
 * Everything v1 reads (phone, contact_id, location.id, workflow.id/name and the
 * click of `contact.attributionSource` / `contact.lastAttributionSource`) is
 * read by the very same code; this file only adds:
 *
 *  - `lead_value` (number, in reais) = the value (BRL) of the opportunity.
 *    It is always the main value; the rule may keep an optional fixed value
 *    used ONLY when the call has no valid `lead_value`. A value-requiring
 *    event (the Purchase...) with neither is ignored with a clear reason
 *    (same pattern as the Webhook / n8n `webhook_value_missing`).
 *  - the opportunity identity: top-level `id` (opportunity id), `pipeline_id`,
 *    `pipeline_name` and `pipleline_stage` (GHL's own misspelling; the correct
 *    `pipeline_stage` is accepted too). `triggerData` comes empty, not read.
 *  - the optional "Pipeline + etapa" filter of the rule.
 *
 * Deduplication (externalExecutionKey):
 *  - opportunity id + stage present, event NOT once-per-lead: the key is
 *    location + opportunity + pipeline_id + stage. The same opportunity in the
 *    same stage is a resend (no new conversion); another stage is another
 *    conversion;
 *  - once-per-lead events (Lead, Qualified Lead) and payloads without an
 *    opportunity keep the v1 key exactly (location + workflow + contact); the
 *    lifetime dedupe stays once per lead downstream.
 *
 * Stage filter: the call carries `pipeline_id` and the stage NAME
 * (`pipleline_stage`). The pipeline id is compared first; then the stage name
 * inside that pipeline, ignoring case and edge spaces.
 */
export const GOHIGHLEVEL_AUTOMATION_V2_PARSER_VERSION = "automation-v2";
/** Callback of another stage/pipeline than the rule's filter: ignored. */
export const GOHIGHLEVEL_PIPELINE_STAGE_NOT_IN_RULE =
  "gohighlevel_automation_v2_stage_not_in_rule";
export const GOHIGHLEVEL_VALUE_MISSING =
  "gohighlevel_automation_v2_value_missing";
export const GOHIGHLEVEL_VALUE_INVALID =
  "gohighlevel_automation_v2_value_invalid";

export function isGoHighLevelAutomationVersion(
  version: string | null | undefined,
): boolean {
  return (
    version === "automation-v1" ||
    version === GOHIGHLEVEL_AUTOMATION_V2_PARSER_VERSION
  );
}

export type GoHighLevelRuleInput = {
  eventName: string;
  /** Optional fixed value (fallback only; lead_value always wins). */
  defaultValueCents?: number | null;
  /** Optional "Pipeline + etapa" filter (pipeline id + stage name, or null). */
  ghlPipelineId?: string | null;
  ghlStageName?: string | null;
};

export type ParsedGoHighLevelAutomationV2 = ParsedGoHighLevelAutomationV1 & {
  eventName: ConversionEventNameDto;
  /** Opportunity id (top-level `id`); null when the call has none. */
  opportunityId: string | null;
  pipelineId: string | null;
  pipelineStage: string | null;
  receivedValue: WebhookReceivedValue;
  /** Value observed for THIS rule (null = the rule's own value, if any). */
  valueCents: number | null;
  currency: CurrencyCode | null;
};

export type GoHighLevelAutomationV2ParseResult =
  | { ok: true; value: ParsedGoHighLevelAutomationV2 }
  | {
      ok: false;
      errorCode:
        | typeof GOHIGHLEVEL_AUTOMATION_V1_INVALID
        | typeof GOHIGHLEVEL_PIPELINE_STAGE_NOT_IN_RULE
        | typeof GOHIGHLEVEL_VALUE_MISSING
        | typeof GOHIGHLEVEL_VALUE_INVALID;
    };

/** String field: text or a safe integer; blank/other = null. */
function text(value: unknown, max: number): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value)
      ? boundedString(String(value), max)
      : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? boundedString(trimmed, max) : null;
}

/** Case/accent/space-blind comparison of ids, names and stages. */
export function normalizeGoHighLevelLabel(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/** `lead_value` 0 (an opportunity without value) is "no value", not invalid. */
function leadValue(value: unknown): WebhookReceivedValue {
  if (value === 0 || (typeof value === "string" && Number(value) === 0)) {
    return { status: "missing" };
  }
  return webhookReceivedValue(value, "BRL");
}

function opportunityKey(input: {
  locationId: string;
  opportunityId: string;
  pipelineId: string | null;
  stage: string;
}): string {
  const digest = createHash("sha256")
    .update(GOHIGHLEVEL_AUTOMATION_V1_SCHEMA, "utf8")
    .update("\0opportunity\0", "utf8")
    .update(input.locationId, "utf8")
    .update("\0", "utf8")
    .update(input.opportunityId, "utf8")
    .update("\0", "utf8")
    .update(input.pipelineId ?? "", "utf8")
    .update("\0", "utf8")
    .update(input.stage, "utf8")
    .digest("hex");
  return `gohighlevel-automation:${digest}`;
}

/**
 * True when the rule's "Pipeline + etapa" filter accepts the call (no filter =
 * always): same pipeline_id, then the same stage name (case and edge spaces
 * ignored).
 */
export function goHighLevelStageMatches(
  rule: Pick<GoHighLevelRuleInput, "ghlPipelineId" | "ghlStageName">,
  call: { pipelineId: string | null; pipelineStage: string | null },
): boolean {
  if (!rule.ghlPipelineId || !rule.ghlStageName) return true;
  if (!call.pipelineId || !call.pipelineStage) return false;
  return (
    call.pipelineId === rule.ghlPipelineId &&
    normalizeGoHighLevelLabel(call.pipelineStage) ===
      normalizeGoHighLevelLabel(rule.ghlStageName)
  );
}

/**
 * Reads a call for ITS rule (ingestion, reevaluation and the production check
 * all come through here, so they always agree). `receivedAt` must be the FIRST
 * arrival of the delivery. A call without ctwa_clid in either source is
 * returned as `ok` with `hasCtwa: false` (the observation ignores it without
 * leaving a mark); the stage filter and the value only judge calls that carry
 * a click.
 */
export function parseGoHighLevelAutomationV2(
  payload: unknown,
  receivedAt: Date,
  rule: GoHighLevelRuleInput,
): GoHighLevelAutomationV2ParseResult {
  const invalid = {
    ok: false as const,
    errorCode: GOHIGHLEVEL_AUTOMATION_V1_INVALID,
  };
  try {
    const eventName = conversionEventNameSchema.parse(rule.eventName);
    const base = parseGoHighLevelAutomationV1(payload, receivedAt);
    if (!base.ok) return invalid;
    const body = unwrapGoHighLevelBody(payload);
    if (!body) return invalid;

    const opportunityId = text(body.id, 255);
    const pipelineId = text(body.pipeline_id, 255);
    const pipelineStage =
      text(body.pipleline_stage, 255) ?? text(body.pipeline_stage, 255);

    if (
      base.value.hasCtwa &&
      !goHighLevelStageMatches(rule, { pipelineId, pipelineStage })
    ) {
      return { ok: false, errorCode: GOHIGHLEVEL_PIPELINE_STAGE_NOT_IN_RULE };
    }

    const receivedValue = leadValue(body.lead_value);
    const observed =
      conversionEventCarriesValue(eventName) &&
      receivedValue.status === "valid"
        ? {
            valueCents: receivedValue.valueCents,
            currency: receivedValue.currency ?? ("BRL" as CurrencyCode),
          }
        : { valueCents: null, currency: null };
    if (
      base.value.hasCtwa &&
      conversionEventRequiresValue(eventName) &&
      observed.valueCents === null &&
      !rule.defaultValueCents
    ) {
      return {
        ok: false,
        errorCode:
          receivedValue.status === "invalid"
            ? GOHIGHLEVEL_VALUE_INVALID
            : GOHIGHLEVEL_VALUE_MISSING,
      };
    }

    const oncePerLead = conversionEventDedupeMode(eventName) === "lifetime";
    const externalExecutionKey =
      !oncePerLead && opportunityId && pipelineStage
        ? opportunityKey({
            locationId: base.value.locationId,
            opportunityId,
            pipelineId,
            stage: pipelineStage,
          })
        : base.value.externalExecutionKey;

    return {
      ok: true,
      value: {
        ...base.value,
        eventName,
        opportunityId,
        pipelineId,
        pipelineStage,
        receivedValue,
        ...observed,
        externalExecutionKey,
      },
    };
  } catch {
    return invalid;
  }
}
