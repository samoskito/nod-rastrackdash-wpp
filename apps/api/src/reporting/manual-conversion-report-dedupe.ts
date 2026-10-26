import { isLeadLifetimeEvent } from "../conversion-events/lead-lifetime-conversion-guard";

/**
 * Tarefa 21 (decision 2): a manual conversion kept "only in the panel"
 * (sourceTrigger manual_conversion, status not_eligible) of a once-per-lead
 * event does NOT stop the automation from sending the same event later. The
 * reports must still count that lead/event ONCE: when the same lead has the
 * same once-per-lead event from another log (sent or on its way) for the same
 * pixel - or either side has no pixel - the local manual log is dropped from
 * the metrics (the automation one, the one Meta received, is kept).
 * Different pixels keep both (each pixel may receive the lead once).
 */
export type ReportDedupeEvent = {
  id: string;
  leadId?: string | null;
  phoneHash: string | null;
  eventName: string;
  sourceTrigger?: string | null;
  status: string;
  metaConversionDestinationId?: string | null;
};

const MANUAL_TRIGGER = "manual_conversion";

function isLocalManual(event: ReportDedupeEvent): boolean {
  return event.sourceTrigger === MANUAL_TRIGGER && event.status === "not_eligible";
}

function identityOf(event: ReportDedupeEvent): string | null {
  return event.leadId
    ? `lead:${event.leadId}`
    : event.phoneHash
      ? `phone:${event.phoneHash}`
      : null;
}

export function dedupeLocalManualLifetimeEvents<T extends ReportDedupeEvent>(
  events: T[],
): T[] {
  const candidates = events.filter(
    (event) => isLocalManual(event) && isLeadLifetimeEvent(event.eventName),
  );
  if (candidates.length === 0) return events;
  const others = new Map<string, T[]>();
  for (const event of events) {
    if (isLocalManual(event) || event.status === "skipped") continue;
    const identity = identityOf(event);
    if (!identity) continue;
    const key = `${identity}\0${event.eventName}`;
    others.set(key, [...(others.get(key) ?? []), event]);
  }
  const dropped = new Set<string>();
  for (const manual of candidates) {
    const identity = identityOf(manual);
    if (!identity) continue;
    const siblings = others.get(`${identity}\0${manual.eventName}`) ?? [];
    if (
      siblings.some(
        (other) =>
          !manual.metaConversionDestinationId ||
          !other.metaConversionDestinationId ||
          other.metaConversionDestinationId ===
            manual.metaConversionDestinationId,
      )
    )
      dropped.add(manual.id);
  }
  return dropped.size
    ? events.filter((event) => !dropped.has(event.id))
    : events;
}
