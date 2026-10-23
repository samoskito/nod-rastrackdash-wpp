import {
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import {
  type CurrentWorkspaceDto,
  type WorkspaceListDto,
  type WorkspacePermissionsDto,
  type WorkspaceRole
} from "@wpptrack/shared";
import type { AuthenticatedUser } from "../auth/session.types";
import { WorkspaceAccessPolicyService } from "./workspace-access-policy.service";

@Injectable()
export class WorkspaceContextService {
  constructor(
    private readonly accessPolicy: WorkspaceAccessPolicyService = new WorkspaceAccessPolicyService()
  ) {}

  getPermissions(
    role: WorkspaceRole,
    canManageMembers = false
  ): WorkspacePermissionsDto {
    return this.accessPolicy.getPermissions(role, canManageMembers);
  }

  listMemberships(authenticated: AuthenticatedUser): WorkspaceListDto {
    return authenticated.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      role: workspace.role,
      operationalStatus: workspace.operationalStatus,
      permissions: this.getPermissions(
        workspace.role,
        workspace.canManageMembers === true
      )
    }));
  }

  getCurrentWorkspace(authenticated: AuthenticatedUser): CurrentWorkspaceDto {
    const supportContext = authenticated.supportContext;

    if (supportContext) {
      return {
        id: supportContext.workspaceId,
        name: supportContext.workspaceName,
        slug: supportContext.workspaceSlug,
        role: "owner",
        operationalStatus: supportContext.operationalStatus ?? "active",
        permissions: this.getPermissions("owner"),
        accessMode: "platform_support",
        platformRole: authenticated.user.platformRole ?? null
      };
    }

    const activeWorkspaceId =
      authenticated.activeWorkspaceId ??
      (authenticated.workspaces.length === 1
        ? (authenticated.workspaces[0]?.id ?? null)
        : null);
    const workspace = authenticated.workspaces.find(
      (candidate) => candidate.id === activeWorkspaceId
    );

    if (!workspace) {
      throw new NotFoundException("Workspace não encontrado");
    }

    if (workspace.operationalStatus === "blocked") {
      throw new ForbiddenException("Workspace bloqueado operacionalmente");
    }

    return {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      role: workspace.role,
      operationalStatus: workspace.operationalStatus,
      permissions: this.getPermissions(
        workspace.role,
        workspace.canManageMembers === true
      ),
      accessMode: "member",
      platformRole: authenticated.user.platformRole ?? null
    };
  }
}
