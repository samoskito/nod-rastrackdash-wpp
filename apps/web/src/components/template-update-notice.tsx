"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { shortSha, TEMPLATE_UPDATE_GUIDE_URL } from "../lib/template-version-format";

const STORAGE_KEY_PREFIX = "rastrackdash:template-update-dismissed:v1:";

/**
 * One key per signed-in owner; the value pins the exact installed/latest pair
 * that was dismissed, so a new main revision (or a redeploy) brings the notice
 * back. localStorage is already per-origin, which keeps instances apart.
 */
export function templateUpdateDismissKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${userId}`;
}

export function templateUpdateDismissValue(
  deployedSha: string,
  latestMainSha: string,
): string {
  return `${deployedSha}:${latestMainSha}`;
}

function readDismissed(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeDismissed(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked/full: the notice still hides for this page view.
  }
}

type Visibility = "pending" | "visible" | "dismissed";

/**
 * Dismissible "update available" notice for the platform owner. Server and
 * first client render both output nothing (storage is unknown until mount),
 * so hydration is stable and a dismissed notice never flashes back in.
 */
export function TemplateUpdateNotice({
  deployedSha,
  latestMainSha,
  userId,
}: {
  deployedSha: string;
  latestMainSha: string;
  userId: string;
}) {
  const [visibility, setVisibility] = useState<Visibility>("pending");
  const [justDismissed, setJustDismissed] = useState(false);
  const confirmationRef = useRef<HTMLParagraphElement>(null);
  const key = templateUpdateDismissKey(userId);
  const value = templateUpdateDismissValue(deployedSha, latestMainSha);

  useEffect(() => {
    setVisibility(readDismissed(key) === value ? "dismissed" : "visible");
  }, [key, value]);

  useEffect(() => {
    if (justDismissed) {
      confirmationRef.current?.focus();
    }
  }, [justDismissed]);

  if (visibility === "pending") {
    return null;
  }

  if (visibility === "dismissed") {
    return justDismissed ? (
      <p className="sr-only" ref={confirmationRef} role="status" tabIndex={-1}>
        Aviso de atualização dispensado até a próxima versão.
      </p>
    ) : null;
  }

  return (
    <div
      className="feedback-banner warn template-version-banner"
      role="status"
    >
      <div className="template-version-banner-copy">
        <strong>Há uma atualização disponível</strong>
        <span>
          Esta instância está na versão <code>{shortSha(deployedSha)}</code> e
          há uma versão mais recente do template.
        </span>
        <a href={TEMPLATE_UPDATE_GUIDE_URL} rel="noopener noreferrer" target="_blank">
          Ver guia de atualização
          <span className="sr-only"> (abre em nova aba)</span>
        </a>
      </div>
      <button
        aria-label="Dispensar aviso de atualização"
        className="template-version-dismiss"
        onClick={() => {
          writeDismissed(key, value);
          setJustDismissed(true);
          setVisibility("dismissed");
        }}
        type="button"
      >
        <X aria-hidden="true" size={16} strokeWidth={2} />
      </button>
    </div>
  );
}
