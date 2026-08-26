import type { PlatformRole } from "@prisma/client";
import {
  acquirePlatformAdminLock,
  platformAdminTransactionOptions,
} from "./platform-admin-lock";
import {
  assertBcryptCompatiblePassword,
  PasswordService,
} from "./password.service";

type BootstrapUser = {
  id: string;
  email: string;
  passwordHash: string | null;
  platformRole: PlatformRole | null;
};

type BootstrapPrisma = {
  $transaction: <T>(
    callback: (tx: BootstrapPrisma) => Promise<T>,
    options?: unknown,
  ) => Promise<T>;
  $executeRaw: (...args: unknown[]) => Promise<unknown>;
  user: {
    findUnique: (args: unknown) => Promise<BootstrapUser | null>;
    create: (args: unknown) => Promise<BootstrapUser>;
    update: (args: unknown) => Promise<BootstrapUser>;
    count: (args: unknown) => Promise<number>;
  };
  auditLog?: {
    create: (args: unknown) => Promise<unknown>;
  };
};

export type PlatformAdminBootstrapInput = {
  email: string;
  password: string;
  confirmExisting?: boolean;
};

export type PlatformAdminBootstrapResult = {
  email: string;
  userId: string;
  platformRole: "platform_owner";
  createdUser: boolean;
  changedRole: boolean;
  passwordPreserved: boolean;
};

export function validatePlatformAdminBootstrapInput(
  input: PlatformAdminBootstrapInput,
): string {
  const email = normalizeEmail(input.email);

  if (!isEmail(email) || input.password.length < 8) {
    throw new Error("Informe email valido e senha com 8+ caracteres.");
  }
  assertBcryptCompatiblePassword(input.password);

  return email;
}

/**
 * Creates the persistent first platform owner without creating a workspace.
 * Existing accounts are intentionally left untouched unless the caller
 * explicitly confirms a role promotion. Existing passwords are never replaced.
 */
export async function bootstrapPlatformAdminUser(
  prisma: BootstrapPrisma,
  input: PlatformAdminBootstrapInput,
  passwordService = new PasswordService(),
): Promise<PlatformAdminBootstrapResult> {
  const email = validatePlatformAdminBootstrapInput(input);

  return prisma.$transaction(async (tx) => {
    await acquirePlatformAdminLock(tx as never);

    const existing = await tx.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        platformRole: true,
      },
    });
    const ownerCount = await tx.user.count({
      where: { platformRole: "platform_owner" },
    });

    if (ownerCount > 1) {
      throw new Error(
        "Invariante de proprietarios invalida. Corrija a plataforma antes do bootstrap.",
      );
    }

    if (ownerCount === 1) {
      if (existing?.platformRole === "platform_owner") {
        await auditBootstrap(
          tx,
          existing.id,
          "idempotent",
          existing.platformRole,
        );
        return result(existing, false, false);
      }

      throw new Error(
        "Bootstrap fechado: ja existe um proprietario de plataforma. Use a administracao autenticada para alterar papeis.",
      );
    }

    if (existing) {
      if (!input.confirmExisting) {
        throw new Error(
          "Usuario existente nao alterado. Confirme explicitamente a promocao.",
        );
      }

      const updated = await tx.user.update({
        where: { id: existing.id },
        data: {
          platformRole: "platform_owner",
          ...(existing.passwordHash === null
            ? {
                passwordHash: await passwordService.hash(input.password),
                authProvider: "email",
                emailVerifiedAt: new Date(),
              }
            : {}),
        },
        select: {
          id: true,
          email: true,
          passwordHash: true,
          platformRole: true,
        },
      });

      await auditBootstrap(tx, updated.id, "promoted", updated.platformRole);
      return result(updated, false, true, existing.passwordHash !== null);
    }

    const passwordHash = await passwordService.hash(input.password);
    const created = await tx.user.create({
      data: {
        email,
        passwordHash,
        authProvider: "email",
        emailVerifiedAt: new Date(),
        platformRole: "platform_owner",
      },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        platformRole: true,
      },
    });

    await auditBootstrap(tx, created.id, "created", created.platformRole);
    return result(created, true, true, false);
  }, platformAdminTransactionOptions);
}

function result(
  user: BootstrapUser,
  createdUser: boolean,
  changedRole: boolean,
  passwordPreserved = !createdUser && user.passwordHash !== null,
): PlatformAdminBootstrapResult {
  return {
    email: user.email,
    userId: user.id,
    platformRole: "platform_owner",
    createdUser,
    changedRole,
    passwordPreserved,
  };
}

async function auditBootstrap(
  prisma: BootstrapPrisma,
  userId: string,
  outcome: "created" | "promoted" | "idempotent",
  platformRole: PlatformRole | null,
): Promise<void> {
  await prisma.auditLog?.create({
    data: {
      workspaceId: null,
      actorUserId: null,
      actorType: "system_cli",
      action: "platform.bootstrap_owner",
      targetType: "User",
      targetId: userId,
      resultStatus: "success",
      afterSummary: { outcome, platformRole },
    },
  });
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
