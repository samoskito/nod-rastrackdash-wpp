"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  setAdAccountParams,
  splitAdAccountIds,
} from "../../../lib/ad-account-params";
import { dateRangeStatus } from "../overview/overview-filters";

/** Every report filter, in canonical URL order ("" = not set). */
export type ReportFilterValues = {
  since: string;
  until: string;
  compareSince: string;
  compareUntil: string;
  businessId: string;
  /**
   * Ad accounts joined by "," in selection order; written as `adAccountId`
   * (one) or `adAccountIds` (two or more).
   */
  adAccountId: string;
  whatsappInstanceId: string;
  campaignId: string;
  adSetId: string;
  adId: string;
  nameContains: string;
  nameScope: string;
  status: string;
  delivery: string;
  selectedIds: string;
  whatsappClassification: string;
  pageSize: string;
  metrics: string;
  view: string;
  /** "insights" or "" for the default table. */
  mode: string;
  /** Insight objective; "" for the default. */
  objective: string;
  /** Column ordering; both "" when the API order is used. */
  sort: string;
  dir: string;
};

export type ReportFilterKey = keyof ReportFilterValues;

export const reportFilterKeys = [
  "since",
  "until",
  "compareSince",
  "compareUntil",
  "businessId",
  "adAccountId",
  "whatsappInstanceId",
  "campaignId",
  "adSetId",
  "adId",
  "nameContains",
  "nameScope",
  "status",
  "delivery",
  "selectedIds",
  "whatsappClassification",
  "pageSize",
  "metrics",
  "view",
  "mode",
  "objective",
  "sort",
  "dir",
] as const satisfies readonly ReportFilterKey[];

/** Typing dates and names emits intermediate values; wait before applying. */
const deferredCommitDelayMs = 800;

/**
 * Canonical, shareable href: fixed param order, empty and default params
 * omitted, and no `page` so a new filter always starts on the first page.
 */
export function reportFiltersHref(filters: ReportFilterValues): string {
  const params = new URLSearchParams();

  for (const key of reportFilterKeys) {
    const value = filters[key];

    if (key === "adAccountId") {
      setAdAccountParams(params, splitAdAccountIds(value));
      continue;
    }

    if (
      !value ||
      (key === "nameScope" && !filters.nameContains) ||
      (key === "delivery" && value === "all") ||
      (key === "metrics" && value === "overview")
    ) {
      continue;
    }

    params.set(key, value);
  }

  const query = params.toString();
  return query ? `/reports?${query}` : "/reports";
}

/** The comparison is optional, so clearing both ends is a valid edit. */
export function comparisonRangeStatus(
  compareSince: string,
  compareUntil: string,
): ReturnType<typeof dateRangeStatus> {
  return !compareSince && !compareUntil
    ? "valid"
    : dateRangeStatus(compareSince, compareUntil);
}

/**
 * Applies only what is committable: a half-typed or inverted range keeps the
 * applied one while every other edit still goes through.
 */
export function committableReportFilters(
  next: ReportFilterValues,
  applied: ReportFilterValues,
): ReportFilterValues {
  const period =
    dateRangeStatus(next.since, next.until) === "valid" ? next : applied;
  const comparison =
    comparisonRangeStatus(next.compareSince, next.compareUntil) === "valid"
      ? next
      : applied;

  return {
    ...next,
    since: period.since,
    until: period.until,
    compareSince: comparison.compareSince,
    compareUntil: comparison.compareUntil,
  };
}

type ReportFilterState = {
  applied: ReportFilterValues;
  fields: ReportFilterValues;
  isPending: boolean;
  statusMessage: string;
  /** Selects: apply right away. */
  update: (patch: Partial<ReportFilterValues>) => void;
  /** Dates and text: apply after a pause in typing, on blur or on Enter. */
  edit: (patch: Partial<ReportFilterValues>) => void;
  flush: () => void;
  submit: (event: FormEvent<HTMLFormElement>) => void;
};

const ReportFilterContext = createContext<ReportFilterState | null>(null);

/**
 * One filter state for the Periodo and Escopo forms, so a date still being
 * typed and a select changed meanwhile land in the same URL.
 */
export function ReportFiltersProvider({
  applied,
  children,
}: {
  applied: ReportFilterValues;
  children: ReactNode;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const appliedHref = reportFiltersHref(applied);
  const appliedRef = useRef(applied);
  appliedRef.current = applied;
  // Local edits; the URL (props) is the source of truth once it lands.
  const [fields, setFields] = useState<ReportFilterValues>(applied);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const lastSyncedRef = useRef(applied);
  const lastCommittedHrefRef = useRef(appliedHref);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const wasPendingRef = useRef(false);

  // Same rule as the overview: sync once nothing is in flight, and only the
  // fields the URL changed, so a late navigation never eats a newer edit.
  useEffect(() => {
    if (isPending) {
      return;
    }

    const previous = lastSyncedRef.current;
    const changed = reportFilterKeys.filter(
      (key) => previous[key] !== applied[key],
    );

    lastCommittedHrefRef.current = appliedHref;

    if (changed.length === 0) {
      return;
    }

    lastSyncedRef.current = applied;
    setFields((current) => {
      const next = { ...current };

      for (const key of changed) {
        next[key] = applied[key];
      }

      return next;
    });
    // `applied` is rebuilt every render; its serialised form is the dependency.
  }, [appliedHref, isPending]);

  useEffect(() => {
    if (isPending) {
      wasPendingRef.current = true;
      setStatusMessage("");
    } else if (wasPendingRef.current) {
      wasPendingRef.current = false;
      setStatusMessage("Dados atualizados.");
    }
  }, [isPending]);

  useEffect(() => () => clearTimer(), []);

  function clearTimer() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function commit(next: ReportFilterValues) {
    clearTimer();

    const href = reportFiltersHref(
      committableReportFilters(next, appliedRef.current),
    );

    if (href === lastCommittedHrefRef.current) {
      return;
    }

    lastCommittedHrefRef.current = href;
    startTransition(() => {
      router.push(href, { scroll: false });
    });
  }

  function setLocal(patch: Partial<ReportFilterValues>) {
    const next = { ...fieldsRef.current, ...patch };

    fieldsRef.current = next;
    setFields(next);
    return next;
  }

  const value: ReportFilterState = {
    applied,
    fields,
    isPending,
    statusMessage,
    update: (patch) => commit(setLocal(patch)),
    edit: (patch) => {
      setLocal(patch);
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        commit(fieldsRef.current);
      }, deferredCommitDelayMs);
    },
    flush: () => commit(fieldsRef.current),
    submit: (event) => {
      event.preventDefault();
      commit(fieldsRef.current);
    },
  };

  return (
    <ReportFilterContext.Provider value={value}>
      {children}
    </ReportFilterContext.Provider>
  );
}

export function useReportFilters(): ReportFilterState {
  const state = useContext(ReportFilterContext);

  if (!state) {
    throw new Error(
      "useReportFilters must be used inside ReportFiltersProvider",
    );
  }

  return state;
}

/** Keeps the no-JS GET complete: every filter the form does not render. */
export function ReportHiddenFields({
  rendered,
}: {
  rendered: readonly ReportFilterKey[];
}) {
  const { fields } = useReportFilters();

  return (
    <>
      {reportFilterKeys
        .filter((key) => !rendered.includes(key) && fields[key])
        .map((key) => (
          <input key={key} type="hidden" name={key} value={fields[key]} />
        ))}
    </>
  );
}
