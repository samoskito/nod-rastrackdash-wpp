import { randomBytes, createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { Prisma, type WorkspaceInvite } from "@prisma/client";
import type {
  CurrentWorkspaceDto,
  WorkspaceInviteDto,
  WorkspaceInviteAcceptDto,
  WorkspaceInviteAcceptInputDto,
  WorkspaceInviteInspectionDto,
  WorkspaceInviteInputDto,
  WorkspaceInviteNewUserAcceptInputDto,
  WorkspaceListDto,
  WorkspaceMemberManagerUpdateInputDto,
  WorkspaceMemberDto,
  WorkspaceMemberRoleUpdateInputDto,
  WorkspacePermissionsDto,
  WorkspaceUpdateInputDto,
  WorkspaceRole,
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { PasswordService } from "../auth/password.service";
import {
  AuthService,
  type AuthRequestContext,
  type AuthSessionResult,
} from "../auth/auth.service";
import type { AuthenticatedUser } from "../auth/session.types";
import { EmailQueueService } from "../email/email-queue.service";
import {
  WorkspaceAccessPolicyService,
  type WorkspacePolicySubject,
} from "./workspace-access-policy.service";
import { WorkspaceContextService } from "./workspace-context.service";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { parseWebOrigin } from "../config/deployment-config";

const inviteTtlMs = 1000 * 60 * 60 * 24 * 7;
const actionableInviteStatuses = ["pending", "sent", "failed"] as const;

export type NewUserInviteAcceptanceResult = {
  accepted: WorkspaceInviteAcceptDto;
  session: AuthSessionResult;
};

@Injectable()
export class WorkspacesService {
  private readonly logger = new Logger(WorkspacesService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional()
    @Inject(PasswordService)
    private readonly passwordService: PasswordService = new PasswordService(),
    @Optional()
    @Inject(WorkspaceContextService)
    private readonly workspaceContext: WorkspaceContextService = new WorkspaceContextService(),
    @Optional()
    @Inject(WorkspaceAccessPolicyService)
    private readonly accessPolicy: WorkspaceAccessPolicyService = new WorkspaceAccessPolicyService(),
    @Optional()
    @Inject(AuthService)
    private readonly authService?: AuthService,
    @Optional()
    @Inject(EmailQueueService)
    private readonly emailQueue?: EmailQueueService,
    @Optional()
    @Inject(RUNTIME_ENV)
    private readonly env: RuntimeEnv = process.env,
  ) {}

  getPermissions(
    role: WorkspaceRole,
    canManageMembers = false,
  ): WorkspacePermissionsDto {
    return this.workspaceContext.getPermissions(role, canManageMembers);
  }

  listAvailableWorkspaces(authenticated: AuthenticatedUser): WorkspaceListDto {
    return this.workspaceContext.listMemberships(authenticated);
  }

  getCurrentWorkspace(authenticated: AuthenticatedUser): CurrentWorkspaceDto {
    return this.workspaceContext.getCurrentWorkspace(authenticated);
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMemberDto[]> {
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: {
        user: true,
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    return members.map((member) => ({
      id: member.id,
      userId: member.userId,
      email: member.user.email,
      name: member.user.name,
      role: member.role,
      canManageMembers: member.canManageMembers,
      joinedAt: member.createdAt.toISOString(),
    }));
  }

  async listInvites(workspaceId: string): Promise<WorkspaceInviteDto[]> {
    await this.prisma.workspaceInvite.updateMany({
      where: {
        workspaceId,
        status: { in: [...actionableInviteStatuses] },
        expiresAt: { lte: new Date() },
      },
      data: { status: "expired" },
    });
    const invites = await this.prisma.workspaceInvite.findMany({
      where: { workspaceId },
      orderBy: {
        createdAt: "desc",
      },
    });

    return invites.flatMap((invite) =>
      this.isInvitableRole(invite.role) ? [this.toInviteDto(invite)] : [],
    );
  }

  async updateMemberRole(
    authenticated: AuthenticatedUser,
    memberId: string,
    input: WorkspaceMemberRoleUpdateInputDto,
  ): Promise<WorkspaceMemberDto> {
    const { actor, actorType, workspace } =
      this.requireTeamManager(authenticated);
    const target = await this.findWorkspaceMember(workspace.id, memberId);

    if (
      !this.accessPolicy.canManageMember(
        actor,
        target,
        target.userId === authenticated.user.id,
      )
    ) {
      throw new ForbiddenException("Sem permissao para alterar este membro");
    }

    const updated = await this.prisma.workspaceMember.update({
      where: { id: target.id },
      data: {
        role: input.role,
        canManageMembers:
          input.role === "admin" ? target.canManageMembers : false,
      },
      include: { user: true },
    });
    await this.recordWorkspaceAudit({
      workspaceId: workspace.id,
      actorUserId: authenticated.user.id,
      actorType,
      action: "workspace.member_role_updated",
      targetType: "WorkspaceMember",
      targetId: target.id,
      resultStatus: "success",
      beforeSummary: {
        role: target.role,
        canManageMembers: target.canManageMembers,
      } as Prisma.InputJsonValue,
      afterSummary: {
        role: updated.role,
        canManageMembers: updated.canManageMembers,
      } as Prisma.InputJsonValue,
    });

    return this.toWorkspaceMemberDto(updated);
  }

  async updateMemberManagerCapability(
    authenticated: AuthenticatedUser,
    memberId: string,
    input: WorkspaceMemberManagerUpdateInputDto,
  ): Promise<WorkspaceMemberDto> {
    const { actor, actorType, workspace } =
      this.requireTeamManager(authenticated);

    if (actor.role !== "owner") {
      throw new ForbiddenException(
        "Somente o owner pode delegar a gestao da equipe",
      );
    }

    const target = await this.findWorkspaceMember(workspace.id, memberId);

    if (target.role !== "admin") {
      throw new BadRequestException(
        "A gestao da equipe so pode ser delegada a administradores",
      );
    }

    const updated = await this.prisma.workspaceMember.update({
      where: { id: target.id },
      data: { canManageMembers: input.canManageMembers },
      include: { user: true },
    });
    await this.recordWorkspaceAudit({
      workspaceId: workspace.id,
      actorUserId: authenticated.user.id,
      actorType,
      action: "workspace.member_manager_updated",
      targetType: "WorkspaceMember",
      targetId: target.id,
      resultStatus: "success",
      beforeSummary: {
        role: target.role,
        canManageMembers: target.canManageMembers,
      } as Prisma.InputJsonValue,
      afterSummary: {
        role: updated.role,
        canManageMembers: updated.canManageMembers,
      } as Prisma.InputJsonValue,
    });

    return this.toWorkspaceMemberDto(updated);
  }

  async removeMember(
    authenticated: AuthenticatedUser,
    memberId: string,
  ): Promise<{ memberId: string; status: "removed" }> {
    const { actor, actorType, workspace } =
      this.requireTeamManager(authenticated);
    const target = await this.findWorkspaceMember(workspace.id, memberId);

    if (
      !this.accessPolicy.canManageMember(
        actor,
        target,
        target.userId === authenticated.user.id,
      )
    ) {
      throw new ForbiddenException("Sem permissao para remover este membro");
    }

    const revokedAt = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.workspaceMember.delete({
        where: { id: target.id },
      });
      await tx.authSession.updateMany({
        where: {
          userId: target.userId,
          activeWorkspaceId: workspace.id,
          revokedAt: null,
        },
        data: { revokedAt },
      });
      await tx.user.updateMany({
        where: {
          id: target.userId,
          lastWorkspaceId: workspace.id,
        },
        data: { lastWorkspaceId: null },
      });
    });
    await this.recordWorkspaceAudit({
      workspaceId: workspace.id,
      actorUserId: authenticated.user.id,
      actorType,
      action: "workspace.member_removed",
      targetType: "WorkspaceMember",
      targetId: target.id,
      resultStatus: "success",
      beforeSummary: {
        userId: target.userId,
        role: target.role,
        canManageMembers: target.canManageMembers,
      } as Prisma.InputJsonValue,
      afterSummary: {
        status: "removed",
        activeWorkspaceSessionsRevokedAt: revokedAt.toISOString(),
      } as Prisma.InputJsonValue,
    });

    return { memberId: target.id, status: "removed" };
  }

  async updateCurrentWorkspace(
    authenticated: AuthenticatedUser,
    input: WorkspaceUpdateInputDto,
  ): Promise<CurrentWorkspaceDto> {
    const workspace = this.getCurrentWorkspace(authenticated);

    if (!workspace.permissions.canManageWorkspaceSettings) {
      throw new ForbiddenException("Sem permissao para atualizar workspace");
    }

    const updated = await this.prisma.workspace.update({
      where: { id: workspace.id },
      data: {
        name: input.name,
      },
      select: {
        id: true,
        name: true,
        slug: true,
      },
    });
    await this.recordWorkspaceAudit({
      workspaceId: workspace.id,
      actorUserId: authenticated.user.id,
      action: "workspace.profile_updated",
      targetType: "Workspace",
      targetId: workspace.id,
      resultStatus: "success",
      beforeSummary: {
        name: workspace.name,
        slug: workspace.slug,
      } as Prisma.InputJsonValue,
      afterSummary: {
        name: updated.name,
        slug: updated.slug,
      } as Prisma.InputJsonValue,
    });

    return {
      ...updated,
      role: workspace.role,
      operationalStatus: workspace.operationalStatus,
      permissions: workspace.permissions,
      accessMode: workspace.accessMode,
      platformRole: workspace.platformRole,
    };
  }

  async createInvite(
    authenticated: AuthenticatedUser,
    input: WorkspaceInviteInputDto,
  ): Promise<WorkspaceInviteDto> {
    const { actorType, workspace } = this.requireTeamManager(authenticated);

    const expiresAt = new Date(Date.now() + inviteTtlMs);
    const acceptToken = randomBytes(32).toString("hex");
    const invite = await this.prisma.workspaceInvite.create({
      data: {
        workspaceId: workspace.id,
        email: input.email,
        role: input.role,
        tokenHash: this.hashInviteToken(acceptToken),
        expiresAt,
      },
    });
    await this.recordWorkspaceAudit({
      workspaceId: workspace.id,
      actorUserId: authenticated.user.id,
      actorType,
      action: "workspace.invite_created",
      targetType: "WorkspaceInvite",
      targetId: invite.id,
      resultStatus: "pending",
      afterSummary: {
        invitedEmailHash: this.hashAuditValue(invite.email),
        role: invite.role,
        status: invite.status,
        expiresAt: invite.expiresAt.toISOString(),
      } as Prisma.InputJsonValue,
    });
    const deliverable = await this.queueWorkspaceInvitation({
      invite,
      token: acceptToken,
      workspaceName: workspace.name,
      inviterName: authenticated.user.name,
    });

    return this.toInviteDto(deliverable, acceptToken);
  }

  async resendInvite(
    authenticated: AuthenticatedUser,
    inviteId: string,
  ): Promise<WorkspaceInviteDto> {
    const { actorType, workspace } = this.requireTeamManager(authenticated);
    const invite = await this.findWorkspaceInvite(workspace.id, inviteId);

    if (invite.status === "accepted") {
      throw new BadRequestException("Convite ja foi aceito");
    }

    const acceptToken = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + inviteTtlMs);
    const updated = await this.prisma.workspaceInvite.update({
      where: { id: invite.id },
      data: {
        tokenHash: this.hashInviteToken(acceptToken),
        status: "pending",
        expiresAt,
        acceptedAt: null,
      },
    });
    await this.recordWorkspaceAudit({
      workspaceId: workspace.id,
      actorUserId: authenticated.user.id,
      actorType,
      action: "workspace.invite_resent",
      targetType: "WorkspaceInvite",
      targetId: invite.id,
      resultStatus: "pending",
      beforeSummary: {
        invitedEmailHash: this.hashAuditValue(invite.email),
        role: invite.role,
        status: invite.status,
        expiresAt: invite.expiresAt.toISOString(),
      } as Prisma.InputJsonValue,
      afterSummary: {
        invitedEmailHash: this.hashAuditValue(updated.email),
        role: updated.role,
        status: updated.status,
        expiresAt: updated.expiresAt.toISOString(),
      } as Prisma.InputJsonValue,
    });
    const deliverable = await this.queueWorkspaceInvitation({
      invite: updated,
      token: acceptToken,
      workspaceName: workspace.name,
      inviterName: authenticated.user.name,
    });

    return this.toInviteDto(deliverable, acceptToken);
  }

  async revokeInvite(
    authenticated: AuthenticatedUser,
    inviteId: string,
  ): Promise<WorkspaceInviteDto> {
    const { actorType, workspace } = this.requireTeamManager(authenticated);
    const invite = await this.findWorkspaceInvite(workspace.id, inviteId);

    if (invite.status === "accepted") {
      throw new BadRequestException("Convite ja foi aceito");
    }

    const updated = await this.prisma.workspaceInvite.update({
      where: { id: invite.id },
      data: { status: "revoked" },
    });
    await this.recordWorkspaceAudit({
      workspaceId: workspace.id,
      actorUserId: authenticated.user.id,
      actorType,
      action: "workspace.invite_revoked",
      targetType: "WorkspaceInvite",
      targetId: invite.id,
      resultStatus: "revoked",
      beforeSummary: {
        invitedEmailHash: this.hashAuditValue(invite.email),
        role: invite.role,
        status: invite.status,
      } as Prisma.InputJsonValue,
      afterSummary: {
        invitedEmailHash: this.hashAuditValue(updated.email),
        role: updated.role,
        status: updated.status,
      } as Prisma.InputJsonValue,
    });

    return this.toInviteDto(updated);
  }

  async inspectInvite(
    input: WorkspaceInviteAcceptInputDto,
  ): Promise<WorkspaceInviteInspectionDto> {
    const tokenHash = this.hashInviteToken(input.token);
    const invite = await this.prisma.workspaceInvite.findUnique({
      where: { tokenHash },
      include: {
        workspace: {
          select: { name: true },
        },
      },
    });

    if (!invite || !this.isInvitableRole(invite.role)) {
      return { state: "invalid" };
    }

    if (!this.isActionableInviteStatus(invite.status)) {
      return { state: "invalid" };
    }

    if (invite.expiresAt.getTime() <= Date.now()) {
      await this.expireInvite(invite);
      return { state: "invalid" };
    }

    const user = await this.prisma.user.findUnique({
      where: { email: this.normalizeEmail(invite.email) },
      select: { passwordHash: true },
    });

    return {
      state: "valid",
      workspaceName: invite.workspace.name,
      emailHint: this.maskEmail(invite.email),
      role: invite.role,
      accountMode: user?.passwordHash ? "login" : "create",
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  async acceptInvite(
    authenticated: AuthenticatedUser,
    input: WorkspaceInviteAcceptInputDto,
    refreshToken: string,
  ): Promise<WorkspaceInviteAcceptDto> {
    const tokenHash = this.hashInviteToken(input.token);
    const invite = await this.prisma.workspaceInvite.findUnique({
      where: { tokenHash },
    });

    if (
      !invite ||
      !this.isInvitableRole(invite.role) ||
      !this.isActionableInviteStatus(invite.status)
    ) {
      throw this.invalidInvite();
    }

    if (invite.expiresAt.getTime() <= Date.now()) {
      await this.expireInvite(invite, authenticated.user.id);
      throw this.invalidInvite();
    }

    if (
      this.normalizeEmail(invite.email) !==
      this.normalizeEmail(authenticated.user.email)
    ) {
      throw this.invalidInvite();
    }

    const inviteRole = this.requireInvitableRole(invite.role);
    const authService = this.requireAuthService();
    const acceptedAt = new Date();

    let result: WorkspaceInviteAcceptDto;

    try {
      result = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.workspaceInvite.updateMany({
          where: {
            id: invite.id,
            tokenHash,
            status: { in: [...actionableInviteStatuses] },
            expiresAt: { gt: acceptedAt },
          },
          data: {
            status: "accepted",
            acceptedAt,
          },
        });

        if (claimed.count !== 1) {
          throw this.invalidInvite();
        }

        const member = await tx.workspaceMember.create({
          data: {
            workspaceId: invite.workspaceId,
            userId: authenticated.user.id,
            role: inviteRole,
          },
        });
        await authService.activateWorkspaceSessionInTransaction(
          tx,
          refreshToken,
          authenticated.user.id,
          invite.workspaceId,
        );

        return {
          workspaceId: invite.workspaceId,
          memberId: member.id,
          role: inviteRole,
          status: "accepted" as const,
        };
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        throw this.invalidInvite();
      }

      throw error;
    }

    await this.recordInviteAcceptedAudit({
      invite,
      userId: authenticated.user.id,
      result,
    });

    return result;
  }

  async acceptInviteForNewUser(
    input: WorkspaceInviteNewUserAcceptInputDto,
    context: AuthRequestContext = {},
  ): Promise<NewUserInviteAcceptanceResult> {
    const tokenHash = this.hashInviteToken(input.token);
    const invite = await this.prisma.workspaceInvite.findUnique({
      where: { tokenHash },
    });

    if (
      !invite ||
      !this.isInvitableRole(invite.role) ||
      !this.isActionableInviteStatus(invite.status)
    ) {
      throw this.invalidInvite();
    }

    if (invite.expiresAt.getTime() <= Date.now()) {
      await this.expireInvite(invite);
      throw this.invalidInvite();
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email: this.normalizeEmail(invite.email) },
      select: { id: true, passwordHash: true },
    });

    if (existingUser?.passwordHash) {
      throw this.invalidInvite();
    }

    const passwordHash = await this.passwordService.hash(input.password);
    const authService = this.requireAuthService();
    const acceptedAt = new Date();

    let transactionResult: NewUserInviteAcceptanceResult & { userId: string };

    try {
      transactionResult = await this.prisma.$transaction(async (tx) => {
        const currentInvite = await tx.workspaceInvite.findUnique({
          where: { tokenHash },
        });

        if (
          !currentInvite ||
          !this.isInvitableRole(currentInvite.role) ||
          !this.isActionableInviteStatus(currentInvite.status) ||
          currentInvite.expiresAt.getTime() <= acceptedAt.getTime()
        ) {
          throw this.invalidInvite();
        }

        const claimed = await tx.workspaceInvite.updateMany({
          where: {
            id: currentInvite.id,
            tokenHash,
            status: { in: [...actionableInviteStatuses] },
            expiresAt: { gt: acceptedAt },
          },
          data: {
            status: "accepted",
            acceptedAt,
          },
        });

        if (claimed.count !== 1) {
          throw this.invalidInvite();
        }

        const email = this.normalizeEmail(currentInvite.email);
        const currentUser = await tx.user.findUnique({
          where: { email },
          select: { id: true, passwordHash: true },
        });

        if (currentUser?.passwordHash) {
          throw this.invalidInvite();
        }

        const user = currentUser
          ? await tx.user.update({
              where: { id: currentUser.id },
              data: {
                name: input.name,
                passwordHash,
                authProvider: "email",
                emailVerifiedAt: acceptedAt,
              },
            })
          : await tx.user.create({
              data: {
                email,
                name: input.name,
                passwordHash,
                authProvider: "email",
                emailVerifiedAt: acceptedAt,
              },
            });
        const member = await tx.workspaceMember.create({
          data: {
            workspaceId: currentInvite.workspaceId,
            userId: user.id,
            role: currentInvite.role,
          },
        });
        const session = await authService.createSessionForUser(
          user.id,
          context,
          {
            activeWorkspaceId: currentInvite.workspaceId,
            transaction: tx,
          },
        );

        return {
          userId: user.id,
          accepted: {
            workspaceId: currentInvite.workspaceId,
            memberId: member.id,
            role: currentInvite.role,
            status: "accepted" as const,
          },
          session,
        };
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        throw this.invalidInvite();
      }

      throw error;
    }

    await this.recordInviteAcceptedAudit({
      invite,
      userId: transactionResult.userId,
      result: transactionResult.accepted,
    });

    return {
      accepted: transactionResult.accepted,
      session: transactionResult.session,
    };
  }

  private async queueWorkspaceInvitation(input: {
    invite: WorkspaceInvite;
    token: string;
    workspaceName: string;
    inviterName: string | null;
  }): Promise<WorkspaceInvite> {
    const role = this.requireInvitableRole(input.invite.role);

    if (!this.emailQueue?.isEnabled()) {
      return this.markInviteDeliveryFailed(input.invite);
    }

    try {
      await this.emailQueue.enqueue({
        workspaceId: input.invite.workspaceId,
        action: {
          type: "WorkspaceInvite",
          id: input.invite.id,
          version: input.invite.expiresAt.toISOString(),
        },
        envelope: {
          to: { address: input.invite.email },
          template: "workspace_invitation",
          data: {
            workspaceName: input.workspaceName,
            inviterName: input.inviterName ?? undefined,
            roleLabel: role === "admin" ? "Administrador" : "Analista",
            token: input.token,
            expiresAt: input.invite.expiresAt.toISOString(),
          },
        },
      });

      return input.invite;
    } catch {
      return this.markInviteDeliveryFailed(input.invite);
    }
  }

  private async markInviteDeliveryFailed(
    invite: WorkspaceInvite,
  ): Promise<WorkspaceInvite> {
    await this.prisma.workspaceInvite.updateMany({
      where: {
        id: invite.id,
        tokenHash: invite.tokenHash,
        status: "pending",
      },
      data: { status: "failed" },
    });
    const updated =
      (await this.prisma.workspaceInvite.findUnique({
        where: { id: invite.id },
      })) ?? invite;

    await this.recordWorkspaceAudit({
      workspaceId: invite.workspaceId,
      actorUserId: null,
      actorType: "system",
      action: "workspace.invite_delivery_failed",
      targetType: "WorkspaceInvite",
      targetId: invite.id,
      resultStatus: "failed",
      afterSummary: {
        invitedEmailHash: this.hashAuditValue(invite.email),
        status: updated.status,
      } as Prisma.InputJsonValue,
    });

    return updated;
  }

  private async expireInvite(
    invite: WorkspaceInvite,
    actorUserId: string | null = null,
  ): Promise<void> {
    const expired = await this.prisma.workspaceInvite.updateMany({
      where: {
        id: invite.id,
        status: { in: [...actionableInviteStatuses] },
        expiresAt: { lte: new Date() },
      },
      data: { status: "expired" },
    });

    if (expired.count === 0) {
      return;
    }

    await this.recordWorkspaceAudit({
      workspaceId: invite.workspaceId,
      actorUserId,
      actorType: actorUserId ? "user" : "system",
      action: "workspace.invite_expired",
      targetType: "WorkspaceInvite",
      targetId: invite.id,
      resultStatus: "expired",
      beforeSummary: {
        status: invite.status,
        invitedEmailHash: this.hashAuditValue(invite.email),
        role: invite.role,
        expiresAt: invite.expiresAt.toISOString(),
      } as Prisma.InputJsonValue,
      afterSummary: {
        status: "expired",
      } as Prisma.InputJsonValue,
    });
  }

  private async recordInviteAcceptedAudit(input: {
    invite: WorkspaceInvite;
    userId: string;
    result: WorkspaceInviteAcceptDto;
  }): Promise<void> {
    await this.recordWorkspaceAudit({
      workspaceId: input.invite.workspaceId,
      actorUserId: input.userId,
      action: "workspace.invite_accepted",
      targetType: "WorkspaceInvite",
      targetId: input.invite.id,
      resultStatus: "accepted",
      beforeSummary: {
        status: input.invite.status,
        invitedEmailHash: this.hashAuditValue(input.invite.email),
        role: input.invite.role,
      } as Prisma.InputJsonValue,
      afterSummary: {
        status: "accepted",
        memberId: input.result.memberId,
        userId: input.userId,
        role: input.result.role,
      } as Prisma.InputJsonValue,
    });
  }

  private isActionableInviteStatus(
    status: string,
  ): status is (typeof actionableInviteStatuses)[number] {
    return actionableInviteStatuses.some((candidate) => candidate === status);
  }

  private isInvitableRole(role: string): role is "admin" | "member" {
    return role === "admin" || role === "member";
  }

  private requireInvitableRole(role: string): "admin" | "member" {
    if (!this.isInvitableRole(role)) {
      throw this.invalidInvite();
    }

    return role;
  }

  private requireAuthService(): AuthService {
    if (!this.authService) {
      throw new Error("AuthService is required for account onboarding");
    }

    return this.authService;
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private maskEmail(email: string): string {
    const normalized = this.normalizeEmail(email);
    const [localPart, domain] = normalized.split("@");

    if (!localPart || !domain) {
      return "email protegido";
    }

    const visible = localPart.slice(0, Math.min(2, localPart.length));
    return `${visible}${"*".repeat(Math.max(2, localPart.length - visible.length))}@${domain}`;
  }

  private invalidInvite(): NotFoundException {
    return new NotFoundException("Convite invalido ou expirado");
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    );
  }

  private requireTeamManager(authenticated: AuthenticatedUser): {
    actor: WorkspacePolicySubject;
    actorType: "platform_owner" | "user";
    workspace: CurrentWorkspaceDto;
  } {
    const workspace = this.getCurrentWorkspace(authenticated);
    const isPlatformOwnerSupport =
      workspace.accessMode === "platform_support" &&
      authenticated.user.platformRole === "platform_owner";

    if (isPlatformOwnerSupport) {
      return {
        actor: {
          role: "owner",
          canManageMembers: true,
        },
        actorType: "platform_owner",
        workspace,
      };
    }

    const membership = authenticated.workspaces.find(
      (candidate) => candidate.id === workspace.id,
    );

    if (
      workspace.accessMode !== "member" ||
      !membership ||
      !workspace.permissions.canManageMembers
    ) {
      throw new ForbiddenException("Sem permissao para gerenciar membros");
    }

    return {
      actor: {
        role: membership.role,
        canManageMembers: membership.canManageMembers === true,
      },
      actorType: "user",
      workspace,
    };
  }

  private async findWorkspaceMember(workspaceId: string, memberId: string) {
    const member = await this.prisma.workspaceMember.findFirst({
      where: {
        id: memberId,
        workspaceId,
      },
      include: { user: true },
    });

    if (!member) {
      throw new NotFoundException("Membro nao encontrado");
    }

    return member;
  }

  private async findWorkspaceInvite(workspaceId: string, inviteId: string) {
    const invite = await this.prisma.workspaceInvite.findFirst({
      where: {
        id: inviteId,
        workspaceId,
      },
    });

    if (!invite) {
      throw new NotFoundException("Convite nao encontrado");
    }

    return invite;
  }

  private toWorkspaceMemberDto(member: {
    id: string;
    userId: string;
    role: WorkspaceRole;
    canManageMembers: boolean;
    createdAt: Date;
    user: {
      email: string;
      name: string | null;
    };
  }): WorkspaceMemberDto {
    return {
      id: member.id,
      userId: member.userId,
      email: member.user.email,
      name: member.user.name,
      role: member.role,
      canManageMembers: member.canManageMembers,
      joinedAt: member.createdAt.toISOString(),
    };
  }

  private getWebOrigin(): string {
    return parseWebOrigin(this.env);
  }

  private buildWebUrl(path: string, token: string): string {
    const url = new URL(path, `${this.getWebOrigin()}/`);
    url.searchParams.set("token", token);
    return url.toString();
  }

  private toInviteDto(
    invite: {
      id: string;
      email: string;
      role: string;
      status: WorkspaceInviteDto["status"] | string;
      expiresAt: Date;
    },
    acceptToken?: string,
  ): WorkspaceInviteDto {
    return {
      id: invite.id,
      email: invite.email,
      role: this.requireInvitableRole(invite.role),
      status: invite.status as WorkspaceInviteDto["status"],
      expiresAt: invite.expiresAt.toISOString(),
      ...(acceptToken
        ? { acceptUrl: this.buildWebUrl("/invite/accept", acceptToken) }
        : {}),
    };
  }

  private hashInviteToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private hashAuditValue(value: string): string {
    return createHash("sha256")
      .update(value.trim().toLowerCase())
      .digest("hex");
  }

  private async recordWorkspaceAudit(input: {
    workspaceId: string;
    actorUserId: string | null;
    action: string;
    targetType: string;
    targetId: string;
    resultStatus: string;
    actorType?: string;
    beforeSummary?: Prisma.InputJsonValue;
    afterSummary?: Prisma.InputJsonValue;
  }): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          actorType: input.actorType ?? "user",
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId,
          reason: null,
          sourceIp: null,
          resultStatus: input.resultStatus,
          beforeSummary: input.beforeSummary,
          afterSummary: input.afterSummary,
        },
      });
    } catch {
      this.logger.error(
        `Falha ao registrar auditoria de workspace; workspaceId=${input.workspaceId} action=${input.action} targetId=${input.targetId}`,
      );
    }
  }
}
