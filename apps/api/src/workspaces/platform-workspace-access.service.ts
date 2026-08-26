import { createHash, randomBytes } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma, type PlatformRole } from "@prisma/client";
import {
  backofficeWorkspaceCreateInputSchema,
  backofficeWorkspaceCreateResultSchema,
  backofficeWorkspaceActivationReissueResultSchema,
  backofficeWorkspaceListSchema,
  type BackofficeWorkspaceCreateInputDto,
  type BackofficeWorkspaceCreateResultDto,
  type BackofficeWorkspaceActivationReissueResultDto,
  type BackofficeWorkspaceDto,
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  acquirePlatformWorkspaceWriteLocks,
  withWorkspaceUniqueRetry,
} from "../common/prisma/workspace-write-concurrency";
import { acquirePlatformRoleLock } from "../common/prisma/platform-role-concurrency";
import { EmailQueueService } from "../email/email-queue.service";
import type { PlatformAdminUser } from "../auth/platform-admin.service";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { parseWebOrigin } from "../config/deployment-config";

const activationTtlMs = 1000 * 60 * 60 * 24 * 7;

type ResponsibleRecord = {
  id: string;
  name: string | null;
  email: string;
  passwordHash: string | null;
  platformRole: PlatformRole | null;
};

type WorkspaceWithResponsible = {
  id: string;
  name: string;
  slug: string;
  operationalStatus: "active" | "blocked";
  createdAt: Date;
  members: Array<{
    role: "owner" | "admin" | "member";
    user: ResponsibleRecord;
  }>;
};

type PendingDelivery = {
  tokenId: string;
  token: string;
  expiresAt: Date;
};

export type ClientOwnerActivationLinkResult = {
  ok: true;
  mode: "activation";
  delivery: "link_only";
  activationUrl: string;
  expiresAt: string;
  emailAttempted: false;
};

@Injectable()
export class PlatformWorkspaceAccessService {
  private readonly logger = new Logger(PlatformWorkspaceAccessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailQueue: EmailQueueService,
    @Optional()
    @Inject(RUNTIME_ENV)
    private readonly env: RuntimeEnv = process.env,
  ) {}

