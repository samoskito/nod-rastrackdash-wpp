import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  MANUAL_CONVERSION_TRIGGER,
  normalizeManualOrderRef,
} from "@wpptrack/shared";
import { manualOrderKey, manualPurchaseDedupeKey } from "./manual-conversion-payload";
import { manualPurchaseSalesPlatformTriggers } from "./manual-conversion-sales-platforms";

export { manualOrderKey };

/**
 * Purchase dedupe between the manual conversion and the sales platforms
 * (Payt/Braip), tarefa 21. Both sides compute the same order key
 * (manualOrderKey: workspace + order/sale number) and serialize on the same
 * per-customer advisory lock the provider job already takes for a purchase
 * (workspace + phone hash + event), so a manual sale and the platform
 * callback of the same order never both become a Purchase.
 */

/** reasonCode of a Payt/Braip execution whose order was registered manually. */
export const PURCHASE_REGISTERED_MANUALLY = "purchase_registered_manually";
/** Field added to a Payt/Braip Purchase sourcePayload (new logs only). */
export const PROVIDER_PURCHASE_ORDER_KEY_FIELD = "manualOrderKey";

/** Statuses that never count as a registered sale (canceled/dropped). */
const NON_COUNTING_STATUSES = ["skipped"];

/**
 * Same formula as ProviderConversionProductionService.lockKeys. Taken by the
 * manual writer for every +-24h event and by the provider job for purchases
 * and +-24h events (per customer + event), so both sides serialize.
 */
export function purchaseCustomerLockKeys(
  workspaceId: string,
  phoneHash: string,
  eventName: string,
): { first: number; second: number } {
  const digest = createHash("sha256")
    .update(`${workspaceId}\0${phoneHash}\0${eventName}`, "utf8")
    .digest();
  return { first: digest.readInt32BE(0), second: digest.readInt32BE(4) };
}

/** Manual Purchase of this order for one of these leads (not canceled). */
export async function findManualPurchaseForOrder(
  client: Pick<Prisma.TransactionClient, "conversionEventLog">,
  input: { workspaceId: string; leadIds: string[]; orderKey: string },
): Promise<{ id: string; eventOccurredAt: Date } | null> {
  if (input.leadIds.length === 0) return null;
  return client.conversionEventLog.findFirst({
    where: {
      workspaceId: input.workspaceId,
      dedupeKey: manualPurchaseDedupeKey(input.orderKey),
      eventName: "Purchase",
      sourceTrigger: MANUAL_CONVERSION_TRIGGER,
      leadId: { in: input.leadIds },
      status: { notIn: NON_COUNTING_STATUSES },
    },
    select: { id: true, eventOccurredAt: true },
  });
}

/**
 * reasonCode of an automation (phrase, catalog, Umbler/Unnichat automation)
 * whose +-24h event the operator already registered manually for the lead.
 */
export const LEAD_EVENT_REGISTERED_MANUALLY = "lead_event_registered_manually";
const RECENT_WINDOW_MS = 24 * 60 * 60_000;

/**
 * A manual conversion of the same 24h event for these leads within +-24h of
 * `occurredAt`, on its way to (or already at) this Meta destination. A
 * manual kept only in the panel (not_eligible) or canceled (skipped) never
 * blocks the automation: Meta did not receive it.
 */
export async function findRecentManualSameEvent(
  client: Pick<Prisma.TransactionClient, "conversionEventLog">,
  input: {
    workspaceId: string;
    leadIds: string[];
    eventName: string;
    occurredAt: Date;
    conversionDestinationId: string | null;
  },
): Promise<{ id: string } | null> {
  if (input.leadIds.length === 0) return null;
  const logs = await client.conversionEventLog.findMany({
    where: {
      workspaceId: input.workspaceId,
      leadId: { in: input.leadIds },
      eventName: input.eventName,
      sourceTrigger: MANUAL_CONVERSION_TRIGGER,
      status: { notIn: ["skipped", "not_eligible"] },
      eventOccurredAt: {
        gte: new Date(input.occurredAt.getTime() - RECENT_WINDOW_MS),
        lte: new Date(input.occurredAt.getTime() + RECENT_WINDOW_MS),
      },
    },
    select: { id: true, metaConversionDestinationId: true },
    take: 20,
  });
  return (
    logs.find(
      (log) =>
        !input.conversionDestinationId ||
        !log.metaConversionDestinationId ||
        log.metaConversionDestinationId === input.conversionDestinationId,
    ) ?? null
  );
}

