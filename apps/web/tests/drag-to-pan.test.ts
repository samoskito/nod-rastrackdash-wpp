// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import React, { useRef } from "react";
import {
  DRAG_TO_PAN_THRESHOLD,
  panScrollLeft,
  shouldStartPan,
  useDragToPan,
} from "../src/lib/drag-to-pan";

afterEach(cleanup);

function press(
  target: EventTarget | null,
  overrides: Partial<{ button: number; pointerType: string }> = {},
) {
  return {
    button: 0,
    pointerType: "mouse",
    target,
    offsetX: 0,
    offsetY: 0,
    ...overrides,
  };
}

function pointer(
  element: Element,
  type: string,
  clientX: number,
  overrides: Partial<{ button: number; pointerType: string }> = {},
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    button: overrides.button ?? 0,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", {
    value: overrides.pointerType ?? "mouse",
  });
  element.dispatchEvent(event);
  return event;
}

function Board({ enabled = true }: { enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useDragToPan(ref, { enabled, cardSelector: ".crm-card" });
  return React.createElement(
    "div",
    { ref, "data-testid": "board", className: "crm-board" },
    React.createElement(
      "section",
      { className: "crm-column", "data-testid": "column" },
      React.createElement("article", {
        className: "crm-card",
        "data-testid": "card",
      }),
      React.createElement("button", { "data-testid": "load-more" }, "Mais"),
    ),
  );
}

describe("shouldStartPan", () => {
  it("starts on the board or column background with the main mouse button", () => {
    const board = document.createElement("div");
    const column = document.createElement("section");
    board.append(column);
    expect(shouldStartPan(press(board))).toBe(true);
    expect(shouldStartPan(press(column), { cardSelector: ".crm-card" })).toBe(true);
  });

  it("never starts on a card, button, link or field", () => {
    const board = document.createElement("div");
    const card = document.createElement("article");
    card.className = "crm-card";
    const inner = document.createElement("strong");
    card.append(inner);
    const button = document.createElement("button");
    const link = document.createElement("a");
    const input = document.createElement("input");
    board.append(card, button, link, input);
    for (const target of [card, inner, button, link, input]) {
      expect(shouldStartPan(press(target), { cardSelector: ".crm-card" })).toBe(
        false,
      );
    }
  });

  it("ignores touch, pen and the other mouse buttons", () => {
    const board = document.createElement("div");
    expect(shouldStartPan(press(board, { pointerType: "touch" }))).toBe(false);
    expect(shouldStartPan(press(board, { pointerType: "pen" }))).toBe(false);
    expect(shouldStartPan(press(board, { button: 1 }))).toBe(false);
    expect(shouldStartPan(press(board, { button: 2 }))).toBe(false);
  });

  it("ignores a press on the element's own scrollbar", () => {
    const board = document.createElement("div");
    Object.defineProperty(board, "clientHeight", { value: 300 });
    Object.defineProperty(board, "clientWidth", { value: 900 });
    expect(shouldStartPan({ ...press(board), offsetY: 306 })).toBe(false);
    expect(shouldStartPan({ ...press(board), offsetX: 905 })).toBe(false);
    expect(shouldStartPan({ ...press(board), offsetY: 120 })).toBe(true);
  });
});

describe("panScrollLeft", () => {
  it("moves the content with the pointer and never goes below zero", () => {
    expect(panScrollLeft(400, 500, 380)).toBe(520);
    expect(panScrollLeft(400, 500, 650)).toBe(250);
    expect(panScrollLeft(50, 500, 800)).toBe(0);
  });
});

describe("useDragToPan", () => {
  it("scrolls the board when the background is dragged sideways", () => {
    const { getByTestId } = render(React.createElement(Board));
    const board = getByTestId("board");
    board.scrollLeft = 200;
    expect(board.classList.contains("can-pan")).toBe(true);

    pointer(board, "pointerdown", 600);
    pointer(board, "pointermove", 600 - DRAG_TO_PAN_THRESHOLD + 1);
    expect(board.scrollLeft).toBe(200);
    pointer(board, "pointermove", 480);
    expect(board.classList.contains("is-panning")).toBe(true);
    expect(board.scrollLeft).toBe(320);
    pointer(board, "pointerup", 480);
    expect(board.classList.contains("is-panning")).toBe(false);
  });

  it("leaves card drags alone", () => {
    const { getByTestId } = render(React.createElement(Board));
    const board = getByTestId("board");
    board.scrollLeft = 200;
    const card = getByTestId("card");

    pointer(card, "pointerdown", 600);
    pointer(card, "pointermove", 400);
    expect(board.scrollLeft).toBe(200);
    expect(board.classList.contains("is-panning")).toBe(false);
  });

  it("swallows the click that ends a pan, but not a plain click", () => {
    const onClick = vi.fn();
    const { getByTestId } = render(React.createElement(Board));
    const board = getByTestId("board");
    const loadMore = getByTestId("load-more");
    loadMore.addEventListener("click", onClick);

    pointer(board, "pointerdown", 600);
    pointer(board, "pointermove", 500);
    pointer(board, "pointerup", 500);
    loadMore.click();
    expect(onClick).not.toHaveBeenCalled();

    pointer(board, "pointerdown", 600);
    pointer(board, "pointerup", 600);
    loadMore.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does nothing on touch or when disabled (phone)", () => {
    const { getByTestId, rerender } = render(React.createElement(Board));
    const board = getByTestId("board");
    board.scrollLeft = 200;
    pointer(board, "pointerdown", 600, { pointerType: "touch" });
    pointer(board, "pointermove", 400, { pointerType: "touch" });
    expect(board.scrollLeft).toBe(200);

    rerender(React.createElement(Board, { enabled: false }));
    expect(board.classList.contains("can-pan")).toBe(false);
    pointer(board, "pointerdown", 600);
    pointer(board, "pointermove", 400);
    expect(board.scrollLeft).toBe(200);
  });
});