  async listWorkspaces(): Promise<BackofficeWorkspaceDto[]> {
    const workspaces = await this.prisma.workspace.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        slug: true,
        operationalStatus: true,
        createdAt: true,
        members: {
          where: { role: "owner" },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: 1,
          select: {
            role: true,
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                passwordHash: true,
                platformRole: true,
              },
            },
          },
        },
      },
    });

    return backofficeWorkspaceListSchema.parse(
      workspaces.map((workspace) => this.toWorkspaceDto(workspace)),
    );
  }

  async createWorkspace(
    rawInput: BackofficeWorkspaceCreateInputDto,
    actor: PlatformAdminUser,
  ): Promise<BackofficeWorkspaceCreateResultDto> {
    if (actor.role !== "platform_owner") {
      throw new ForbiddenException(
        "Acao restrita ao proprietario da plataforma",
      );
    }

    const parsed = backofficeWorkspaceCreateInputSchema.safeParse(rawInput);

    if (!parsed.success) {
      throw new BadRequestException("Payload invalido");
    }

    const input = parsed.data;
    const existing = await this.prisma.user.findUnique({
      where: { email: input.responsible.email },
      select: {
        id: true,
        name: true,
        email: true,
        passwordHash: true,
        platformRole: true,
      },
    });

    this.assertResponsibleCanBeProvisioned(existing, input.reuseExistingUser);

    if ((!existing || !existing.passwordHash) && !this.emailQueue.isEnabled()) {
      throw new ServiceUnavailableException(
        "Entrega de ativacao do responsavel indisponivel",
      );
    }

    const created = await withWorkspaceUniqueRetry(() =>
      this.prisma.$transaction(async (tx) => {
        await acquirePlatformWorkspaceWriteLocks(tx);
        const currentUser = await tx.user.findUnique({
          where: { email: input.responsible.email },
          select: {
            id: true,
            name: true,
            email: true,
            passwordHash: true,
            platformRole: true,
          },
        });

        this.assertResponsibleCanBeProvisioned(
          currentUser,
          input.reuseExistingUser,
        );

        const workspace = await tx.workspace.create({
          data: {
            name: input.name,
            slug: await this.resolveWorkspaceSlug(input.name, tx),
          },
          select: {
            id: true,
            name: true,
            slug: true,
            operationalStatus: true,
            createdAt: true,
          },
        });

        const user = currentUser
          ? currentUser.passwordHash
            ? currentUser
            : await tx.user.update({
                where: { id: currentUser.id },
                data: { name: input.responsible.name },
                select: {
                  id: true,
                  name: true,
                  email: true,
                  passwordHash: true,
                  platformRole: true,
                },
              })
          : await tx.user.create({
              data: {
                name: input.responsible.name,
                email: input.responsible.email,
                authProvider: "email",
              },
              select: {
                id: true,
                name: true,
                email: true,
                passwordHash: true,
                platformRole: true,
              },
            });

        const member = await tx.workspaceMember.create({
          data: {
            workspaceId: workspace.id,
            userId: user.id,
            role: "owner",
          },
        });

        let pendingDelivery: PendingDelivery | null = null;
        if (!user.passwordHash) {
          const token = randomBytes(32).toString("hex");
          const expiresAt = new Date(Date.now() + activationTtlMs);
          await tx.authActionToken.updateMany({
            where: {
              userId: user.id,
              type: "account_activation",
              usedAt: null,
            },
            data: { usedAt: new Date() },
          });
          const actionToken = await tx.authActionToken.create({
            data: {
              userId: user.id,
              workspaceId: workspace.id,
              type: "account_activation",
              tokenHash: this.hashToken(token),
              expiresAt,
            },
            select: { id: true },
          });
          pendingDelivery = {
            tokenId: actionToken.id,
            token,
            expiresAt,
          };
        }

        await tx.auditLog.create({
          data: {
            workspaceId: workspace.id,
            actorUserId: actor.id,
            actorType: actor.role,
            action: "backoffice.workspace_created",
            targetType: "Workspace",
            targetId: workspace.id,
            resultStatus: "success",
            afterSummary: {
              slug: workspace.slug,
              responsibleUserId: user.id,
              responsibleRole: "owner",
            },
          },
        });
        await tx.auditLog.create({
          data: {
            workspaceId: workspace.id,
            actorUserId: actor.id,
            actorType: actor.role,
            action: currentUser
              ? "backoffice.workspace_responsible_reused"
              : "backoffice.workspace_responsible_invited",
            targetType: "WorkspaceMember",
            targetId: member.id,
            resultStatus: "success",
            afterSummary: {
              userId: user.id,
              role: "owner",
              reusedExistingUser: Boolean(currentUser),
              activationRequired: Boolean(pendingDelivery),
            },
          },
        });

        return {
          workspace,
          user,
          pendingDelivery,
          reusedExistingUser: Boolean(currentUser),
        };
      }),
    );

    let deliveryStatus: "queued" | "failed" | "not_required" = "not_required";
    if (created.pendingDelivery) {
      try {
        await this.emailQueue.enqueue({
          workspaceId: created.workspace.id,
          action: {
            type: "AuthActionToken",
            id: created.pendingDelivery.tokenId,
            version: "1",
          },
          envelope: {
            to: {
              address: created.user.email,
              name: created.user.name ?? undefined,
            },
            template: "client_owner_activation",
            data: {
              recipientName: created.user.name ?? undefined,
              workspaceName: created.workspace.name,
              token: created.pendingDelivery.token,
              expiresAt: created.pendingDelivery.expiresAt.toISOString(),
            },
          },
        });
        deliveryStatus = "queued";
      } catch {
        deliveryStatus = "failed";
        await this.recordDeliveryFailure(
          created.workspace.id,
          created.pendingDelivery.tokenId,
        );
      }
    }

    const response = {
      ...this.toWorkspaceDto({
        ...created.workspace,
        members: [{ role: "owner", user: created.user }],
      }),
      reusedExistingUser: created.reusedExistingUser,
      deliveryStatus,
    } as const;

    return backofficeWorkspaceCreateResultSchema.parse(response);
  }

  async reissueClientOwnerActivation(
    workspaceId: string,
    ownerUserId: string,
    actor: PlatformAdminUser,
  ): Promise<BackofficeWorkspaceActivationReissueResultDto> {
    if (actor.role !== "platform_owner") {
      throw new ForbiddenException(
        "Acao restrita ao proprietario da plataforma",
      );
    }

    const issued = await withWorkspaceUniqueRetry(() =>
      this.prisma.$transaction(async (tx) => {
        await acquirePlatformRoleLock(tx);
        const membership = await tx.workspaceMember.findFirst({
          where: {
            workspaceId,
            userId: ownerUserId,
            role: "owner",
          },
          select: {
            id: true,
            workspace: { select: { id: true, name: true } },
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                passwordHash: true,
                platformRole: true,
              },
            },
          },
        });

        if (!membership) {
          throw new NotFoundException(
            "Responsavel do workspace nao encontrado",
          );
        }

        if (membership.user.platformRole) {
          throw new ForbiddenException(
            "Um administrador da plataforma nao pode receber ativacao de cliente",
          );
        }

        if (membership.user.passwordHash) {
          throw new ConflictException("A conta do responsavel ja foi ativada");
        }

        const token = randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + activationTtlMs);
        await tx.authActionToken.updateMany({
          where: {
            userId: membership.user.id,
            type: "account_activation",
            usedAt: null,
          },
          data: { usedAt: new Date() },
        });
        const actionToken = await tx.authActionToken.create({
          data: {
            userId: membership.user.id,
            workspaceId: membership.workspace.id,
            type: "account_activation",
            tokenHash: this.hashToken(token),
            expiresAt,
          },
          select: { id: true },
        });

        await tx.auditLog.create({
          data: {
            workspaceId: membership.workspace.id,
            actorUserId: actor.id,
            actorType: actor.role,
            action: "backoffice.workspace_owner_activation_reissued",
            targetType: "AuthActionToken",
            targetId: actionToken.id,
            resultStatus: "success",
            afterSummary: {
              ownerUserId: membership.user.id,
              ownerRole: "owner",
              delivery: "pending",
            },
          },
        });

        return {
          workspace: membership.workspace,
          user: membership.user,
          tokenId: actionToken.id,
          token,
          expiresAt,
        };
      }),
    );

    try {
      await this.emailQueue.enqueue({
        workspaceId: issued.workspace.id,
        action: {
          type: "AuthActionToken",
          id: issued.tokenId,
          version: "1",
        },
        envelope: {
          to: {
            address: issued.user.email,
            name: issued.user.name ?? undefined,
          },
          template: "client_owner_activation",
          data: {
            recipientName: issued.user.name ?? undefined,
            workspaceName: issued.workspace.name,
            token: issued.token,
            expiresAt: issued.expiresAt.toISOString(),
          },
        },
      });
    } catch {
      await this.recordDeliveryFailure(
        issued.workspace.id,
        issued.tokenId,
        "backoffice.workspace_owner_activation_delivery_failed",
        true,
      );
      throw new ServiceUnavailableException(
        "Entrega de ativacao indisponivel. Reemita o link mais tarde.",
      );
    }

    await this.recordDeliveryQueued(issued.workspace.id, issued.tokenId);
    return backofficeWorkspaceActivationReissueResultSchema.parse({
      accepted: true,
      deliveryStatus: "queued",
    });
  }

  async createClientOwnerActivationLink(
    workspaceId: string,
    ownerUserId: string,
    actor: PlatformAdminUser,
  ): Promise<ClientOwnerActivationLinkResult> {
    if (actor.role !== "platform_owner") {
      throw new ForbiddenException(
        "Acao restrita ao proprietario da plataforma",
      );
    }

    // Validate and normalize the installation origin before rotating any token.
    // Otherwise an invalid deployment setting could commit a usable token that
    // this request cannot return as a manual activation link.
    const webOrigin = parseWebOrigin(this.env);

    const issued = await this.prisma.$transaction(async (tx) => {
      // Serialize token rotation with platform-admin activation mutations. The
      // token remains one-time even when two manual links are requested at once.
      await acquirePlatformRoleLock(tx);
      const membership = await tx.workspaceMember.findFirst({
        where: {
          workspaceId,
          userId: ownerUserId,
          role: "owner",
        },
        select: {
          id: true,
          workspace: { select: { id: true, name: true } },
          user: {
            select: {
              id: true,
              passwordHash: true,
              platformRole: true,
            },
          },
        },
      });

      if (!membership) {
        throw new NotFoundException("Responsavel do workspace nao encontrado");
      }

      if (membership.user.platformRole) {
        throw new ForbiddenException(
          "Um administrador da plataforma nao pode receber ativacao de cliente",
        );
      }

      if (membership.user.passwordHash) {
        throw new ConflictException("A conta do responsavel ja foi ativada");
      }

      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + activationTtlMs);
      await tx.authActionToken.updateMany({
        where: {
          userId: membership.user.id,
          type: "account_activation",
          usedAt: null,
        },
        data: { usedAt: new Date() },
      });
      const actionToken = await tx.authActionToken.create({
        data: {
          userId: membership.user.id,
          workspaceId: membership.workspace.id,
          type: "account_activation",
          // The raw token is deliberately kept only in this request result.
          tokenHash: this.hashToken(token),
          expiresAt,
        },
        select: { id: true },
      });

      await tx.auditLog.create({
        data: {
          workspaceId: membership.workspace.id,
          actorUserId: actor.id,
          actorType: actor.role,
          action: "backoffice.workspace_owner_activation_link_generated",
          targetType: "AuthActionToken",
          targetId: actionToken.id,
          resultStatus: "success",
          afterSummary: {
            ownerUserId: membership.user.id,
            ownerRole: "owner",
            delivery: "manual_link",
            expiresAt: expiresAt.toISOString(),
          },
        },
      });

      return { token, expiresAt };
    });

    return {
      ok: true,
      mode: "activation",
      delivery: "link_only",
      activationUrl: this.buildActivationUrl(webOrigin, issued.token),
      expiresAt: issued.expiresAt.toISOString(),
      emailAttempted: false,
    };
  }

  private assertResponsibleCanBeProvisioned(
    existing: ResponsibleRecord | null,
    reuseExistingUser: boolean,
  ): void {
    if (!existing) {
      return;
    }

    if (existing.platformRole) {
      throw new ConflictException(
        "Um administrador da plataforma nao pode ser responsavel de cliente",
      );
    }

    if (!reuseExistingUser) {
      throw new ConflictException(
        "Usuario existente exige confirmacao explicita de reutilizacao",
      );
    }
  }

  private async resolveWorkspaceSlug(
    name: string,
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    const base = this.slugify(name);
    let candidate = base;
    let suffix = 2;

    while (
      await tx.workspace.findUnique({
        where: { slug: candidate },
        select: { id: true },
      })
    ) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }

    return candidate;
  }

  private toWorkspaceDto(
    workspace: WorkspaceWithResponsible,
  ): BackofficeWorkspaceDto {
    const member = workspace.members[0];

    return {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      operationalStatus: workspace.operationalStatus,
      createdAt: workspace.createdAt.toISOString(),
      responsible: member
        ? {
            id: member.user.id,
            name: member.user.name,
            email: member.user.email,
            role: "owner",
            status: member.user.passwordHash ? "active" : "pending_activation",
          }
        : null,
    };
  }

  private slugify(value: string): string {
    const slug = value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    return slug || "workspace";
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private buildActivationUrl(webOrigin: string, token: string): string {
    const url = new URL("/login/activate", `${webOrigin}/`);
    url.searchParams.set("token", token);
    return url.toString();
  }

  private async recordDeliveryFailure(
    workspaceId: string,
    actionTokenId: string,
    action = "backoffice.workspace_responsible_delivery_failed",
    reissueAvailable = false,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          workspaceId,
          actorUserId: null,
          actorType: "system",
          action,
          targetType: "AuthActionToken",
          targetId: actionTokenId,
          resultStatus: "failed",
          afterSummary: { reissueAvailable },
        },
      });
    } catch {
      this.logger.error(
        `Falha ao auditar delivery de ativacao; workspaceId=${workspaceId} actionTokenId=${actionTokenId}`,
      );
    }
  }

  private async recordDeliveryQueued(
    workspaceId: string,
    actionTokenId: string,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          workspaceId,
          actorUserId: null,
          actorType: "system",
          action: "backoffice.workspace_owner_activation_delivery_queued",
          targetType: "AuthActionToken",
          targetId: actionTokenId,
          resultStatus: "success",
          afterSummary: { delivery: "queued" },
        },
      });
    } catch {
      this.logger.error(
        `Falha ao auditar delivery enfileirado; workspaceId=${workspaceId} actionTokenId=${actionTokenId}`,
      );
    }
  }
}
