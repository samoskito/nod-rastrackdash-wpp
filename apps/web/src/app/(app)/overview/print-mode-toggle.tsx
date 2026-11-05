"use client";

import { Camera, X } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * "Modo print": hides the menu and the support/data bars so the Visao geral
 * fills the screen for a clean screenshot. Esc or the same button leaves it.
 * Nothing is saved; reloading the page always starts in the normal mode.
 */
export function PrintModeToggle() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    if (active) {
      root.dataset.printMode = "active";
    } else {
      delete root.dataset.printMode;
    }
    return () => {
      delete root.dataset.printMode;
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const leaveOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActive(false);
    };
    window.addEventListener("keydown", leaveOnEscape);
    return () => window.removeEventListener("keydown", leaveOnEscape);
  }, [active]);

  return (
    <button
      type="button"
      className="button ghost print-mode-toggle"
      aria-pressed={active}
      title={
        active
          ? "Voltar ao modo normal (Esc)"
          : "Esconde o menu e as barras para tirar um print limpo"
      }
      onClick={() => setActive((current) => !current)}
    >
      {active ? (
        <X aria-hidden="true" size={15} strokeWidth={2.2} />
      ) : (
        <Camera aria-hidden="true" size={15} strokeWidth={2.2} />
      )}
      {active ? "Sair do modo print" : "Modo print"}
    </button>
  );
}
