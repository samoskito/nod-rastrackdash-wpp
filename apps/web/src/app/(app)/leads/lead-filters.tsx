"use client";

import {
  CalendarDays,
  RotateCcw,
  Search,
  SlidersHorizontal,
} from "lucide-react";
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
import {
  hasEditableLeadFilter,
  leadFilterKeys,
  leadFiltersClearHref,
  leadFiltersHref,
  reportScopeKeys,
  scopeKeys,
  type LeadFilterKey,
  type LeadFilterValues,
} from "./lead-filter-params";

/** Typing dates and text emits intermediate values; wait before applying. */
const deferredCommitDelayMs = 800;

/**
 * The Leads period is optional on both ends: either side alone is a valid
 * open range, but a half-typed date or Fim before Inicio never commits.
 */
export function leadDateRangeStatus(
  since: string,
  until: string,
): ReturnType<typeof dateRangeStatus> {
  if (since && until) {
    return dateRangeStatus(since, until);
  }

  const single = since || until;
  return single ? dateRangeStatus(single, single) : "valid";
}

/**
 * Applies only what is committable: a half-typed or inverted period keeps the
 * applied one while every other edit still goes through.
 */
export function committableLeadFilters(
  next: LeadFilterValues,
  applied: LeadFilterValues,
): LeadFilterValues {
  const period =
    leadDateRangeStatus(next.since, next.until) === "valid" ? next : applied;

  return { ...next, since: period.since, until: period.until };
}

