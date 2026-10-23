"use client";

import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";

export const presentationModeStorageKey = "wpptrack-presentation-mode";
export const presentationModeEvent = "wpptrack:presentation-mode";

function presentationModeFromDocument(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.dataset.presentationMode === "active"
  );
}

export function setPresentationMode(active: boolean) {
  document.documentElement.dataset.presentationMode = active
    ? "active"
    : "inactive";

  try {
    window.localStorage.setItem(presentationModeStorageKey, String(active));
  } catch {
    // The visual mode still works when storage is unavailable.
  }

  window.dispatchEvent(new CustomEvent(presentationModeEvent));
}

export function usePresentationMode(): boolean {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const syncMode = () => setActive(presentationModeFromDocument());

    syncMode();
    window.addEventListener(presentationModeEvent, syncMode);
    window.addEventListener("storage", syncMode);

    return () => {
      window.removeEventListener(presentationModeEvent, syncMode);
      window.removeEventListener("storage", syncMode);
    };
  }, []);

  return active;
}

export function PresentationModeToggle() {
  const active = usePresentationMode();

  return (
    <button
      aria-label={active ? "Exibir dados reais" : "Ocultar dados sensíveis"}
      aria-pressed={active}
      className={`presentation-mode-toggle${active ? " active" : ""}`}
      onClick={() => setPresentationMode(!active)}
      title={active ? "Exibir dados reais" : "Ocultar dados sensíveis"}
      type="button"
    >
      {active ? (
        <Eye aria-hidden="true" size={16} />
      ) : (
        <EyeOff aria-hidden="true" size={16} />
      )}
      <span className="presentation-mode-label">
        {active ? "Exibir dados" : "Ocultar dados"}
      </span>
    </button>
  );
}
