"use client";

import { ShoppingCart } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import { dateRangeStatus } from "../../overview/overview-filters";

/** Every purchase review filter, in canonical URL order ("" = not set). */
export type PurchaseReviewFilterValues = {
  since: string;
  until: string;
  view: string;
  status: string;
  providerRuleId: string;
};

type PurchaseReviewFilterKey = keyof PurchaseReviewFilterValues;

export type PurchaseReviewRuleOption = { id: string; label: string };

export const purchaseReviewFilterKeys = [
  "since",
  "until",
  "view",
  "status",
  "providerRuleId",
] as const satisfies readonly PurchaseReviewFilterKey[];

/** Typing dates emits intermediate values; wait before applying. */
const deferredCommitDelayMs = 800;

/**
 * Canonical, shareable href in the same order the pagination links use, minus
 * `page` (a new filter always starts on the first page) and the fixed page
 * size.
 */
export function purchaseReviewFiltersHref(
  filters: PurchaseReviewFilterValues,
): string {
  const params = new URLSearchParams();

  for (const key of purchaseReviewFilterKeys) {
    const value = filters[key].trim();

    if (value) {
      params.set(key, value);
    }
  }

  const query = params.toString();
  return query
    ? `/events/purchase-reviews?${query}`
    : "/events/purchase-reviews";
}

/**
 * The review period needs both ends: a half-typed, cleared or inverted range
 * keeps the applied one while every other edit still goes through.
 */
export function committablePurchaseReviewFilters(
  next: PurchaseReviewFilterValues,
  applied: PurchaseReviewFilterValues,
): PurchaseReviewFilterValues {
  const period =
    dateRangeStatus(next.since, next.until) === "valid" ? next : applied;

  return { ...next, since: period.since, until: period.until };
}

export function PurchaseReviewFilters({
  applied,
  page,
  ruleOptions,
  totalItems,
}: {
  applied: PurchaseReviewFilterValues;
  page: number;
  ruleOptions: PurchaseReviewRuleOption[];
  totalItems: number;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const dateErrorId = useId();
  const appliedHref = purchaseReviewFiltersHref(applied);
  const location = `${appliedHref}#${page}`;
  const appliedRef = useRef(applied);
  appliedRef.current = applied;
  // Local edits; the URL (props) is the source of truth once it lands.
  const [fields, setFields] = useState<PurchaseReviewFilterValues>(applied);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const lastSyncedRef = useRef(applied);
  const lastLocationRef = useRef(location);
  const lastCommittedHrefRef = useRef(appliedHref);
  // Hrefs pushed by this form that have not landed yet, oldest first.
  const inFlightHrefsRef = useRef<string[]>([]);
  // Dates typed since the last commit; a landing navigation must not eat them.
  const dirtyKeysRef = useRef(new Set<PurchaseReviewFilterKey>());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const wasPendingRef = useRef(false);

  useEffect(() => {
    if (isPending || location === lastLocationRef.current) {
      return;
    }

    const previous = lastSyncedRef.current;
    // Our own commits always land on page 1 of an href we pushed. Anything
    // else (back/forward, pagination, even back to page 1) is a navigation the
    // user chose, so a pending edit from before it is stale.
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
    const changed = purchaseReviewFilterKeys.filter(
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

  function commit(next: PurchaseReviewFilterValues) {
    cancelPendingEdit();

    const href = purchaseReviewFiltersHref(
      committablePurchaseReviewFilters(next, appliedRef.current),
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

  function setLocal(patch: Partial<PurchaseReviewFilterValues>) {
    const next = { ...fieldsRef.current, ...patch };

    fieldsRef.current = next;
    setFields(next);
    return next;
  }

  /** Selects: apply right away. */
  function update(patch: Partial<PurchaseReviewFilterValues>) {
    commit(setLocal(patch));
  }

  /** Dates: apply after a pause in typing, on blur or on Enter. */
  function edit(patch: Partial<PurchaseReviewFilterValues>) {
    setLocal(patch);

    for (const key of Object.keys(patch) as PurchaseReviewFilterKey[]) {
      dirtyKeysRef.current.add(key);
    }

    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      commit(fieldsRef.current);
    }, deferredCommitDelayMs);
  }

  function flush() {
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
      action="/events/purchase-reviews"
      aria-label="Filtros da revisão de compras"
      className="purchase-review-filter-form"
      onSubmit={submit}
    >
      <div className="purchase-review-filter-title">
        <ShoppingCart aria-hidden="true" size={18} />
        <span>
          <strong>Fila operacional</strong>
          <small>{totalItems} compra(s) no período</small>
        </span>
      </div>
      <label className="filter-field">
        <span>Início</span>
        <input
          className="input-field"
          name="since"
          type="date"
          value={fields.since}
          onChange={(event) => edit({ since: event.currentTarget.value })}
          onBlur={flush}
        />
      </label>
      <label className="filter-field overview-date-end">
        <span>Fim</span>
        <input
          className="input-field"
          name="until"
          type="date"
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
      <label className="filter-field">
        <span>Visualização</span>
        <select
          className="filter-control"
          name="view"
          value={fields.view}
          onChange={(event) => update({ view: event.currentTarget.value })}
        >
          <option value="actionable">Pendências</option>
          <option value="history">Histórico concluído</option>
          <option value="all">Todas</option>
        </select>
      </label>
      <label className="filter-field">
        <span>Estado</span>
        <select
          className="filter-control"
          name="status"
          value={fields.status}
          onChange={(event) => update({ status: event.currentTarget.value })}
        >
          <option value="">Todos</option>
          <option value="review_required">Revisão necessária</option>
          <option value="awaiting_data">Aguardando dados</option>
          <option value="recognized">Reconhecidas</option>
          <option value="approved">Na fila</option>
          <option value="sent">Enviadas</option>
          <option value="failed">Falhas</option>
          <option value="duplicate">Duplicadas</option>
          <option value="rejected">Rejeitadas</option>
          <option value="corrected_after_send">Corrigidas no painel</option>
        </select>
      </label>
      <label className="filter-field">
        <span>Regra</span>
        <select
          className="filter-control"
          name="providerRuleId"
          value={fields.providerRuleId}
          onChange={(event) =>
            update({ providerRuleId: event.currentTarget.value })
          }
        >
          <option value="">Todas as regras</option>
          {ruleOptions.map((rule) => (
            <option key={rule.id} value={rule.id}>
              {rule.label}
            </option>
          ))}
        </select>
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

      {/* Implicit Enter-submit and the no-JS GET still need a submitter. */}
      <button className="sr-only" type="submit" tabIndex={-1}>
        Atualizar revisão
      </button>
    </form>
  );
}
