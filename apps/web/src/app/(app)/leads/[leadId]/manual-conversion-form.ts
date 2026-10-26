import {
  conversionEventCatalogOrdered,
  conversionEventValuePolicy,
  manualConversionAgeState,
  manualConversionInputSchema,
  MANUAL_CONVERSION_NOTE_MAX_LENGTH,
  type ConversionEventNameDto,
  type CurrencyCode,
  type ManualConversionInputDto,
} from "@wpptrack/shared";

/**
 * Pure form logic of "Registrar conversao manual" (tarefa 21): the client
 * dialog and its tests share it. The API validates the same schema again.
 */

export type ManualConversionFields = {
  eventName: ConversionEventNameDto;
  /** <input type="datetime-local"> value, in the browser's local time. */
  occurredAtLocal: string;
  /** "199,90" / "199.90" / "1.299,90". */
  value: string;
  currency: CurrencyCode;
  orderRef: string;
  contentName: string;
  note: string;
  localOnly: boolean;
};

export type ManualConversionFieldErrors = Partial<
  Record<keyof ManualConversionFields, string>
>;

/** Options of the event select: the catalog, in funnel order, in Portuguese. */
export const manualConversionEventOptions = conversionEventCatalogOrdered.map(
  (event) => ({ value: event.eventName, label: event.label }),
);

export const MANUAL_CONVERSION_NOTE_HINT = `Até ${MANUAL_CONVERSION_NOTE_MAX_LENGTH} caracteres. Não inclua dados pessoais (CPF, telefone, endereço): a observação fica só no painel e nunca é enviada à Meta.`;

export const MANUAL_CONVERSION_OLD_WARNING =
  "Será registrado só no painel, não enviado à Meta (mais de 7 dias).";

/** "YYYY-MM-DDTHH:mm" of a date in the local time (datetime-local value). */
export function toDatetimeLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Brazilian or plain decimal money text to cents; null when empty/invalid. */
export function parseMoneyToCents(text: string): number | null {
  const raw = text.trim().replace(/\s|R\$|US\$|€/gu, "");
  if (!raw) return null;
  const normalized = /,\d{1,2}$/u.test(raw)
    ? raw.replace(/\./gu, "").replace(",", ".")
    : raw.replace(/,/gu, "");
  if (!/^\d+(\.\d{1,2})?$/u.test(normalized)) return Number.NaN;
  return Math.round(Number(normalized) * 100);
}

export function manualConversionValuePolicy(eventName: ConversionEventNameDto) {
  return conversionEventValuePolicy(eventName);
}

/** The chosen date is older than Meta's 7-day window (local only). */
export function isOutsideMetaWindow(
  occurredAtLocal: string,
  now: Date = new Date(),
): boolean {
  return (
    manualConversionAgeState(new Date(occurredAtLocal), now) ===
    "outside_meta_window"
  );
}

export function buildManualConversionInput(
  fields: ManualConversionFields,
  idempotencyKey: string,
):
  | { ok: true; input: ManualConversionInputDto }
  | { ok: false; errors: ManualConversionFieldErrors } {
  const errors: ManualConversionFieldErrors = {};
  const occurredAt = new Date(fields.occurredAtLocal);
  if (!fields.occurredAtLocal || !Number.isFinite(occurredAt.getTime()))
    errors.occurredAtLocal = "Informe a data e a hora da conversão.";
  const policy = conversionEventValuePolicy(fields.eventName);
  const cents = policy === "none" ? null : parseMoneyToCents(fields.value);
  if (cents !== null && !Number.isFinite(cents))
    errors.value = "Valor inválido. Use, por exemplo, 199,90.";
  if (Object.keys(errors).length) return { ok: false, errors };

  const parsed = manualConversionInputSchema.safeParse({
    eventName: fields.eventName,
    occurredAt: occurredAt.toISOString(),
    valueCents: cents,
    // The currency select always has a value: sent with a value, or when
    // the event requires one (so only the value itself is reported missing).
    currency:
      policy === "none" || (cents === null && policy === "optional")
        ? null
        : fields.currency,
    orderRef: policy === "none" ? null : fields.orderRef,
    contentName: policy === "none" ? null : fields.contentName,
    note: fields.note,
    sendToMeta: !fields.localOnly,
    idempotencyKey,
  });
  if (parsed.success) return { ok: true, input: parsed.data };

  const fieldOf: Record<string, keyof ManualConversionFields> = {
    occurredAt: "occurredAtLocal",
    valueCents: "value",
    currency: "currency",
    orderRef: "orderRef",
    contentName: "contentName",
    note: "note",
    eventName: "eventName",
  };
  for (const issue of parsed.error.issues) {
    const field = fieldOf[String(issue.path[0])] ?? "eventName";
    errors[field] ??=
      issue.code === "too_big"
        ? "Texto longo demais."
        : issue.message;
  }
  return { ok: false, errors };
}
