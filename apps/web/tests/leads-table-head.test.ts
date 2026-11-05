// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import {
  LEADS_COLUMN_MIN_WIDTH,
  LEADS_COLUMN_STORAGE_KEY,
  LeadsTableHead,
  parseLeadsColumnWidths,
  resizeLeadsColumn,
} from "../src/app/(app)/leads/leads-table-head";

function renderHead() {
  return render(
    React.createElement(
      "table",
      { className: "leads-table" },
      React.createElement(LeadsTableHead),
    ),
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("parseLeadsColumnWidths", () => {
  it("keeps known columns, rounds and enforces the minimum width", () => {
    expect(
      parseLeadsColumnWidths(
        JSON.stringify({ lead: 320.4, source: 20, nope: 500, stage: "x" }),
      ),
    ).toEqual({ lead: 320, source: LEADS_COLUMN_MIN_WIDTH });
  });

  it("returns no widths for missing or broken data", () => {
    expect(parseLeadsColumnWidths(null)).toEqual({});
    expect(parseLeadsColumnWidths("{not json")).toEqual({});
  });

  it("resizes one column without going below the minimum", () => {
    expect(resizeLeadsColumn({ lead: 300 }, "lead", 340.6)).toEqual({ lead: 341 });
    expect(resizeLeadsColumn({ lead: 300 }, "lead", 10)).toEqual({
      lead: LEADS_COLUMN_MIN_WIDTH,
    });
  });
});

describe("LeadsTableHead", () => {
  it("renders the same columns as before, each with a resize handle", () => {
    renderHead();
    const headers = screen
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers).toEqual([
      "Lead",
      "Campanha / origem",
      "Etapa atual",
      "Recebido",
      "Última atividade",
      "Abrir lead",
    ]);
    for (const label of [
      "Lead",
      "Campanha / origem",
      "Etapa atual",
      "Recebido",
      "Última atividade",
    ]) {
      expect(
        screen.getByRole("separator", {
          name: `Ajustar largura da coluna ${label}`,
        }),
      ).toBeTruthy();
    }
    expect(screen.getByText("Abrir lead")).toBeTruthy();
  });

  it("applies the widths this browser saved", async () => {
    window.localStorage.setItem(
      LEADS_COLUMN_STORAGE_KEY,
      JSON.stringify({ lead: 360 }),
    );
    const { container } = renderHead();
    await vi.waitFor(() => {
      const leadCol = container.querySelector<HTMLElement>(".leads-col-lead");
      expect(leadCol?.style.width).toBe("360px");
    });
    expect(
      container.querySelector("table")?.classList.contains("has-custom-widths"),
    ).toBe(true);
  });

  it("widens a column with the keyboard, saves it, and resets on double click", () => {
    const { container } = renderHead();
    const handle = screen.getByRole("separator", {
      name: "Ajustar largura da coluna Lead",
    });

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    const saved = JSON.parse(
      window.localStorage.getItem(LEADS_COLUMN_STORAGE_KEY) ?? "{}",
    );
    expect(saved.lead).toBeGreaterThanOrEqual(LEADS_COLUMN_MIN_WIDTH);
    expect(container.querySelector<HTMLElement>(".leads-col-lead")?.style.width).toBe(
      `${saved.lead}px`,
    );

    fireEvent.doubleClick(handle);
    expect(window.localStorage.getItem(LEADS_COLUMN_STORAGE_KEY)).toBeNull();
    expect(container.querySelector<HTMLElement>(".leads-col-lead")?.style.width).toBe(
      "",
    );
  });

  it("keeps working when the browser blocks localStorage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    renderHead();
    const handle = screen.getByRole("separator", {
      name: "Ajustar largura da coluna Lead",
    });
    expect(() => fireEvent.keyDown(handle, { key: "ArrowRight" })).not.toThrow();
  });
});
