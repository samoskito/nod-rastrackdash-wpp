"use client";

import {
  MANUAL_CONVERSION_MAY_EXPIRE_LABEL,
  supportedCurrencyCodes,
  type CurrencyCode,
  type ManualConversionInputDto,
  type ManualConversionPreviewDto,
  type ManualConversionResultDto,
  type ManualConversionSourceDto,
} from "@wpptrack/shared";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { Modal } from "../../../../components/modal";
import {
  cancelManualConversionAction,
  createManualConversionAction,
  previewManualConversionAction,
} from "./actions";
import {
  buildManualConversionInput,
  isOutsideMetaWindow,
  manualConversionEventOptions,
  manualConversionValuePolicy,
  MANUAL_CONVERSION_NOTE_HINT,
  MANUAL_CONVERSION_OLD_WARNING,
  toDatetimeLocal,
  type ManualConversionFieldErrors,
  type ManualConversionFields,
} from "./manual-conversion-form";

type Step =
  | { kind: "form" }
  | {
      kind: "confirm";
      input: ManualConversionInputDto;
      preview: ManualConversionPreviewDto;
    }
  | { kind: "done"; result: ManualConversionResultDto }
  | { kind: "already_converted"; message: string };

function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

function initialFields(currency: CurrencyCode): ManualConversionFields {
  return {
    eventName: "QualifiedLead",
    occurredAtLocal: toDatetimeLocal(new Date()),
    value: "",
    currency,
    orderRef: "",
    contentName: "",
    note: "",
    localOnly: false,
  };
}

/** Warning callout (design system feedback-banner, warn tone). */
export function ManualConversionWarning({
  title,
  detail,
  role = "status",
}: {
  title: string;
  detail?: string | null;
  role?: "status" | "alert";
}) {
  return (
    <div className="feedback-banner warn manual-conversion-callout" role={role}>
      <strong>{title}</strong>
      {detail ? <span>{detail}</span> : null}
    </div>
  );
}

/**
 * Body of the blocking callout: the title already says "Lead já convertido" /
 * "Pedido já registrado", so the body only adds when and by whom.
 */
export function blockedDuplicateDetail(
  duplicate: NonNullable<ManualConversionPreviewDto["duplicate"]>,
): string {
  if (!duplicate.occurredAt || !duplicate.originLabel) return duplicate.message;
  const date = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(duplicate.occurredAt));
  return duplicate.kind === "order_already_registered"
    ? `Em ${date} por ${duplicate.originLabel}. Não é possível registrar o mesmo pedido de novo.`
    : `Em ${date} por ${duplicate.originLabel}. Não é possível registrar de novo.`;
}

/** Outcome titles shown after "Confirmar". */
export function manualConversionOutcomeTitle(
  result: ManualConversionResultDto,
): string {
  return result.outcome === "queued"
    ? "Enfileirado"
    : result.outcome === "expired"
      ? "Expirou antes do envio"
      : "Registrado só no painel";
}

/**
 * "Registrar conversao manual" on the lead detail (tarefa 21). Owner/admin
 * only (the page renders it only for canManageIntegrations; the API checks
 * again). Form -> confirmation (server preview) -> result.
 */
