"use client";

import type { WorkspaceListEntryDto } from "@wpptrack/shared";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type ChangeEvent } from "react";
import { switchActiveWorkspace } from "../app/actions/workspaces";

/**
 * Back office workspace picker. Reuses the same switch/revalidate mechanism
 * as the app shell's workspace selector (`switchActiveWorkspace` +
 * `router.refresh()`) instead of a parallel workspace-selection path — the
 * API still revalidates the requested workspace against the caller's real
 * memberships, so this component only ever offers IDs the server already
 * trusts.
 */
export function BackofficeWorkspaceSelector({
  workspaces,
  selectedWorkspaceId,
}: {
  workspaces: WorkspaceListEntryDto[];
  selectedWorkspaceId: string | null;
}) {
  const router = useRouter();
  const selectId = useId();
  const [isPending, startTransition] = useTransition();
  const [switchError, setSwitchError] = useState(false);

  if (workspaces.length === 0) {
    return null;
  }

  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const workspaceId = event.target.value;

    if (!workspaceId || workspaceId === selectedWorkspaceId || isPending) {
      return;
    }

    setSwitchError(false);
    startTransition(async () => {
      const result = await switchActiveWorkspace(workspaceId);

      if (!result.ok) {
        setSwitchError(true);
        return;
      }

      router.refresh();
    });
  };

  return (
    <section className="surface-panel">
      <div className="section-heading-row">
        <div>
          <span className="eyebrow">Contexto</span>
          <h2>Workspace</h2>
        </div>
      </div>

      <label className="operations-filter-field" htmlFor={selectId}>
        <span>
          {workspaces.length === 1
            ? "Workspace disponível"
            : `${workspaces.length} workspaces disponíveis`}
        </span>
        <select
          id={selectId}
          key={selectedWorkspaceId ?? "none"}
          aria-busy={isPending}
          defaultValue={selectedWorkspaceId ?? ""}
          disabled={isPending}
          onChange={handleChange}
        >
          <option disabled value="">
            Selecione um workspace
          </option>
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
      </label>

      {switchError ? (
        <p className="status-chip bad" role="alert">
          Não foi possível trocar de workspace. Tente novamente.
        </p>
      ) : null}
    </section>
  );
}
