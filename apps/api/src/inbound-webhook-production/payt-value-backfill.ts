import type { Prisma, PrismaClient } from "@prisma/client";
import { buildProviderPurchaseIdentity } from "../conversion-rules/provider-purchase-identity";
import type { InboundWebhookPayloadEncryptionService } from "../inbound-webhooks/inbound-webhook-payload-encryption.service";
import {
  parsePaytSaleEventV1,
  paytLegacyTotalPriceCents,
  PAYT_VALUE_CORRECTION_REASON,
} from "../inbound-webhooks/providers/payt/payt-automation-v1.parser";

/**
 * One-off correction of Payt sales recorded with `total_price` (card
 * installment interest included) before the parser preferred
 * `price_without_installments`. Ported from the SaaS (`608ec47`, `1d65161`).
 *
 * Student edition rule (Fase 5.0): only a conversion that has NOT been sent
 * to Meta yet is corrected; one already sent (or being sent) keeps its value
 * everywhere and is only counted (`alreadySentToMeta`). Nothing is ever
 * resent: event_id, dedupe key and delivery status are untouched. A queued
 * conversion corrected here is sent later with the corrected value (the Meta
 * payload is built from the conversion row at send time).
 *
 * The new value is re-read from the preserved postback; once that body
 * expired (retention ~7 days) there is no other stored source of the value
 * without interest (the frozen decision only holds total_price), so the row
 * is left as is and counted.
 *
 * The SaaS also corrects the "Vendas sem atribuicao" snapshot
 * (IntegrationEndpointEvent): that table arrives in this edition with Fase
 * 5.3, after the parser fix, so it never holds a legacy value here.
 *
 * Idempotent: a corrected log carries `sourcePayload.valueCorrection` and
 * every write is guarded by the previous value.
 */

export const PAYT_VALUE_BACKFILL_DEFAULT_LIMIT = 200;
export const PAYT_VALUE_BACKFILL_MAX_LIMIT = 2_000;
const BATCH_SIZE = 100;
const SAMPLE_SIZE = 50;
/** Conversion statuses whose value Meta has (or may have) already received. */
const SENT_TO_META_STATUSES = ["sent", "dispatching"];

export type PaytValueBackfillOptions = {
  apply: boolean;
  /** Max conversion logs examined in this run. */
  limit: number;
  workspaceId?: string;
  /** Resume after this ConversionEventLog id (the previous `nextCursor`). */
  afterId?: string;
  /** Platform owner recorded in the audit (required when applying). */
  actorUserId?: string;
  now?: Date;
};

type Outcome =
  | "corrected"
  | "unchanged"
  | "alreadyCorrected"
  | "alreadySentToMeta"
  | "manualAdjustment"
  | "payloadUnavailable"
  | "parseFailed"
  | "identityMismatch"
  | "valueNotLegacy";

export type PaytValueBackfillReport = {
  mode: "dry_run" | "apply";
  conversionEvents: {
    scanned: number;
    /** In dry-run: would be corrected. */
    corrected: number;
    previousTotalCents: number;
    correctedTotalCents: number;
    unchanged: number;
    alreadyCorrected: number;
    /** Already sent to Meta (or being sent): never changed. */
    alreadySentToMeta: number;
    manualAdjustment: number;
    payloadUnavailable: number;
    parseFailed: number;
    identityMismatch: number;
    valueNotLegacy: number;
    /** Lost a race (value or delivery changed meanwhile): left untouched. */
    concurrentChange: number;
    executionsUpdated: number;
    purchaseReviewsUpdated: number;
    nextCursor: string | null;
    samples: Array<{
      conversionEventLogId: string;
      workspaceId: string | null;
      outcome: Outcome;
      previousValueCents: number | null;
      valueCents: number | null;
    }>;
  };
  safety: {
    metaEventsResent: false;
    metaDeliveryStatusChanged: false;
    eventIdOrDedupeChanged: false;
    sentEventsChanged: false;
  };
};

