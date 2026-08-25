import { Prisma, type Prisma as PrismaTypes } from "@prisma/client";

type PlatformAdminLockTransaction = Pick<
  PrismaTypes.TransactionClient,
  "$queryRaw"
>;

const platformAdminLockNamespace = 147_203_911;
const platformAdminLockKey = 619_470_281;

/**
 * One lock for the single installation database. Every Fase 1 platform-role
 * write takes it, so owner cardinality is evaluated and mutated atomically.
 */
export async function acquirePlatformAdminLock(
  transaction: PlatformAdminLockTransaction,
): Promise<void> {
  // pg_advisory_xact_lock returns void. Selecting it directly is valid; casting
  // that void result is not. Prisma binds both lock IDs as query parameters.
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(
      CAST(${platformAdminLockNamespace} AS integer),
      CAST(${platformAdminLockKey} AS integer)
    )
  `;
}

export const platformAdminTransactionOptions = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 10_000,
  timeout: 20_000,
} as const;
