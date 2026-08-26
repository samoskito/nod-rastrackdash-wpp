import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  AccountActivationConfirmDto,
  AccountActivationConfirmInputDto,
  EmailVerificationConfirmDto,
  EmailVerificationConfirmInputDto,
  EmailVerificationStartDto,
  GoogleOAuthCallbackQueryDto,
  GoogleOAuthCallbackResultDto,
  GoogleOAuthStartDto,
  GoogleOAuthStartResultDto,
  LoginDto,
  PasswordResetConfirmDto,
  PasswordResetConfirmInputDto,
  PasswordResetRequestDto,
  PasswordResetRequestInputDto,
  PlatformRole,
  RegisterDto,
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  RUNTIME_ENV,
  RUNTIME_FETCH,
  type RuntimeEnv,
  type RuntimeFetch,
} from "../common/runtime/runtime.module";
import { EmailQueueService } from "../email/email-queue.service";
import {
  acquirePlatformWorkspaceWriteLocks,
  withWorkspaceUniqueRetry,
} from "../common/prisma/workspace-write-concurrency";
import { acquirePlatformRoleLock } from "../common/prisma/platform-role-concurrency";
import {
  assertBcryptCompatiblePassword,
  PasswordService,
} from "./password.service";
import type { AuthenticatedUser } from "./session.types";

const refreshTokenBytes = 32;
const sessionTtlMs = 1000 * 60 * 60 * 24 * 30;
const passwordResetTtlMs = 1000 * 60 * 30;
const emailVerificationTtlMs = 1000 * 60 * 60 * 24;
const accountActivationTtlMs = 1000 * 60 * 60 * 24 * 7;
const loginFailureWindowMs = 1000 * 60 * 15;
const loginFailureLimit = 5;
const passwordResetRequestWindowMs = 1000 * 60 * 15;
const passwordResetRequestLimit = 3;
const emailVerificationRequestWindowMs = 1000 * 60 * 15;
const emailVerificationRequestLimit = 3;

type WorkspaceMembershipRecord = {
  role: AuthenticatedUser["workspaces"][number]["role"];
  canManageMembers?: boolean;
  workspace: {
    id: string;
    name: string;
    slug: string;
    operationalStatus?: AuthenticatedUser["workspaces"][number]["operationalStatus"];
  };
};

type EmailLoginUserRecord = {
  id: string;
  email: string;
  name: string | null;
  passwordHash: string | null;
  lastWorkspaceId?: string | null;
  authProvider?: string;
  googleId?: string | null;
  emailVerifiedAt?: Date | null;
  platformRole?: PlatformRole | null;
  memberships: WorkspaceMembershipRecord[];
};

type SessionUserRecord = EmailLoginUserRecord;

type AuthSessionRecord = {
  id?: string;
  userId?: string;
  activeWorkspaceId?: string | null;
  revokedAt: Date | null;
  expiresAt: Date;
  supportWorkspaceStartedAt?: Date | null;
  supportWorkspace?: {
    id: string;
    name: string;
    slug: string;
    operationalStatus?: AuthenticatedUser["workspaces"][number]["operationalStatus"];
  } | null;
  user: SessionUserRecord;
};

export type AuthRequestContext = {
  userAgent?: string | null;
  ipAddress?: string | null;
};

export type AuthSessionCreationOptions = {
  activeWorkspaceId?: string | null;
  transaction?: Prisma.TransactionClient;
};

type CreatedWorkspaceOwnership = {
  userId: string;
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  memberId: string;
};
type AuthActionTokenType =
  "password_reset" | "email_verification" | "account_activation";
type AuthActionTokenRecord = {
  id: string;
  userId: string;
  workspaceId: string | null;
  type: AuthActionTokenType;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
};

type GoogleTokenResponse = {
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
};

type GoogleUserInfoResponse = {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
};

type GoogleOAuthCallbackNonAuthenticatedResult =
  GoogleOAuthCallbackResultDto & {
    action: "configure_env" | "exchange_pending" | "exchange_failed";
  };

type GoogleOAuthCallbackServiceResult =
  | GoogleOAuthCallbackNonAuthenticatedResult
  | (GoogleOAuthCallbackResultDto & {
      action: "authenticated";
      session: AuthSessionResult;
    });

export type AuthSessionResult = AuthenticatedUser & {
  refreshToken: string;
  expiresAt: Date;
};