type LogRow = {
  id: string;
  workspaceId: string | null;
  eventName: string;
  status: string;
  sentAt: Date | null;
  dedupeKey: string | null;
  valueCents: number | null;
  sourcePayload: Prisma.JsonValue | null;
  purchaseValueAdjustments: Array<{ id: string }>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type EncryptedRow = {
  encryptedPayload: string | null;
  payloadIv: string | null;
  payloadTag: string | null;
  encryptionKeyVersion: number | null;
  payloadExpiresAt: Date;
};

function decryptJson(
  encryption: Pick<InboundWebhookPayloadEncryptionService, "decrypt">,
  row: EncryptedRow,
  context: { workspaceId: string; connectionId: string; deliveryId: string },
  now: Date,
): unknown | undefined {
  if (
    row.payloadExpiresAt <= now ||
    !row.encryptedPayload ||
    !row.payloadIv ||
    !row.payloadTag ||
    row.encryptionKeyVersion === null
  )
    return undefined;
  try {
    return JSON.parse(
      encryption
        .decrypt(
          {
            encryptedPayload: row.encryptedPayload,
            payloadIv: row.payloadIv,
            payloadTag: row.payloadTag,
            encryptionKeyVersion: row.encryptionKeyVersion,
          },
          context,
        )
        .toString("utf8"),
    ) as unknown;
  } catch {
    return undefined;
  }
}

function sentToMeta(row: { status: string; sentAt: Date | null }): boolean {
  return row.sentAt !== null || SENT_TO_META_STATUSES.includes(row.status);
}

export async function runPaytValueBackfill(
  prisma: PrismaClient,
  encryption: Pick<InboundWebhookPayloadEncryptionService, "decrypt">,
  options: PaytValueBackfillOptions,
): Promise<PaytValueBackfillReport> {
  if (options.apply && !options.actorUserId)
    throw new Error("payt_value_backfill_actor_required");
  const now = options.now ?? new Date();
  const limit = Math.max(
    1,
    Math.min(options.limit, PAYT_VALUE_BACKFILL_MAX_LIMIT),
  );
  const report: PaytValueBackfillReport = {
    mode: options.apply ? "apply" : "dry_run",
    conversionEvents: {
      scanned: 0,
      corrected: 0,
      previousTotalCents: 0,
      correctedTotalCents: 0,
      unchanged: 0,
      alreadyCorrected: 0,
      alreadySentToMeta: 0,
      manualAdjustment: 0,
      payloadUnavailable: 0,
      parseFailed: 0,
      identityMismatch: 0,
      valueNotLegacy: 0,
      concurrentChange: 0,
      executionsUpdated: 0,
      purchaseReviewsUpdated: 0,
      nextCursor: null,
      samples: [],
    },
    safety: {
      metaEventsResent: false,
      metaDeliveryStatusChanged: false,
      eventIdOrDedupeChanged: false,
      sentEventsChanged: false,
    },
  };
  const events = report.conversionEvents;
  const sample = (
    row: LogRow,
    outcome: Outcome,
    valueCents: number | null = row.valueCents,
  ) => {
    if (events.samples.length < SAMPLE_SIZE)
      events.samples.push({
        conversionEventLogId: row.id,
        workspaceId: row.workspaceId,
        outcome,
        previousValueCents: row.valueCents,
        valueCents,
      });
  };

  async function correctLog(row: LogRow): Promise<void> {
    const source = asRecord(row.sourcePayload) ?? {};
    const existing = asRecord(source.valueCorrection);
    if (existing) {
      events.alreadyCorrected += 1;
      // Corrected at send time (legacy frozen decision): the conversion
      // travelled with the corrected value but the execution may still hold
      // the legacy one. Aligning it changes nothing that Meta received.
      const previous = existing.previousValueCents;
      if (
        options.apply &&
        row.workspaceId &&
        typeof previous === "number" &&
        row.valueCents !== null &&
        previous !== row.valueCents
      ) {
        const executions =
          await prisma.providerConversionRuleExecution.updateMany({
            where: {
              workspaceId: row.workspaceId,
              conversionEventLogId: row.id,
              valueCents: previous,
            },
            data: { valueCents: row.valueCents },
          });
        events.executionsUpdated += executions.count;
      }
      return;
    }
    // What Meta already received never changes here.
    if (sentToMeta(row)) {
      events.alreadySentToMeta += 1;
      sample(row, "alreadySentToMeta");
      return;
    }
    // An operator-adjusted value (purchase review) always wins.
    if (row.purchaseValueAdjustments.length > 0) {
      events.manualAdjustment += 1;
      sample(row, "manualAdjustment");
      return;
    }
    const deliveryId =
      typeof source.sourceDeliveryId === "string"
        ? source.sourceDeliveryId
        : null;
    const delivery =
      deliveryId && row.workspaceId
        ? await prisma.inboundWebhookDelivery.findFirst({
            where: { id: deliveryId, workspaceId: row.workspaceId },
            select: {
              id: true,
              workspaceId: true,
              connectionId: true,
              encryptedPayload: true,
              payloadIv: true,
              payloadTag: true,
              encryptionKeyVersion: true,
              payloadExpiresAt: true,
            },
          })
        : null;
    const body = delivery
      ? decryptJson(
          encryption,
          delivery,
          {
            workspaceId: delivery.workspaceId,
            connectionId: delivery.connectionId,
            deliveryId: delivery.id,
          },
          now,
        )
      : undefined;
    if (body === undefined) {
      events.payloadUnavailable += 1;
      sample(row, "payloadUnavailable");
      return;
    }
    const parsed = parsePaytSaleEventV1(body);
    if (!parsed.ok || parsed.value.valueCents === null) {
      events.parseFailed += 1;
      sample(row, "parseFailed");
      return;
    }
    // The preserved body must be THIS sale (same purchase identity).
    if (
      parsed.value.eventName !== row.eventName ||
      !row.workspaceId ||
      row.dedupeKey !==
        buildProviderPurchaseIdentity({
          workspaceId: row.workspaceId,
          provider: "payt",
          accountRef: parsed.value.accountRef,
          orderRef: parsed.value.orderRef,
          eventName: parsed.value.eventName,
        })
    ) {
      events.identityMismatch += 1;
      sample(row, "identityMismatch");
      return;
    }
    const valueCents = parsed.value.valueCents;
    const previousValueCents = row.valueCents!;
    if (valueCents === previousValueCents) {
      events.unchanged += 1;
      return;
    }
    // Only the legacy value (total_price of the same body) is corrected; any
    // other difference has another origin and is left for a human.
    if (previousValueCents !== paytLegacyTotalPriceCents(body)) {
      events.valueNotLegacy += 1;
      sample(row, "valueNotLegacy");
      return;
    }
    if (!options.apply) {
      events.corrected += 1;
      events.previousTotalCents += previousValueCents;
      events.correctedTotalCents += valueCents;
      sample(row, "corrected", valueCents);
      return;
    }
    const valueCorrection = {
      previousValueCents,
      valueCents,
      reason: PAYT_VALUE_CORRECTION_REASON,
      correctedAt: now.toISOString(),
      source: "backfill",
    };
    const outcome = await prisma.$transaction(async (tx) => {
      const updated = await tx.conversionEventLog.updateMany({
        where: {
          id: row.id,
          valueCents: previousValueCents,
          // Never race the sender: a conversion sent (or being sent) since
          // it was read keeps its value.
          sentAt: null,
          status: { notIn: SENT_TO_META_STATUSES },
        },
        data: {
          valueCents,
          sourcePayload: {
            ...source,
            valueCorrection,
          } as Prisma.InputJsonValue,
        },
      });
      if (updated.count !== 1) return null;
      const executions = await tx.providerConversionRuleExecution.updateMany({
        where: {
          workspaceId: row.workspaceId!,
          conversionEventLogId: row.id,
          valueCents: previousValueCents,
        },
        data: { valueCents },
      });
      const reviews = await tx.purchaseReview.updateMany({
        where: {
          workspaceId: row.workspaceId!,
          conversionEventLogId: row.id,
          effectiveValueCents: previousValueCents,
        },
        data: { effectiveValueCents: valueCents, version: { increment: 1 } },
      });
      await tx.auditLog.create({
        data: {
          workspaceId: row.workspaceId,
          actorUserId: options.actorUserId!,
          actorType: "platform_owner",
          action: "conversion_event.payt_value_corrected",
          targetType: "ConversionEventLog",
          targetId: row.id,
          reason: "Payt: valor da venda sem juros do parcelamento",
          resultStatus: "success",
          beforeSummary: { valueCents: previousValueCents },
          afterSummary: {
            valueCents,
            executionsUpdated: executions.count,
            purchaseReviewsUpdated: reviews.count,
            metaEventResent: false,
          },
        },
      });
      return { executions: executions.count, reviews: reviews.count };
    });
    if (!outcome) {
      events.concurrentChange += 1;
      return;
    }
    events.corrected += 1;
    events.previousTotalCents += previousValueCents;
    events.correctedTotalCents += valueCents;
    events.executionsUpdated += outcome.executions;
    events.purchaseReviewsUpdated += outcome.reviews;
    sample(row, "corrected", valueCents);
  }

  // Conversion events (reports, revenue, ROAS, Eventos Meta, lead).
  let cursor = options.afterId ?? null;
  let exhausted = false;
  while (events.scanned < limit) {
    const rows = (await prisma.conversionEventLog.findMany({
      where: {
        eventName: "Purchase",
        valueCents: { not: null },
        ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
        ...(cursor ? { id: { gt: cursor } } : {}),
        OR: [
          { sourcePayload: { path: ["provider"], equals: "payt" } },
          { sourceTrigger: { startsWith: "inbound_webhook:payt:" } },
        ],
      },
      orderBy: { id: "asc" },
      take: Math.min(BATCH_SIZE, limit - events.scanned),
      select: {
        id: true,
        workspaceId: true,
        eventName: true,
        status: true,
        sentAt: true,
        dedupeKey: true,
        valueCents: true,
        sourcePayload: true,
        purchaseValueAdjustments: { take: 1, select: { id: true } },
      },
    })) as LogRow[];
    if (rows.length === 0) {
      exhausted = true;
      break;
    }
    for (const row of rows) {
      events.scanned += 1;
      cursor = row.id;
      await correctLog(row);
    }
  }
  events.nextCursor = exhausted ? null : cursor;

  if (options.apply) {
    await prisma.auditLog.create({
      data: {
        workspaceId: options.workspaceId ?? null,
        actorUserId: options.actorUserId!,
        actorType: "platform_owner",
        action: "conversion_event.payt_value_backfill",
        targetType: options.workspaceId ? "Workspace" : "Platform",
        targetId: options.workspaceId ?? "platform",
        reason: "Payt: valor da venda sem juros do parcelamento",
        resultStatus: "success",
        afterSummary: {
          conversionEventsScanned: events.scanned,
          conversionEventsCorrected: events.corrected,
          alreadySentToMeta: events.alreadySentToMeta,
          payloadUnavailable: events.payloadUnavailable,
          nextCursor: events.nextCursor,
          metaEventsResent: false,
        },
      },
    });
  }
  return report;
}
