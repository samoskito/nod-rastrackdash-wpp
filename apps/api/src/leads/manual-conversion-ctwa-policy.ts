import type { Prisma } from "@prisma/client";
import { MANUAL_CONVERSION_TRIGGER } from "@wpptrack/shared";
import { resolveCtwaLeadProof } from "../conversion-rules/ctwa-lead-proof";
import type { AuthorizedCtwaDestination } from "../inbound-webhooks/authorized-ctwa-destination";
import {
  MANUAL_CONVERSION_AUDIT_CREATE,
  MANUAL_CONVERSION_AUDIT_TARGET,
  readManualSourcePayload,
} from "./manual-conversion-payload";

export const MANUAL_CTWA_CONTEXT_INVALID = "manual_ctwa_context_invalid";

type ManualCtwaLog = {
  id: string;
  workspaceId: string | null;
  leadId: string | null;
  phoneHash: string | null;
  ctwaClid: string | null;
  adId: string | null;
  sourceTrigger?: string;
  sourcePayload: Prisma.JsonValue | null;
};

/**
 * Send-time re-validation of a manual conversion travelling to an
 * authorized CTWA (page/pixel) destination, inside the sender's claim
 * transaction: the lead must STILL have exactly this verified entry proof
 * (same channel/connection/destination as recorded), and the conversion must
 * carry the audit record of the owner/admin who registered it. Anything else
 * is refused before any Meta effect.
 */
export async function manualCtwaConversionAuthorized(
  tx: Prisma.TransactionClient,
  log: ManualCtwaLog,
  intent: AuthorizedCtwaDestination,
): Promise<boolean> {
  if (
    log.sourceTrigger !== MANUAL_CONVERSION_TRIGGER ||
    !log.workspaceId ||
    log.workspaceId !== intent.workspaceId ||
    !log.leadId ||
    !log.phoneHash ||
    !log.ctwaClid ||
    log.adId
  )
    return false;
  const payload = readManualSourcePayload(log.sourcePayload);
  if (!payload || payload.channelId !== intent.channelId) return false;
  const proof = await resolveCtwaLeadProof(tx, {
    workspaceId: intent.workspaceId,
    leadId: log.leadId,
    phoneHash: log.phoneHash,
    ctwaClid: log.ctwaClid,
    channelId: intent.channelId,
    connectionId: intent.connectionId,
  });
  if (!proof || JSON.stringify(proof) !== JSON.stringify(intent)) return false;
  const audit = await tx.auditLog.findFirst({
    where: {
      workspaceId: intent.workspaceId,
      action: MANUAL_CONVERSION_AUDIT_CREATE,
      targetType: MANUAL_CONVERSION_AUDIT_TARGET,
      targetId: log.id,
      actorUserId: payload.createdByUserId,
      resultStatus: "success",
    },
    select: { id: true },
  });
  return Boolean(audit);
}
