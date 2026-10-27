// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CRM_FIXTURE_NOW,
  crmBoardFixture,
  crmCard,
  crmLeadDetailFixture,
  crmPurchasePreviewFixture,
} from "./support/crm-fixtures";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  refreshCrmBoardAction: vi.fn(),
  loadCrmColumnAction: vi.fn(),
  loadCrmLeadDetailAction: vi.fn(),
  previewManualConversionAction: vi.fn(),
  createManualConversionAction: vi.fn(),
  cancelManualConversionAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
  usePathname: () => "/crm",
}));
vi.mock("../src/app/(app)/crm/actions", () => ({
  refreshCrmBoardAction: mocks.refreshCrmBoardAction,
  loadCrmColumnAction: mocks.loadCrmColumnAction,
  loadCrmLeadDetailAction: mocks.loadCrmLeadDetailAction,
}));
vi.mock("../src/app/(app)/leads/[leadId]/actions", () => ({
  previewManualConversionAction: mocks.previewManualConversionAction,
  createManualConversionAction: mocks.createManualConversionAction,
  cancelManualConversionAction: mocks.cancelManualConversionAction,
}));

import { CrmBoard } from "../src/app/(app)/crm/crm-board";
import {
  appendCrmColumnPage,
  crmDefaultValueText,
  crmForwardTargets,
  crmMoveOutcomeLabel,
  crmRemainingCount,
  crmSkippedLabels,
  mergeCrmRefresh,
  moveCrmCard,
} from "../src/app/(app)/crm/crm-board-state";
import {
  crmFiltersFromSearchParams,
  crmFiltersHref,
  crmQueryString,
} from "../src/app/(app)/crm/crm-filter-params";

const filters = {
  since: "2026-09-25",
  until: "2026-10-24",
  whatsappInstanceId: "",
  campaignId: "",
};
const owner = {
  canManage: true,
  currency: "BRL" as const,
  licenseLocked: false,
};

function setMobile(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function renderBoard(
  props: Partial<React.ComponentProps<typeof CrmBoard>> = {},
) {
  return render(
    React.createElement(CrmBoard, {
      initialBoard: crmBoardFixture(),
      filters,
      manualAccess: owner,
      whatsappInstances: [],
      campaignOptions: [],
      now: CRM_FIXTURE_NOW,
      ...props,
    }),
  );
}

function column(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>(".crm-column")].find(
    (element) => element.querySelector("h2")?.textContent === label,
  );
  if (!found) throw new Error(`column ${label} not found`);
  return found;
}