export function ManualConversionButton({
  leadId,
  defaultCurrency = "BRL",
  licenseLocked = false,
  onRecorded,
}: {
  leadId: string;
  defaultCurrency?: CurrencyCode;
  /** Licença bloqueada: a API recusa o registro (423); o botão fica desabilitado. */
  licenseLocked?: boolean;
  /** Replaces the page refresh (CRM Kanban lead modal). */
  onRecorded?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // A fresh dialog (fields + idempotency key) on every opening.
  const [session, setSession] = useState(0);

  return (
    <>
      <button
        className="button primary"
        type="button"
        disabled={licenseLocked}
        title={
          licenseLocked
            ? "Licença bloqueada: ative a licença em Backoffice → Licença para registrar conversões."
            : undefined
        }
        onClick={() => {
          setSession((value) => value + 1);
          setOpen(true);
        }}
      >
        <Plus aria-hidden="true" size={16} strokeWidth={2.2} />
        Registrar conversão manual
      </button>
      <ManualConversionDialog
        key={session}
        open={open}
        leadId={leadId}
        defaultCurrency={defaultCurrency}
        onRecorded={() => (onRecorded ? onRecorded() : router.refresh())}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/**
 * The manual conversion dialog itself, shared by the lead detail button and
 * the CRM Kanban drop (design §10): same form, same server preview, same
 * protections and the same create route. The Kanban opens it with the event
 * of the destination column locked, the Jornada default value prefilled and
 * source "kanban". Mount it with a new `key` for every new registration.
 */
export function ManualConversionDialog({
  open,
  leadId,
  defaultCurrency = "BRL",
  initial,
  lockEvent = false,
  source,
  notice,
  title = "Registrar conversão manual",
  onRecorded,
  onClose,
}: {
  open: boolean;
  leadId: string;
  defaultCurrency?: CurrencyCode;
  /** Prefilled fields (Kanban: event, Jornada default value/currency). */
  initial?: Partial<ManualConversionFields>;
  /** The event comes from the destination column and cannot change. */
  lockEvent?: boolean;
  source?: ManualConversionSourceDto;
  /** Shown on the form and confirmation (e.g. skipped stages). */
  notice?: string | null;
  title?: string;
  onRecorded?: (result: ManualConversionResultDto) => void;
  /** `result` = the registration that happened in this dialog, if any. */
  onClose: (result: ManualConversionResultDto | null) => void;
}) {
  const [fields, setFields] = useState<ManualConversionFields>(() => ({
    ...initialFields(defaultCurrency),
    ...initial,
  }));
  const [errors, setErrors] = useState<ManualConversionFieldErrors>({});
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // One key per filled form: a double click on "Confirmar" never duplicates.
  const idempotencyKey = useRef<string>("");
  if (!idempotencyKey.current) idempotencyKey.current = newIdempotencyKey();
  const inFlight = useRef(false);
  const recorded = useRef<ManualConversionResultDto | null>(null);

  const policy = manualConversionValuePolicy(fields.eventName);
  const old = isOutsideMetaWindow(fields.occurredAtLocal);
  const maxLocal = toDatetimeLocal(new Date());

  function update(patch: Partial<ManualConversionFields>) {
    setFields((current) => ({
      ...current,
      ...patch,
      ...(lockEvent ? { eventName: current.eventName } : {}),
    }));
    setErrors({});
    setMessage(null);
  }

  function close() {
    if (pending) return;
    onClose(recorded.current);
  }

  function review() {
    const built = buildManualConversionInput(
      fields,
      idempotencyKey.current,
      source,
    );
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setMessage(null);
    startTransition(async () => {
      const response = await previewManualConversionAction(
        leadId,
        built.input,
      ).catch(() => null);
      if (!response) {
        setMessage("Não foi possível conferir o destino agora.");
        return;
      }
      if (!response.ok) {
        setMessage(response.message);
        return;
      }
      setStep({ kind: "confirm", input: built.input, preview: response.preview });
    });
  }

  function confirm(input: ManualConversionInputDto, confirmDuplicate: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    startTransition(async () => {
      try {
        const response = await createManualConversionAction(leadId, {
          ...input,
          confirmDuplicate,
        }).catch(() => null);
        if (!response) {
          setMessage("Não foi possível registrar a conversão agora.");
          return;
        }
        if (!response.ok) {
          if (response.state === "already_converted") {
            setStep({ kind: "already_converted", message: response.message });
            return;
          }
          if (
            response.state === "needs_confirmation" &&
            step.kind === "confirm"
          ) {
            // Appeared after the preview: ask for the explicit confirmation.
            setStep({
              ...step,
              preview: {
                ...step.preview,
                recentDuplicate: {
                  kind: "recent_same_event",
                  message: response.message,
                  conversionEventLogId: null,
                  occurredAt: null,
                },
              },
            });
            return;
          }
          setMessage(response.message);
          return;
        }
        recorded.current = response.result;
        setStep({ kind: "done", result: response.result });
        onRecorded?.(response.result);
      } finally {
        inFlight.current = false;
      }
    });
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={title}
      description="O destino Meta é o mesmo das automações deste lead; você não escolhe o pixel."
      size="wide"
      className="manual-conversion-modal"
    >
      {step.kind === "form" ? (
        <ManualConversionForm
          fields={fields}
          errors={errors}
          policy={policy}
          old={old}
          maxLocal={maxLocal}
          pending={pending}
          message={message}
          lockEvent={lockEvent}
          notice={notice}
          onChange={update}
          onCancel={close}
          onSubmit={review}
        />
      ) : null}
      {step.kind === "confirm" ? (
        <ManualConversionConfirm
          preview={step.preview}
          pending={pending}
          message={message}
          notice={notice}
          onBack={() => {
            setStep({ kind: "form" });
            setMessage(null);
          }}
          onConfirm={(confirmDuplicate) =>
            confirm(step.input, confirmDuplicate)
          }
        />
      ) : null}
        {step.kind === "done" ? (
          <ManualConversionOutcome
            tone={
              step.result.outcome === "queued"
                ? "ok"
                : step.result.outcome === "expired"
                  ? "warn"
                  : "neutral"
            }
            title={manualConversionOutcomeTitle(step.result)}
            detail={step.result.message}
            onClose={close}
          />
        ) : null}
        {step.kind === "already_converted" ? (
          <ManualConversionOutcome
            tone="warn"
            title="Já convertido"
            detail={step.message}
            onClose={close}
          />
        ) : null}
    </Modal>
  );
}

export function ManualConversionForm({
  fields,
  errors,
  policy,
  old,
  maxLocal,
  pending,
  message,
  lockEvent = false,
  notice,
  onChange,
  onCancel,
  onSubmit,
}: {
  fields: ManualConversionFields;
  errors: ManualConversionFieldErrors;
  policy: "required" | "optional" | "none";
  old: boolean;
  maxLocal: string;
  pending: boolean;
  message: string | null;
  /** CRM Kanban: the event of the destination column, not editable. */
  lockEvent?: boolean;
  notice?: string | null;
  onChange: (patch: Partial<ManualConversionFields>) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const required = policy === "required";
  return (
    <form
      className="manual-conversion-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="manual-conversion-row">
        <label className="manual-conversion-field">
          <span className="field-label">Evento</span>
          <select
            name="eventName"
            disabled={lockEvent}
            title={
              lockEvent ? "Evento da coluna de destino do Kanban" : undefined
            }
            value={fields.eventName}
            onChange={(event) =>
              onChange({
                eventName: event.currentTarget
                  .value as ManualConversionFields["eventName"],
              })
            }
          >
            {manualConversionEventOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="manual-conversion-field">
          <span className="field-label">Data e hora</span>
          <input
            name="occurredAt"
            type="datetime-local"
            max={maxLocal}
            value={fields.occurredAtLocal}
            onChange={(event) =>
              onChange({ occurredAtLocal: event.currentTarget.value })
            }
            aria-invalid={Boolean(errors.occurredAtLocal)}
          />
          {errors.occurredAtLocal ? (
            <span className="form-error">{errors.occurredAtLocal}</span>
          ) : null}
        </label>
      </div>
      {notice ? <ManualConversionWarning title={notice} /> : null}
      {old && !errors.occurredAtLocal ? (
        <ManualConversionWarning title={MANUAL_CONVERSION_OLD_WARNING} />
      ) : null}

      {policy !== "none" ? (
        <>
          <div className="manual-conversion-row">
            <label className="manual-conversion-field">
              <span className="field-label">
                Valor{required ? "" : " (opcional)"}
              </span>
              <input
                name="value"
                inputMode="decimal"
                placeholder="199,90"
                value={fields.value}
                onChange={(event) =>
                  onChange({ value: event.currentTarget.value })
                }
                aria-invalid={Boolean(errors.value)}
              />
              {errors.value ? (
                <span className="form-error">{errors.value}</span>
              ) : null}
            </label>
            <label className="manual-conversion-field">
              <span className="field-label">Moeda</span>
              <select
                name="currency"
                value={fields.currency}
                onChange={(event) =>
                  onChange({
                    currency: event.currentTarget.value as CurrencyCode,
                  })
                }
              >
                {supportedCurrencyCodes.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
              {errors.currency ? (
                <span className="form-error">{errors.currency}</span>
              ) : null}
            </label>
          </div>
          <div className="manual-conversion-row">
            <label className="manual-conversion-field">
              <span className="field-label">
                Número do pedido/venda{required ? "" : " (opcional)"}
              </span>
              <input
                name="orderRef"
                maxLength={120}
                value={fields.orderRef}
                onChange={(event) =>
                  onChange({ orderRef: event.currentTarget.value })
                }
                aria-invalid={Boolean(errors.orderRef)}
              />
              {errors.orderRef ? (
                <span className="form-error">{errors.orderRef}</span>
              ) : null}
            </label>
            <label className="manual-conversion-field">
              <span className="field-label">Produto (opcional)</span>
              <input
                name="contentName"
                maxLength={200}
                value={fields.contentName}
                onChange={(event) =>
                  onChange({ contentName: event.currentTarget.value })
                }
              />
            </label>
          </div>
        </>
      ) : null}

      <label className="manual-conversion-field">
        <span className="field-label">Observação (opcional)</span>
        <textarea
          name="note"
          rows={3}
          maxLength={500}
          value={fields.note}
          onChange={(event) => onChange({ note: event.currentTarget.value })}
          aria-invalid={Boolean(errors.note)}
        />
        <span className="manual-conversion-hint">
          {MANUAL_CONVERSION_NOTE_HINT}
        </span>
        {errors.note ? <span className="form-error">{errors.note}</span> : null}
      </label>

      <label className="manual-conversion-checkbox">
        <input
          name="localOnly"
          type="checkbox"
          checked={fields.localOnly}
          onChange={(event) =>
            onChange({ localOnly: event.currentTarget.checked })
          }
        />
        <span>Registrar só no painel (não enviar à Meta)</span>
      </label>

      {errors.eventName ? (
        <p className="form-error" role="alert">
          {errors.eventName}
        </p>
      ) : null}
      {message ? (
        <ManualConversionWarning title={message} role="alert" />
      ) : null}

      <div className="conversion-flow-actions">
        <button
          className="button"
          type="button"
          onClick={onCancel}
          disabled={pending}
        >
          Cancelar
        </button>
        <button className="button primary" type="submit" disabled={pending}>
          {pending ? "Conferindo..." : "Revisar"}
        </button>
      </div>
    </form>
  );
}

export function ManualConversionConfirm({
  preview,
  pending,
  message,
  onBack,
  onConfirm,
  initialConfirmDuplicate = false,
  notice,
}: {
  preview: ManualConversionPreviewDto;
  pending: boolean;
  message: string | null;
  /** CRM Kanban: e.g. "as etapas intermediárias não são enviadas". */
  notice?: string | null;
  onBack: () => void;
  onConfirm: (confirmDuplicate: boolean) => void;
  /** Tests/screenshots: render the confirm-anyway box already checked. */
  initialConfirmDuplicate?: boolean;
}) {
  const checkboxId = useId();
  const [confirmDuplicate, setConfirmDuplicate] = useState(
    initialConfirmDuplicate,
  );
  const blocked = Boolean(preview.duplicate);
  const needsConfirmation = Boolean(preview.recentDuplicate);
  const disabled =
    pending || blocked || (needsConfirmation && !confirmDuplicate);
  const destination =
    preview.destination.kind === "none"
      ? "Nenhum pixel resolvido para este lead"
      : [
          preview.destination.destinationName,
          preview.destination.pixelId
            ? `pixel ${preview.destination.pixelId}`
            : null,
          preview.destination.kind === "ctwa"
            ? "entrada CTWA verificada"
            : "rota do anúncio",
        ]
          .filter(Boolean)
          .join(" · ");
  const attribution =
    [preview.attribution.campaignName, preview.attribution.adName]
      .filter(Boolean)
      .join(" / ") || "Sem campanha/anúncio identificado";
  return (
    <div className="manual-conversion-confirm">
      <dl className="manual-conversion-summary">
        <div>
          <dt>Evento</dt>
          <dd>{preview.eventLabel}</dd>
        </div>
        <div>
          <dt>Destino</dt>
          <dd>{destination}</dd>
        </div>
        <div>
          <dt>Campanha / anúncio</dt>
          <dd>{attribution}</dd>
        </div>
        <div>
          <dt>Envio à Meta</dt>
          <dd>
            {preview.willSendToMeta
              ? "Será enviado à Meta"
              : (preview.notSentReasonLabel ?? "Não será enviado à Meta")}
          </dd>
        </div>
      </dl>
      {notice ? <ManualConversionWarning title={notice} /> : null}
      {preview.mayExpireBeforeSend ? (
        <ManualConversionWarning
          title="Pode expirar antes do envio"
          detail={MANUAL_CONVERSION_MAY_EXPIRE_LABEL}
        />
      ) : null}
      {preview.duplicate ? (
        <ManualConversionWarning
          title={
            preview.duplicate.kind === "order_already_registered"
              ? "Pedido já registrado"
              : "Lead já convertido"
          }
          detail={blockedDuplicateDetail(preview.duplicate)}
          role="alert"
        />
      ) : null}
      {preview.recentDuplicate ? (
        <div className="manual-conversion-recent">
          <ManualConversionWarning
            title="Evento repetido nas últimas 24 horas"
            detail={preview.recentDuplicate.message}
            role="alert"
          />
          <label className="manual-conversion-checkbox" htmlFor={checkboxId}>
            <input
              id={checkboxId}
              name="confirmDuplicate"
              type="checkbox"
              checked={confirmDuplicate}
              onChange={(event) =>
                setConfirmDuplicate(event.currentTarget.checked)
              }
            />
            <span>
              Sim, registrar mesmo assim (é outra conversão, não a mesma)
            </span>
          </label>
        </div>
      ) : null}
      {message ? (
        <ManualConversionWarning title={message} role="alert" />
      ) : null}
      <div className="conversion-flow-actions">
        <button
          className="button"
          type="button"
          onClick={onBack}
          disabled={pending}
        >
          Voltar
        </button>
        <button
          className="button primary manual-conversion-submit"
          type="button"
          onClick={() => onConfirm(needsConfirmation && confirmDuplicate)}
          disabled={disabled}
          aria-disabled={disabled}
        >
          {pending
            ? "Registrando..."
            : needsConfirmation
              ? "Registrar mesmo assim"
              : "Confirmar"}
        </button>
      </div>
    </div>
  );
}

export function ManualConversionOutcome({
  tone,
  title,
  detail,
  onClose,
}: {
  tone: "ok" | "neutral" | "warn";
  title: string;
  detail: string;
  onClose: () => void;
}) {
  return (
    <div className="manual-conversion-outcome" role="status">
      <span
        className={`status-chip manual-conversion-outcome-chip${tone === "warn" ? " warn" : tone === "neutral" ? " neutral" : ""}`}
      >
        {title}
      </span>
      <p>{detail}</p>
      <div className="conversion-flow-actions">
        <Link className="button" href="/events">
          Ver em Eventos Meta
        </Link>
        <button className="button primary" type="button" onClick={onClose}>
          Fechar
        </button>
      </div>
    </div>
  );
}

/** "Cancelar" of a manual conversion not sent yet (decision 8). */
export function CancelManualConversionButton({
  leadId,
  conversionEventLogId,
  onCanceled,
}: {
  leadId: string;
  conversionEventLogId: string;
  /** Replaces the page refresh (CRM Kanban lead modal). */
  onCanceled?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function cancel() {
    if (
      !window.confirm(
        "Cancelar esta conversão manual? Ela não será enviada à Meta e sai dos relatórios.",
      )
    )
      return;
    startTransition(async () => {
      const response = await cancelManualConversionAction(
        leadId,
        conversionEventLogId,
      ).catch(() => null);
      if (!response || !response.ok) {
        setMessage(response?.message ?? "Não foi possível cancelar agora.");
        return;
      }
      if (onCanceled) onCanceled();
      else router.refresh();
    });
  }

  return (
    <span className="manual-conversion-cancel">
      <button
        className="button compact"
        type="button"
        onClick={cancel}
        disabled={pending}
      >
        {pending ? "Cancelando..." : "Cancelar"}
      </button>
      {message ? <span className="form-error">{message}</span> : null}
    </span>
  );
}
