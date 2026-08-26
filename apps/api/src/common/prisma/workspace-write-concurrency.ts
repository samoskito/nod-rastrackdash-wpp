import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { acquirePlatformRoleLock } from "./platform-role-concurrency";

const workspaceSlugLockNamespace = 147_203_911;
const workspaceSlugLockKey = 731_884_217;
const workspaceSlugRetryLimit = 3;

type QueryRawTransaction = Pick<
  Prisma.TransactionClient,
  "$queryRaw" | "$executeRaw"
>;

export async function acquireWorkspaceSlugLock(
  transaction: QueryRawTransaction,
): Promise<void> {
  // Keep slug allocation serialized across registration and backoffice writes.
  // The lock is transaction-scoped, so it is released on commit or rollback.
  if (typeof transaction.$queryRaw !== "function") {
    throw new Error("PostgreSQL transaction is required for workspace writes");
  }

  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(
      CAST(${workspaceSlugLockNamespace} AS integer),
      CAST(${workspaceSlugLockKey} AS integer)
    )
  `;
}

/**
 * Acquires the installation-wide locks in one canonical order. User creation
 * and workspace creation both re-read their unique and platform-role state
 * after these locks are held, so their decisions share one serialization
 * boundary with platform-admin mutations.
 */
export async function acquirePlatformWorkspaceWriteLocks(
  transaction: QueryRawTransaction,
): Promise<void> {
  await acquirePlatformRoleLock(transaction);
  await acquireWorkspaceSlugLock(transaction);
}

export async function withWorkspaceUniqueRetry<T>(
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= workspaceSlugRetryLimit; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const constraint = knownWorkspaceWriteConstraint(error);
      if (!constraint) {
        throw error;
      }

      if (constraint === "user_email") {
        throw new ConflictException("Email ja cadastrado");
      }

      if (constraint === "workspace_slug") {
        if (attempt < workspaceSlugRetryLimit) {
          continue;
        }

        throw new ConflictException(
          "Nao foi possivel reservar um identificador unico para o workspace",
        );
      }
    }
  }

  throw new ConflictException("Conflito ao persistir o workspace");
}

type WorkspaceWriteConstraint = "user_email" | "workspace_slug";

function knownWorkspaceWriteConstraint(
  error: unknown,
): WorkspaceWriteConstraint | null {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
    ? exactUniqueTarget(error, ["email"])
      ? "user_email"
      : exactUniqueTarget(error, ["slug"])
        ? "workspace_slug"
        : null
    : null;
}

function exactUniqueTarget(
  error: unknown,
  expected: readonly string[],
): boolean {
  if (typeof error !== "object" || error === null || !("meta" in error)) {
    return false;
  }

  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  if (Array.isArray(target)) {
    return (
      target.length === expected.length &&
      target.every((field, index) => field === expected[index])
    );
  }

  return expected.length === 1 && target === expected[0];
}
