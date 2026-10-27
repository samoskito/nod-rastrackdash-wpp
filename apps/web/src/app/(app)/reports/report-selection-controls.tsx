"use client";

import { Filter, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type ReportSelectionLevel = "campaign" | "adset" | "ad";

type SelectionEventDetail = {
  ids: string[];
  storageKey: string;
};

const MAX_SELECTED_IDS = 200;
const SELECTION_EVENT = "wpptrack:report-selection-change";

function reportSelectionStorageKey(
  workspaceId: string,
  level: ReportSelectionLevel,
) {
  return `wpptrack:reports:selection:${workspaceId}:${level}`;
}

function normalizeSelection(ids: string[]) {
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean))).slice(
    0,
    MAX_SELECTED_IDS,
  );
}

function readSelection(storageKey: string) {
  try {
    const stored = window.sessionStorage.getItem(storageKey);
    const parsed: unknown = stored ? JSON.parse(stored) : [];

    return Array.isArray(parsed)
      ? normalizeSelection(
          parsed.filter((id): id is string => typeof id === "string"),
        )
      : [];
  } catch {
    return [];
  }
}

function writeSelection(storageKey: string, ids: string[]) {
  const normalized = normalizeSelection(ids);

  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(normalized));
  } catch {
    // The selection still works for the current render when storage is blocked.
  }

  window.dispatchEvent(
    new CustomEvent<SelectionEventDetail>(SELECTION_EVENT, {
      detail: { ids: normalized, storageKey },
    }),
  );

  return normalized;
}

function navigateWithSelection(ids: string[], enabled: boolean) {
  const params = new URLSearchParams(window.location.search);

  params.delete("page");

  if (enabled && ids.length > 0) {
    params.set("selectedIds", ids.join(","));
  } else {
    params.delete("selectedIds");
  }

  const query = params.toString();
  window.location.assign(
    query ? `${window.location.pathname}?${query}` : window.location.pathname,
  );
}

function useReportSelection(
  workspaceId: string,
  level: ReportSelectionLevel,
  activeSelectedIds: string[],
) {
  const storageKey = useMemo(
    () => reportSelectionStorageKey(workspaceId, level),
    [level, workspaceId],
  );
  const activeSelectionKey = activeSelectedIds.join(",");
  const [ids, setIds] = useState<string[]>(() =>
    normalizeSelection(activeSelectedIds),
  );

  useEffect(() => {
    const stored = readSelection(storageKey);
    const seeded = normalizeSelection([...stored, ...activeSelectedIds]);

    if (seeded.join(",") !== stored.join(",")) {
      writeSelection(storageKey, seeded);
    }

    setIds(seeded);

    function handleSelectionChange(event: Event) {
      const detail = (event as CustomEvent<SelectionEventDetail>).detail;

      if (detail?.storageKey === storageKey) {
        setIds(detail.ids);
      }
    }

    window.addEventListener(SELECTION_EVENT, handleSelectionChange);

    return () => {
      window.removeEventListener(SELECTION_EVENT, handleSelectionChange);
    };
  }, [activeSelectionKey, storageKey]);

  const update = useCallback(
    (nextIds: string[]) => {
      const normalized = writeSelection(storageKey, nextIds);
      setIds(normalized);
      return normalized;
    },
    [storageKey],
  );

  return { ids, update };
}

type SharedSelectionProps = {
  activeSelectedIds: string[];
  filterActive: boolean;
  level: ReportSelectionLevel;
  workspaceId: string;
};

export function ReportSelectionToolbar({
  activeSelectedIds,
  filterActive,
  level,
  workspaceId,
}: SharedSelectionProps) {
  const { ids, update } = useReportSelection(
    workspaceId,
    level,
    activeSelectedIds,
  );

  function clearSelection() {
    update([]);

    if (filterActive) {
      navigateWithSelection([], false);
    }
  }

  return (
    <div className="report-selection-toolbar" aria-label="Seleção do relatório">
      <span className="report-selection-count" aria-live="polite">
        {ids.length} selecionado{ids.length === 1 ? "" : "s"}
      </span>
      <button
        aria-pressed={filterActive}
        className={`report-selection-filter${filterActive ? " is-active" : ""}`}
        disabled={ids.length === 0}
        onClick={() => navigateWithSelection(ids, !filterActive)}
        type="button"
      >
        <Filter aria-hidden="true" size={14} />
        Filtrar por seleção
      </button>
      <span className="report-selection-divider" aria-hidden="true" />
      <button
        aria-label="Limpar seleção"
        className="report-selection-clear"
        disabled={ids.length === 0}
        onClick={clearSelection}
        title="Limpar seleção"
        type="button"
      >
        <X aria-hidden="true" size={15} />
      </button>
    </div>
  );
}

type ReportSelectionCheckboxProps = SharedSelectionProps & {
  entityId: string;
  entityLabel: string;
};

export function ReportSelectionCheckbox({
  activeSelectedIds,
  entityId,
  entityLabel,
  filterActive,
  level,
  workspaceId,
}: ReportSelectionCheckboxProps) {
  const { ids, update } = useReportSelection(
    workspaceId,
    level,
    activeSelectedIds,
  );
  const checked = ids.includes(entityId);

  function handleChange() {
    const nextIds = update(
      checked ? ids.filter((id) => id !== entityId) : [...ids, entityId],
    );

    if (filterActive) {
      navigateWithSelection(nextIds, nextIds.length > 0);
    }
  }

  return (
    <label
      className="report-selection-checkbox report-row-selector"
      title={`Selecionar ${entityLabel}`}
    >
      <input
        aria-label={`Selecionar ${entityLabel}`}
        checked={checked}
        onChange={handleChange}
        type="checkbox"
      />
      <span aria-hidden="true" />
    </label>
  );
}

type ReportPageSelectionCheckboxProps = SharedSelectionProps & {
  entityIds: string[];
  entityLabel: string;
};

export function ReportPageSelectionCheckbox({
  activeSelectedIds,
  entityIds,
  entityLabel,
  filterActive,
  level,
  workspaceId,
}: ReportPageSelectionCheckboxProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { ids, update } = useReportSelection(
    workspaceId,
    level,
    activeSelectedIds,
  );
  const selectedOnPage = entityIds.filter((id) => ids.includes(id)).length;
  const allSelected =
    entityIds.length > 0 && selectedOnPage === entityIds.length;
  const partiallySelected = selectedOnPage > 0 && !allSelected;

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = partiallySelected;
    }
  }, [partiallySelected]);

  function handleChange() {
    const visibleIds = new Set(entityIds);
    const nextIds = allSelected
      ? ids.filter((id) => !visibleIds.has(id))
      : [...ids, ...entityIds];
    const normalized = update(nextIds);

    if (filterActive) {
      navigateWithSelection(normalized, normalized.length > 0);
    }
  }

  return (
    <label
      className="report-selection-checkbox report-page-selector"
      title={`Selecionar ${entityLabel} desta página`}
    >
      <input
        aria-label={`Selecionar ${entityLabel} desta página`}
        checked={allSelected}
        disabled={entityIds.length === 0}
        onChange={handleChange}
        ref={inputRef}
        type="checkbox"
      />
      <span aria-hidden="true" />
    </label>
  );
}
