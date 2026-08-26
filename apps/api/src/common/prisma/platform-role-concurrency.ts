import { Prisma } from "@prisma/client";

type PlatformRoleLockTransaction = Pick<
  Prisma.TransactionClient,
  "$executeRaw"
>;

const platformRoleLockNamespace = 147_203_911;
const platformRoleLockKey = 619_470_281;

/**
 * Serializes every mutation that can change the installation-level
 * platformRole invariant. The lock is transaction-scoped and is released by
 * PostgreSQL on commit or rollback.
 */
export async function acquirePlatformRoleLock(
  transaction: PlatformRoleLockTransaction,
): Promise<void> {
  if (typeof transaction.$executeRaw !== "function") {
    throw new Error(
      "PostgreSQL transaction is required for platform-role writes",
    );
  }

  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(
      CAST(${platformRoleLockNamespace} AS integer),
      CAST(${platformRoleLockKey} AS integer)
    )
  `;
}

export const platformRoleTransactionOptions = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 10_000,
  timeout: 20_000,
} as const;
