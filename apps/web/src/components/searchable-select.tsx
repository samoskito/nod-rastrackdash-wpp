"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { normalizeSearchText } from "../lib/search-text";

export type SearchableSelectOption = {
  value: string;
  label: string;
  description?: string;
};

type SearchableSelectProps = {
  name: string;
  value: string;
  options: SearchableSelectOption[];
  onValueChange: (value: string) => void | Promise<void>;
  ariaLabel: string;
  placeholder: string;
  emptyMessage?: string;
  disabled?: boolean;
  sensitive?: boolean;
  presentationPlaceholder?: string;
};

export function filterSearchableOptions(
  options: SearchableSelectOption[],
  query: string,
  selectedLabel = "",
) {
  const normalizedQuery = normalizeSearchText(query);

  if (
    !normalizedQuery ||
    normalizedQuery === normalizeSearchText(selectedLabel)
  ) {
    return options;
  }

  return options.filter((option) =>
    normalizeSearchText(`${option.label} ${option.description ?? ""}`).includes(
      normalizedQuery,
    ),
  );
}

export function SearchableSelect({
  name,
  value,
  options,
  onValueChange,
  ariaLabel,
  placeholder,
  emptyMessage = "Nenhum ativo encontrado",
  disabled = false,
  sensitive = false,
  presentationPlaceholder = "Dado oculto",
}: SearchableSelectProps) {
  const listboxId = useId();
  const selectedOption = options.find((option) => option.value === value);
  const [query, setQuery] = useState(selectedOption?.label ?? "");
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const filteredOptions = useMemo(
    () => filterSearchableOptions(options, query, selectedOption?.label),
    [options, query, selectedOption?.label],
  );

  useEffect(() => {
    if (!isOpen) {
      setQuery(selectedOption?.label ?? "");
    }
  }, [isOpen, selectedOption?.label]);

  useEffect(() => {
    if (!isOpen || filteredOptions.length === 0) {
      setActiveIndex(-1);
      return;
    }

    setActiveIndex((current) => {
      if (current >= 0 && current < filteredOptions.length) {
        return current;
      }

      const selectedIndex = filteredOptions.findIndex(
        (option) => option.value === value,
      );

      return selectedIndex >= 0 ? selectedIndex : 0;
    });
  }, [filteredOptions, isOpen, value]);

  function selectOption(option: SearchableSelectOption) {
    setQuery(option.label);
    setIsOpen(false);
    setActiveIndex(-1);
    void onValueChange(option.value);
  }

  function handleInputChange(nextQuery: string) {
    setQuery(nextQuery);
    setIsOpen(true);
    setActiveIndex(0);

    if (value && nextQuery !== selectedOption?.label) {
      void onValueChange("");
    }
  }

  return (
    <div
      className="searchable-select"
      data-presentation-sensitive={sensitive ? "true" : undefined}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsOpen(false);
          setQuery(selectedOption?.label ?? "");
        }
      }}
    >
      <input type="hidden" name={name} value={value} />
      <input
        className="filter-control searchable-select-input"
        type="search"
        value={query}
        onChange={(event) => handleInputChange(event.currentTarget.value)}
        onFocus={() => {
          if (!disabled) {
            setIsOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setIsOpen(true);
            setActiveIndex((current) =>
              Math.min(current + 1, filteredOptions.length - 1),
            );
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setIsOpen(true);
            setActiveIndex((current) =>
              current <= 0 ? filteredOptions.length - 1 : current - 1,
            );
          } else if (
            event.key === "Enter" &&
            isOpen &&
            activeIndex >= 0 &&
            filteredOptions[activeIndex]
          ) {
            event.preventDefault();
            selectOption(filteredOptions[activeIndex]);
          } else if (event.key === "Escape") {
            event.preventDefault();
            setIsOpen(false);
            setQuery(selectedOption?.label ?? "");
          }
        }}
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={isOpen}
        aria-activedescendant={
          isOpen && activeIndex >= 0
            ? `${listboxId}-option-${activeIndex}`
            : undefined
        }
        autoComplete="off"
        placeholder={placeholder}
        disabled={disabled}
        data-presentation-sensitive-field={sensitive ? "true" : undefined}
      />
      {sensitive ? (
        <span
          aria-hidden="true"
          className="searchable-select-presentation-placeholder"
        >
          {presentationPlaceholder}
        </span>
      ) : null}
      <div
        className="searchable-select-menu"
        id={listboxId}
        role="listbox"
        hidden={!isOpen || disabled}
      >
        {filteredOptions.length > 0 ? (
          filteredOptions.map((option, index) => (
            <button
              className={`searchable-select-option${
                index === activeIndex ? " active" : ""
              }`}
              id={`${listboxId}-option-${index}`}
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => selectOption(option)}
            >
              <strong>{option.label}</strong>
              {option.description ? <span>{option.description}</span> : null}
            </button>
          ))
        ) : (
          <span className="searchable-select-empty">{emptyMessage}</span>
        )}
      </div>
    </div>
  );
}