export type AccountActivationResult = AccountActivationConfirmDto & {
  session: AuthSessionResult;
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    @Optional()
    @Inject(RUNTIME_ENV)
    private readonly env: RuntimeEnv = process.env,
    @Optional()
    @Inject(RUNTIME_FETCH)
    private readonly fetchImpl: RuntimeFetch = fetch,
    @Optional()
    @Inject(EmailQueueService)
    private readonly emailQueue?: EmailQueueService,
  ) {}

  async register(
    input: RegisterDto,
    context: AuthRequestContext = {},
  ): Promise<AuthSessionResult> {
    const email = this.normalizeEmail(input.email);
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw new ConflictException("Email ja cadastrado");
    }

    const passwordHash = await this.passwordService.hash(input.password);
    const name = input.name.trim();
    const workspaceName = input.workspaceName.trim();

    const created = await withWorkspaceUniqueRetry(() =>
      this.prisma.$transaction(async (tx) => {
        await acquirePlatformWorkspaceWriteLocks(tx);
        const currentUser = await tx.user.findUnique({
          where: { email },
          select: { id: true },
        });

        if (currentUser) {
          throw new ConflictException("Email ja cadastrado");
        }

        const slug = await this.resolveWorkspaceSlug(workspaceName, tx);
        const workspace = await tx.workspace.create({
          data: {
            name: workspaceName,
            slug,
          },
        });
        const user = await tx.user.create({
          data: {
            email,
            name,
            passwordHash,
          },
        });

        const member = await tx.workspaceMember.create({
          data: {
            workspaceId: workspace.id,
            userId: user.id,
            role: "owner",
          },
        });

        return {
          userId: user.id,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workspaceSlug: workspace.slug,
          memberId: member.id,
        };
      }),
    );
    await this.recordInitialWorkspaceOwnership(created, context);

    return this.createSessionForUser(created.userId, context);
  }

  async login(
    input: LoginDto,
    context: AuthRequestContext = {},
  ): Promise<AuthSessionResult> {
    const email = this.normalizeEmail(input.email);

    await this.assertLoginNotRateLimited(email, context);

    let authenticated: AuthenticatedUser;

    try {
      authenticated = await this.validateEmailLogin(input);
    } catch (error) {
      await this.recordLoginFailure(email, context);
      throw error;
    }

    const session = await this.createSessionForUser(
      authenticated.user.id,
      context,
    );
    await this.recordLoginSuccess(session, context);

    return session;
  }

  async getSession(refreshToken: string): Promise<AuthenticatedUser> {
    const refreshHash = this.hashRefreshToken(refreshToken);
    const session = (await this.prisma.authSession.findUnique({
      where: { refreshHash },
      include: {
        user: {
          include: {
            memberships: {
              include: {
                workspace: true,
              },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            },
          },
        },
        supportWorkspace: true,
      },
    })) as AuthSessionRecord | null;

    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now()
    ) {
      throw this.invalidCredentials();
    }

    const authenticated = this.toAuthenticatedUser(
      session.user,
      session.activeWorkspaceId ?? null,
      session.supportWorkspace ?? null,
      session.supportWorkspaceStartedAt ?? null,
    );

    if (
      session.id &&
      session.activeWorkspaceId !== undefined &&
      session.activeWorkspaceId !== authenticated.activeWorkspaceId
    ) {
      await this.prisma.authSession.updateMany({
        where: {
          id: session.id,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: {
          activeWorkspaceId: authenticated.activeWorkspaceId,
        },
      });
    }

    return authenticated;
  }

  async setActiveWorkspace(
    refreshToken: string,
    workspaceId: string,
  ): Promise<void> {
    const refreshHash = this.hashRefreshToken(refreshToken);
    const session = await this.prisma.authSession.findUnique({
      where: { refreshHash },
      select: {
        id: true,
        userId: true,
        activeWorkspaceId: true,
        revokedAt: true,
        expiresAt: true,
      },
    });

    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now()
    ) {
      throw this.invalidCredentials();
    }

    const membership = await this.prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId: session.userId,
        },
      },
      select: {
        workspaceId: true,
      },
    });

    if (!membership) {
      throw new NotFoundException("Workspace nao encontrado");
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const sessionUpdate = await tx.authSession.updateMany({
        where: {
          id: session.id,
          userId: session.userId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: {
          activeWorkspaceId: membership.workspaceId,
        },
      });

      if (sessionUpdate.count > 0) {
        await tx.user.update({
          where: { id: session.userId },
          data: { lastWorkspaceId: membership.workspaceId },
        });
      }

      return sessionUpdate;
    });

    if (updated.count === 0) {
      throw this.invalidCredentials();
    }

    await this.safeCreateAuditLog({
      workspaceId: membership.workspaceId,
      actorUserId: session.userId,
      actorType: "user",
      action: "workspace.active_changed",
      targetType: "Workspace",
      targetId: membership.workspaceId,
      reason: null,
      sourceIp: null,
      resultStatus: "success",
      beforeSummary: {
        workspaceId: session.activeWorkspaceId,
      },
      afterSummary: {
        workspaceId: membership.workspaceId,
      },
    });
  }

  async setSupportWorkspace(
    refreshToken: string,
    workspaceId: string | null,
  ): Promise<void> {
    const refreshHash = this.hashRefreshToken(refreshToken);
    const result = await this.prisma.authSession.updateMany({
      where: {
        refreshHash,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: {
        supportWorkspaceId: workspaceId,
        supportWorkspaceStartedAt: workspaceId ? new Date() : null,
      },
    });

    if (result.count === 0) {
      throw this.invalidCredentials();
    }
  }

  async logout(refreshToken: string): Promise<void> {
    const refreshHash = this.hashRefreshToken(refreshToken);
    const session = (await this.prisma.authSession.findUnique({
      where: { refreshHash },
      include: {
        user: {
          include: {
            memberships: {
              include: {
                workspace: true,
              },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            },
          },
        },
      },
    })) as AuthSessionRecord | null;

    await this.prisma.authSession.updateMany({
      where: {
        refreshHash,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
        activeWorkspaceId: null,
        supportWorkspaceId: null,
        supportWorkspaceStartedAt: null,
      },
    });

    if (session && !session.revokedAt) {
      const activeWorkspaceId = this.resolveActiveMemberWorkspaceId(
        session.user,
        session.activeWorkspaceId ?? null,
      );

      await this.safeCreateAuditLog({
        workspaceId: activeWorkspaceId,
        actorUserId: session.user.id,
        actorType: "user",
        action: "auth.logout",
        targetType: "AuthSession",
        targetId: session.id ?? refreshHash,
        reason: null,
        sourceIp: null,
        resultStatus: "success",
        beforeSummary: null,
        afterSummary: {
          userId: session.user.id,
        },
      });
    }
  }

  getGoogleOAuthStart(input: GoogleOAuthStartDto): GoogleOAuthStartResultDto {
    const clientId = this.env.GOOGLE_CLIENT_ID;
    const redirectUri = this.env.GOOGLE_REDIRECT_URI;
    const requiredEnv: Array<[string, string | undefined]> = [
      ["GOOGLE_CLIENT_ID", clientId],
      ["GOOGLE_REDIRECT_URI", redirectUri],
    ];
    const missingEnv = requiredEnv
      .filter(([, value]) => !value)
      .map(([key]) => key);

    if (missingEnv.length > 0) {
      return {
        provider: "google",
        action: "configure_env",
        authorizationUrl: null,
        missingEnv,
        state: null,
      };
    }

    const state = this.createOAuthState(input.redirectTo);
    const params = new URLSearchParams({
      client_id: clientId!,
      redirect_uri: redirectUri!,
      response_type: "code",
      scope: "openid email profile",
      access_type: "offline",
      prompt: "select_account",
      state,
    });

    return {
      provider: "google",
      action: "redirect",
      authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      missingEnv: [],
      state,
    };
  }

  async handleGoogleOAuthCallback(
    input: GoogleOAuthCallbackQueryDto,
    context: AuthRequestContext = {},
  ): Promise<GoogleOAuthCallbackServiceResult> {
    const requiredEnv: Array<[string, string | undefined]> = [
      ["GOOGLE_CLIENT_ID", this.env.GOOGLE_CLIENT_ID],
      ["GOOGLE_CLIENT_SECRET", this.env.GOOGLE_CLIENT_SECRET],
      ["GOOGLE_REDIRECT_URI", this.env.GOOGLE_REDIRECT_URI],
    ];
    const missingEnv = requiredEnv
      .filter(([, value]) => !value)
      .map(([key]) => key);
    const redirectTo = this.readOAuthRedirect(input.state);

    if (missingEnv.length > 0) {
      return {
        provider: "google",
        action: "configure_env",
        missingEnv,
        codeReceived: true,
        redirectTo,
      };
    }

    const token = await this.exchangeGoogleCode(input.code);

    if (!token.accessToken) {
      return {
        provider: "google",
        action: "exchange_failed",
        missingEnv: [],
        codeReceived: true,
        redirectTo,
        message: token.message,
      };
    }

    const profile = await this.getGoogleUserInfo(token.accessToken);

    if (!profile.googleId || !profile.email || !profile.emailVerified) {
      return {
        provider: "google",
        action: "exchange_failed",
        missingEnv: [],
        codeReceived: true,
        redirectTo,
        message:
          profile.message ??
          (!profile.emailVerified ? "Email Google nao verificado" : undefined),
      };
    }

    const session = await this.authenticateGoogleProfile(
      {
        googleId: profile.googleId,
        email: profile.email,
        emailVerified: profile.emailVerified,
        name: profile.name,
      },
      context,
    );

    if (!session) {
      return {
        provider: "google",
        action: "exchange_pending",
        missingEnv: [],
        codeReceived: true,
        redirectTo,
        message: "Usuario ainda nao liberado para acessar a plataforma",
      };
    }

    return {
      provider: "google",
      action: "authenticated",
      missingEnv: [],
      codeReceived: true,
      redirectTo,
      session,
    };
  }

  async requestPasswordReset(
    input: PasswordResetRequestInputDto,
    context: AuthRequestContext = {},
  ): Promise<PasswordResetRequestDto> {
    const email = this.normalizeEmail(input.email);
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        name: true,
        passwordHash: true,
      },
    });
    const rateLimited = await this.isPasswordResetRequestRateLimited(
      email,
      context,
    );

    if (rateLimited) {
      await this.recordPasswordResetRequest(
        email,
        user?.id ?? null,
        context,
        "rate_limited",
      );

      return {
        ok: true,
        delivery: this.getTokenDelivery(),
        devToken: null,
      };
    }

    await this.recordPasswordResetRequest(
      email,
      user?.id ?? null,
      context,
      "queued",
    );

    if (!user?.passwordHash) {
      return {
        ok: true,
        delivery: this.getTokenDelivery(),
        devToken: null,
      };
    }

    return this.createActionToken(user, "password_reset", passwordResetTtlMs);
  }

  async activateProvisionedAccount(
    input: AccountActivationConfirmInputDto,
    context: AuthRequestContext = {},
  ): Promise<AccountActivationResult> {
    assertBcryptCompatiblePassword(input.password);
    await this.assertAccountActivationCandidate(input.token);
    const passwordHash = await this.passwordService.hash(input.password);
    const now = new Date();
    const session = await this.prisma.$transaction(async (tx) => {
      // Token rotation and activation must share the same transaction-scoped
      // installation lock. Otherwise activation can validate an old token
      // while a concurrent issuer replaces it with a newer one.
      await acquirePlatformRoleLock(tx);
      const token = await this.consumeActionTokenInTransaction(
        tx,
        "account_activation",
        input.token,
        now,
      );

      const user = await tx.user.findUnique({
        where: { id: token.userId },
        select: {
          id: true,
          emailVerifiedAt: true,
          passwordHash: true,
          platformRole: true,
        },
      });

      if (
        !token.workspaceId &&
        user?.platformRole === "platform_operator" &&
        user.passwordHash === null
      ) {
        const activated = await tx.user.updateMany({
          where: {
            id: user.id,
            platformRole: "platform_operator",
            passwordHash: null,
          },
          data: {
            passwordHash,
            emailVerifiedAt: user.emailVerifiedAt ?? now,
          },
        });

        if (activated.count !== 1) {
          throw this.invalidAccountActivation();
        }

        await tx.authActionToken.updateMany({
          where: {
            userId: user.id,
            type: "account_activation",
            usedAt: null,
          },
          data: { usedAt: now },
        });
        await tx.auditLog.create({
          data: {
            workspaceId: null,
            actorUserId: user.id,
            actorType: "user",
            action: "auth.platform_operator_activated",
            targetType: "User",
            targetId: user.id,
            resultStatus: "success",
            beforeSummary: { platformRole: "platform_operator" },
            afterSummary: { emailVerified: true },
          },
        });

        return this.createSessionForUser(user.id, context, {
          activeWorkspaceId: null,
          transaction: tx,
        });
      }

      if (!token.workspaceId) {
        throw this.invalidAccountActivation();
      }

      const membership = await tx.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: token.workspaceId,
            userId: token.userId,
          },
        },
        select: {
          id: true,
          role: true,
        },
      });

      if (!membership || membership.role !== "owner" || !user?.id) {
        throw this.invalidAccountActivation();
      }

      const activated = await tx.user.updateMany({
        where: {
          id: user.id,
          passwordHash: null,
        },
        data: {
          passwordHash,
          emailVerifiedAt: user.emailVerifiedAt ?? now,
        },
      });

      if (activated.count !== 1) {
        throw this.invalidAccountActivation();
      }

      await tx.authActionToken.updateMany({
        where: {
          userId: user.id,
          type: "account_activation",
          usedAt: null,
        },
        data: { usedAt: now },
      });
      await tx.auditLog.create({
        data: {
          workspaceId: token.workspaceId,
          actorUserId: user.id,
          actorType: "user",
          action: "auth.account_activated",
          targetType: "User",
          targetId: user.id,
          resultStatus: "success",
          beforeSummary: Prisma.JsonNull,
          afterSummary: {
            memberId: membership.id,
            emailVerified: true,
          },
        },
      });

      return this.createSessionForUser(user.id, context, {
        activeWorkspaceId: token.workspaceId,
        transaction: tx,
      });
    });

    return { ok: true, session };
  }

  async resetPassword(
    input: PasswordResetConfirmInputDto,
  ): Promise<PasswordResetConfirmDto> {
    const passwordHash = await this.passwordService.hash(input.password);
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const token = await this.consumeActionTokenInTransaction(
        tx,
        "password_reset",
        input.token,
        now,
      );

      await tx.user.update({
        where: { id: token.userId },
        data: { passwordHash },
      });
      await tx.authActionToken.updateMany({
        where: {
          userId: token.userId,
          type: "password_reset",
          usedAt: null,
        },
        data: { usedAt: now },
      });
      const revokedSessions = await tx.authSession.updateMany({
        where: {
          userId: token.userId,
          revokedAt: null,
        },
        data: {
          revokedAt: now,
          activeWorkspaceId: null,
          supportWorkspaceId: null,
          supportWorkspaceStartedAt: null,
        },
      });

      return {
        userId: token.userId,
        revokedSessions: revokedSessions.count,
      };
    });
    await this.safeCreateAuditLog({
      workspaceId: null,
      actorUserId: result.userId,
      actorType: "user",
      action: "auth.password_reset_confirmed",
      targetType: "User",
      targetId: result.userId,
      reason: null,
      sourceIp: null,
      resultStatus: "success",
      beforeSummary: null,
      afterSummary: {
        revokedSessions: result.revokedSessions,
      },
    });

    return { ok: true };
  }

  async requestEmailVerification(
    refreshToken: string,
    context: AuthRequestContext = {},
  ): Promise<EmailVerificationStartDto> {
    const authenticated = await this.getSession(refreshToken);
    return this.requestEmailVerificationForUser(authenticated.user.id, context);
  }

  async requestEmailVerificationForUser(
    userId: string,
    context: AuthRequestContext = {},
  ): Promise<EmailVerificationStartDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        emailVerifiedAt: true,
      },
    });

    if (!user) {
      throw this.invalidCredentials();
    }

    const rateLimited = await this.isEmailVerificationRequestRateLimited(
      user.id,
      context,
    );

    if (rateLimited || user.emailVerifiedAt) {
      await this.recordEmailVerificationRequest(
        user.id,
        context,
        rateLimited ? "rate_limited" : "already_verified",
      );

      return {
        ok: true,
        delivery: this.getTokenDelivery(),
        devToken: null,
      };
    }

    const result = await this.createActionToken(
      user,
      "email_verification",
      emailVerificationTtlMs,
    );
    await this.recordEmailVerificationRequest(user.id, context, "queued");

    return result;
  }

  async confirmEmailVerification(
    input: EmailVerificationConfirmInputDto,
  ): Promise<EmailVerificationConfirmDto> {
    const emailVerifiedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      const token = await this.consumeActionTokenInTransaction(
        tx,
        "email_verification",
        input.token,
        emailVerifiedAt,
      );

      await tx.user.update({
        where: { id: token.userId },
        data: { emailVerifiedAt },
      });
      await tx.authActionToken.updateMany({
        where: {
          userId: token.userId,
          type: "email_verification",
          usedAt: null,
        },
        data: { usedAt: emailVerifiedAt },
      });
    });

    return {
      ok: true,
      emailVerifiedAt: emailVerifiedAt.toISOString(),
    };
  }

  async validateEmailLogin(input: LoginDto): Promise<AuthenticatedUser> {
    const email = this.normalizeEmail(input.email);
    const user = (await this.prisma.user.findUnique({
      where: { email },
      include: {
        memberships: {
          include: {
            workspace: true,
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
      },
    })) as EmailLoginUserRecord | null;

    if (!user?.passwordHash) {
      throw this.invalidCredentials();
    }

    const validPassword = await this.passwordService.verify(
      input.password,
      user.passwordHash,
    );

    if (!validPassword) {
      throw this.invalidCredentials();
    }

    return this.toAuthenticatedUser(user);
  }

  async createSessionForUser(
    userId: string,
    context: AuthRequestContext = {},
    options: AuthSessionCreationOptions = {},
  ): Promise<AuthSessionResult> {
    const create = async (tx: Prisma.TransactionClient) => {
      const user = (await tx.user.findUnique({
        where: { id: userId },
        include: {
          memberships: {
            include: {
              workspace: true,
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          },
        },
      })) as EmailLoginUserRecord | null;

      if (!user) {
        throw this.invalidCredentials();
      }

      const refreshToken = randomBytes(refreshTokenBytes).toString("hex");
      const expiresAt = new Date(Date.now() + sessionTtlMs);
      const requestedWorkspaceId = options.activeWorkspaceId ?? null;
      const authenticated = this.toAuthenticatedUser(
        user,
        requestedWorkspaceId,
      );

      if (
        requestedWorkspaceId &&
        authenticated.activeWorkspaceId !== requestedWorkspaceId
      ) {
        throw this.invalidCredentials();
      }

      await tx.authSession.create({
        data: {
          userId: user.id,
          activeWorkspaceId: authenticated.activeWorkspaceId,
          refreshHash: this.hashRefreshToken(refreshToken),
          userAgent: context.userAgent ?? null,
          ipAddress: context.ipAddress ?? null,
          expiresAt,
        },
      });

      if (
        authenticated.activeWorkspaceId &&
        authenticated.activeWorkspaceId !== user.lastWorkspaceId
      ) {
        await tx.user.update({
          where: { id: user.id },
          data: { lastWorkspaceId: authenticated.activeWorkspaceId },
        });
      }

      return {
        ...authenticated,
        refreshToken,
        expiresAt,
      };
    };

    return options.transaction
      ? create(options.transaction)
      : this.prisma.$transaction(create);
  }

  async activateWorkspaceSessionInTransaction(
    tx: Prisma.TransactionClient,
    refreshToken: string,
    userId: string,
    workspaceId: string,
  ): Promise<void> {
    const membership = await tx.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId,
        },
      },
      select: { id: true },
    });

    if (!membership) {
      throw this.invalidCredentials();
    }

    const updated = await tx.authSession.updateMany({
      where: {
        refreshHash: this.hashRefreshToken(refreshToken),
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: {
        activeWorkspaceId: workspaceId,
        supportWorkspaceId: null,
        supportWorkspaceStartedAt: null,
      },
    });

    if (updated.count !== 1) {
      throw this.invalidCredentials();
    }

    await tx.user.update({
      where: { id: userId },
      data: { lastWorkspaceId: workspaceId },
    });
  }

  private async exchangeGoogleCode(
    code: string,
  ): Promise<{ accessToken: string | null; message?: string }> {
    const body = new URLSearchParams({
      code,
      client_id: this.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: this.env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: this.env.GOOGLE_REDIRECT_URI ?? "",
      grant_type: "authorization_code",
    });

    try {
      const response = await this.fetchImpl(
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        },
      );
      const payload = (await response
        .json()
        .catch(() => ({}))) as GoogleTokenResponse;

      if (!response.ok || !this.asString(payload.access_token)) {
        return {
          accessToken: null,
          message:
            this.asString(payload.error_description) ??
            this.asString(payload.error) ??
            `Google OAuth HTTP ${response.status}`,
        };
      }

      return {
        accessToken: this.asString(payload.access_token),
      };
    } catch (error) {
      return {
        accessToken: null,
        message:
          error instanceof Error ? error.message : "Erro ao trocar code Google",
      };
    }
  }

  private async getGoogleUserInfo(accessToken: string): Promise<{
    googleId: string | null;
    email: string | null;
    emailVerified: boolean;
    name: string | null;
    message?: string;
  }> {
    try {
      const response = await this.fetchImpl(
        "https://openidconnect.googleapis.com/v1/userinfo",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );
      const payload = (await response
        .json()
        .catch(() => ({}))) as GoogleUserInfoResponse;

      if (!response.ok) {
        return {
          googleId: null,
          email: null,
          emailVerified: false,
          name: null,
          message: `Google userinfo HTTP ${response.status}`,
        };
      }

      return {
        googleId: this.asString(payload.sub),
        email: this.asString(payload.email)
          ? this.normalizeEmail(this.asString(payload.email)!)
          : null,
        emailVerified: payload.email_verified === true,
        name: this.asString(payload.name),
        message: undefined,
      };
    } catch (error) {
      return {
        googleId: null,
        email: null,
        emailVerified: false,
        name: null,
        message:
          error instanceof Error
            ? error.message
            : "Erro ao buscar perfil Google",
      };
    }
  }

  private async authenticateGoogleProfile(
    profile: {
      googleId: string;
      email: string;
      emailVerified: boolean;
      name: string | null;
    },
    context: AuthRequestContext,
  ): Promise<AuthSessionResult | null> {
    const existingByGoogle = (await this.prisma.user.findUnique({
      where: { googleId: profile.googleId },
      include: {
        memberships: {
          include: {
            workspace: true,
          },
        },
      },
    })) as EmailLoginUserRecord | null;

    if (existingByGoogle) {
      return this.createSessionForUser(existingByGoogle.id, context);
    }

    const existingByEmail = (await this.prisma.user.findUnique({
      where: { email: profile.email },
      include: {
        memberships: {
          include: {
            workspace: true,
          },
        },
      },
    })) as EmailLoginUserRecord | null;

    if (existingByEmail) {
      await this.prisma.user.update({
        where: { id: existingByEmail.id },
        data: {
          authProvider: "google",
          googleId: profile.googleId,
          name: existingByEmail.name ?? profile.name,
          emailVerifiedAt:
            existingByEmail.emailVerifiedAt ??
            (profile.emailVerified ? new Date() : null),
        },
      });

      return this.createSessionForUser(existingByEmail.id, context);
    }

    return null;
  }

  private async recordInitialWorkspaceOwnership(
    created: CreatedWorkspaceOwnership,
    context: AuthRequestContext,
  ): Promise<void> {
    await this.safeCreateAuditLog({
      workspaceId: created.workspaceId,
      actorUserId: created.userId,
      actorType: "user",
      action: "workspace.created",
      targetType: "Workspace",
      targetId: created.workspaceId,
      reason: null,
      sourceIp: context.ipAddress ?? null,
      resultStatus: "success",
      beforeSummary: null,
      afterSummary: {
        name: created.workspaceName,
        slug: created.workspaceSlug,
      },
    });
    await this.safeCreateAuditLog({
      workspaceId: created.workspaceId,
      actorUserId: created.userId,
      actorType: "user",
      action: "workspace.member_added",
      targetType: "WorkspaceMember",
      targetId: created.memberId,
      reason: null,
      sourceIp: context.ipAddress ?? null,
      resultStatus: "owner",
      beforeSummary: null,
      afterSummary: {
        workspaceId: created.workspaceId,
        userId: created.userId,
        role: "owner",
      },
    });
  }

  private async resolveWorkspaceSlug(
    workspaceName: string,
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    const baseSlug = this.slugify(workspaceName);
    let candidate = baseSlug;
    let suffix = 2;

    while (
      await tx.workspace.findUnique({
        where: { slug: candidate },
      })
    ) {
      candidate = `${baseSlug}-${suffix}`;
      suffix += 1;
    }

    return candidate;
  }

  private toAuthenticatedUser(
    user: EmailLoginUserRecord,
    activeWorkspaceId: string | null = null,
    supportWorkspace: AuthSessionRecord["supportWorkspace"] = null,
    supportWorkspaceStartedAt: Date | null = null,
  ): AuthenticatedUser {
    const platformRole = this.resolvePlatformRole(user);
    const activeSupportWorkspace = platformRole ? supportWorkspace : null;
    const memberWorkspaces = user.memberships.map((membership) => ({
      id: membership.workspace.id,
      name: membership.workspace.name,
      slug: membership.workspace.slug,
      role: membership.role,
      canManageMembers: membership.canManageMembers === true,
      operationalStatus:
        membership.workspace.operationalStatus === "blocked"
          ? ("blocked" as const)
          : ("active" as const),
    }));
    const supportContext = activeSupportWorkspace
      ? {
          workspaceId: activeSupportWorkspace.id,
          workspaceName: activeSupportWorkspace.name,
          workspaceSlug: activeSupportWorkspace.slug,
          operationalStatus:
            activeSupportWorkspace.operationalStatus === "blocked"
              ? ("blocked" as const)
              : ("active" as const),
          startedAt: (supportWorkspaceStartedAt ?? new Date()).toISOString(),
        }
      : null;
    const resolvedActiveWorkspaceId = this.resolveActiveMemberWorkspaceId(
      user,
      activeWorkspaceId,
    );

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        authProvider: user.authProvider ?? "email",
        emailVerifiedAt: user.emailVerifiedAt ?? null,
        platformRole,
      },
      activeWorkspaceId: resolvedActiveWorkspaceId,
      workspaces: memberWorkspaces,
      supportContext,
    };
  }

  private resolveActiveMemberWorkspaceId(
    user: EmailLoginUserRecord,
    activeWorkspaceId: string | null,
  ): string | null {
    for (const candidate of [activeWorkspaceId, user.lastWorkspaceId ?? null]) {
      if (
        candidate &&
        user.memberships.some(
          (membership) => membership.workspace.id === candidate,
        )
      ) {
        return candidate;
      }
    }

    return user.memberships.length === 1
      ? (user.memberships[0]?.workspace.id ?? null)
      : null;
  }

  private resolvePlatformRole(user: EmailLoginUserRecord): PlatformRole | null {
    if (
      user.platformRole === "platform_owner" ||
      user.platformRole === "platform_operator"
    ) {
      return user.platformRole;
    }

    // Platform authorization is persistent. The legacy email allowlist is
    // intentionally not an authorization fallback: an env change must never
    // create or promote an account on its own.
    return null;
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private asString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value : null;
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

  private hashRefreshToken(refreshToken: string): string {
    return createHash("sha256").update(refreshToken).digest("hex");
  }

  private hashAuthIdentity(email: string): string {
    return createHash("sha256")
      .update(this.normalizeEmail(email))
      .digest("hex");
  }

  private async assertLoginNotRateLimited(
    email: string,
    context: AuthRequestContext,
  ): Promise<void> {
    const filters: Array<{ targetId?: string; sourceIp?: string }> = [
      {
        targetId: this.hashAuthIdentity(email),
      },
    ];

    if (context.ipAddress) {
      filters.push({ sourceIp: context.ipAddress });
    }

    const recentFailures = await this.prisma.auditLog.count({
      where: {
        action: "auth.login_failed",
        resultStatus: "failed",
        createdAt: {
          gte: new Date(Date.now() - loginFailureWindowMs),
        },
        OR: filters,
      },
    });

    if (recentFailures >= loginFailureLimit) {
      throw new HttpException(
        "Muitas tentativas de login. Tente novamente em alguns minutos.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async isPasswordResetRequestRateLimited(
    email: string,
    context: AuthRequestContext,
  ): Promise<boolean> {
    const filters: Array<{ targetId?: string; sourceIp?: string }> = [
      {
        targetId: this.hashAuthIdentity(email),
      },
    ];

    if (context.ipAddress) {
      filters.push({ sourceIp: context.ipAddress });
    }

    const recentRequests = await this.prisma.auditLog.count({
      where: {
        action: "auth.password_reset_requested",
        createdAt: {
          gte: new Date(Date.now() - passwordResetRequestWindowMs),
        },
        OR: filters,
      },
    });

    return recentRequests >= passwordResetRequestLimit;
  }

  private async recordPasswordResetRequest(
    email: string,
    userId: string | null,
    context: AuthRequestContext,
    resultStatus: "queued" | "rate_limited",
  ): Promise<void> {
    await this.safeCreateAuditLog({
      workspaceId: null,
      actorUserId: userId,
      actorType: userId ? "user" : "anonymous",
      action: "auth.password_reset_requested",
      targetType: "AuthIdentity",
      targetId: this.hashAuthIdentity(email),
      reason:
        resultStatus === "rate_limited"
          ? "Limite de recuperacao de senha atingido"
          : null,
      sourceIp: context.ipAddress ?? null,
      resultStatus,
      beforeSummary: null,
      afterSummary: {
        delivery: this.getTokenDelivery(),
        userAgent: context.userAgent ?? null,
      },
    });
  }

  private async isEmailVerificationRequestRateLimited(
    userId: string,
    context: AuthRequestContext,
  ): Promise<boolean> {
    const filters: Array<{ targetId?: string; sourceIp?: string }> = [
      { targetId: userId },
    ];

    if (context.ipAddress) {
      filters.push({ sourceIp: context.ipAddress });
    }

    const recentRequests = await this.prisma.auditLog.count({
      where: {
        action: "auth.email_verification_requested",
        createdAt: {
          gte: new Date(Date.now() - emailVerificationRequestWindowMs),
        },
        OR: filters,
      },
    });

    return recentRequests >= emailVerificationRequestLimit;
  }

  private async recordEmailVerificationRequest(
    userId: string,
    context: AuthRequestContext,
    resultStatus: "queued" | "rate_limited" | "already_verified",
  ): Promise<void> {
    await this.safeCreateAuditLog({
      workspaceId: null,
      actorUserId: userId,
      actorType: "user",
      action: "auth.email_verification_requested",
      targetType: "User",
      targetId: userId,
      reason:
        resultStatus === "rate_limited"
          ? "Limite de verificacao de email atingido"
          : null,
      sourceIp: context.ipAddress ?? null,
      resultStatus,
      beforeSummary: null,
      afterSummary: {
        delivery: this.getTokenDelivery(),
        userAgent: context.userAgent ?? null,
      },
    });
  }

  private async recordLoginFailure(
    email: string,
    context: AuthRequestContext,
  ): Promise<void> {
    await this.safeCreateAuditLog({
      workspaceId: null,
      actorUserId: null,
      actorType: "anonymous",
      action: "auth.login_failed",
      targetType: "AuthIdentity",
      targetId: this.hashAuthIdentity(email),
      reason: "Credenciais invalidas",
      sourceIp: context.ipAddress ?? null,
      resultStatus: "failed",
      beforeSummary: null,
      afterSummary: {
        userAgent: context.userAgent ?? null,
      },
    });
  }

  private async recordLoginSuccess(
    session: AuthSessionResult,
    context: AuthRequestContext,
  ): Promise<void> {
    await this.safeCreateAuditLog({
      workspaceId: session.activeWorkspaceId,
      actorUserId: session.user.id,
      actorType: "user",
      action: "auth.login_succeeded",
      targetType: "User",
      targetId: session.user.id,
      reason: null,
      sourceIp: context.ipAddress ?? null,
      resultStatus: "success",
      beforeSummary: null,
      afterSummary: {
        authProvider: session.user.authProvider,
        userAgent: context.userAgent ?? null,
      },
    });
  }

  private async safeCreateAuditLog(input: {
    workspaceId: string | null;
    actorUserId: string | null;
    actorType: string;
    action: string;
    targetType: string;
    targetId: string;
    reason: string | null;
    sourceIp: string | null;
    resultStatus: string;
    beforeSummary: unknown;
    afterSummary: unknown;
  }): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          actorType: input.actorType,
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId,
          reason: input.reason,
          sourceIp: input.sourceIp,
          resultStatus: input.resultStatus,
          beforeSummary:
            input.beforeSummary === null
              ? undefined
              : (input.beforeSummary as Prisma.InputJsonValue),
          afterSummary:
            input.afterSummary === null
              ? undefined
              : (input.afterSummary as Prisma.InputJsonValue),
        },
      });
    } catch {
      this.logger.error(
        `Falha ao registrar auditoria de autenticacao; action=${input.action} targetType=${input.targetType} targetId=${input.targetId}`,
      );
    }
  }

  private createOAuthState(redirectTo?: string): string {
    const payload = Buffer.from(
      JSON.stringify({
        redirectTo: this.safeRedirectPath(redirectTo ?? "/overview"),
        nonce: randomBytes(16).toString("hex"),
      }),
    ).toString("base64url");
    const signature = this.signOAuthStatePayload(payload);

    return `${payload}.${signature}`;
  }

  private readOAuthRedirect(state: string): string {
    const [payload, signature] = state.split(".");

    if (
      !payload ||
      !signature ||
      !this.isValidOAuthStateSignature(payload, signature)
    ) {
      return "/overview";
    }

    try {
      const decoded = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as {
        redirectTo?: unknown;
      };

      return this.safeRedirectPath(decoded.redirectTo);
    } catch {
      return "/overview";
    }
  }

  private safeRedirectPath(path: unknown): string {
    return typeof path === "string" &&
      path.startsWith("/") &&
      !path.startsWith("//")
      ? path
      : "/overview";
  }

  private signOAuthStatePayload(payload: string): string {
    return createHmac("sha256", this.getOAuthStateSecret())
      .update(payload)
      .digest("base64url");
  }

  private isValidOAuthStateSignature(
    payload: string,
    signature: string,
  ): boolean {
    const expected = Buffer.from(this.signOAuthStatePayload(payload));
    const received = Buffer.from(signature);

    return (
      expected.length === received.length && timingSafeEqual(expected, received)
    );
  }

  private getOAuthStateSecret(): string {
    return (
      this.env.GOOGLE_OAUTH_STATE_SECRET ??
      this.env.JWT_REFRESH_SECRET ??
      this.env.GOOGLE_CLIENT_SECRET ??
      "wpptrack-dev-oauth-state-secret"
    );
  }

  private async createActionToken(
    user: { id: string; email: string; name: string | null },
    type: AuthActionTokenType,
    ttlMs: number,
  ): Promise<PasswordResetRequestDto | EmailVerificationStartDto> {
    const token = randomBytes(32).toString("hex");
    const actionToken = await this.prisma.$transaction(async (tx) => {
      await tx.authActionToken.updateMany({
        where: {
          userId: user.id,
          type,
          usedAt: null,
        },
        data: {
          usedAt: new Date(),
        },
      });
      return tx.authActionToken.create({
        data: {
          userId: user.id,
          type,
          tokenHash: this.hashActionToken(token),
          expiresAt: new Date(Date.now() + ttlMs),
        },
      });
    });

    if (this.emailQueue?.isEnabled()) {
      try {
        await this.emailQueue.enqueue({
          workspaceId: null,
          action: {
            type: "AuthActionToken",
            id: actionToken.id,
            version: "1",
          },
          envelope:
            type === "password_reset"
              ? {
                  to: {
                    address: user.email,
                    name: user.name ?? undefined,
                  },
                  template: "password_reset",
                  data: {
                    recipientName: user.name ?? undefined,
                    token,
                    expiresAt: actionToken.expiresAt.toISOString(),
                  },
                }
              : {
                  to: {
                    address: user.email,
                    name: user.name ?? undefined,
                  },
                  template: "email_verification",
                  data: {
                    recipientName: user.name ?? undefined,
                    token,
                    expiresAt: actionToken.expiresAt.toISOString(),
                  },
                },
        });
      } catch {
        await this.safeCreateAuditLog({
          workspaceId: null,
          actorUserId: user.id,
          actorType: "system",
          action: "auth.action_email_queue_failed",
          targetType: "AuthActionToken",
          targetId: actionToken.id,
          reason: "Transactional email queue unavailable",
          sourceIp: null,
          resultStatus: "failed",
          beforeSummary: null,
          afterSummary: { type },
        });
      }
    }

    return {
      ok: true,
      delivery: this.getTokenDelivery(),
      devToken: this.shouldExposeDevTokens() ? token : null,
    };
  }

  private async consumeActionTokenInTransaction(
    tx: Prisma.TransactionClient,
    type: AuthActionTokenType,
    token: string,
    now: Date,
  ): Promise<AuthActionTokenRecord> {
    const tokenHash = this.hashActionToken(token);
    const record = (await tx.authActionToken.findFirst({
      where: {
        type,
        tokenHash,
      },
    })) as AuthActionTokenRecord | null;

    if (
      !record ||
      record.usedAt ||
      record.expiresAt.getTime() <= now.getTime()
    ) {
      throw new BadRequestException("Token invalido ou expirado");
    }

    const consumed = await tx.authActionToken.updateMany({
      where: {
        id: record.id,
        type,
        tokenHash,
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });

    if (consumed.count !== 1) {
      throw new BadRequestException("Token invalido ou expirado");
    }

    return record;
  }

  private getTokenDelivery(): "email_queued" | "not_configured" {
    return this.emailQueue?.isEnabled() ? "email_queued" : "not_configured";
  }

  private invalidAccountActivation(): BadRequestException {
    return new BadRequestException("Link de ativacao invalido ou expirado");
  }

  private async assertAccountActivationCandidate(token: string): Promise<void> {
    const record = await this.prisma.authActionToken.findFirst({
      where: {
        type: "account_activation",
        tokenHash: this.hashActionToken(token),
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: {
        userId: true,
        workspaceId: true,
        user: {
          select: { passwordHash: true, platformRole: true },
        },
      },
    });

    if (!record || record.user.passwordHash) {
      throw this.invalidAccountActivation();
    }

    if (
      !record.workspaceId &&
      record.user.platformRole === "platform_operator"
    ) {
      return;
    }

    if (!record.workspaceId) {
      throw this.invalidAccountActivation();
    }

    const membership = await this.prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: record.workspaceId,
          userId: record.userId,
        },
      },
      select: { role: true },
    });

    if (membership?.role !== "owner") {
      throw this.invalidAccountActivation();
    }
  }

  private shouldExposeDevTokens(): boolean {
    return (
      this.env.AUTH_EXPOSE_DEV_TOKENS === "true" &&
      this.env.NODE_ENV !== "production"
    );
  }

  private hashActionToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private invalidCredentials(): UnauthorizedException {
    return new UnauthorizedException("Credenciais invalidas");
  }
}
