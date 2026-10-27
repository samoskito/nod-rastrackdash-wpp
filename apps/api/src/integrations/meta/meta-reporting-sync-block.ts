import type { Prisma } from "@prisma/client";

/**
 * Reporting-only circuit breaker state (MetaReportingAccount
 * reportingSyncBlockedAt / reportingSyncBlockReason).
 *
 * It deliberately never touches credential/connection/integration status,
 * validationError or lastValidatedAt: CAPI and CTWA routing read those, and a
 * reporting failure must never stop conversions.
 */

type ReportingAccountClient = {
  metaReportingAccount: {
    updateMany(args: {
      where: Prisma.MetaReportingAccountWhereInput;
      data: Prisma.MetaReportingAccountUpdateManyMutationInput;
    }): Promise<unknown>;
  };
};

/** Prisma filter for accounts the report sync may call Meta for. */
export const REPORTING_SYNC_UNBLOCKED = {
  reportingSyncBlockedAt: null,
} as const;

export async function blockMetaReportingSync(
  client: ReportingAccountClient,
  where: Prisma.MetaReportingAccountWhereInput,
  input: { reason: string; message: string; now?: Date },
): Promise<void> {
  await client.metaReportingAccount.updateMany({
    where: { ...where, reportingSyncBlockedAt: null },
    data: {
      reportingSyncBlockedAt: input.now ?? new Date(),
      reportingSyncBlockReason: input.reason.slice(0, 200),
      syncStatus: "error",
      syncError: input.message,
    },
  });
}

/**
 * Called by revalidation/reconnect/"Testar" flows. Best effort: a failure
 * here must not fail the user-facing revalidation.
 */
export async function clearMetaReportingSyncBlocks(
  client: unknown,
  where: Prisma.MetaReportingAccountWhereInput,
): Promise<void> {
  try {
    await (client as ReportingAccountClient).metaReportingAccount.updateMany({
      where: { ...where, reportingSyncBlockedAt: { not: null } },
      data: {
        reportingSyncBlockedAt: null,
        reportingSyncBlockReason: null,
        syncStatus: "pending",
        syncError: null,
      },
    });
  } catch {
    // Next revalidation or sync attempt can clear it again.
  }
}