beforeEach(() => {
  setMobile(false);
  vi.stubGlobal("crypto", { randomUUID: () => "4b0c5a3e-8f43-4a8f-9c55-0d3a9f1d2e11" });
  for (const mock of Object.values(mocks)) mock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CRM board state (pure)", () => {
  const board = crmBoardFixture();

  it("moves a card to the top of the destination and fixes both totals", () => {
    const moved = moveCrmCard(board.columns, "lead_000", "Purchase", CRM_FIXTURE_NOW);
    expect(moved[0]).toMatchObject({ total: 45 });
    expect(moved[0]!.cards.some((card) => card.leadId === "lead_000")).toBe(false);
    expect(moved[2]).toMatchObject({ total: 3 });
    expect(moved[2]!.cards[0]).toMatchObject({
      leadId: "lead_000",
      enteredStageAt: CRM_FIXTURE_NOW.toISOString(),
    });
  });

  it("offers only later stages; lists the skipped ones", () => {
    const override = crmBoardFixture({ override: true }).columns;
    expect(crmForwardTargets(override, "conversations").map((c) => c.key)).toEqual([
      "LeadSubmitted",
      "QualifiedLead",
      "Purchase",
    ]);
    expect(crmForwardTargets(override, "QualifiedLead").map((c) => c.key)).toEqual(["Purchase"]);
    expect(crmForwardTargets(override, "Purchase")).toEqual([]);
    expect(crmSkippedLabels(override, "LeadSubmitted", "Purchase")).toEqual(["Lead qualificado"]);
  });

  it("appends a page without duplicates and keeps loaded pages on refresh", () => {
    const page = {
      key: "LeadSubmitted",
      cards: [crmCard(30), crmCard(31), crmCard(0)],
      nextCursor: "cursor_40",
      remaining: 6,
    };
    const loaded = appendCrmColumnPage(board.columns, page);
    expect(loaded[0]!.cards).toHaveLength(22);
    expect(crmRemainingCount(loaded[0]!)).toBe(24);
    // Fresh first page: lead_031 moved to Lead qualificado meanwhile.
    const fresh = crmBoardFixture().columns.map((column) =>
      column.key === "QualifiedLead"
        ? { ...column, total: 5, cards: [crmCard(31), ...column.cards] }
        : column.key === "LeadSubmitted"
          ? { ...column, total: 47 }
          : column,
    );
    const merged = mergeCrmRefresh(loaded, fresh);
    expect(merged[0]!.total).toBe(47);
    expect(merged[0]!.cards.map((c) => c.leadId)).toContain("lead_030");
    expect(merged[0]!.cards.map((c) => c.leadId)).not.toContain("lead_031");
    expect(merged[0]!.nextCursor).toBe("cursor_40");
    expect(merged[1]!.cards[0]!.leadId).toBe("lead_031");
  });

  it("toast and value texts", () => {
    const base = { conversionEventLogId: "log", message: "x", replayed: false };
    expect(crmMoveOutcomeLabel({ ...base, outcome: "queued", status: "sent" })).toBe("Enviado à Meta");
    expect(crmMoveOutcomeLabel({ ...base, outcome: "queued", status: "ready_to_send" })).toBe(
      "Na fila de envio à Meta",
    );
    expect(crmMoveOutcomeLabel({ ...base, outcome: "local_only", status: "not_eligible" })).toBe(
      "Registrado só no painel",
    );
    expect(crmDefaultValueText(49_700)).toBe("497,00");
    expect(crmDefaultValueText(null)).toBe("");
  });

  it("filters: default 30 days, canonical href and API query", () => {
    expect(crmFiltersFromSearchParams({}, CRM_FIXTURE_NOW)).toEqual(filters);
    expect(crmFiltersHref(filters, CRM_FIXTURE_NOW)).toBe("/crm");
    expect(
      crmFiltersHref({ ...filters, since: "2026-10-01", campaignId: "cmp_bf" }, CRM_FIXTURE_NOW),
    ).toBe("/crm?since=2026-10-01&until=2026-10-24&campaignId=cmp_bf");
    expect(crmQueryString(filters, { cursor: "abc" })).toBe(
      "since=2026-09-25&until=2026-10-24&cursor=abc",
    );
    expect(
      crmFiltersFromSearchParams({ since: "2026-10-30", until: "2026-10-01" }, CRM_FIXTURE_NOW),
    ).toEqual(filters);
    // 180-day cap: a longer URL period falls back to the default.
    expect(
      crmFiltersFromSearchParams({ since: "2026-04-28", until: "2026-10-24" }, CRM_FIXTURE_NOW).since,
    ).toBe("2026-04-28");
    expect(
      crmFiltersFromSearchParams({ since: "2026-04-27", until: "2026-10-24" }, CRM_FIXTURE_NOW),
    ).toEqual(filters);
  });
});