/**
 * Order number of a Payt/Braip execution, read from its preserved callback
 * (null when the payload expired, is unavailable or does not parse).
 */
export type ProviderOrderRefReader = (input: {
  workspaceId: string;
  executionId: string;
}) => Promise<string | null>;

const LEGACY_LOOKBACK_MS = 90 * 24 * 60 * 60_000;
const LEGACY_SCAN_LIMIT = 50;
// nod: Payt today; Braip/Hotmart/Yampi join via manual-conversion-sales-platforms.
const SALES_PLATFORM_TRIGGERS = manualPurchaseSalesPlatformTriggers();

/**
 * Payt/Braip Purchases recorded BEFORE this release carry no manualOrderKey.
 * For them, the lead's Purchase logs of the last 90 days are matched by an
 * order field of the stored sourcePayload when present, else by the order
 * number of the preserved callback (while its payload is retained).
 */
export async function findLegacyProviderPurchaseForOrder(
  client: Pick<Prisma.TransactionClient, "conversionEventLog">,
  input: {
    workspaceId: string;
    leadIds: string[];
    normalizedOrderRef: string;
    now?: Date;
  },
  readOrderRef: ProviderOrderRefReader | null,
): Promise<{ id: string; eventOccurredAt: Date; sourceTrigger: string } | null> {
  if (input.leadIds.length === 0 || !input.normalizedOrderRef) return null;
  const logs = await client.conversionEventLog.findMany({
    where: {
      workspaceId: input.workspaceId,
      eventName: "Purchase",
      leadId: { in: input.leadIds },
      sourceTrigger: { startsWith: "inbound_webhook:" },
      status: { notIn: NON_COUNTING_STATUSES },
      eventOccurredAt: {
        gte: new Date((input.now ?? new Date()).getTime() - LEGACY_LOOKBACK_MS),
      },
    },
    select: {
      id: true,
      eventOccurredAt: true,
      sourceTrigger: true,
      sourcePayload: true,
    },
    orderBy: { eventOccurredAt: "desc" },
    take: LEGACY_SCAN_LIMIT,
  });
  for (const log of logs) {
    const payload =
      log.sourcePayload &&
      typeof log.sourcePayload === "object" &&
      !Array.isArray(log.sourcePayload)
        ? (log.sourcePayload as Record<string, unknown>)
        : {};
    if (typeof payload[PROVIDER_PURCHASE_ORDER_KEY_FIELD] === "string")
      continue; // already covered by findProviderPurchaseForOrder
    const direct = ["orderRef", "transactionId", "orderId"]
      .map((field) => payload[field])
      .find((value): value is string => typeof value === "string");
    let orderRef: string | null = direct ?? null;
    if (
      !orderRef &&
      readOrderRef &&
      typeof payload.providerConversionExecutionId === "string" &&
      SALES_PLATFORM_TRIGGERS.some((prefix) =>
        log.sourceTrigger.startsWith(prefix),
      )
    ) {
      orderRef = await readOrderRef({
        workspaceId: input.workspaceId,
        executionId: payload.providerConversionExecutionId,
      }).catch(() => null);
    }
    if (orderRef && normalizeManualOrderRef(orderRef) === input.normalizedOrderRef)
      return {
        id: log.id,
        eventOccurredAt: log.eventOccurredAt,
        sourceTrigger: log.sourceTrigger,
      };
  }
  return null;
}

/** Payt/Braip Purchase of this order already recorded for these leads. */
export async function findProviderPurchaseForOrder(
  client: Pick<Prisma.TransactionClient, "conversionEventLog">,
  input: { workspaceId: string; leadIds: string[]; orderKey: string },
): Promise<{ id: string; eventOccurredAt: Date; sourceTrigger: string } | null> {
  if (input.leadIds.length === 0) return null;
  return client.conversionEventLog.findFirst({
    where: {
      workspaceId: input.workspaceId,
      eventName: "Purchase",
      leadId: { in: input.leadIds },
      sourceTrigger: { startsWith: "inbound_webhook:" },
      status: { notIn: NON_COUNTING_STATUSES },
      sourcePayload: {
        path: [PROVIDER_PURCHASE_ORDER_KEY_FIELD],
        equals: input.orderKey,
      },
    },
    select: { id: true, eventOccurredAt: true, sourceTrigger: true },
  });
}
