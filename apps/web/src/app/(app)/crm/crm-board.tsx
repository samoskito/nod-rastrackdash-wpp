"use client";

import {
  DndContext,
  DragOverlay,
  KeyboardCode,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import {
  type CrmBoardDto,
  type CrmColumnDto,
  type ManualConversionResultDto,
} from "@wpptrack/shared";
import { RefreshCw, Settings2 } from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type TouchEvent,
} from "react";
import { Toast, type ToastMessage } from "../../../components/toast";
import type { ManualConversionAccess } from "../../../lib/manual-conversion-access";
import { ManualConversionDialog } from "../leads/[leadId]/manual-conversion-dialog";
import { loadCrmColumnAction, refreshCrmBoardAction } from "./actions";
import {
  appendCrmColumnPage,
  crmBoardIsEmpty,
  crmColumnMoveCheck,
  crmDefaultValueText,
  crmForwardTargets,
  crmMoveOutcomeLabel,
  crmRemainingCount,
  crmSkippedLabels,
  findCrmCard,
  mergeCrmRefresh,
  moveCrmCard,
  type CrmBoardColumns,
} from "./crm-board-state";
import { CrmCard, CrmCardBody, type CrmCardOptions } from "./crm-card";
import {
  CrmFilters,
  type CrmCampaignOption,
  type CrmWhatsappInstanceOption,
} from "./crm-filters";

export type { CrmCampaignOption, CrmWhatsappInstanceOption };
import type { CrmFilterValues } from "./crm-filter-params";
import { CrmLeadModal } from "./crm-lead-modal";

/** Light refresh (design §11). */
export const CRM_REFRESH_INTERVAL_MS = 60_000;
const MOBILE_QUERY = "(max-width: 760px)";
const SWIPE_MIN_PX = 60;

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(MOBILE_QUERY);
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return mobile;
}

/**
 * The page never scrolls (design §4): the board takes the height left below
 * its top edge, and each column scrolls inside it.
 */
/** `layoutKey`: re-measure when the content above the board changes (mobile tabs, notices). */
function useFillHeight<T extends HTMLElement>(layoutKey: unknown) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const top = element.getBoundingClientRect().top;
      // nod: keep the residual footer (RastrackDash · powered by PalmUP)
      // inside the viewport under the board, never pushed below the fold.
      const footer = document.querySelector<HTMLElement>(".content-footer");
      let footerSpace = 0;
      if (footer) {
        const style = window.getComputedStyle(footer);
        footerSpace =
          footer.offsetHeight +
          (Number.parseFloat(style.marginTop) || 0) +
          (Number.parseFloat(style.marginBottom) || 0);
      }
      element.style.setProperty(
        "--crm-board-height",
        `${Math.max(320, window.innerHeight - top - 16 - footerSpace)}px`,
      );
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [layoutKey]);
  return ref;
}

/**
 * Keyboard drag (design §13): arrows jump straight to the center of the
 * previous/next column instead of moving a few pixels.
 */
const columnKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { context, currentCoordinates },
) => {
  const horizontal =
    event.code === KeyboardCode.Right || event.code === KeyboardCode.Left;
  if (!horizontal && event.code !== KeyboardCode.Down && event.code !== KeyboardCode.Up)
    return undefined;
  event.preventDefault();
  if (!horizontal) return currentCoordinates;
  const rects = [...context.droppableRects.values()].sort(
    (left, right) => left.left - right.left,
  );
  const x = currentCoordinates.x;
  const target =
    event.code === KeyboardCode.Right
      ? rects.find((rect) => rect.left > x + 1)
      : [...rects].reverse().find((rect) => rect.left + rect.width < x - 1);
  if (!target) return currentCoordinates;
  return { x: target.left + 12, y: Math.max(currentCoordinates.y, target.top + 12) };
};

type PendingMove = {
  leadId: string;
  fromKey: string;
  toKey: string;
  snapshot: CrmBoardColumns;
  dialogKey: number;
};