describe("CRM board (rendered)", () => {
  it("renders the Jornada columns with real totals, cards and the CTWA badge", () => {
    renderBoard();
    expect(screen.getByRole("heading", { name: "CRM" })).toBeTruthy();
    const novos = column("Leads novos");
    expect(within(novos).getByLabelText("46 leads")).toBeTruthy();
    expect(within(novos).getByText("Mariana Alves")).toBeTruthy();
    expect(within(novos).getByText("+55 11 99876-1020")).toBeTruthy();
    expect(within(novos).getAllByText("CTWA").length).toBe(20);
    expect(within(novos).getAllByText("Black Friday WhatsApp · Carrossel 40% OFF").length).toBeGreaterThan(0);
    expect(within(novos).getAllByText(/nesta etapa/u).length).toBe(20);
    // Value only on the value column; number shown (2+ numbers).
    expect(within(novos).queryByText(/R\$/u)).toBeNull();
    expect(within(column("Compra")).getByText("R$ 497,00")).toBeTruthy();
    expect(within(novos).getAllByText("Comercial SP").length).toBeGreaterThan(0);
    // Summary per column.
    const summary = screen.getByRole("list", { name: "Total por etapa" });
    expect(within(summary).getByText("Lead qualificado")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Conversas iniciadas" })).toBeNull();
  });

  it("period over 180 days shows the message and is not applied", () => {
    vi.useFakeTimers();
    renderBoard();
    fireEvent.change(document.querySelector('input[name="since"]')!, {
      target: { value: "2026-01-01" },
    });
    expect(screen.getByRole("alert").textContent).toBe("Escolha um período de até 180 dias.");
    vi.advanceTimersByTime(2_000);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("Atualizar asks for a fresh board (skips the server cache)", async () => {
    mocks.refreshCrmBoardAction.mockResolvedValue({ ok: true, board: crmBoardFixture() });
    renderBoard();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Atualizar" }));
    });
    expect(mocks.refreshCrmBoardAction).toHaveBeenCalledWith(filters, true);
  });

  it("hides the WhatsApp number with a single number; override shows Conversas iniciadas first", () => {
    renderBoard({ initialBoard: crmBoardFixture({ override: true, showWhatsappNumber: false }) });
    const regions = [...document.querySelectorAll<HTMLElement>(".crm-column")];
    expect(regions[0]!.getAttribute("aria-labelledby")).toBe("crm-column-conversations");
    expect(within(regions[0]!).getByText(/Ainda não é conversão/u)).toBeTruthy();
    expect(screen.queryByText("Comercial SP")).toBeNull();
  });

  it("Carregar mais (N restantes) appends the next page of that column", async () => {
    mocks.loadCrmColumnAction.mockResolvedValue({
      ok: true,
      page: {
        key: "LeadSubmitted",
        cards: [crmCard(40), crmCard(41)],
        nextCursor: "cursor_novos_40",
        remaining: 24,
      },
    });
    renderBoard();
    const button = screen.getByRole("button", { name: "Carregar mais (26 restantes)" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(mocks.loadCrmColumnAction).toHaveBeenCalledWith(
      "LeadSubmitted",
      filters,
      "cursor_novos_20",
    );
    expect(
      screen.getByRole("button", { name: "Carregar mais (24 restantes)" }),
    ).toBeTruthy();
    expect(within(column("Leads novos")).getAllByText("CTWA")).toHaveLength(22);
  });

  it("the lead modal keeps loaded pages and column scroll; a registration there refreshes the board", async () => {
    mocks.loadCrmColumnAction.mockResolvedValue({
      ok: true,
      page: { key: "LeadSubmitted", cards: [crmCard(40)], nextCursor: null, remaining: 0 },
    });
    mocks.loadCrmLeadDetailAction.mockResolvedValue({
      ok: true,
      detail: crmLeadDetailFixture(),
    });
    renderBoard();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Carregar mais/u }));
    });
    const body = column("Leads novos").querySelector(".crm-column-body") as HTMLElement;
    body.scrollTop = 480;
    await act(async () => {
      fireEvent.click(within(column("Lead qualificado")).getAllByRole("button")[0]!);
    });
    const dialog = await screen.findByRole("dialog", { name: "Detalhe do lead" });
    expect(within(dialog).getByText("Eventos do Pixel/CAPI")).toBeTruthy();
    expect(within(dialog).getAllByText("Manual (Kanban)").length).toBeGreaterThan(0);
    expect(within(dialog).getByRole("button", { name: /Registrar conversão manual/u })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Fechar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(column("Leads novos")).getAllByText("CTWA")).toHaveLength(21);
    expect(body.isConnected).toBe(true);
    expect(body.scrollTop).toBe(480);
    // Nothing changed in the modal: no refresh.
    expect(mocks.refreshCrmBoardAction).not.toHaveBeenCalled();
  });

  it("analysts see the board and open details, but cannot drag or move", () => {
    renderBoard({
      initialBoard: crmBoardFixture({ canMoveCards: false }),
      manualAccess: { canManage: false, currency: "BRL", licenseLocked: false },
    });
    expect(document.querySelector(".crm-card.is-draggable")).toBeNull();
    expect(screen.getAllByRole("button", { name: /Abrir detalhes de/u }).length).toBeGreaterThan(0);
    expect(screen.queryByText("Mover para…")).toBeNull();
  });

  it("nod: with the license locked the board stays readable but cards cannot move", () => {
    renderBoard({ manualAccess: { ...owner, licenseLocked: true } });
    expect(document.querySelector(".crm-license-locked")?.textContent).toMatch(
      /Licença bloqueada/u,
    );
    expect(document.querySelector(".crm-card.is-draggable")).toBeNull();
    expect(screen.getAllByRole("button", { name: /Abrir detalhes de/u }).length).toBeGreaterThan(0);
    expect(screen.queryByText("Mover para…")).toBeNull();
  });

  it("owners get keyboard-draggable cards with Portuguese instructions", () => {
    renderBoard();
    const card = document.querySelector(".crm-card.is-draggable") as HTMLElement;
    expect(card.getAttribute("role")).toBe("button");
    expect(card.getAttribute("aria-roledescription")).toBe("draggable");
    expect(document.body.textContent).toContain("pressione Espaço");
  });

  it("empty states: no lead in the period / Jornada without visible stages", () => {
    const board = crmBoardFixture();
    renderBoard({
      initialBoard: {
        ...board,
        columns: board.columns.map((c) => ({ ...c, total: 0, cards: [], nextCursor: null })),
      },
    });
    expect(screen.getByText("Nenhum lead no período")).toBeTruthy();
    cleanup();
    renderBoard({ initialBoard: { ...board, journeyConfigured: false, columns: [] } });
    expect(screen.getByText("Configure a Jornada")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Configurar a Jornada" }).getAttribute("href"),
    ).toBe("/settings#configuracao-conversoes");
  });
});

