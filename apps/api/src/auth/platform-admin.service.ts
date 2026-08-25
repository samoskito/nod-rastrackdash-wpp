import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import type { PlatformRole, Prisma } from "@prisma/client";
import {
  platformUserListSchema,
  platformUserProvisionInputSchema,
  platformUserProvisionResultSchema,
  platformUserRoleUpdateInputSchema,
  platformUserSchema,
  type PlatformUserProvisionInputDto,
  type PlatformUserRoleUpdateInputDto,
  type PlatformUserDto,
  type PlatformUserProvisionResultDto,
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { EmailQueueService } from "../email/email-queue.service";
import { AuthService } from "./auth.service";
import {
  acquirePlatformAdminLock,
  platformAdminTransactionOptions,
} from "./platform-admin-lock";

const platformOperatorInviteTtlMs = 1000 * 60 * 60 * 24 * 7;
const mutationRateLimitWindowMs = 1000 * 60 * 15;
const inviteRateLimit = 5;
const roleMutationRateLimit = 20;

export type PlatformAdminUser = {
  id: string;
  email: string;
  role: PlatformRole;
};

type PlatformUserRecord = {
  id: string;
  name: string | null;
  email: string;
  passwordHash: string | null;
  platformRole: PlatformRole;
  createdAt: Date;
};

type PlatformUserInvitationRecord = {
  user: PlatformUserRecord;
  activationTokenId: string;
  token: string;
  expiresAt: Date;
};

type MutationKind = "invite" | "role";

@Injectable()
export class PlatformAdminService {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(EmailQueueService)
    private readonly emailQueue?: EmailQueueService,
  ) {}

  async assertPlatformAdmin(refreshToken: string): Promise<PlatformAdminUser> {
    const authenticated = await this.authService.getSession(refreshToken);
    const role = authenticated.user.platformRole;

    if (role !== "platform_owner" && role !== "platform_operator") {
      throw new ForbiddenException(
        "Backoffice restrito aos administradores da plataforma",
      );
    }

    return {
      id: authenticated.user.id,
      email: this.normalizeEmail(authenticated.user.email),
      role,
    };
  }

  async assertPlatformOwner(refreshToken: string): Promise<PlatformAdminUser> {
    const admin = await this.assertPlatformAdmin(refreshToken);
    this.assertOwnerActor(admin);
    return admin;
  }

  async listPlatformUsers(): Promise<PlatformUserDto[]> {
    const users = await this.prisma.user.findMany({
      where: { platformRole: { not: null } },
      orderBy: [{ platformRole: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        name: true,
        email: true,
        passwordHash: true,
        platformRole: true,
        createdAt: true,
      },
    });

    return platformUserListSchema.parse(
      users.map((user) => this.toPlatformUser(user as PlatformUserRecord)),
    );
  }

  /**
   * Returns the same accepted response for newly-created, pending, and already
   * existing addresses. This prevents the endpoint from becoming an account
   * existence oracle, even for authenticated platform owners.
   */
  async invitePlatformOperator(
    rawInput: PlatformUserProvisionInputDto,
    actor: PlatformAdminUser,
  ): Promise<PlatformUserProvisionResultDto> {
    this.assertOwnerActor(actor);
    const input = this.parseProvisionInput(rawInput);
    this.assertInvitationDeliveryAvailable();

    const invitation = await this.withPlatformAdminLock(async (tx) => {
      await this.assertMutationRateLimit(tx, actor, "invite");
      const existing = await tx.user.findUnique({
        where: { email: input.email },
        select: {
          id: true,
          name: true,
          email: true,
          passwordHash: true,
          platformRole: true,
          createdAt: true,
        },
      });

      if (!existing) {
        const created = await tx.user.create({
          data: {
            name: input.name,
            email: input.email,
            authProvider: "email",
            platformRole: "platform_operator",
          },
          select: {
            id: true,
            name: true,
            email: true,
            passwordHash: true,
            platformRole: true,
            createdAt: true,
          },
        });
        const issued = await this.issueOperatorInvitation(
          tx,
          created as PlatformUserRecord,
        );
        await this.audit(tx, {
          actor,
          action: "platform_user.invite_requested",
          targetId: created.id,
          beforeSummary: null,
          afterSummary: {
            platformRole: "platform_operator",
            outcome: "created",
          },
        });
        return issued;
      }

      if (
        existing.platformRole === "platform_operator" &&
        existing.passwordHash === null
      ) {
        const issued = await this.issueOperatorInvitation(
          tx,
          existing as PlatformUserRecord,
        );
        await this.audit(tx, {
          actor,
          action: "platform_user.invite_requested",
          targetId: existing.id,
          beforeSummary: null,
          afterSummary: {
            platformRole: "platform_operator",
            outcome: "reissued",
          },
        });
        return issued;
      }

      await this.audit(tx, {
        actor,
        action: "platform_user.invite_requested",
        targetId: this.hashIdentity(input.email),
        targetType: "AuthIdentity",
        beforeSummary: null,
        afterSummary: { outcome: "accepted_noop" },
      });
      return null;
    });

    if (invitation) {
      await this.deliverOperatorInvitation(invitation);
    }

    return platformUserProvisionResultSchema.parse({ accepted: true });
  }

  async reissuePlatformOperatorInvitation(
    userId: string,
    actor: PlatformAdminUser,
  ): Promise<PlatformUserProvisionResultDto> {
    this.assertOwnerActor(actor);
    this.assertInvitationDeliveryAvailable();

    const invitation = await this.withPlatformAdminLock(async (tx) => {
      await this.assertMutationRateLimit(tx, actor, "invite");
      const target = await tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          email: true,
          passwordHash: true,
          platformRole: true,
          createdAt: true,
        },
      });

      if (
        !target ||
        target.platformRole !== "platform_operator" ||
        target.passwordHash !== null
      ) {
        throw new NotFoundException("Convite de operador nao encontrado");
      }

      const issued = await this.issueOperatorInvitation(
        tx,
        target as PlatformUserRecord,
      );
      await this.audit(tx, {
        actor,
        action: "platform_user.invitation_reissued",
        targetId: target.id,
        beforeSummary: null,
        afterSummary: { platformRole: "platform_operator" },
      });
      return issued;
    });

    await this.deliverOperatorInvitation(invitation);
    return platformUserProvisionResultSchema.parse({ accepted: true });
  }

  async updatePlatformUserRole(
    userId: string,
    rawInput: PlatformUserRoleUpdateInputDto,
    actor: PlatformAdminUser,
  ): Promise<PlatformUserDto | { id: string; role: null }> {
    this.assertOwnerActor(actor);
    const input = this.parseRoleUpdateInput(rawInput);

    const updated = await this.withPlatformAdminLock(async (tx) => {
      await this.assertMutationRateLimit(tx, actor, "role");
      const target = await tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          email: true,
          passwordHash: true,
          platformRole: true,
          createdAt: true,
        },
      });

      if (!target || !target.platformRole) {
        throw new NotFoundException("Usuario de plataforma nao encontrado");
      }

      if (target.id === actor.id && input.role !== "platform_owner") {
        throw new ForbiddenException(
          "O proprietario nao pode remover o proprio acesso",
        );
      }

      if (
        target.platformRole === "platform_owner" &&
        input.role !== "platform_owner"
      ) {
        const ownerCount = await tx.user.count({
          where: { platformRole: "platform_owner" },
        });

        if (ownerCount <= 1) {
          throw new ForbiddenException(
            "A plataforma precisa manter ao menos um proprietario",
          );
        }
      }

      if (
        input.role === "platform_owner" &&
        target.platformRole === "platform_operator" &&
        target.passwordHash === null
      ) {
        throw new BadRequestException(
          "Ative o operador antes de promove-lo a proprietario",
        );
      }

      const changed = await tx.user.update({
        where: { id: target.id },
        data: { platformRole: input.role },
        select: {
          id: true,
          name: true,
          email: true,
          passwordHash: true,
          platformRole: true,
          createdAt: true,
        },
      });

      await this.audit(tx, {
        actor,
        action: "platform_user.role_updated",
        targetId: target.id,
        beforeSummary: { platformRole: target.platformRole },
        afterSummary: { platformRole: changed.platformRole },
      });

      return changed;
    });

    if (!updated.platformRole) {
      return { id: updated.id, role: null };
    }

    return platformUserSchema.parse(
      this.toPlatformUser(updated as PlatformUserRecord),
    );
  }

  private async withPlatformAdminLock<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (transaction) => {
      await acquirePlatformAdminLock(transaction);
      return operation(transaction);
    }, platformAdminTransactionOptions);
  }

  private async issueOperatorInvitation(
    transaction: Prisma.TransactionClient,
    user: PlatformUserRecord,
  ): Promise<PlatformUserInvitationRecord> {
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + platformOperatorInviteTtlMs);

    await transaction.authActionToken.updateMany({
      where: {
        userId: user.id,
        type: "account_activation",
        usedAt: null,
      },
      data: { usedAt: new Date() },
    });
    const activationToken = await transaction.authActionToken.create({
      data: {
        userId: user.id,
        type: "account_activation",
        tokenHash: this.hashActionToken(token),
        expiresAt,
      },
      select: { id: true },
    });

    return {
      user,
      activationTokenId: activationToken.id,
      token,
      expiresAt,
    };
  }

  private assertInvitationDeliveryAvailable(): void {
    if (!this.emailQueue?.isEnabled()) {
      throw new ServiceUnavailableException("Entrega de convite indisponivel");
    }
  }

  private async deliverOperatorInvitation(
    invitation: PlatformUserInvitationRecord,
  ): Promise<void> {
    try {
      await this.emailQueue!.enqueue({
        workspaceId: null,
        action: {
          type: "AuthActionToken",
          id: invitation.activationTokenId,
          version: "1",
        },
        envelope: {
          to: {
            address: invitation.user.email,
            name: invitation.user.name ?? undefined,
          },
          template: "platform_operator_activation",
          data: {
            recipientName: invitation.user.name ?? undefined,
            token: invitation.token,
            expiresAt: invitation.expiresAt.toISOString(),
          },
        },
      });
    } catch {
      await this.recordDeliveryFailure(invitation.user.id);
      throw new ServiceUnavailableException(
        "Entrega de convite indisponivel. Reemita o convite mais tarde.",
      );
    }
  }

  private async assertMutationRateLimit(
    transaction: Prisma.TransactionClient,
    actor: PlatformAdminUser,
    kind: MutationKind,
  ): Promise<void> {
    const actions =
      kind === "invite"
        ? [
            "platform_user.invite_requested",
            "platform_user.invitation_reissued",
          ]
        : ["platform_user.role_updated"];
    const limit = kind === "invite" ? inviteRateLimit : roleMutationRateLimit;
    const recentMutations = await transaction.auditLog.count({
      where: {
        actorUserId: actor.id,
        action: { in: actions },
        resultStatus: "success",
        createdAt: { gte: new Date(Date.now() - mutationRateLimitWindowMs) },
      },
    });

    if (recentMutations >= limit) {
      throw new HttpException(
        "Muitas alteracoes administrativas. Tente novamente em alguns minutos.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async audit(
    transaction: Prisma.TransactionClient,
    input: {
      actor: PlatformAdminUser;
      action: string;
      targetId: string;
      targetType?: string;
      beforeSummary: Prisma.InputJsonValue | null;
      afterSummary: Prisma.InputJsonValue | null;
    },
  ): Promise<void> {
    await transaction.auditLog.create({
      data: {
        workspaceId: null,
        actorUserId: input.actor.id,
        actorType: input.actor.role,
        action: input.action,
        targetType: input.targetType ?? "User",
        targetId: input.targetId,
        resultStatus: "success",
        beforeSummary: input.beforeSummary ?? undefined,
        afterSummary: input.afterSummary ?? undefined,
      },
    });
  }

  private async recordDeliveryFailure(userId: string): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          workspaceId: null,
          actorUserId: null,
          actorType: "system",
          action: "platform_user.invitation_delivery_failed",
          targetType: "User",
          targetId: userId,
          resultStatus: "failed",
          afterSummary: { reissueAvailable: true },
        },
      });
    } catch {
      // The active token remains reissuable even if secondary audit fails.
    }
  }

  private parseProvisionInput(
    input: PlatformUserProvisionInputDto,
  ): PlatformUserProvisionInputDto {
    const parsed = platformUserProvisionInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException("Payload invalido");
    }
    return parsed.data;
  }

  private parseRoleUpdateInput(
    input: PlatformUserRoleUpdateInputDto,
  ): PlatformUserRoleUpdateInputDto {
    const parsed = platformUserRoleUpdateInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException("Payload invalido");
    }
    return parsed.data;
  }

  private assertOwnerActor(actor: PlatformAdminUser): void {
    if (actor.role !== "platform_owner") {
      throw new ForbiddenException(
        "Acao restrita ao proprietario da plataforma",
      );
    }
  }

  private toPlatformUser(user: PlatformUserRecord): PlatformUserDto {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.platformRole,
      createdAt: user.createdAt.toISOString(),
    };
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private hashActionToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private hashIdentity(email: string): string {
    return createHash("sha256")
      .update(this.normalizeEmail(email))
      .digest("hex");
  }
}