function CrmColumnView({
  column,
  board,
  activeFromKey,
  isMobileHidden,
  children,
  onLoadMore,
  loadingMore,
}: {
  column: CrmColumnDto;
  board: CrmBoardColumns;
  activeFromKey: string | null;
  isMobileHidden: boolean;
  children: React.ReactNode;
  onLoadMore: () => void;
  loadingMore: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: column.key,
    disabled: column.readOnly,
  });
  const check = activeFromKey
    ? crmColumnMoveCheck(board, activeFromKey, column.key)
    : null;
  const dropState = !activeFromKey
    ? undefined
    : check?.ok
      ? "allowed"
      : check?.reason === "same"
        ? "origin"
        : "refused";
  const remaining = crmRemainingCount(column);
  const titleId = `crm-column-${column.key}`;
  return (
    <section
      ref={setNodeRef}
      className="crm-column"
      aria-labelledby={titleId}
      data-drop-state={dropState}
      data-over={isOver ? "true" : undefined}
      data-kind={column.kind}
      hidden={isMobileHidden || undefined}
    >
      <header className="crm-column-header">
        <h2 id={titleId}>{column.label}</h2>
        <span className="crm-column-count" aria-label={`${column.total} leads`}>
          {column.total.toLocaleString("pt-BR")}
        </span>
      </header>
      {column.kind === "conversations" ? (
        <p className="crm-column-hint">
          Ainda não é conversão: o Lead é enviado pela regra.
        </p>
      ) : null}
      <div className="crm-column-body" tabIndex={-1}>
        {column.cards.length === 0 ? (
          <p className="crm-column-empty">Nenhum lead nesta etapa.</p>
        ) : (
          children
        )}
        {remaining > 0 && column.nextCursor ? (
          <button
            className="button ghost crm-load-more"
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            {loadingMore
              ? "Carregando..."
              : `Carregar mais (${remaining.toLocaleString("pt-BR")} restantes)`}
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function CrmBoard({
  initialBoard,
  filters,
  manualAccess,
  whatsappInstances,
  campaignOptions,
  initialMobileColumn,
  now: fixedNow,
}: {
  initialBoard: CrmBoardDto;
  filters: CrmFilterValues;
  manualAccess: ManualConversionAccess;
  whatsappInstances: CrmWhatsappInstanceOption[];
  campaignOptions: CrmCampaignOption[] | null;
  /** Tests/screenshots. */
  initialMobileColumn?: string;
  now?: Date;
}) {
  const isMobile = useIsMobile();
  // Stable ids for the dnd-kit live region/description (SSR hydration).
  const dndId = useId();
  const [columns, setColumns] = useState<CrmBoardColumns>(initialBoard.columns);
  const [generatedAt, setGeneratedAt] = useState(initialBoard.generatedAt);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingColumns, setLoadingColumns] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [openLeadId, setOpenLeadId] = useState<string | null>(null);
  const [activeLeadId, setActiveLeadId] = useState<string | null>(null);
  const [mobileColumn, setMobileColumn] = useState<string>(
    initialMobileColumn ??
      initialBoard.columns.find((column) => column.kind === "stage")?.key ??
      initialBoard.columns[0]?.key ??
      "",
  );
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastId = useRef(0);
  const lastDragEnd = useRef(0);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const boardRef = useFillHeight<HTMLDivElement>(isMobile);
  const busyRef = useRef(false);
  busyRef.current = Boolean(pending) || Boolean(openLeadId);
  const now = fixedNow ?? new Date();
  // nod: with the license locked the board stays readable, but moving a card
  // registers a conversion (a write): the API answers 423, so it is disabled.
  const licenseLocked = manualAccess.canManage && manualAccess.licenseLocked;
  const canMove =
    initialBoard.canMoveCards && manualAccess.canManage && !licenseLocked;

  const notify = useCallback(
    (title: string, tone: ToastMessage["tone"], detail?: string | null) => {
      toastId.current += 1;
      setToast({ id: toastId.current, title, tone, detail: detail ?? null });
    },
    [],
  );
  const dismissToast = useCallback(() => setToast(null), []);

  const refresh = useCallback(
    async (force = false, announceErrors = false) => {
      if (busyRef.current && !force) return;
      setRefreshing(true);
      try {
        // Forced refreshes ("Atualizar", after a move) skip the server cache.
        const response = await refreshCrmBoardAction(filters, force).catch(
          () => null,
        );
        if (!response?.ok) {
          if (announceErrors) notify("Não foi possível atualizar agora", "warn");
          return;
        }
        // A move started meanwhile: its optimistic state wins until it ends.
        if (busyRef.current && !force) return;
        setColumns((current) => mergeCrmRefresh(current, response.board.columns));
        setGeneratedAt(response.board.generatedAt);
      } finally {
        setRefreshing(false);
      }
    },
    [filters, notify],
  );

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, CRM_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  async function loadMore(column: CrmColumnDto) {
    if (!column.nextCursor || loadingColumns.has(column.key)) return;
    setLoadingColumns((current) => new Set(current).add(column.key));
    try {
      const response = await loadCrmColumnAction(
        column.key,
        filters,
        column.nextCursor,
      ).catch(() => null);
      if (!response?.ok) {
        notify("Não foi possível carregar mais leads", "warn");
        return;
      }
      setColumns((current) => appendCrmColumnPage(current, response.page));
    } finally {
      setLoadingColumns((current) => {
        const next = new Set(current);
        next.delete(column.key);
        return next;
      });
    }
  }

  /** Drop or "Mover para…": forward check, optimistic move, confirmation. */
  function requestMove(leadId: string, toKey: string) {
    if (!canMove || pending) return;
    const found = findCrmCard(columns, leadId);
    if (!found) return;
    const check = crmColumnMoveCheck(columns, found.column.key, toKey);
    if (!check) return;
    if (!check.ok) {
      if (check.reason !== "same") notify(check.message, "warn");
      return;
    }
    setPending({
      leadId,
      fromKey: found.column.key,
      toKey,
      snapshot: columns,
      dialogKey: Date.now(),
    });
    setColumns((current) => moveCrmCard(current, leadId, toKey));
  }

  function finishMove(result: ManualConversionResultDto | null) {
    const move = pending;
    if (!move) return;
    setPending(null);
    if (!result) {
      // Cancel (or an error the user closed): the card goes back.
      setColumns(move.snapshot);
      return;
    }
    notify(crmMoveOutcomeLabel(result), result.outcome === "queued" ? "ok" : "neutral");
    // Value/date of the registered conversion; never disturbs loaded pages.
    void refresh(true);
  }

  function openLead(leadId: string) {
    if (Date.now() - lastDragEnd.current < 250) return;
    setOpenLeadId(leadId);
  }

  function closeLead(changed: boolean) {
    setOpenLeadId(null);
    if (changed) void refresh(true);
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: columnKeyboardCoordinates,
      keyboardCodes: {
        start: [KeyboardCode.Space],
        cancel: [KeyboardCode.Esc],
        end: [KeyboardCode.Space, KeyboardCode.Enter],
      },
    }),
  );

  const labelOf = useCallback(
    (key: string | number | undefined) =>
      columns.find((column) => column.key === key)?.label ?? "fora das colunas",
    [columns],
  );
  const leadNameOf = useCallback(
    (id: string | number) =>
      findCrmCard(columns, String(id))?.card.name ?? "Lead sem nome",
    [columns],
  );
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Card de ${leadNameOf(active.id)} selecionado em ${labelOf(
        active.data.current?.fromKey as string,
      )}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${leadNameOf(active.id)} sobre ${labelOf(over.id)}.`
        : `${leadNameOf(active.id)} fora das colunas.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `${leadNameOf(active.id)} solto em ${labelOf(over.id)}.`
        : `${leadNameOf(active.id)} solto fora das colunas.`,
    onDragCancel: ({ active }) =>
      `Movimento de ${leadNameOf(active.id)} cancelado.`,
  };

  function onDragStart(event: DragStartEvent) {
    setActiveLeadId(String(event.active.id));
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveLeadId(null);
    lastDragEnd.current = Date.now();
    if (event.over) requestMove(String(event.active.id), String(event.over.id));
  }

  const activeCard = activeLeadId ? findCrmCard(columns, activeLeadId) : null;
  const target = pending
    ? columns.find((column) => column.key === pending.toKey)
    : undefined;
  const skipped = pending
    ? crmSkippedLabels(pending.snapshot, pending.fromKey, pending.toKey)
    : [];
  const summary = useMemo(
    () => columns.map((column) => ({ key: column.key, label: column.label, total: column.total })),
    [columns],
  );
  const empty = crmBoardIsEmpty({ columns });
  const cardOptions = (column: CrmColumnDto): CrmCardOptions => ({
    showWhatsappNumber: initialBoard.showWhatsappNumber,
    showValue: column.requiresValue,
    now,
  });
  const updatedLabel = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(generatedAt));

  function onTouchStart(event: TouchEvent) {
    const touch = event.touches[0];
    swipeStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  }

  function onTouchEnd(event: TouchEvent) {
    const start = swipeStart.current;
    const touch = event.changedTouches[0];
    swipeStart.current = null;
    if (!start || !touch || !isMobile) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const index = columns.findIndex((column) => column.key === mobileColumn);
    const next = columns[index + (dx < 0 ? 1 : -1)];
    if (next) setMobileColumn(next.key);
  }

  return (
    <section className="crm-page" aria-labelledby="crm-title">
      <header className="crm-header">
        <div className="crm-header-title">
          <span className="eyebrow">Operação</span>
          <h1 id="crm-title">CRM</h1>
          <p>
            Leads de anúncio (CTWA) por etapa da Jornada. Arraste um card para
            registrar a conversão da etapa.
          </p>
        </div>
        <div className="crm-header-actions">
          <span className="crm-updated" aria-live="polite">
            {refreshing ? "Atualizando..." : `Atualizado às ${updatedLabel}`}
          </span>
          <button
            className="button ghost"
            type="button"
            onClick={() => void refresh(true, true)}
            disabled={refreshing}
          >
            <RefreshCw aria-hidden="true" size={15} strokeWidth={2} />
            Atualizar
          </button>
        </div>
        {licenseLocked ? (
          <p className="crm-license-locked" role="status">
            Licença bloqueada: o quadro continua visível, mas mover cards
            (registrar a conversão da etapa) fica desabilitado até a licença
            ser ativada em Backoffice → Licença.
          </p>
        ) : null}
        <CrmFilters
          filters={filters}
          whatsappInstances={whatsappInstances}
          campaignOptions={campaignOptions}
        />
        {initialBoard.journeyConfigured ? (
          <ul className="crm-summary" aria-label="Total por etapa">
            {summary.map((item) => (
              <li key={item.key}>
                <span>{item.label}</span>
                <strong>{item.total.toLocaleString("pt-BR")}</strong>
              </li>
            ))}
          </ul>
        ) : null}
      </header>

      {!initialBoard.journeyConfigured ? (
        <div className="crm-empty-state surface-panel">
          <Settings2 aria-hidden="true" size={22} strokeWidth={1.8} />
          <strong>Configure a Jornada</strong>
          <span>
            O quadro usa as etapas visíveis da Jornada. Nenhuma etapa está
            visível agora.
          </span>
          <Link className="button primary" href="/settings#configuracao-conversoes">
            Configurar a Jornada
          </Link>
        </div>
      ) : empty ? (
        <div className="crm-empty-state surface-panel">
          <strong>Nenhum lead no período</strong>
          <span>
            Nenhum lead de anúncio chegou neste período com estes filtros.
            Amplie o período ou limpe os filtros.
          </span>
        </div>
      ) : (
        <DndContext
          id={dndId}
          sensors={sensors}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setActiveLeadId(null)}
          accessibility={{
            announcements,
            screenReaderInstructions: {
              draggable:
                "Pressione Enter para abrir o lead. Para mover para outra etapa, pressione Espaço, use as setas para a esquerda e para a direita e pressione Espaço ou Enter para soltar. Esc cancela.",
            },
          }}
        >
          <div className="crm-board-area">
          {isMobile ? (
            <div className="crm-mobile-tabs" role="tablist" aria-label="Etapas">
              {columns.map((column) => (
                <button
                  key={column.key}
                  type="button"
                  role="tab"
                  aria-selected={column.key === mobileColumn}
                  className={column.key === mobileColumn ? "active" : undefined}
                  onClick={() => setMobileColumn(column.key)}
                >
                  <span>{column.label}</span>
                  <strong>{column.total.toLocaleString("pt-BR")}</strong>
                </button>
              ))}
            </div>
          ) : null}
          <div
            ref={boardRef}
            className={`crm-board${isMobile ? " is-mobile" : ""}`}
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
          >
            {columns.map((column) => (
              <CrmColumnView
                key={column.key}
                column={column}
                board={columns}
                activeFromKey={activeCard?.column.key ?? null}
                isMobileHidden={isMobile && column.key !== mobileColumn}
                loadingMore={loadingColumns.has(column.key)}
                onLoadMore={() => void loadMore(column)}
              >
                {column.cards.map((card) => (
                  <CrmCard
                    key={card.leadId}
                    card={card}
                    column={column}
                    options={cardOptions(column)}
                    draggable={canMove && !isMobile && !pending}
                    moveTargets={
                      canMove && isMobile ? crmForwardTargets(columns, column.key) : null
                    }
                    pending={pending?.leadId === card.leadId}
                    onOpen={openLead}
                    onMove={requestMove}
                  />
                ))}
              </CrmColumnView>
            ))}
          </div>
          </div>
          <DragOverlay dropAnimation={null}>
            {activeCard ? (
              <article className="crm-card is-overlay">
                <CrmCardBody card={activeCard.card} options={cardOptions(activeCard.column)} />
              </article>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {pending && target?.eventName ? (
        <ManualConversionDialog
          key={pending.dialogKey}
          open
          leadId={pending.leadId}
          defaultCurrency={manualAccess.currency}
          lockEvent
          source="kanban"
          title={`Mover para ${target.label}`}
          initial={{
            eventName: target.eventName,
            value: crmDefaultValueText(target.defaultValueCents),
            currency:
              (target.defaultCurrency as typeof manualAccess.currency | null) ??
              manualAccess.currency,
            contentName: target.defaultContentName ?? "",
          }}
          notice={
            skipped.length
              ? `Só a etapa ${target.label} dispara conversão. As etapas intermediárias (${skipped.join(", ")}) não são enviadas.`
              : null
          }
          onRecorded={(result) => finishMove(result)}
          onClose={(result) => finishMove(result)}
        />
      ) : null}

      {openLeadId ? (
        <CrmLeadModal
          leadId={openLeadId}
          manualAccess={manualAccess}
          onClose={closeLead}
        />
      ) : null}

      <Toast toast={toast} onDismiss={dismissToast} />
    </section>
  );
}
