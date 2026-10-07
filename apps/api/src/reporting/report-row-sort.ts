import type { ReportSortDto, ReportSortKeyDto } from "@wpptrack/shared";

export type SortableReportRow = {
  id: string;
  name: string;
} & Partial<Record<ReportSortKeyDto, number | null>>;

// Finite values (zero included) sort by the requested direction. Missing or
// nonfinite values always sort last. Ties fall back to name, then id, both
// ascending by code unit so the order never depends on the server locale.
export function sortReportRows<T extends SortableReportRow>(
  rows: readonly T[],
  sort: ReportSortDto,
): T[] {
  const directionFactor = sort.direction === "asc" ? 1 : -1;

  return [...rows].sort((left, right) => {
    const leftValue = finiteOrNull(left[sort.key]);
    const rightValue = finiteOrNull(right[sort.key]);

    if (leftValue !== rightValue) {
      if (leftValue === null) {
        return 1;
      }

      if (rightValue === null) {
        return -1;
      }

      return (leftValue - rightValue) * directionFactor;
    }

    return (
      compareCodeUnits(left.name, right.name) ||
      compareCodeUnits(left.id, right.id)
    );
  });
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
