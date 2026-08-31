import type { BackofficeWorkspaceListDto } from "@wpptrack/shared";
import { formatDateTime } from "../lib/date-time";
import { BackofficeClientsEnterWorkspaceButton } from "./backoffice-clients-enter-workspace-button";
import { BackofficeClientsResponsibleCell } from "./backoffice-clients-responsible-cell";

const operationalStatusLabels: Record<string, string> = {
  active: "Ativo",
  blocked: "Bloqueado",
};

export function BackofficeClientsWorkspaceTable({
  workspaces,
}: {
  workspaces: BackofficeWorkspaceListDto;
}) {
  return (
    <div className="client-workspaces-table">
      <table>
        <thead>
          <tr>
            <th>Workspace</th>
            <th>Slug</th>
            <th>Status</th>
            <th>Responsável</th>
            <th>Criado em</th>
            <th>Acesso</th>
          </tr>
        </thead>
        <tbody>
          {workspaces.map((workspace) => (
            <tr key={workspace.id}>
              <td>
                <strong>{workspace.name}</strong>
              </td>
              <td>{workspace.slug}</td>
              <td>
                <span
                  className={`status-chip${workspace.operationalStatus === "blocked" ? " bad" : ""}`}
                >
                  {operationalStatusLabels[workspace.operationalStatus] ??
                    workspace.operationalStatus}
                </span>
              </td>
              <td>
                <BackofficeClientsResponsibleCell
                  responsible={workspace.responsible}
                  workspaceId={workspace.id}
                />
              </td>
              <td>{formatDateTime(workspace.createdAt)}</td>
              <td>
                <BackofficeClientsEnterWorkspaceButton
                  workspaceId={workspace.id}
                  workspaceName={workspace.name}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