export function LeadFilters({
  applied,
  page,
}: {
  applied: LeadFilterValues;
  page: number;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const dateErrorId = useId();
  const appliedHref = leadFiltersHref(applied);
  const location = `${appliedHref}#${page}`;
  const appliedRef = useRef(applied);
  appliedRef.current = applied;
  // Local edits; the URL (props) is the source of truth once it lands.
  const [fields, setFields] = useState<LeadFilterValues>(applied);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const lastSyncedRef = useRef(applied);
  const lastLocationRef = useRef(location);
  const lastCommittedHrefRef = useRef(appliedHref);
  // Keys typed since the last commit; a landing navigation must not eat them.
  const dirtyKeysRef = useRef(new Set<LeadFilterKey>());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const wasPendingRef = useRef(false);
  const advancedFilterCount = [
    applied.attribution,
    applied.label,
    applied.since,
    applied.until,
    ...reportScopeKeys.map((key) => applied[key]),
  ].filter(Boolean).length;
  const clearHref = leadFiltersClearHref(applied);
  const canClear = hasEditableLeadFilter(applied);
  // Uncontrolled after mount: applying a filter must not fold the panel the
  // user is working in.
  const [advancedOpen, setAdvancedOpen] = useState(advancedFilterCount > 0);

  useEffect(() => {
    if (isPending || location === lastLocationRef.current) {
      return;
    }

    const previous = lastSyncedRef.current;
    // Our own commits always land on page 1 of the href we pushed. Anything
    // else (back/forward, Limpar, pagination) is a navigation the user chose,
    // so a pending edit from before it is stale.
    const isOwnNavigation =
      appliedHref === lastCommittedHrefRef.current && page === 1;

    lastLocationRef.current = location;
    lastSyncedRef.current = applied;
    lastCommittedHrefRef.current = appliedHref;

    if (!isOwnNavigation) {
      cancelPendingEdit();
      setFields(applied);
      return;
    }

    // Same rule as the overview: only the keys the URL changed, so a late
    // navigation never overwrites a newer edit.
    const changed = leadFilterKeys.filter(
      (key) => previous[key] !== applied[key] && !dirtyKeysRef.current.has(key),
    );

    if (changed.length === 0) {
      return;
    }

    setFields((current) => {
      const next = { ...current };

      for (const key of changed) {
        // "mari " already applied as "mari": keep the space being typed.
        if (current[key].trim() !== applied[key]) {
          next[key] = applied[key];
        }
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

  function commit(next: LeadFilterValues) {
    cancelPendingEdit();

    const href = leadFiltersHref(
      committableLeadFilters(next, appliedRef.current),
    );

    if (href === lastCommittedHrefRef.current) {
      return;
    }

    lastCommittedHrefRef.current = href;
    startTransition(() => {
      router.push(href, { scroll: false });
    });
  }

  function setLocal(patch: Partial<LeadFilterValues>) {
    const next = { ...fieldsRef.current, ...patch };

    fieldsRef.current = next;
    setFields(next);
    return next;
  }

  /** Selects: apply right away. */
  function update(patch: Partial<LeadFilterValues>) {
    commit(setLocal(patch));
  }

  /** Text and dates: apply after a pause in typing, on blur or on Enter. */
  function edit(patch: Partial<LeadFilterValues>) {
    setLocal(patch);

    for (const key of Object.keys(patch) as LeadFilterKey[]) {
      dirtyKeysRef.current.add(key);
    }

    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      commit(fieldsRef.current);
    }, deferredCommitDelayMs);
  }

  function flush(event: FocusEvent<HTMLInputElement>) {
    // Leaving a field for Limpar must not apply the edit Limpar discards.
    if (
      event.relatedTarget instanceof Element &&
      event.relatedTarget.closest("[data-lead-filters-clear]")
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
    leadDateRangeStatus(fields.since, fields.until) === "order";

  return (
    <form
      className="surface-panel lead-filter-panel"
      aria-label="Filtros de leads"
      action="/leads"
      onSubmit={submit}
    >
      <div className="lead-filter-primary">
        <label className="lead-search-control">
          <span className="sr-only">Buscar por nome ou telefone</span>
          <Search aria-hidden="true" size={18} strokeWidth={2} />
          <input
            className="filter-control"
            name="search"
            placeholder="Nome ou telefone"
            value={fields.search}
            onChange={(event) => edit({ search: event.currentTarget.value })}
            onBlur={flush}
            data-presentation-sensitive-field="true"
          />
        </label>
        <select
          className="filter-control"
          name="base"
          aria-label="Base de leads"
          title="Leads novos: primeiro contato no período. Voltaram: já falaram antes e iniciaram uma nova conversa por anúncio no período. 2+ conversas: iniciaram 2 ou mais conversas por anúncio no período, novos ou não."
          value={fields.base}
          onChange={(event) => update({ base: event.currentTarget.value })}
        >
          <option value="">Leads novos</option>
          <option value="returning">Voltaram</option>
          <option value="repeat">2+ conversas</option>
        </select>
        <select
          className="filter-control"
          name="status"
          aria-label="Situação operacional"
          value={fields.status}
          onChange={(event) => update({ status: event.currentTarget.value })}
        >
          <option value="">Toda situação</option>
          <option value="active">Em atendimento</option>
          <option value="qualified">Qualificados</option>
          <option value="converted">Compradores</option>
          <option value="lost">Perdidos</option>
        </select>
        <select
          className="filter-control"
          name="eventName"
          aria-label="Etapa do funil"
          value={fields.eventName}
          onChange={(event) => update({ eventName: event.currentTarget.value })}
        >
          <option value="">Todas as etapas</option>
          <option value="LeadSubmitted">Conversa iniciada</option>
          <option value="QualifiedLead">Lead qualificado</option>
          <option value="Purchase">Compra atribuída</option>
        </select>
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
        {canClear ? (
          <Link
            className="button ghost"
            href={clearHref}
            data-lead-filters-clear="true"
            onClick={cancelPendingEdit}
          >
            <RotateCcw aria-hidden="true" size={16} strokeWidth={2} />
            Limpar
          </Link>
        ) : null}
      </div>

      <details
        className="lead-advanced-filters"
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary>
          <span>
            <SlidersHorizontal aria-hidden="true" size={17} strokeWidth={2} />
            Filtros avançados
          </span>
          {advancedFilterCount > 0 ? (
            <span className="lead-active-filter-count">
              {advancedFilterCount} ativo(s)
            </span>
          ) : (
            <span>Origem, etiqueta, período e exibição</span>
          )}
        </summary>
        <div className="lead-filter-advanced-grid">
          <label className="filter-field">
            <span>Origem</span>
            <select
              className="filter-control"
              name="attribution"
              value={fields.attribution}
              onChange={(event) =>
                update({ attribution: event.currentTarget.value })
              }
            >
              <option value="">Toda origem</option>
              <option value="paid">Anúncio</option>
              <option value="organic">Orgânico (sem anúncio)</option>
            </select>
          </label>
          <label className="filter-field">
            <span>Etiqueta</span>
            <input
              className="filter-control"
              name="label"
              placeholder="Ex.: VIP"
              value={fields.label}
              onChange={(event) => edit({ label: event.currentTarget.value })}
              onBlur={flush}
              data-presentation-sensitive-field="true"
            />
          </label>
          <label className="filter-field">
            <span>Início</span>
            <span className="lead-date-control">
              <CalendarDays aria-hidden="true" size={16} strokeWidth={2} />
              <input
                type="date"
                name="since"
                value={fields.since}
                onChange={(event) => edit({ since: event.currentTarget.value })}
                onBlur={flush}
              />
            </span>
          </label>
          <label className="filter-field overview-date-end">
            <span>Fim</span>
            <span className="lead-date-control">
              <CalendarDays aria-hidden="true" size={16} strokeWidth={2} />
              <input
                type="date"
                name="until"
                value={fields.until}
                aria-invalid={dateOrderInvalid ? "true" : undefined}
                aria-describedby={dateOrderInvalid ? dateErrorId : undefined}
                onChange={(event) => edit({ until: event.currentTarget.value })}
                onBlur={flush}
              />
            </span>
            {dateOrderInvalid ? (
              <span className="overview-filter-error" id={dateErrorId}>
                Fim antes do início
              </span>
            ) : null}
          </label>
          <label className="filter-field">
            <span>Por página</span>
            <select
              className="filter-control"
              name="pageSize"
              value={fields.pageSize}
              onChange={(event) =>
                update({ pageSize: event.currentTarget.value })
              }
            >
              <option value="25">25 leads</option>
              <option value="50">50 leads</option>
              <option value="100">100 leads</option>
            </select>
          </label>
        </div>
      </details>

      {scopeKeys.map((key) =>
        fields[key] ? (
          <input key={key} type="hidden" name={key} value={fields[key]} />
        ) : null,
      )}
      {/* Implicit Enter-submit and the no-JS GET still need a submitter. */}
      <button className="sr-only" type="submit" tabIndex={-1}>
        Atualizar leads
      </button>
    </form>
  );
}
