"use client";

import {
  CRM_MAX_PERIOD_DAYS,
  CRM_MAX_PERIOD_MESSAGE,
  crmPeriodDays,
} from "@wpptrack/shared";
import { CalendarDays, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  FilterCombobox,
  type FilterComboboxCopy,
} from "../../../components/filter-combobox";
import { usePresentationMode } from "../../../components/presentation-mode-toggle";
import {
  crmFiltersHref,
  defaultCrmPeriod,
  type CrmFilterValues,
} from "./crm-filter-params";

/** Native date inputs emit intermediate years while typing. */
const dateCommitDelayMs = 800;
const datePattern = /^(20\d{2})-\d{2}-\d{2}$/u;

/** Fase 6.3b (SaaS #116 + CRM do SaaS): a mesma busca de campanha da Visão Geral. */
const campaignCopy: FilterComboboxCopy = {
  all: "Todas as campanhas",
  searchPlaceholder: "Buscar campanha",
  searchLabel: "Buscar campanha por nome ou ID",
  count: (matches, total) => `${matches} de ${total} campanhas`,
  found: (matches) =>
    matches === 1 ? "1 campanha encontrada" : `${matches} campanhas encontradas`,
  noResults: (query) => `Nenhuma campanha com "${query}"`,
  clearSearch: "Limpar busca",
};

/** An active WhatsApp connection (nod: one number per connection). */
export type CrmWhatsappInstanceOption = {
  id: string;
  name: string;
  phone: string | null;
};
/** A Meta campaign of the workspace. */
export type CrmCampaignOption = { id: string; name: string };

/** "Nome - •••• 1234" (nod: the overview has no number filter yet). */
function instanceLabel(instance: CrmWhatsappInstanceOption): string {
  const identifier = instance.phone?.trim();
  if (!identifier) return instance.name;
  const suffix = identifier.slice(-4);
  return `${instance.name} - ${identifier.length <= 4 ? suffix : `•••• ${suffix}`}`;
}

/**
 * CRM filters (design §3): period by lead arrival (default last 30 days),
 * WhatsApp number and campaign, all in the URL. Same controls as the Visão
 * Geral (native selects, FilterCombobox for campaigns, Fase 6.3b).
 */
export function CrmFilters({
  filters,
  whatsappInstances,
  campaignOptions,
}: {
  filters: CrmFilterValues;
  whatsappInstances: CrmWhatsappInstanceOption[];
  campaignOptions: CrmCampaignOption[] | null;
}) {
  const router = useRouter();
  const presentationMode = usePresentationMode();
  const [isPending, startTransition] = useTransition();
  const [period, setPeriod] = useState({
    since: filters.since,
    until: filters.until,
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setPeriod({ since: filters.since, until: filters.until });
  }, [filters.since, filters.until]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function go(next: CrmFilterValues) {
    const href = crmFiltersHref(next);
    startTransition(() => router.push(href, { scroll: false }));
  }

  function editPeriod(patch: Partial<typeof period>) {
    const next = { ...period, ...patch };
    setPeriod(next);
    if (timer.current) clearTimeout(timer.current);
    if (
      !datePattern.test(next.since) ||
      !datePattern.test(next.until) ||
      next.since > next.until ||
      crmPeriodDays(next.since, next.until) > CRM_MAX_PERIOD_DAYS
    )
      return;
    timer.current = setTimeout(() => go({ ...filters, ...next }), dateCommitDelayMs);
  }

  const fallback = defaultCrmPeriod();
  const hasFilter =
    Boolean(filters.whatsappInstanceId || filters.campaignId) ||
    filters.since !== fallback.since ||
    filters.until !== fallback.until;
  const periodInvalid = Boolean(
    period.since && period.until && period.since > period.until,
  );
  const periodTooLong =
    !periodInvalid &&
    datePattern.test(period.since) &&
    datePattern.test(period.until) &&
    crmPeriodDays(period.since, period.until) > CRM_MAX_PERIOD_DAYS;
  const options = (campaignOptions ?? []).map((option) => ({
    value: option.id,
    label: option.name,
    description: `ID ${option.id}`,
  }));
  if (
    filters.campaignId &&
    !options.some((option) => option.value === filters.campaignId)
  )
    options.unshift({
      value: filters.campaignId,
      label: "Campanha selecionada",
      description: `ID ${filters.campaignId}`,
    });

  return (
    <form
      className="crm-filters"
      aria-label="Filtros do CRM"
      onSubmit={(event) => event.preventDefault()}
    >
      <label className="filter-field">
        <span>Chegada de</span>
        <span className="lead-date-control">
          <CalendarDays aria-hidden="true" size={16} strokeWidth={2} />
          <input
            type="date"
            name="since"
            value={period.since}
            onChange={(event) => editPeriod({ since: event.currentTarget.value })}
          />
        </span>
      </label>
      <label className="filter-field">
        <span>até</span>
        <span className="lead-date-control">
          <CalendarDays aria-hidden="true" size={16} strokeWidth={2} />
          <input
            type="date"
            name="until"
            value={period.until}
            aria-invalid={periodInvalid || periodTooLong ? "true" : undefined}
            onChange={(event) => editPeriod({ until: event.currentTarget.value })}
          />
        </span>
        {periodInvalid ? (
          <span className="overview-filter-error">Fim antes do início</span>
        ) : periodTooLong ? (
          <span className="overview-filter-error" role="alert">
            {CRM_MAX_PERIOD_MESSAGE}
          </span>
        ) : null}
      </label>
      <label className="filter-field">
        <span>Número</span>
        <select
          name="whatsappInstanceId"
          value={filters.whatsappInstanceId}
          onChange={(event) =>
            go({ ...filters, whatsappInstanceId: event.currentTarget.value })
          }
        >
          <option value="">Todos os números</option>
          {filters.whatsappInstanceId &&
          !whatsappInstances.some((i) => i.id === filters.whatsappInstanceId) ? (
            <option value={filters.whatsappInstanceId}>Número selecionado</option>
          ) : null}
          {whatsappInstances.map((instance) => (
            <option key={instance.id} value={instance.id}>
              {presentationMode ? "Número oculto" : instanceLabel(instance)}
            </option>
          ))}
        </select>
      </label>
      <FilterCombobox
        className="crm-campaign-filter"
        mode="single"
        name="campaignId"
        label="Campanha"
        value={filters.campaignId ? [filters.campaignId] : []}
        options={options}
        copy={campaignCopy}
        disabledLabel={
          campaignOptions === null && !filters.campaignId
            ? "Campanhas indisponíveis"
            : undefined
        }
        presentationPlaceholder={
          presentationMode
            ? filters.campaignId
              ? "Campanha oculta"
              : campaignCopy.all
            : undefined
        }
        onCommit={(next) => go({ ...filters, campaignId: next[0] ?? "" })}
      />
      <div className="crm-filter-status" aria-live="polite">
        {isPending ? (
          <span className="overview-filter-status-label">
            <span className="overview-filter-spinner" aria-hidden="true" />
            Atualizando...
          </span>
        ) : null}
      </div>
      {hasFilter ? (
        <button
          className="button ghost"
          type="button"
          onClick={() =>
            go({
              ...fallback,
              whatsappInstanceId: "",
              campaignId: "",
            })
          }
        >
          <RotateCcw aria-hidden="true" size={15} strokeWidth={2} />
          Limpar
        </button>
      ) : null}
    </form>
  );
}
