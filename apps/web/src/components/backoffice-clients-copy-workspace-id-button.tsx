"use client";

import { useState } from "react";

export function BackofficeClientsCopyWorkspaceIdButton({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string;
  workspaceName: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(workspaceId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 4_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      aria-label={`Copiar ID do workspace ${workspaceName}`}
      className="button ghost compact-button workspace-id-copy-button"
      onClick={handleCopy}
      type="button"
    >
      {copied ? "ID copiado" : "Copiar ID"}
    </button>
  );
}
