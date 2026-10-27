"use client";

import type {
  CampaignOptionDto,
  CurrencyCode,
  MetaReportingAccountDto,
} from "@wpptrack/shared";
import { RotateCcw, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { AdAccountFilter } from "../../../components/ad-account-filter";
import {
  FilterCombobox,
  type FilterComboboxCopy,
  type FilterComboboxGroup,
  type FilterComboboxHandle,
  type FilterComboboxOption,
} from "../../../components/filter-combobox";
import { usePresentationMode } from "../../../components/presentation-mode-toggle";
import {
  joinAdAccountIds,
  setAdAccountParams,
  splitAdAccountIds,
} from "../../../lib/ad-account-params";
import type { WhatsappNumberOption } from "../../../lib/whatsapp-number-options";
import {
  maxOverviewCampaigns,
  setCampaignParams,
} from "./overview-campaign-params";
import { instanceLabel } from "./overview-labels";
import { useOverviewTransition } from "./overview-pending";

type OverviewFiltersProps = {
  /** Selected ad accounts, joined by "," in selection order. */
  adAccountId?: string;
  /** Effective currency per ad account (badge in the account filter). */
  accountCurrencies?: Readonly<Record<string, CurrencyCode>>;
  businessId?: string;
  /** Applied campaigns, in selection order. */
  campaignIds?: string[];
  /** Names from the report, for selected campaigns missing from the options. */
  campaignNames?: Record<string, string>;
  /** `null` when `/reports/campaign-options` failed; the field is disabled. */
  campaignOptions: CampaignOptionDto[] | null;
  hasActiveFilter: boolean;
  reportingAccounts: MetaReportingAccountDto[];
  since?: string;
  until?: string;
  whatsappInstanceId?: string;
  whatsappInstances: WhatsappNumberOption[];
};

type CampaignOptionGroups =
  | { kind: "flat"; options: CampaignOptionDto[] }
  | {
      kind: "grouped";
      withLeads: CampaignOptionDto[];
      others: CampaignOptionDto[];
    };

/** Every overview filter, in canonical URL order ("" / [] = not set). */
export type OverviewFilterValues = {
  since: string;
  until: string;
  businessId: string;
  /**
   * Ad accounts joined by "," in selection order; written as `adAccountId`
   * (one) or `adAccountIds` (two or more).
   */
  adAccountId: string;
  whatsappInstanceId: string;
  /** Selection order; written as `campaignId` or `campaignIds` (§3.1). */
  campaignIds: string[];
};

const filterKeys = [
  "since",
  "until",
  "businessId",
  "adAccountId",
  "whatsappInstanceId",
  "campaignIds",
] as const satisfies readonly (keyof OverviewFilterValues)[];

const campaignLabelMaxLength = 60;
const campaignChipMaxLength = 32;
/** Chips shown before the rest collapse into "+k" (1 on mobile, via CSS). */
const campaignChipLimit = 6;
const accountsCollapseQuery = "(max-width: 620px)";
/** Native date inputs emit intermediate years while typing (0002, 0020...). */
const dateCommitDelayMs = 800;
/** The product has no data before this year; lower years are half-typed. */
const minFilterYear = 2020;

function selectedCampaignsLabel(count: number) {
  return `${count} ${count === 1 ? "selecionada" : "selecionadas"}`;
}

const campaignComboboxCopy: FilterComboboxCopy = {
  all: "Todas as campanhas",
  searchPlaceholder: "Buscar campanha",
  searchLabel: "Buscar campanha por nome ou ID",
  count: (matches, total) => `${matches} de ${total} campanhas`,
  found: (matches) =>
    matches === 1
      ? "1 campanha encontrada"
      : `${matches} campanhas encontradas`,
  noResults: (query) => `Nenhuma campanha com "${query}"`,
  clearSearch: "Limpar busca",
  multi: {
    triggerCount: (count) => `${count} campanhas`,
    selectedCount: selectedCampaignsLabel,
    toggled: (label, added, count) =>
      `${label} ${added ? "adicionada" : "removida"}. ${selectedCampaignsLabel(count)}.`,
    limit: (max) => `Limite de ${max} campanhas`,
    clear: "Limpar",
    done: "Pronto",
  },
};

const campaignComboboxGroups: FilterComboboxGroup[] = [
  { key: "with_leads", label: "Com conversas neste número" },
  { key: "others", label: "Outras campanhas" },
];

/** Canonical, shareable href: fixed param order, empty params omitted. */
export function overviewFiltersHref(filters: OverviewFilterValues): string {
  const params = new URLSearchParams();

  for (const key of filterKeys) {
    if (key === "campaignIds") {
      setCampaignParams(params, filters.campaignIds);
    } else if (key === "adAccountId") {
      setAdAccountParams(params, splitAdAccountIds(filters.adAccountId));
    } else if (filters[key]) {
      params.set(key, filters[key]);
    }
  }

  const query = params.toString();
  return query ? `/overview?${query}` : "/overview";
}

function sameFilterValue(left: string | string[], right: string | string[]) {
  return Array.isArray(left) && Array.isArray(right)
    ? left.join(",") === right.join(",")
    : left === right;
}

function isCommittableDate(value: string) {
  const match = /^(\d{4})-\d{2}-\d{2}$/.exec(value);
  return Boolean(match) && Number(match![1]) >= minFilterYear;
}

/**
 * A period only commits when both ends are complete, plausible dates and the
 * range is ordered. `"order"` is the only state worth telling the user about.
 */
export function dateRangeStatus(
  since: string,
  until: string,
): "valid" | "incomplete" | "order" {
  if (!isCommittableDate(since) || !isCommittableDate(until)) {
    return "incomplete";
  }

  return until < since ? "order" : "valid";
}

function businessesFromAccounts(accounts: MetaReportingAccountDto[]) {
  const businesses = new Map<string, string>();

  for (const account of accounts) {
    businesses.set(account.businessId, account.businessName);
  }

  return Array.from(businesses, ([id, name]) => ({ id, name }));
}

function byName(left: CampaignOptionDto, right: CampaignOptionDto) {
  return left.name.localeCompare(right.name, "pt-BR");
}

/**
 * A number never hides campaigns, it only regroups them: campaigns with
 * conversations on the selected number come first (most leads first), the
 * rest stay selectable under "Outras campanhas".
 */
export function groupCampaignOptions(
  options: CampaignOptionDto[],
  whatsappInstanceId: string,
): CampaignOptionGroups {
  if (!whatsappInstanceId) {
    return { kind: "flat", options: [...options].sort(byName) };
  }

  const leadsOn = (option: CampaignOptionDto) =>
    option.leadsByInstance[whatsappInstanceId] ?? 0;

  return {
    kind: "grouped",
    withLeads: options
      .filter((option) => leadsOn(option) > 0)
      .sort(
        (left, right) => leadsOn(right) - leadsOn(left) || byName(left, right),
      ),
    others: options.filter((option) => leadsOn(option) === 0).sort(byName),
  };
}

/**
 * Whether a campaign option belongs to the BM/account scope being edited.
 * `adAccountId` may hold several accounts joined by ",".
 */
export function campaignInScope(
  option: CampaignOptionDto | undefined,
  businessId: string,
  adAccountId: string,
): boolean {
  const accountIds = splitAdAccountIds(adAccountId);

  if (!option) {
    return !businessId && accountIds.length === 0;
  }

  return (
    (!businessId || option.businessId === businessId) &&
    (accountIds.length === 0 || accountIds.includes(option.adAccountId))
  );
}

function truncate(text: string, maxLength: number) {
  return text.length > maxLength
    ? `${text.slice(0, maxLength - 1).trimEnd()}…`
    : text;
}

export function campaignOptionLabel(option: CampaignOptionDto): string {
  const name = truncate(option.name, campaignLabelMaxLength);

  return option.status === "paused" ? `${name} · Pausada` : name;
}

function missingCampaignLabel(name: string | undefined) {
  return `${name ?? "Campanha selecionada"} (sem dados no período)`;
}

function conversationsOnNumber(count: number) {
  return `${count} ${count === 1 ? "conversa" : "conversas"} neste número`;
}

function campaignComboboxOption(
  option: CampaignOptionDto,
  whatsappInstanceId: string,
  group?: string,
): FilterComboboxOption {
  const leads = whatsappInstanceId
    ? (option.leadsByInstance[whatsappInstanceId] ?? 0)
    : 0;

  return {
    value: option.id,
    label: campaignOptionLabel(option),
    title: option.name,
    description: leads > 0 ? conversationsOnNumber(leads) : undefined,
    group,
  };
}

export function OverviewFilters({
  accountCurrencies,
  adAccountId,
  businessId,
  campaignIds,
  campaignNames,
  campaignOptions,
  hasActiveFilter,
  reportingAccounts,
  since,
  until,
  whatsappInstanceId,
  whatsappInstances,
}: OverviewFiltersProps) {
  const router = useRouter();
  const [isPending, startTransition] = useOverviewTransition();
  const dateErrorId = useId();
  const businesses = useMemo(
    () => businessesFromAccounts(reportingAccounts),
    [reportingAccounts],
  );
  const presentationMode = usePresentationMode();
  const applied: OverviewFilterValues = {
    since: since ?? "",
    until: until ?? "",
    businessId: businessId ?? "",
    adAccountId: adAccountId ?? "",
    whatsappInstanceId: whatsappInstanceId ?? "",
    campaignIds: campaignIds ?? [],
  };
  const appliedHref = overviewFiltersHref(applied);
  // Local edits; the URL (props) is the source of truth once it lands.
  const [fields, setFields] = useState<OverviewFilterValues>(applied);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const lastSyncedRef = useRef(applied);
  const lastCommittedHrefRef = useRef(appliedHref);
  const dateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const campaignComboboxRef = useRef<FilterComboboxHandle>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const wasPendingRef = useRef(false);
  const accountFiltersActive = Boolean(businessId);
  // SSR renders the mobile layout (collapsed unless active). On wider screens
  // the details is `display: contents`, and the effect below keeps it open.
  const [accountsOpen, setAccountsOpen] = useState(accountFiltersActive);
  const accounts = useMemo(
    () =>
      fields.businessId
        ? reportingAccounts.filter(
            (account) => account.businessId === fields.businessId,
          )
        : reportingAccounts,
    [reportingAccounts, fields.businessId],
  );
  const activeWhatsappInstances = useMemo(
    () =>
      whatsappInstances.filter((instance) => instance.active),
    [whatsappInstances],
  );
  const selectedInstanceWasRemoved =
    Boolean(fields.whatsappInstanceId) &&
    !activeWhatsappInstances.some(
      (instance) => instance.id === fields.whatsappInstanceId,
    );
  const scopedCampaignOptions = useMemo(
    () =>
      (campaignOptions ?? []).filter((option) =>
        campaignInScope(option, fields.businessId, fields.adAccountId),
      ),
    [campaignOptions, fields.adAccountId, fields.businessId],
  );
  // Selected campaigns the period's options no longer list stay selectable.
  const missingCampaignIds = useMemo(
    () =>
      fields.campaignIds.filter(
        (id) => !scopedCampaignOptions.some((option) => option.id === id),
      ),
    [fields.campaignIds, scopedCampaignOptions],
  );
  const comboboxOptions = useMemo(() => {
    const groups = groupCampaignOptions(
      scopedCampaignOptions,
      fields.whatsappInstanceId,
    );
    const missing: FilterComboboxOption[] = missingCampaignIds.map((id) => ({
      value: id,
      label: missingCampaignLabel(campaignNames?.[id]),
    }));
    const toOption = (option: CampaignOptionDto, group?: string) =>
      campaignComboboxOption(option, fields.whatsappInstanceId, group);

    return groups.kind === "flat"
      ? [...missing, ...groups.options.map((option) => toOption(option))]
      : [
          ...missing,
          ...groups.withLeads.map((option) => toOption(option, "with_leads")),
          ...groups.others.map((option) => toOption(option, "others")),
        ];
  }, [
    campaignNames,
    fields.whatsappInstanceId,
    missingCampaignIds,
    scopedCampaignOptions,
  ]);
  const dateStatus = dateRangeStatus(fields.since, fields.until);

  // Sync from the URL only once nothing is in flight, and only the fields the
  // URL actually changed: a late navigation must not overwrite a newer local
  // edit (e.g. a date still being typed), while Back/Forward must still land.
  useEffect(() => {
    if (isPending) {
      return;
    }

    const previous = lastSyncedRef.current;
    const changed = filterKeys.filter(
      (key) => !sameFilterValue(previous[key], applied[key]),
    );

    lastCommittedHrefRef.current = appliedHref;

    if (changed.length === 0) {
      return;
    }

    lastSyncedRef.current = applied;
    setFields((current) => {
      const next = { ...current };

      for (const key of changed) {
        Object.assign(next, { [key]: applied[key] });
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

  useEffect(() => () => clearDateTimer(), []);

  useEffect(() => {
    const media = window.matchMedia(accountsCollapseQuery);
    const sync = () =>
      setAccountsOpen(media.matches ? accountFiltersActive : true);

    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [accountFiltersActive]);

  function clearDateTimer() {
    if (dateTimerRef.current) {
      clearTimeout(dateTimerRef.current);
      dateTimerRef.current = null;
    }
  }

  /** Navigates to the filters; an incomplete period keeps the applied one. */
  function commit(next: OverviewFilterValues) {
    clearDateTimer();

    const period =
      dateRangeStatus(next.since, next.until) === "valid"
        ? { since: next.since, until: next.until }
        : { since: applied.since, until: applied.until };
    const href = overviewFiltersHref({ ...next, ...period });

    if (href === lastCommittedHrefRef.current) {
      return;
    }

    lastCommittedHrefRef.current = href;
    startTransition(() => {
      router.push(href, { scroll: false });
    });
  }

  function update(patch: Partial<OverviewFilterValues>) {
    const next = { ...fieldsRef.current, ...patch };

    fieldsRef.current = next;
    setFields(next);
    commit(next);
  }

  /** Drops only the selected campaigns outside the new BM/Conta (§2.3). */
  function campaignsAfterScopeChange(
    nextBusinessId: string,
    nextAdAccountId: string,
  ) {
    return fieldsRef.current.campaignIds.filter((id) =>
      campaignInScope(
        campaignOptions?.find((option) => option.id === id),
        nextBusinessId,
        nextAdAccountId,
      ),
    );
  }

  function handleBusinessChange(nextBusinessId: string) {
    // One navigation for the BM and everything it invalidates.
    update({
      businessId: nextBusinessId,
      adAccountId: "",
      campaignIds: campaignsAfterScopeChange(nextBusinessId, ""),
    });
  }

  function handleAccountChange(nextAdAccountIds: string[]) {
    const nextAdAccountId = joinAdAccountIds(nextAdAccountIds);

    update({
      adAccountId: nextAdAccountId,
      campaignIds: campaignsAfterScopeChange(
        fieldsRef.current.businessId,
        nextAdAccountId,
      ),
    });
  }

  function removeCampaign(id: string) {
    update({
      campaignIds: fieldsRef.current.campaignIds.filter(
        (candidate) => candidate !== id,
      ),
    });
  }

  function handleDateChange(key: "since" | "until", value: string) {
    const next = { ...fieldsRef.current, [key]: value };

    fieldsRef.current = next;
    setFields(next);
    clearDateTimer();

    if (dateRangeStatus(next.since, next.until) === "valid") {
      dateTimerRef.current = setTimeout(() => {
        dateTimerRef.current = null;
        commit(fieldsRef.current);
      }, dateCommitDelayMs);
    }
  }

  function flushDateCommit() {
    if (dateTimerRef.current) {
      commit(fieldsRef.current);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    commit(fieldsRef.current);
  }

  const showBusinessFilter = businesses.length > 1;
  const showAccountFilter = reportingAccounts.length > 1;
  const showAccountGroup = showBusinessFilter || showAccountFilter;
  const accountFilterCount = Number(Boolean(fields.businessId));
  const selectedAdAccountIds = splitAdAccountIds(fields.adAccountId);
  const campaignDisabledLabel =
    campaignOptions === null
      ? "Campanhas indisponíveis"
      : campaignOptions.length === 0
        ? "Nenhuma campanha no período"
        : undefined;
  const dateOrderInvalid = dateStatus === "order";
  const selectedCampaignCount = fields.campaignIds.length;
  const campaignChips = fields.campaignIds.map((id) => {
    const option = campaignOptions?.find((candidate) => candidate.id === id);
    const title =
      option && !missingCampaignIds.includes(id)
        ? option.name
        : missingCampaignLabel(campaignNames?.[id] ?? option?.name);

    return { id, title, label: truncate(title, campaignChipMaxLength) };
  });
  const hiddenChipCount = Math.max(
    0,
    selectedCampaignCount - campaignChipLimit,
  );

  return (
    <form
      action="/overview"
      className={`overview-filter-bar${showAccountGroup ? "" : " single-row"}`}
      aria-label="Filtros da visão geral"
      onSubmit={handleSubmit}
    >
      <div className="overview-filter-heading">
        <span className="micro-label">Recorte da análise</span>
        {hasActiveFilter ? (
          <Link
            className="button ghost icon-button"
            href="/overview"
            aria-label="Limpar filtros"
            title="Limpar filtros"
          >
            <RotateCcw size={15} aria-hidden="true" />
          </Link>
        ) : null}
      </div>

      <div
        className="overview-filter-group"
        role="group"
        aria-label="Período e contas"
      >
        <span className="micro-label overview-filter-group-label">
          Período e contas
        </span>
        <label className="filter-field">
          <span>Início</span>
          <input
            type="date"
            name="since"
            value={fields.since}
            onChange={(event) =>
              handleDateChange("since", event.currentTarget.value)
            }
            onBlur={flushDateCommit}
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
            onChange={(event) =>
              handleDateChange("until", event.currentTarget.value)
            }
            onBlur={flushDateCommit}
          />
          {dateOrderInvalid ? (
            <span className="overview-filter-error" id={dateErrorId}>
              Fim antes do início
            </span>
          ) : null}
        </label>

        {showAccountFilter ? (
          <AdAccountFilter
            className="overview-scope-filter overview-ad-account-filter"
            accounts={accounts}
            currencies={accountCurrencies}
            value={selectedAdAccountIds}
            presentationMode={presentationMode}
            onCommit={handleAccountChange}
          />
        ) : null}

        {showBusinessFilter ? (
          <details
            className="overview-filter-accounts"
            open={accountsOpen}
            onToggle={(event) => setAccountsOpen(event.currentTarget.open)}
          >
            <summary>
              <span>Business Manager</span>
              {accountFilterCount > 0 ? (
                <span className="tag">{accountFilterCount}</span>
              ) : null}
            </summary>

            <label className="filter-field overview-scope-filter">
              <span>Business Manager</span>
              {presentationMode ? (
                <>
                  <input
                    type="hidden"
                    name="businessId"
                    value={fields.businessId}
                  />
                  <span className="presentation-filter-placeholder">
                    BM oculto
                  </span>
                </>
              ) : (
                <select
                  name="businessId"
                  value={fields.businessId}
                  onChange={(event) =>
                    handleBusinessChange(event.currentTarget.value)
                  }
                >
                  <option value="">Todos os BMs</option>
                  {businesses.map((business) => (
                    <option key={business.id} value={business.id}>
                      {business.name}
                    </option>
                  ))}
                </select>
              )}
            </label>
          </details>
        ) : null}
      </div>

      <div
        className="overview-filter-group overview-filter-group-cut"
        role="group"
        aria-label="Número e campanha"
      >
        <span className="micro-label overview-filter-group-label">
          Número e campanha
        </span>
        <label className="filter-field overview-scope-filter">
          <span>Número WhatsApp</span>
          {presentationMode ? (
            <>
              <input
                type="hidden"
                name="whatsappInstanceId"
                value={fields.whatsappInstanceId}
              />
              <span className="presentation-filter-placeholder">
                Número oculto
              </span>
            </>
          ) : (
            <select
              name="whatsappInstanceId"
              value={fields.whatsappInstanceId}
              onChange={(event) =>
                update({ whatsappInstanceId: event.currentTarget.value })
              }
            >
              <option value="">Todos os números</option>
              {selectedInstanceWasRemoved ? (
                <option value={fields.whatsappInstanceId}>
                  Número removido
                </option>
              ) : null}
              {activeWhatsappInstances.map((instance) => (
                <option key={instance.id} value={instance.id}>
                  {instanceLabel(instance)}
                </option>
              ))}
            </select>
          )}
        </label>

        <FilterCombobox
          className="overview-scope-filter overview-campaign-filter"
          mode="multi"
          max={maxOverviewCampaigns}
          handleRef={campaignComboboxRef}
          name={selectedCampaignCount > 1 ? "campaignIds" : "campaignId"}
          label="Campanhas"
          value={fields.campaignIds}
          options={comboboxOptions}
          groups={campaignComboboxGroups}
          copy={campaignComboboxCopy}
          disabledLabel={campaignDisabledLabel}
          presentationPlaceholder={
            presentationMode
              ? selectedCampaignCount === 0
                ? campaignComboboxCopy.all
                : selectedCampaignCount === 1
                  ? "Campanha oculta"
                  : `${selectedCampaignCount} campanhas ocultas`
              : undefined
          }
          onCommit={(next) => update({ campaignIds: next })}
        />

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

        {/* Chips hold names, so presentation mode never renders them. */}
        {!presentationMode && selectedCampaignCount > 0 ? (
          <div
            className="overview-campaign-strip"
            role="group"
            aria-label="Campanhas selecionadas"
          >
            {campaignChips.slice(0, campaignChipLimit).map((chip, index) => (
              <span
                className={`tag overview-campaign-chip${
                  index > 0 ? " overview-campaign-chip-extra" : ""
                }`}
                key={chip.id}
                title={chip.title}
              >
                <span className="overview-campaign-chip-label">
                  {chip.label}
                </span>
                <button
                  type="button"
                  className="overview-campaign-chip-remove"
                  aria-label={`Remover ${chip.title}`}
                  onClick={() => removeCampaign(chip.id)}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </span>
            ))}
            {hiddenChipCount > 0 ? (
              <button
                type="button"
                className="tag overview-campaign-chip-more"
                aria-label={`Ver mais ${hiddenChipCount} campanhas`}
                onClick={() => campaignComboboxRef.current?.open()}
              >
                +{hiddenChipCount}
              </button>
            ) : null}
            {selectedCampaignCount > 1 ? (
              <button
                type="button"
                className="tag overview-campaign-chip-more overview-campaign-chip-more-mobile"
                aria-label={`Ver mais ${selectedCampaignCount - 1} campanhas`}
                onClick={() => campaignComboboxRef.current?.open()}
              >
                +{selectedCampaignCount - 1}
              </button>
            ) : null}
            <button
              type="button"
              className="overview-campaign-clear"
              onClick={() => update({ campaignIds: [] })}
            >
              Limpar campanhas
            </button>
          </div>
        ) : null}
      </div>

      {/* Implicit Enter-submit and the no-JS GET still need a submitter. */}
      <button className="sr-only" type="submit" tabIndex={-1}>
        Atualizar recorte
      </button>
    </form>
  );
}
