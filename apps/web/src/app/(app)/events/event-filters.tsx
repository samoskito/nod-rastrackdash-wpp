"use client";

import type { ConversionAuditEventOptionDto } from "@wpptrack/shared";
import { CalendarRange, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type FocusEvent,
  type FormEvent,
} from "react";
import { dateRangeStatus } from "../overview/overview-filters";

/** Every audit filter, in canonical URL order ("" = not set). */
export type EventFilterValues = {
  since: string;
  until: string;
  pageSize: string;
  eventName: string;
  status: string;
  source: string;
};

type EventFilterKey = keyof EventFilterValues;

export const eventFilterKeys = [
  "since",
  "until",
  "pageSize",
  "eventName",
  "status",
  "source",
] as const satisfies readonly EventFilterKey[];

/** Typing dates emits intermediate values; wait before applying. */
const deferredCommitDelayMs = 800;

/**
 * Canonical, shareable href in the same order the pagination links use, minus
 * `page` so a new filter always starts on the first page. The audit always
 * carries its period and page size, as Limpar filtros always did.
 */
export function eventFiltersHref(filters: EventFilterValues): string {
  const params = new URLSearchParams();

  for (const key of eventFilterKeys) {
    const value = filters[key].trim();

    if (value) {
      params.set(key, value);
    }
  }

  const query = params.toString();
  return query ? `/events?${query}` : "/events";
}

/**
 * The audit period needs both ends: a half-typed, cleared or inverted range
 * keeps the applied one while every other edit still goes through.
 */
export function committableEventFilters(
  next: EventFilterValues,
  applied: EventFilterValues,
): EventFilterValues {
  const period =
    dateRangeStatus(next.since, next.until) === "valid" ? next : applied;

  return { ...next, since: period.since, until: period.until };
}

