"use client";

import { X } from "lucide-react";
import { useEffect } from "react";

export type ToastMessage = {
  id: number;
  title: string;
  detail?: string | null;
  tone: "ok" | "neutral" | "warn";
};

/**
 * Small transient notice (bottom of the screen), announced politely to
 * screen readers. Disappears by itself after `durationMs`.
 */
export function Toast({
  toast,
  onDismiss,
  durationMs = 4500,
}: {
  toast: ToastMessage | null;
  onDismiss: () => void;
  durationMs?: number;
}) {
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(onDismiss, durationMs);
    return () => window.clearTimeout(timer);
  }, [toast, onDismiss, durationMs]);

  return (
    <div className="app-toast-region" role="status" aria-live="polite">
      {toast ? (
        <div className={`app-toast ${toast.tone}`} key={toast.id}>
          <span className="app-toast-dot" aria-hidden="true" />
          <span className="app-toast-text">
            <strong>{toast.title}</strong>
            {toast.detail ? <span>{toast.detail}</span> : null}
          </span>
          <button
            className="app-toast-close"
            type="button"
            onClick={onDismiss}
            aria-label="Fechar aviso"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
