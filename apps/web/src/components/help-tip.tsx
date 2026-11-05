"use client";

import { Info } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * Small "i" button that holds an explanation. Hover or keyboard focus shows
 * it, a tap or click pins it open (phones have no hover), Esc or a click
 * outside closes it. Help text lives here instead of taking the top of the
 * page.
 */
export function HelpTip({
  children,
  label = "Ajuda",
  align = "start",
}: {
  children: ReactNode;
  /** Accessible name of the button, e.g. "Sobre os leads". */
  label?: string;
  /** Which edge of the button the bubble lines up with. */
  align?: "start" | "end";
}) {
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const tipId = useId();

  useEffect(() => {
    if (!pinned) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setPinned(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPinned(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [pinned]);

  return (
    <span
      ref={rootRef}
      className={`help-tip help-tip-${align}${pinned ? " is-open" : ""}`}
    >
      <button
        type="button"
        className="help-tip-button"
        aria-label={label}
        aria-describedby={tipId}
        aria-expanded={pinned}
        onClick={() => setPinned((open) => !open)}
      >
        <Info aria-hidden="true" size={14} strokeWidth={2.2} />
      </button>
      <span role="tooltip" id={tipId} className="help-tip-bubble">
        {children}
      </span>
    </span>
  );
}
