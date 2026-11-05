"use client";

import { useEffect, type RefObject } from "react";

/**
 * Trello-style horizontal panning: press the mouse on an empty part of a
 * horizontally scrolling area and drag sideways. Cards, buttons, links and
 * form fields keep their own behaviour (card drag-and-drop included), touch
 * keeps native scrolling, and shift+wheel / trackpad scrolling are untouched.
 */

/** Elements that must never start a pan. */
export const DRAG_TO_PAN_IGNORE_SELECTOR = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "[role='button']",
  "[role='tab']",
  "[contenteditable='true']",
  "[data-no-pan]",
].join(",");

/** Movement (px) before a press becomes a pan; below it a click stays a click. */
export const DRAG_TO_PAN_THRESHOLD = 4;

type PanPress = {
  button: number;
  pointerType: string;
  target: EventTarget | null;
  /** Pointer position relative to the target's padding box. */
  offsetX: number;
  offsetY: number;
};

function isScrollbarPress(target: Element, offsetX: number, offsetY: number) {
  const element = target as HTMLElement;
  // A press past the client box lands on that element's scrollbar.
  return (
    (element.clientWidth > 0 && offsetX > element.clientWidth) ||
    (element.clientHeight > 0 && offsetY > element.clientHeight)
  );
}

/** Whether a press on the area should start panning. */
export function shouldStartPan(
  press: PanPress,
  options: { cardSelector?: string } = {},
): boolean {
  if (press.button !== 0 || press.pointerType !== "mouse") {
    return false;
  }
  if (!(press.target instanceof Element)) {
    return false;
  }
  const ignore = options.cardSelector
    ? `${DRAG_TO_PAN_IGNORE_SELECTOR},${options.cardSelector}`
    : DRAG_TO_PAN_IGNORE_SELECTOR;
  if (press.target.closest(ignore)) {
    return false;
  }
  return !isScrollbarPress(press.target, press.offsetX, press.offsetY);
}

/** scrollLeft for a pointer that moved from startX to x. */
export function panScrollLeft(
  startScrollLeft: number,
  startX: number,
  x: number,
): number {
  return Math.max(0, startScrollLeft - (x - startX));
}

export function useDragToPan(
  ref: RefObject<HTMLElement | null>,
  { enabled = true, cardSelector }: { enabled?: boolean; cardSelector?: string } = {},
) {
  useEffect(() => {
    const area = ref.current;
    if (!area || !enabled) {
      return;
    }

    area.classList.add("can-pan");
    let pointerId: number | null = null;
    let startX = 0;
    let startScrollLeft = 0;
    let panning = false;
    let suppressClick = false;

    const finish = () => {
      if (pointerId !== null && area.hasPointerCapture?.(pointerId)) {
        area.releasePointerCapture(pointerId);
      }
      pointerId = null;
      suppressClick = panning;
      panning = false;
      area.classList.remove("is-panning");
    };

    const onPointerDown = (event: PointerEvent) => {
      suppressClick = false;
      if (!shouldStartPan(event, { cardSelector })) {
        return;
      }
      pointerId = event.pointerId;
      startX = event.clientX;
      startScrollLeft = area.scrollLeft;
      panning = false;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) {
        return;
      }
      if (!panning) {
        if (Math.abs(event.clientX - startX) < DRAG_TO_PAN_THRESHOLD) {
          return;
        }
        panning = true;
        area.classList.add("is-panning");
        try {
          area.setPointerCapture(event.pointerId);
        } catch {
          // Capture is best effort (unsupported or pointer already gone).
        }
      }
      event.preventDefault();
      area.scrollLeft = panScrollLeft(startScrollLeft, startX, event.clientX);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (pointerId === event.pointerId) {
        finish();
      }
    };

    // A pan that ends over a card must not also open it.
    const onClickCapture = (event: MouseEvent) => {
      if (suppressClick) {
        suppressClick = false;
        event.preventDefault();
        event.stopPropagation();
      }
    };

    area.addEventListener("pointerdown", onPointerDown);
    area.addEventListener("pointermove", onPointerMove);
    area.addEventListener("pointerup", onPointerUp);
    area.addEventListener("pointercancel", onPointerUp);
    area.addEventListener("click", onClickCapture, true);

    return () => {
      area.classList.remove("can-pan", "is-panning");
      area.removeEventListener("pointerdown", onPointerDown);
      area.removeEventListener("pointermove", onPointerMove);
      area.removeEventListener("pointerup", onPointerUp);
      area.removeEventListener("pointercancel", onPointerUp);
      area.removeEventListener("click", onClickCapture, true);
    };
  }, [ref, enabled, cardSelector]);
}
