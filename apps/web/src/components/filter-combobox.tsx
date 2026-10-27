"use client";

import {
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from "react";
import { normalizeSearchText } from "../lib/search-text";

export type FilterComboboxOption = {
  value: string;
  label: string;
  /** Second line (meta), also searchable. */
  description?: string;
  /** Group key; options without a known group render above the groups. */
  group?: string;
  /** Full name when `label` is truncated; also searchable. */
  title?: string;
  /** Short tag after the label (e.g. the ad account currency). */
  badge?: string;
};

export type FilterComboboxGroup = { key: string; label: string };

export type FilterComboboxCopy = {
  /** First row and trigger text when nothing is selected. */
  all: string;
  searchPlaceholder: string;
  searchLabel: string;
  count: (matches: number, total: number) => string;
  found: (matches: number) => string;
  noResults: (query: string) => string;
  clearSearch: string;
  /** Multi mode only; generic fallbacks are used when omitted. */
  multi?: FilterComboboxMultiCopy;
};

export type FilterComboboxMultiCopy = {
  /** Trigger text for two or more selected options. */
  triggerCount: (count: number) => string;
  /** Footer count. */
  selectedCount: (count: number) => string;
  /** Live region after a toggle. */
  toggled: (label: string, added: boolean, count: number) => string;
  limit: (max: number) => string;
  clear: string;
  done: string;
};

export type FilterComboboxHandle = {
  /** Opens the popover and focuses its search (e.g. from a "+k" chip). */
  open: () => void;
};

const defaultMultiCopy: FilterComboboxMultiCopy = {
  triggerCount: (count) => `${count} selecionados`,
  selectedCount: (count) =>
    count === 1 ? "1 selecionado" : `${count} selecionados`,
  toggled: (label, added, count) =>
    `${label} ${added ? "adicionado" : "removido"}. ${count} selecionados.`,
  limit: (max) => `Limite de ${max}`,
  clear: "Limpar",
  done: "Pronto",
};

/** Multi toggles apply this long after the last one (or at once on close). */
export const filterComboboxMultiCommitDelayMs = 600;

type FilterComboboxProps = {
  /** Single selects and closes; multi toggles and stays open (§2.4). */
  mode?: "single" | "multi";
  /** Multi only: unselected options are disabled once this many are picked. */
  max?: number;
  handleRef?: Ref<FilterComboboxHandle>;
  name: string;
  label: string;
  value: string[];
  options: FilterComboboxOption[];
  groups?: FilterComboboxGroup[];
  onCommit: (next: string[]) => void;
  copy: FilterComboboxCopy;
  /** Renders a disabled trigger with this text (e.g. options failed). */
  disabledLabel?: string;
  /** Presentation mode: no names in the DOM, only this placeholder. */
  presentationPlaceholder?: string;
  className?: string;
};

export type FilterComboboxSection = {
  key: string;
  label?: string;
  options: FilterComboboxOption[];
};

/** Accent- and case-insensitive substring over label, title, meta and id. */
export function filterComboboxOptions(
  options: FilterComboboxOption[],
  query: string,
) {
  const normalizedQuery = normalizeSearchText(query);

  if (!normalizedQuery) {
    return options;
  }

  return options.filter((option) =>
    normalizeSearchText(
      [
        option.label,
        option.title,
        option.description,
        option.badge,
        option.value,
      ]
        .filter(Boolean)
        .join(" "),
    ).includes(normalizedQuery),
  );
}

/** Ungrouped options first, then groups in the given order; empty ones hidden. */
export function sectionComboboxOptions(
  options: FilterComboboxOption[],
  groups: FilterComboboxGroup[] = [],
): FilterComboboxSection[] {
  const known = new Set(groups.map((group) => group.key));
  const sections: FilterComboboxSection[] = [
    {
      key: "",
      options: options.filter(
        (option) => !option.group || !known.has(option.group),
      ),
    },
    ...groups.map((group) => ({
      key: group.key,
      label: group.label,
      options: options.filter((option) => option.group === group.key),
    })),
  ];

  return sections.filter((section) => section.options.length > 0);
}

function sameValues(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function FilterCombobox({
  mode = "single",
  max,
  handleRef,
  name,
  label,
  value,
  options,
  groups,
  onCommit,
  copy,
  disabledLabel,
  presentationPlaceholder,
  className,
}: FilterComboboxProps) {
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const triggerId = `${baseId}-trigger`;
  const listboxId = `${baseId}-listbox`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const multi = mode === "multi";
  const multiCopy = copy.multi ?? defaultMultiCopy;
  // Multi toggles not yet handed to `onCommit` (debounced, §2.4).
  const [draft, setDraft] = useState<string[] | null>(null);
  const draftRef = useRef<string[] | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const selected = draft ?? value;
  const selectedSet = new Set(selected);
  const atLimit = multi && max !== undefined && selected.length >= max;
  const selectedValue = value[0] ?? "";
  const selectedOption =
    selected.length === 1
      ? options.find((option) => option.value === selected[0])
      : undefined;
  const hiddenValue = multi ? value.join(",") : selectedValue;
  const showAllRow = !multi;
  const hasQuery = normalizeSearchText(query) !== "";
  const matches = useMemo(
    () => filterComboboxOptions(options, query),
    [options, query],
  );
  const sections = useMemo(
    () => sectionComboboxOptions(matches, groups),
    [groups, matches],
  );
  // Flat, rendered order: what the arrows walk through.
  const rows = useMemo<FilterComboboxOption[]>(
    () => [
      ...(hasQuery || !showAllRow ? [] : [{ value: "", label: copy.all }]),
      ...sections.flatMap((section) => section.options),
    ],
    [copy.all, hasQuery, sections, showAllRow],
  );
  const rowId = (index: number) => `${listboxId}-option-${index}`;

  useEffect(() => {
    if (isOpen) {
      searchRef.current?.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && activeIndex >= 0) {
      document
        .getElementById(`${listboxId}-option-${activeIndex}`)
        ?.scrollIntoView?.({ block: "nearest" });
    }
  }, [activeIndex, isOpen, listboxId]);

  useEffect(() => () => clearCommitTimer(), []);

  useImperativeHandle(handleRef, () => ({
    open: () => {
      if (!isOpen) {
        open();
      }
    },
  }));

  function open(seed = "") {
    const seededRows = seed
      ? filterComboboxOptions(options, seed)
      : [
          ...(showAllRow ? [{ value: "" }] : []),
          ...sectionComboboxOptions(options, groups).flatMap(
            (section) => section.options,
          ),
        ];
    const selectedIndex = seed
      ? -1
      : seededRows.findIndex((row) =>
          multi ? selectedSet.has(row.value) : row.value === selectedValue,
        );

    setQuery(seed);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setAnnouncement("");
    setIsOpen(true);
  }

  function close(focusTrigger: boolean) {
    flushDraft();
    setIsOpen(false);
    setQuery("");
    setActiveIndex(-1);
    setAnnouncement("");

    if (focusTrigger) {
      triggerRef.current?.focus();
    }
  }

  function clearCommitTimer() {
    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
  }

  function setPendingDraft(next: string[] | null) {
    draftRef.current = next;
    setDraft(next);
  }

  /** Hands pending multi toggles to `onCommit` (debounce end or close). */
  function flushDraft() {
    clearCommitTimer();

    const next = draftRef.current;

    if (next === null) {
      return;
    }

    setPendingDraft(null);

    if (!sameValues(next, valueRef.current)) {
      onCommit(next);
    }
  }

  function select(option: FilterComboboxOption) {
    close(true);

    if (option.value !== selectedValue) {
      onCommit(option.value ? [option.value] : []);
    }
  }

  function isBlocked(option: FilterComboboxOption) {
    return atLimit && !selectedSet.has(option.value);
  }

  function toggle(option: FilterComboboxOption) {
    if (isBlocked(option)) {
      return;
    }

    const current = draftRef.current ?? valueRef.current;
    const added = !current.includes(option.value);
    // Selection order is kept: it is the chip and URL order.
    const next = added
      ? [...current, option.value]
      : current.filter((candidate) => candidate !== option.value);

    setPendingDraft(next);
    setAnnouncement(multiCopy.toggled(option.label, added, next.length));
    clearCommitTimer();
    commitTimerRef.current = setTimeout(
      flushDraft,
      filterComboboxMultiCommitDelayMs,
    );
  }

  function clearSelection() {
    // Clearing applies at once (§2.3), like the strip's "Limpar".
    clearCommitTimer();
    setPendingDraft(null);
    setAnnouncement(multiCopy.selectedCount(0));

    if (valueRef.current.length > 0) {
      onCommit([]);
    }

    searchRef.current?.focus();
  }

  function choose(option: FilterComboboxOption) {
    if (multi) {
      toggle(option);
    } else {
      select(option);
    }
  }

  function handleQueryChange(nextQuery: string) {
    setQuery(nextQuery);
    setActiveIndex(0);
    setAnnouncement("");
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      open();
    } else if (
      event.key.length === 1 &&
      event.key !== " " &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      open(event.key);
    }
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const last = rows.length - 1;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((current) => (current >= last ? 0 : current + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((current) => (current <= 0 ? last : current - 1));
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(rows.length > 0 ? 0 : -1);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(last);
        break;
      case "Enter":
        // Never submit the surrounding form from the search box.
        event.preventDefault();
        if (rows[activeIndex]) {
          choose(rows[activeIndex]);
        }
        break;
      case " ":
        // Multi: Space toggles only while it cannot be part of a query.
        if (multi && query === "" && rows[activeIndex]) {
          event.preventDefault();
          toggle(rows[activeIndex]);
        }
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case "Tab":
        close(false);
        break;
    }
  }

  const rootClassName = `filter-field filter-combobox${
    className ? ` ${className}` : ""
  }`;

  if (presentationPlaceholder !== undefined) {
    return (
      <div className={rootClassName}>
        <span>{label}</span>
        <input type="hidden" name={name} value={hiddenValue} />
        <span className="presentation-filter-placeholder">
          {presentationPlaceholder}
        </span>
      </div>
    );
  }

  if (disabledLabel !== undefined) {
    return (
      <div className={rootClassName}>
        <span id={labelId}>{label}</span>
        {/* A disabled control keeps an applied cut in the form. */}
        {hiddenValue ? (
          <input type="hidden" name={name} value={hiddenValue} />
        ) : null}
        <button
          className="filter-combobox-trigger"
          type="button"
          id={triggerId}
          aria-labelledby={`${labelId} ${triggerId}`}
          disabled
        >
          <span className="filter-combobox-value">{disabledLabel}</span>
        </button>
      </div>
    );
  }

  const triggerText =
    selected.length > 1
      ? multiCopy.triggerCount(selected.length)
      : (selectedOption?.label ?? copy.all);
  let rowIndex = hasQuery || !showAllRow ? 0 : 1;

  return (
    <div
      className={rootClassName}
      data-open={isOpen ? "true" : undefined}
      onBlur={(event) => {
        if (
          isOpen &&
          !event.currentTarget.contains(event.relatedTarget as Node | null)
        ) {
          close(false);
        }
      }}
    >
      <span id={labelId}>{label}</span>
      <input type="hidden" name={name} value={hiddenValue} />
      <button
        ref={triggerRef}
        className="filter-combobox-trigger"
        type="button"
        id={triggerId}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        aria-labelledby={`${labelId} ${triggerId}`}
        title={selectedOption?.title ?? triggerText}
        onClick={() => (isOpen ? close(true) : open())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="filter-combobox-value">{triggerText}</span>
      </button>

      {isOpen ? (
        <div className="filter-combobox-popover">
          <input
            ref={searchRef}
            className="filter-combobox-search"
            type="text"
            role="combobox"
            aria-label={copy.searchLabel}
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded="true"
            aria-activedescendant={
              activeIndex >= 0 && rows[activeIndex]
                ? rowId(activeIndex)
                : undefined
            }
            autoComplete="off"
            spellCheck={false}
            placeholder={copy.searchPlaceholder}
            value={query}
            onChange={(event) => handleQueryChange(event.currentTarget.value)}
            onKeyDown={handleSearchKeyDown}
          />
          {hasQuery ? (
            <span className="filter-combobox-count">
              {copy.count(matches.length, options.length)}
            </span>
          ) : null}
          <div
            className="filter-combobox-list"
            id={listboxId}
            role="listbox"
            aria-labelledby={labelId}
            aria-multiselectable={multi ? "true" : undefined}
          >
            {hasQuery || !showAllRow
              ? null
              : renderRow({ value: "", label: copy.all }, 0)}
            {sections.map((section) => {
              const renderedRows = section.options.map((option) =>
                renderRow(option, rowIndex++),
              );

              if (!section.label) {
                return renderedRows;
              }

              const groupLabelId = `${listboxId}-group-${section.key}`;

              return (
                <div
                  key={section.key}
                  className="filter-combobox-group"
                  role="group"
                  aria-labelledby={groupLabelId}
                >
                  <span
                    className="micro-label filter-combobox-group-label"
                    id={groupLabelId}
                    role="presentation"
                  >
                    {section.label}
                  </span>
                  {renderedRows}
                </div>
              );
            })}
          </div>
          {hasQuery && matches.length === 0 ? (
            <div className="filter-combobox-empty">
              <span>{copy.noResults(query.trim())}</span>
              <button
                type="button"
                className="filter-combobox-clear"
                onClick={() => {
                  handleQueryChange("");
                  searchRef.current?.focus();
                }}
              >
                {copy.clearSearch}
              </button>
            </div>
          ) : null}
          {multi ? (
            <div className="filter-combobox-footer">
              <span className="filter-combobox-selected-count">
                {multiCopy.selectedCount(selected.length)}
              </span>
              {atLimit ? (
                <span className="filter-combobox-limit">
                  {multiCopy.limit(max!)}
                </span>
              ) : null}
              <button
                type="button"
                className="filter-combobox-clear"
                disabled={selected.length === 0}
                onClick={clearSelection}
              >
                {multiCopy.clear}
              </button>
              <button
                type="button"
                className="button primary filter-combobox-done"
                onClick={() => close(true)}
              >
                {multiCopy.done}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <span className="sr-only" role="status" aria-live="polite">
        {isOpen
          ? announcement || (hasQuery ? copy.found(matches.length) : "")
          : ""}
      </span>
    </div>
  );

  function renderRow(option: FilterComboboxOption, index: number) {
    const isSelected = multi
      ? selectedSet.has(option.value)
      : option.value === selectedValue;
    const blocked = multi && isBlocked(option);

    return (
      <div
        className={`filter-combobox-option${multi ? " multi" : ""}${
          index === activeIndex ? " active" : ""
        }`}
        id={rowId(index)}
        key={option.value || "__all__"}
        role="option"
        aria-selected={isSelected}
        aria-disabled={blocked ? "true" : undefined}
        title={option.title}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() => choose(option)}
      >
        {multi ? (
          <i className="filter-combobox-check" aria-hidden="true" />
        ) : null}
        <strong>
          {option.label}
          {option.badge ? (
            <em className="filter-combobox-badge">{option.badge}</em>
          ) : null}
        </strong>
        {option.description ? <span>{option.description}</span> : null}
      </div>
    );
  }
}
