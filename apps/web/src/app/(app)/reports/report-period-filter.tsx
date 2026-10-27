"use client";

import { CalendarRange } from "lucide-react";
import { useId } from "react";
import { dateRangeStatus } from "../overview/overview-filters";
import { ReportHiddenFields, useReportFilters } from "./report-filter-state";

export function ReportPeriodFilter({ periodLabel }: { periodLabel: string }) {
  const { edit, fields, flush, submit } = useReportFilters();
  const dateErrorId = useId();
  const dateOrderInvalid =
    dateRangeStatus(fields.since, fields.until) === "order";

  return (
    <form className="report-period-form" action="/reports" onSubmit={submit}>
      <ReportHiddenFields rendered={["since", "until"]} />
      <div className="report-period-context">
        <CalendarRange aria-hidden="true" size={17} />
        <span>
          <strong>Período de análise</strong>
          <small>{periodLabel}</small>
        </span>
      </div>
      <div className="report-period-range">
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
      </div>
      {/* Implicit Enter-submit and the no-JS GET still need a submitter. */}
      <button className="sr-only" type="submit" tabIndex={-1}>
        Atualizar período
      </button>
    </form>
  );
}