export function EventFilters({
  applied,
  eventOptions,
  page,
  rangeLabel,
}: {
  applied: EventFilterValues;
  eventOptions: ConversionAuditEventOptionDto[];
  page: number;
  rangeLabel: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const dateErrorId = useId();
  const appliedHref = eventFiltersHref(applied);
  const location = `${appliedHref}#${page}`;
  const appliedRef = useRef(applied);
  appliedRef.current = applied;
  // Local edits; the URL (props) is the source of truth once it lands.
  const [fields, setFields] = useState<EventFilterValues>(applied);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const lastSyncedRef = useRef(applied);
  const lastLocationRef = useRef(location);
  const lastCommittedHrefRef = useRef(appliedHref);
  // Hrefs pushed by this form that have not landed yet, oldest first.
  const inFlightHrefsRef = useRef<string[]>([]);
  // Dates typed since the last commit; a landing navigation must not eat them.
  const dirtyKeysRef = useRef(new Set<EventFilterKey>());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const wasPendingRef = useRef(false);
  const activeFilterCount = [
    applied.eventName,
    applied.status,
    applied.source,
  ].filter(Boolean).length;
  const clearFiltersHref = eventFiltersHref({
    ...applied,
    eventName: "",
    status: "",
    source: "",
  });
  // Uncontrolled after mount: applying a filter must not fold the panel the
  // user is working in.
  const [advancedOpen, setAdvancedOpen] = useState(activeFilterCount > 0);

  useEffect(() => {
    if (isPending || location === lastLocationRef.current) {
      return;
    }

    const previous = lastSyncedRef.current;
    // Our own commits always land on page 1 of an href we pushed. Anything
    // else (back/forward, Limpar filtros, pagination, even back to page 1) is
    // a navigation the user chose, so a pending edit from before it is stale.
    const ownIndex =
      page === 1 ? inFlightHrefsRef.current.indexOf(appliedHref) : -1;
    const isOwnNavigation = ownIndex !== -1;

    // Older pushes were superseded by this landing.
    inFlightHrefsRef.current = inFlightHrefsRef.current.slice(ownIndex + 1);
    lastLocationRef.current = location;
    lastSyncedRef.current = applied;
    lastCommittedHrefRef.current = appliedHref;

    if (!isOwnNavigation) {
      cancelPendingEdit();
      inFlightHrefsRef.current = [];
      setFields(applied);
      return;
    }

    // Same rule as the overview: only the keys the URL changed, so a late
    // navigation never overwrites a newer edit.
    const changed = eventFilterKeys.filter(
      (key) => previous[key] !== applied[key] && !dirtyKeysRef.current.has(key),
    );

    if (changed.length === 0) {
      return;
    }

    setFields((current) => {
      const next = { ...current };

      for (const key of changed) {
        next[key] = applied[key];
      }

      return next;
    });
    // `applied` is rebuilt every render; its serialised form is the dependency.
  }, [location, isPending]);

  useEffect(() => {
    if (isPending) {
      wasPendingRef.current = true;
      setStatusMessage("");
    } else if (wasPendingRef.current) {
      wasPendingRef.current = false;
      setStatusMessage("Dados atualizados.");
    }
  }, [isPending]);

  useEffect(() => {
    // Back/forward can land after the debounce; drop the edit right away.
    window.addEventListener("popstate", cancelPendingEdit);

    return () => {
      window.removeEventListener("popstate", cancelPendingEdit);
      clearTimer();
    };
  }, []);

  function clearTimer() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function cancelPendingEdit() {
    clearTimer();
    dirtyKeysRef.current.clear();
  }

  function commit(next: EventFilterValues) {
    cancelPendingEdit();

    const href = eventFiltersHref(
      committableEventFilters(next, appliedRef.current),
    );

    if (href === lastCommittedHrefRef.current) {
      return;
    }

    lastCommittedHrefRef.current = href;
    inFlightHrefsRef.current.push(href);
    startTransition(() => {
      router.push(href, { scroll: false });
    });
  }

  function setLocal(patch: Partial<EventFilterValues>) {
    const next = { ...fieldsRef.current, ...patch };

    fieldsRef.current = next;
    setFields(next);
    return next;
  }

  /** Selects: apply right away. */
  function update(patch: Partial<EventFilterValues>) {
    commit(setLocal(patch));
  }

  /** Dates: apply after a pause in typing, on blur or on Enter. */
  function edit(patch: Partial<EventFilterValues>) {
    setLocal(patch);

    for (const key of Object.keys(patch) as EventFilterKey[]) {
      dirtyKeysRef.current.add(key);
    }

    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      commit(fieldsRef.current);
    }, deferredCommitDelayMs);
  }

  function flush(event: FocusEvent<HTMLInputElement>) {
    // Leaving a field for Limpar filtros must not apply the edit it discards.
    if (
      event.relatedTarget instanceof Element &&
      event.relatedTarget.closest("[data-event-filters-clear]")
    ) {
      cancelPendingEdit();
      return;
    }

    if (timerRef.current) {
      commit(fieldsRef.current);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    commit(fieldsRef.current);
  }

  const dateOrderInvalid =
    dateRangeStatus(fields.since, fields.until) === "order";

  return (
    <form
      action="/events"
      aria-label="Filtros da auditoria Meta"
      className="audit-filter-form"
      onSubmit={submit}
    >
      <input type="hidden" name="pageSize" value={fields.pageSize} />
      <div className="audit-period-context">
        <CalendarRange aria-hidden="true" size={18} strokeWidth={2.1} />
        <span>
          <strong>Período da auditoria</strong>
          <small>{rangeLabel}</small>
        </span>
      </div>
      <label className="filter-field">
        <span>Início</span>
        <input
          type="date"
          name="since"
          value={fields.since}
          onChange={(event) => edit({ since: event.currentTarget.value })}
          onBlur={flush}
        />
      </label>
      <label className="filter-field overview-date-end">
        <span>Fim</span>
        <input
          type="date"
          name="until"
          value={fields.until}
          aria-invalid={dateOrderInvalid ? "true" : undefined}
          aria-describedby={dateOrderInvalid ? dateErrorId : undefined}
          onChange={(event) => edit({ until: event.currentTarget.value })}
          onBlur={flush}
        />
        {dateOrderInvalid ? (
          <span className="overview-filter-error" id={dateErrorId}>
            Fim antes do início
          </span>
        ) : null}
      </label>
      <div
        className="overview-filter-status"
        data-pending={isPending ? "true" : undefined}
      >
        {isPending ? (
          <span className="overview-filter-status-label" aria-hidden="true">
            <span className="overview-filter-spinner" />
            Atualizando...
          </span>
        ) : null}
        <span className="sr-only" role="status" aria-live="polite">
          {isPending ? "Atualizando..." : statusMessage}
        </span>
      </div>

      <details
        className="audit-advanced-filters"
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary>
          <span>
            <SlidersHorizontal aria-hidden="true" size={15} />
            Filtros
          </span>
          {activeFilterCount > 0 ? (
            <span className="tag">{activeFilterCount} ativo(s)</span>
          ) : (
            <span className="muted">Opcional</span>
          )}
        </summary>
        <div className="audit-filter-grid">
          <label className="filter-field">
            <span>Evento</span>
            <select
              className="filter-control"
              name="eventName"
              value={fields.eventName}
              onChange={(event) =>
                update({ eventName: event.currentTarget.value })
              }
            >
              <option value="">Todos os eventos</option>
              {eventOptions.map((option) => (
                <option key={option.eventName} value={option.eventName}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-field">
            <span>Estado da entrega</span>
            <select
              className="filter-control"
              name="status"
              value={fields.status}
              onChange={(event) =>
                update({ status: event.currentTarget.value })
              }
            >
              <option value="">Todos os estados</option>
              <option value="sent">Enviados</option>
              <option value="queued">Aguardando envio</option>
              <option value="blocked">Bloqueados</option>
              <option value="failed">Falhas</option>
              <option value="not_eligible">Não elegíveis</option>
              <option value="shadow">Observados em sombra</option>
              <option value="historical">Históricos</option>
              <option value="discarded">Descartados</option>
            </select>
          </label>
          <label className="filter-field">
            <span>Origem</span>
            <select
              className="filter-control"
              name="source"
              value={fields.source}
              onChange={(event) =>
                update({ source: event.currentTarget.value })
              }
            >
              <option value="">Todas as origens</option>
              <option value="external_integration">Integração externa</option>
              <option value="whatsapp_automation">Automação do WhatsApp</option>
              <option value="system">Regra automática</option>
              <option value="manual_test">Teste manual</option>
              <option value="manual">Manual</option>
              <option value="other">Outra origem</option>
            </select>
          </label>
        </div>
        <footer className="audit-filter-footer">
          <span>
            {activeFilterCount > 0
              ? "A lista está usando filtros personalizados."
              : "Todos os tipos, estados e origens estão incluídos."}
          </span>
          {activeFilterCount > 0 ? (
            <Link
              className="button ghost"
              href={clearFiltersHref}
              data-event-filters-clear="true"
              onClick={cancelPendingEdit}
            >
              Limpar filtros
            </Link>
          ) : null}
        </footer>
      </details>

      {/* Implicit Enter-submit and the no-JS GET still need a submitter. */}
      <button className="sr-only" type="submit" tabIndex={-1}>
        Atualizar auditoria
      </button>
    </form>
  );
}
