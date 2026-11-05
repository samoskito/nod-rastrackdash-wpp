"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

/**
 * Header of the Leads table ("Conversas recebidas") with columns the user
 * can resize by dragging the edge of a header cell (or with the arrow keys on
 * the handle). Widths are kept per browser in localStorage; double-clicking a
 * handle restores the default widths.
 */

export const LEADS_COLUMN_STORAGE_KEY = "wpptrack-leads-table-columns";
export const LEADS_COLUMN_MIN_WIDTH = 96;
const KEYBOARD_STEP = 16;

/** The last column (open lead) has a fixed width and no handle. */
export const LEADS_TABLE_COLUMNS = [
  { key: "lead", label: "Lead" },
  { key: "source", label: "Campanha / origem" },
  { key: "stage", label: "Etapa atual" },
  { key: "received", label: "Recebido" },
  { key: "activity", label: "Última atividade" },
] as const;

type ColumnKey = (typeof LEADS_TABLE_COLUMNS)[number]["key"];
export type LeadsColumnWidths = Partial<Record<ColumnKey, number>>;

/** Reads saved widths, ignoring anything that is not a sane number. */
export function parseLeadsColumnWidths(raw: string | null): LeadsColumnWidths {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const widths: LeadsColumnWidths = {};
    for (const { key } of LEADS_TABLE_COLUMNS) {
      const value = parsed?.[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        widths[key] = Math.max(LEADS_COLUMN_MIN_WIDTH, Math.round(value));
      }
    }
    return widths;
  } catch {
    return {};
  }
}

export function resizeLeadsColumn(
  widths: LeadsColumnWidths,
  key: ColumnKey,
  width: number,
): LeadsColumnWidths {
  return { ...widths, [key]: Math.max(LEADS_COLUMN_MIN_WIDTH, Math.round(width)) };
}

function readStoredWidths(): LeadsColumnWidths {
  try {
    return parseLeadsColumnWidths(
      window.localStorage.getItem(LEADS_COLUMN_STORAGE_KEY),
    );
  } catch {
    return {};
  }
}

function storeWidths(widths: LeadsColumnWidths) {
  try {
    if (Object.keys(widths).length === 0) {
      window.localStorage.removeItem(LEADS_COLUMN_STORAGE_KEY);
    } else {
      window.localStorage.setItem(
        LEADS_COLUMN_STORAGE_KEY,
        JSON.stringify(widths),
      );
    }
  } catch {
    // Private mode or blocked storage: widths just reset on the next visit.
  }
}

export function LeadsTableHead() {
  const [widths, setWidths] = useState<LeadsColumnWidths>({});
  const headRef = useRef<HTMLTableSectionElement>(null);
  const drag = useRef<{ key: ColumnKey; startX: number; startWidth: number } | null>(
    null,
  );

  useEffect(() => {
    setWidths(readStoredWidths());
  }, []);

  // With custom widths the table is as wide as its columns (the wrapper
  // scrolls sideways); without them the default percentages apply.
  useEffect(() => {
    const table = headRef.current?.closest("table");
    if (!table) return;
    const custom = Object.keys(widths).length > 0;
    table.classList.toggle("has-custom-widths", custom);
    if (!custom) {
      table.style.width = "";
      return;
    }
    const openColumn =
      headRef.current?.querySelector<HTMLTableCellElement>("th:last-child")
        ?.getBoundingClientRect().width ?? 54;
    const total = LEADS_TABLE_COLUMNS.reduce(
      (sum, { key }) =>
        sum +
        (widths[key] ??
          headRef.current
            ?.querySelector<HTMLTableCellElement>(`th[data-column="${key}"]`)
            ?.getBoundingClientRect().width ??
          LEADS_COLUMN_MIN_WIDTH),
      openColumn,
    );
    table.style.width = `${Math.round(total)}px`;
  }, [widths]);

  /** Freezes every column at its rendered width before the first resize. */
  const measuredWidths = useCallback((): LeadsColumnWidths => {
    const cells = headRef.current?.querySelectorAll<HTMLTableCellElement>(
      "th[data-column]",
    );
    const measured: LeadsColumnWidths = {};
    cells?.forEach((cell) => {
      const key = cell.dataset.column as ColumnKey;
      measured[key] = widths[key] ?? Math.round(cell.getBoundingClientRect().width);
    });
    return measured;
  }, [widths]);

  const update = (next: LeadsColumnWidths) => {
    setWidths(next);
    storeWidths(next);
  };

  const onPointerDown = (key: ColumnKey) => (event: PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const base = measuredWidths();
    drag.current = { key, startX: event.clientX, startWidth: base[key] ?? 0 };
    setWidths(base);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLSpanElement>) => {
    const current = drag.current;
    if (!current) return;
    setWidths((previous) =>
      resizeLeadsColumn(
        previous,
        current.key,
        current.startWidth + (event.clientX - current.startX),
      ),
    );
  };

  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    setWidths((previous) => {
      storeWidths(previous);
      return previous;
    });
  };

  const onKeyDown = (key: ColumnKey) => (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const base = measuredWidths();
    const delta = event.key === "ArrowRight" ? KEYBOARD_STEP : -KEYBOARD_STEP;
    update(resizeLeadsColumn(base, key, (base[key] ?? 0) + delta));
  };

  const reset = () => update({});

  return (
    <>
      <colgroup>
        {LEADS_TABLE_COLUMNS.map(({ key }) => (
          <col
            key={key}
            className={`leads-col-${key}`}
            style={widths[key] ? { width: `${widths[key]}px` } : undefined}
          />
        ))}
        <col className="leads-col-open" />
      </colgroup>
      <thead ref={headRef}>
        <tr>
          {LEADS_TABLE_COLUMNS.map(({ key, label }) => (
            <th key={key} data-column={key} className="leads-resizable-th">
              {label}
              <span
                role="separator"
                aria-orientation="vertical"
                aria-label={`Ajustar largura da coluna ${label}`}
                aria-valuemin={LEADS_COLUMN_MIN_WIDTH}
                aria-valuenow={widths[key] ? Math.round(widths[key]) : undefined}
                tabIndex={0}
                title="Arraste para ajustar a largura. Clique duas vezes para voltar ao padrão."
                className="leads-column-resizer"
                onPointerDown={onPointerDown(key)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onDoubleClick={reset}
                onKeyDown={onKeyDown(key)}
              />
            </th>
          ))}
          <th>
            <span className="sr-only">Abrir lead</span>
          </th>
        </tr>
      </thead>
    </>
  );
}
