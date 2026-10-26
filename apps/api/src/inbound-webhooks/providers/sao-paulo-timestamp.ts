import { boundedString } from "./inbound-webhook-delivery-identity";

/**
 * Datas de plataformas de venda brasileiras (Payt, Brink Park): um horario
 * SEM fuso e a hora de Brasilia (America/Sao_Paulo), nunca UTC.
 */
export const SAO_PAULO_TIME_ZONE = "America/Sao_Paulo";

/** Offset (ms) of America/Sao_Paulo at an instant (handles historical DST). */
function saoPauloOffsetMs(instant: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SAO_PAULO_TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(instant / 1_000) * 1_000;
}

/** Wall-clock time in America/Sao_Paulo -> instant. */
export function fromSaoPauloWallTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
): Date | null {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  if (!Number.isFinite(wall)) return null;
  const check = new Date(wall);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return null;
  // Two passes settle the offset around a (historical) DST change.
  let instant = wall - saoPauloOffsetMs(wall);
  instant = wall - saoPauloOffsetMs(instant);
  return new Date(instant);
}

/**
 * Sale time. With an explicit zone (`Z`, `-03:00`) it is kept; WITHOUT a
 * zone ("2026-10-16T12:20:00", "2026-10-16 12:20:00", "16/10/2026 12:20")
 * it is read as America/Sao_Paulo wall-clock time.
 */
export function saoPauloTimestamp(value: unknown): Date | null {
  const text = boundedString(value, 80);
  if (!text) return null;
  const naive =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?$/u.exec(
      text,
    );
  if (naive) {
    return fromSaoPauloWallTime(
      Number(naive[1]),
      Number(naive[2]),
      Number(naive[3]),
      Number(naive[4] ?? "0"),
      Number(naive[5] ?? "0"),
      Number(naive[6] ?? "0"),
      Number((naive[7] ?? "0").slice(0, 3).padEnd(3, "0")),
    );
  }
  const brazilian =
    /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/u.exec(text);
  if (brazilian) {
    return fromSaoPauloWallTime(
      Number(brazilian[3]),
      Number(brazilian[2]),
      Number(brazilian[1]),
      Number(brazilian[4] ?? "0"),
      Number(brazilian[5] ?? "0"),
      Number(brazilian[6] ?? "0"),
      0,
    );
  }
  // ISO 8601 with an explicit zone only (never a locale-dependent parse).
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/u.test(
      text,
    )
  )
    return null;
  const milliseconds = Date.parse(text);
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
}