describe("CRM board on mobile: one column, Mover para…, confirmation", () => {
  beforeEach(() => setMobile(true));

  it("shows one column at a time with tabs and swipe", async () => {
    renderBoard();
    await waitFor(() => expect(screen.getByRole("tablist", { name: "Etapas" })).toBeTruthy());
    const visible = () =>
      [...document.querySelectorAll(".crm-column")].filter((el) => !(el as HTMLElement).hidden);
    expect(visible()).toHaveLength(1);
    expect(visible()[0]!.textContent).toContain("Leads novos");
    fireEvent.click(screen.getByRole("tab", { name: /Compra/u }));
    expect(visible()[0]!.textContent).toContain("Compra");
    const board = document.querySelector(".crm-board") as HTMLElement;
    fireEvent.touchStart(board, { touches: [{ clientX: 300, clientY: 200 }] });
    fireEvent.touchEnd(board, { changedTouches: [{ clientX: 120, clientY: 210 }] });
    expect(visible()[0]!.textContent).toContain("Compra"); // last column
    fireEvent.touchStart(board, { touches: [{ clientX: 100, clientY: 200 }] });
    fireEvent.touchEnd(board, { changedTouches: [{ clientX: 300, clientY: 205 }] });
    expect(visible()[0]!.textContent).toContain("Lead qualificado");
  });

  it("Mover para… → confirmation prefilled for Compra → Cancelar returns the card", async () => {
    renderBoard();
    await screen.findByRole("tablist");
    const card = within(column("Leads novos")).getAllByRole("combobox")[0]!;
    // Only later stages are offered.
    expect([...card.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "Mover para…",
      "Lead qualificado",
      "Compra",
    ]);
    fireEvent.change(card, { target: { value: "Purchase" } });
    const dialog = await screen.findByRole("dialog", { name: "Mover para Compra" });
    // Locked event, Jornada default value, order number required.
    const event = within(dialog).getByRole("combobox", { name: "Evento" }) as HTMLSelectElement;
    expect(event.disabled).toBe(true);
    expect(event.value).toBe("Purchase");
    expect((within(dialog).getByRole("textbox", { name: "Valor" }) as HTMLInputElement).value).toBe(
      "497,00",
    );
    expect(within(dialog).getByText(/etapas intermediárias \(Lead qualificado\) não são enviadas/u)).toBeTruthy();
    // Optimistic: already in Compra while the dialog is open.
    expect(column("Compra").getAttribute("hidden")).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(column("Leads novos")).getByText("Mariana Alves")).toBeTruthy();
    expect(within(column("Leads novos")).getByLabelText("46 leads")).toBeTruthy();
    expect(mocks.createManualConversionAction).not.toHaveBeenCalled();
  });

  it("confirm: same manual conversion (source kanban), card stays, toast with the result", async () => {
    mocks.previewManualConversionAction.mockResolvedValue({
      ok: true,
      preview: crmPurchasePreviewFixture,
    });
    mocks.createManualConversionAction.mockResolvedValue({
      ok: true,
      result: {
        outcome: "queued",
        conversionEventLogId: "log_new",
        status: "ready_to_send",
        message: "Conversão registrada e enfileirada para envio à Meta.",
        replayed: false,
      },
    });
    mocks.refreshCrmBoardAction.mockResolvedValue({ ok: false });
    renderBoard();
    await screen.findByRole("tablist");
    fireEvent.change(within(column("Leads novos")).getAllByRole("combobox")[0]!, {
      target: { value: "Purchase" },
    });
    const dialog = await screen.findByRole("dialog", { name: "Mover para Compra" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Número do pedido/u }), {
      target: { value: "PED-2031" },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Revisar" }));
    });
    expect(mocks.previewManualConversionAction).toHaveBeenCalledWith(
      "lead_000",
      expect.objectContaining({
        eventName: "Purchase",
        valueCents: 49_700,
        currency: "BRL",
        orderRef: "PED-2031",
        source: "kanban",
      }),
    );
    expect(within(dialog).getByText("Pixel Loja Principal · pixel 1234567890 · rota do anúncio")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar" }));
    });
    expect(mocks.createManualConversionAction).toHaveBeenCalledWith(
      "lead_000",
      expect.objectContaining({ source: "kanban", eventName: "Purchase" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Na fila de envio à Meta")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Compra/u }));
    expect(within(column("Compra")).getByText("Mariana Alves")).toBeTruthy();
    expect(within(column("Leads novos")).queryByText("Mariana Alves")).toBeNull();
  });

  it("an API refusal keeps the card back after closing (rollback on error)", async () => {
    mocks.previewManualConversionAction.mockResolvedValue({
      ok: false,
      state: "move_refused",
      message: "Não é possível voltar etapa: a conversão já foi enviada à Meta",
    });
    renderBoard();
    await screen.findByRole("tablist");
    fireEvent.change(within(column("Leads novos")).getAllByRole("combobox")[0]!, {
      target: { value: "QualifiedLead" },
    });
    const dialog = await screen.findByRole("dialog", { name: "Mover para Lead qualificado" });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Revisar" }));
    });
    expect(within(dialog).getByText(/Não é possível voltar etapa/u)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(column("Leads novos")).getByText("Mariana Alves")).toBeTruthy();
  });
});

