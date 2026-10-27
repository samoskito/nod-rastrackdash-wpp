import {
  CRM_COLUMN_PAGE_SIZE,
  crmMoveCheck,
  type CrmBoardDto,
  type CrmColumnDto,
  type CrmColumnPageDto,
  type CrmLeadCardDto,
  type CrmMoveCheck,
  type ManualConversionResultDto,
} from "@wpptrack/shared";

/**
 * Client state of the CRM board (pure, unit-tested): optimistic moves with
 * rollback, "Carregar mais" pages and the light refresh merge that never
 * drops the pages the user already loaded (design §4, §10, §11).
 */

export type CrmBoardColumns = CrmColumnDto[];

export type CrmCardLocation = {
  column: CrmColumnDto;
  card: CrmLeadCardDto;
  index: number;
};

export function findCrmCard(
  columns: CrmBoardColumns,
  leadId: string,
): CrmCardLocation | null {
  for (const column of columns) {
    const index = column.cards.findIndex((card) => card.leadId === leadId);
    if (index >= 0) return { column, card: column.cards[index]!, index };
  }
  return null;
}

/** Cards of the column not loaded yet ("Carregar mais (N restantes)"). */
export function crmRemainingCount(column: CrmColumnDto): number {
  return Math.max(0, column.total - column.cards.length);
}

export function crmColumnMoveCheck(
  columns: CrmBoardColumns,
  fromKey: string,
  toKey: string,
): CrmMoveCheck | null {
  const from = columns.find((column) => column.key === fromKey);
  const to = columns.find((column) => column.key === toKey);
  return from && to ? crmMoveCheck(from, to) : null;
}

/** Destinations offered by "Mover para…": later stages only. */
export function crmForwardTargets(
  columns: CrmBoardColumns,
  fromKey: string,
): CrmColumnDto[] {
  const from = columns.find((column) => column.key === fromKey);
  if (!from) return [];
  return columns.filter((column) => crmMoveCheck(from, column).ok);
}

/** Labels of the stages a move skips (they are not sent). */
export function crmSkippedLabels(
  columns: CrmBoardColumns,
  fromKey: string,
  toKey: string,
): string[] {
  const from = columns.find((column) => column.key === fromKey);
  const to = columns.find((column) => column.key === toKey);
  if (!from || !to) return [];
  return columns
    .filter(
      (column) =>
        column.kind === "stage" &&
        column.rank > from.rank &&
        column.rank < to.rank,
    )
    .map((column) => column.label);
}

/** Optimistic move: the card goes to the top of the destination column. */
export function moveCrmCard(
  columns: CrmBoardColumns,
  leadId: string,
  toKey: string,
  now: Date = new Date(),
): CrmBoardColumns {
  const found = findCrmCard(columns, leadId);
  if (!found || found.column.key === toKey) return columns;
  const moved: CrmLeadCardDto = {
    ...found.card,
    enteredStageAt: now.toISOString(),
    // The value comes with the registered conversion (next refresh).
    valueCents: null,
    currency: null,
  };
  return columns.map((column) => {
    if (column.key === found.column.key)
      return {
        ...column,
        total: Math.max(0, column.total - 1),
        cards: column.cards.filter((card) => card.leadId !== leadId),
      };
    if (column.key === toKey)
      return { ...column, total: column.total + 1, cards: [moved, ...column.cards] };
    return column;
  });
}

export function appendCrmColumnPage(
  columns: CrmBoardColumns,
  page: CrmColumnPageDto,
): CrmBoardColumns {
  const seen = new Set(
    columns.flatMap((column) => column.cards.map((card) => card.leadId)),
  );
  return columns.map((column) =>
    column.key === page.key
      ? {
          ...column,
          cards: [
            ...column.cards,
            ...page.cards.filter((card) => !seen.has(card.leadId)),
          ],
          nextCursor: page.nextCursor,
        }
      : column,
  );
}

/**
 * Light refresh (counts + first page of each column). Totals and first
 * pages come from the server; cards the user loaded with "Carregar mais"
 * stay (unless the server now shows them in another column), and so does
 * the cursor of a column that had more pages loaded.
 */
export function mergeCrmRefresh(
  current: CrmBoardColumns,
  fresh: CrmBoardColumns,
): CrmBoardColumns {
  const freshIds = new Set(
    fresh.flatMap((column) => column.cards.map((card) => card.leadId)),
  );
  return fresh.map((column) => {
    const previous = current.find((candidate) => candidate.key === column.key);
    if (!previous || previous.cards.length <= CRM_COLUMN_PAGE_SIZE)
      return column;
    const extra = previous.cards
      .slice(CRM_COLUMN_PAGE_SIZE)
      .filter((card) => !freshIds.has(card.leadId));
    return {
      ...column,
      cards: [...column.cards, ...extra],
      nextCursor: previous.nextCursor,
    };
  });
}

export function crmBoardIsEmpty(board: Pick<CrmBoardDto, "columns">): boolean {
  return board.columns.every((column) => column.total === 0);
}

/** Toast after a move (design §10). */
export function crmMoveOutcomeLabel(result: ManualConversionResultDto): string {
  if (result.outcome === "queued")
    return result.status === "sent" ? "Enviado à Meta" : "Na fila de envio à Meta";
  if (result.outcome === "expired")
    return "Registrado só no painel (passou da janela de 7 dias da Meta)";
  return "Registrado só no painel";
}

/** Jornada default value (cents) as the form text ("497,00"). */
export function crmDefaultValueText(cents: number | null): string {
  if (cents == null) return "";
  return (cents / 100).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false,
  });
}
