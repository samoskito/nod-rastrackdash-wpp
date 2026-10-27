"use client";

import { effectiveAccountCurrency, type CurrencyCode } from "@wpptrack/shared";
import { useMemo } from "react";
import { maxAdAccountFilter } from "../lib/ad-account-params";
import {
  FilterCombobox,
  type FilterComboboxCopy,
  type FilterComboboxOption,
} from "./filter-combobox";

export type AdAccountFilterAccount = {
  adAccountId: string;
  adAccountName: string;
  businessName?: string;
  /** Moeda da Meta (MetaReportingAccount.currency). */
  currency?: string | null;
};

function selectedAccountsLabel(count: number) {
  return `${count} ${count === 1 ? "selecionada" : "selecionadas"}`;
}

export const adAccountComboboxCopy: FilterComboboxCopy = {
  all: "Todas as contas",
  searchPlaceholder: "Buscar conta",
  searchLabel: "Buscar conta de anúncio por nome, ID ou moeda",
  count: (matches, total) => `${matches} de ${total} contas`,
  found: (matches) =>
    matches === 1 ? "1 conta encontrada" : `${matches} contas encontradas`,
  noResults: (query) => `Nenhuma conta com "${query}"`,
  clearSearch: "Limpar busca",
  multi: {
    triggerCount: (count) => `${count} contas`,
    selectedCount: selectedAccountsLabel,
    toggled: (label, added, count) =>
      `${label} ${added ? "adicionada" : "removida"}. ${selectedAccountsLabel(count)}.`,
    limit: (max) => `Limite de ${max} contas`,
    clear: "Limpar",
    done: "Pronto",
  },
};

/** Options with the effective currency as a badge (override ?? Meta ?? BRL). */
export function adAccountFilterOptions(
  accounts: readonly AdAccountFilterAccount[],
  currencies: Readonly<Record<string, CurrencyCode>> = {},
): FilterComboboxOption[] {
  return [...accounts]
    .sort((left, right) =>
      left.adAccountName.localeCompare(right.adAccountName, "pt-BR"),
    )
    .map((account) => ({
      value: account.adAccountId,
      label: account.adAccountName,
      title: `${account.adAccountName} (${account.adAccountId})`,
      description: account.businessName,
      badge:
        currencies[account.adAccountId] ?? effectiveAccountCurrency(account),
    }));
}

/**
 * Multi-select of ad accounts (Visao Geral and Relatorios). With accounts of
 * one currency selected every value shows in that currency; mixed selections
 * show totals per currency side by side.
 */
export function AdAccountFilter({
  accounts,
  currencies,
  value,
  onCommit,
  presentationMode = false,
  className,
  label = "Contas de anúncio",
}: {
  accounts: readonly AdAccountFilterAccount[];
  currencies?: Readonly<Record<string, CurrencyCode>>;
  value: string[];
  onCommit: (next: string[]) => void;
  presentationMode?: boolean;
  className?: string;
  label?: string;
}) {
  const options = useMemo(
    () => adAccountFilterOptions(accounts, currencies),
    [accounts, currencies],
  );
  // Selected accounts that left the list (inactive) stay removable.
  const missing = value
    .filter((id) => !options.some((option) => option.value === id))
    .map((id) => ({ value: id, label: `Conta ${id} (indisponível)` }));

  return (
    <FilterCombobox
      className={`ad-account-filter${className ? ` ${className}` : ""}`}
      mode="multi"
      max={maxAdAccountFilter}
      name={value.length > 1 ? "adAccountIds" : "adAccountId"}
      label={label}
      value={value}
      options={[...missing, ...options]}
      copy={adAccountComboboxCopy}
      disabledLabel={
        accounts.length === 0 ? "Nenhuma conta conectada" : undefined
      }
      presentationPlaceholder={
        presentationMode
          ? value.length === 0
            ? adAccountComboboxCopy.all
            : value.length === 1
              ? "Conta oculta"
              : `${value.length} contas ocultas`
          : undefined
      }
      onCommit={onCommit}
    />
  );
}