describe("CRM board on desktop: keyboard drag (@dnd-kit)", () => {
  // jsdom has no layout: columns side by side (320px), cards stacked.
  function layout(element: Element): DOMRect {
    const columnElement = element.closest(".crm-column");
    const columns = [...document.querySelectorAll(".crm-column")];
    const left = Math.max(0, columns.indexOf(columnElement as Element)) * 320;
    if (element.classList.contains("crm-column"))
      return new DOMRect(left, 100, 300, 800);
    const card = element.closest(".crm-card");
    const index = card ? [...(card.parentElement?.children ?? [])].indexOf(card) : 0;
    return new DOMRect(left + 10, 150 + index * 120, 280, 110);
  }

  beforeEach(() => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      return layout(this);
    });
  });

  async function keyboardDrag(
    card: HTMLElement,
    arrows: string[],
    drop: { code: string; key: string } = { code: "Space", key: " " },
  ) {
    card.focus();
    await act(async () => {
      fireEvent.keyDown(card, { code: "Space", key: " " });
      // dnd-kit measures the droppable columns after the drag starts.
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    for (const code of arrows)
      await act(async () => {
        fireEvent.keyDown(document.activeElement ?? card, { code, key: code });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? card, drop);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("dropping with Enter opens only the confirmation, never the lead modal", async () => {
    renderBoard();
    const card = column("Leads novos").querySelector(".crm-card.is-draggable") as HTMLElement;
    await keyboardDrag(card, ["ArrowRight"], { code: "Enter", key: "Enter" });
    await screen.findByRole("dialog", { name: "Mover para Lead qualificado" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(mocks.loadCrmLeadDetailAction).not.toHaveBeenCalled();
  });

  it("drag forward opens the confirmation; cancel returns the card", async () => {
    renderBoard();
    const card = column("Leads novos").querySelector(".crm-card.is-draggable") as HTMLElement;
    await keyboardDrag(card, ["ArrowRight"]);
    const dialog = await screen.findByRole("dialog", { name: "Mover para Lead qualificado" });
    expect(within(column("Lead qualificado")).getByText("Mariana Alves")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(column("Lead qualificado")).queryByText("Mariana Alves")).toBeNull();
    expect(within(column("Leads novos")).getByText("Mariana Alves")).toBeTruthy();
  });

  it("drag backward is refused with the Meta message and nothing opens", async () => {
    renderBoard();
    const card = column("Compra").querySelector(".crm-card.is-draggable") as HTMLElement;
    await keyboardDrag(card, ["ArrowLeft"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByText("Não é possível voltar etapa: a conversão já foi enviada à Meta"),
    ).toBeTruthy();
    expect(within(column("Compra")).getByText("Sabrina Freitas")).toBeTruthy();
  });
});
