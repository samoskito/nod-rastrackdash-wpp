"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { switchActiveWorkspace } from "../app/actions/workspaces";

const OPERATIONAL_AREA_PATH = "/overview";

/**
 * Lets a platform admin jump from the client list straight into a
 * workspace's operational area. Reuses `switchActiveWorkspace` with the
 * `"backoffice"` source (same call the back office workspace selector
 * makes), so authorization and the anti-IDOR check stay server-side and the
 * resulting session keeps the `platform_support` access mode. No new
 * endpoint is introduced here.
 */
export function BackofficeClientsEnterWorkspaceButton({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string;
  workspaceName: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [hasError, setHasError] = useState(false);

  const handleClick = () => {
    if (isPending) {
      return;
    }

    setHasError(false);
    startTransition(async () => {
      const result = await switchActiveWorkspace(workspaceId, "backoffice");

      if (!result.ok) {
        setHasError(true);
        return;
      }

      router.push(OPERATIONAL_AREA_PATH);
    });
  };

  return (
    <div className="client-enter-workspace">
      <button
        className="button ghost compact-button"
        type="button"
        aria-busy={isPending}
        aria-label={`Entrar no workspace ${workspaceName}`}
        disabled={isPending}
        onClick={handleClick}
      >
        {isPending ? "Entrando..." : "Entrar no workspace"}
      </button>
      {hasError ? (
        <p className="status-chip bad" role="alert">
          Não foi possível entrar no workspace. Tente novamente.
        </p>
      ) : null}
    </div>
  );
}
