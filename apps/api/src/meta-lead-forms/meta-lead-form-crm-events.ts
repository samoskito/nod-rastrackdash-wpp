import { Prisma } from "@prisma/client";
import type { EncryptedMetaToken } from "../integrations/meta/meta-token-encryption.service";
import { manualDispatchingSince } from "../leads/manual-conversion-payload";
import {
  buildCrmEventBody,
  crmDedupeKey,
  crmEventId,
  crmIneligibility,
  META_LEAD_FORM_CRM_TRIGGER,
  postCrmEvent,
} from "./meta-crm-capi";

/**
 * Fase 6.9 (PR #91 do nod): record and send the CRM stage of a Meta
 * instant-form submission. Called by ConversionEventsService (record, and the
 * sendReadyEvent branch) and, through it, by the manual conversion (#158) and
 * the CRM Kanban (#176): the old "Qualificado" button (#90) does not exist.
 */

type CrmClient = Pick<
  Prisma.TransactionClient,
  "metaLeadSubmission" | "conversionEventLog"
>;

const submissionWithConnection = {
  include: { connection: true },
} as const;

export type LeadFormCrmSubmission = Prisma.MetaLeadSubmissionGetPayload<
  typeof submissionWithConnection
>;

/** Latest submission read on the Graph of these leads (same person). */
export async function findLatestLeadFormSubmission(
  client: Pick<Prisma.TransactionClient, "metaLeadSubmission">,
  workspaceId: string,
  leadIds: string[],
): Promise<LeadFormCrmSubmission | null> {
  if (leadIds.length === 0) return null;
  return client.metaLeadSubmission.findFirst({
    where: {
      workspaceId,
      leadId: { in: leadIds },
      fetchStatus: "fetched",
    },
    orderBy: [{ metaCreatedAt: "desc" }, { createdAt: "desc" }],
    ...submissionWithConnection,
  });
}

export type LeadFormCrmPreview = {
  eventName: string;
  willSend: boolean;
  /** Portuguese reason when it will not be sent. */
  reason: string | null;
};

/** Read-only: what recording the CRM stage would do now. */
export async function previewLeadFormCrmStage(
  client: CrmClient,
  submission: LeadFormCrmSubmission,
  now: Date = new Date(),
): Promise<LeadFormCrmPreview> {
  const eventName = submission.connection.qualifiedEventName;
  const eventId = crmEventId(submission.metaLeadId, eventName);
  const existing = await client.conversionEventLog.findUnique({
    where: { dedupeKey: crmDedupeKey(submission.workspaceId, eventId) },
    select: { id: true },
  });
  if (existing)
    return {
      eventName,
      willSend: false,
      reason: "A etapa deste formulário já foi registrada; nada será reenviado.",
    };
  if (!submission.connection.active)
    return {
      eventName,
      willSend: false,
      reason: "Conexão de formulários pausada em Integrações.",
    };
  const ineligible = crmIneligibility(
    {
      metaLeadId: submission.metaLeadId,
      createdAt: submission.metaCreatedAt ?? submission.createdAt,
      datasetId: submission.connection.crmDatasetId,
      eventName,
    },
    now,
  );
  return { eventName, willSend: !ineligible, reason: ineligible };
}

export type RecordLeadFormCrmResult = {
  created: string[];
  duplicates: string[];
  eventName: string;
  status: string;
  errorMessage: string | null;
};

/**
 * One CRM event per submission and event name: event_id
 * `{metaLeadId}:{eventName}` (the Dashboard Leads format, so Meta drops a
 * duplicate of what that tool already sent) and dedupe key
 * `{ws}:meta_lead_form_crm:{event_id}` (the Dashboard Leads import writes the
 * same key, so an imported stage is never sent again).
 */
export async function recordLeadFormCrmConversion(
  client: CrmClient,
  input: {
    workspaceId: string;
    leadId: string;
    phoneHash: string;
    customerIdentityKey: string | null;
    submission: LeadFormCrmSubmission;
    actorUserId: string;
    qualifiedAt: Date;
    /** Where it came from: the manual conversion log that triggered it. */
    originConversionEventLogId?: string | null;
  },
  now: Date = new Date(),
): Promise<RecordLeadFormCrmResult> {
  const { submission } = input;
  const eventName = submission.connection.qualifiedEventName;
  const eventId = crmEventId(submission.metaLeadId, eventName);
  const dedupeKey = crmDedupeKey(input.workspaceId, eventId);
  const existing = await client.conversionEventLog.findUnique({
    where: { dedupeKey },
    select: { id: true, status: true },
  });
  if (existing)
    return {
      created: [],
      duplicates: [existing.id],
      eventName,
      status: existing.status,
      errorMessage: null,
    };

  const ineligible = crmIneligibility(
    {
      metaLeadId: submission.metaLeadId,
      createdAt: submission.metaCreatedAt ?? submission.createdAt,
      datasetId: submission.connection.crmDatasetId,
      eventName,
    },
    now,
  );
  // A missing dataset is a configuration block, fixable in Integrações and
  // resent by "Reenviar bloqueados" (the send re-reads the connection). The
  // other reasons (28-day window, forbidden event, bad lead id) never change.
  const missingDataset = !submission.connection.crmDatasetId;
  const status = missingDataset
    ? "not_configured"
    : ineligible
      ? "not_eligible"
      : "ready_to_send";

  try {
    const log = await client.conversionEventLog.create({
      data: {
        workspaceId: input.workspaceId,
        leadId: input.leadId,
        phoneHash: input.phoneHash,
        eventOccurredAt: input.qualifiedAt,
        customerIdentityKey: input.customerIdentityKey,
        businessSource: "paid",
        sourceTrigger: META_LEAD_FORM_CRM_TRIGGER,
        eventName,
        status,
        pixelId: submission.connection.crmDatasetId,
        pageId: submission.pageId,
        eventId,
        campaignId: submission.campaignId,
        adSetId: submission.adSetId,
        adId: submission.adId,
        attributionStatus: submission.adId ? "attributed" : "missing_ad_id",
        dedupeKey,
        sourceEventId: submission.metaLeadId,
        sourcePayload: {
          connectionId: submission.connectionId,
          submissionId: submission.id,
          actorUserId: input.actorUserId,
          ...(input.originConversionEventLogId
            ? { originConversionEventLogId: input.originConversionEventLogId }
            : {}),
        },
        customData: Prisma.JsonNull,
        errorCode: missingDataset
          ? "MissingMetaDestination"
          : ineligible
            ? "MetaCrmNotEligible"
            : null,
        errorMessage: ineligible,
      },
      select: { id: true },
    });
    return {
      created: [log.id],
      duplicates: [],
      eventName,
      status,
      errorMessage: ineligible,
    };
  } catch (error) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== "P2002"
    )
      throw error;
    const duplicate = await client.conversionEventLog.findUnique({
      where: { dedupeKey },
      select: { id: true, status: true },
    });
    if (!duplicate) throw error;
    return {
      created: [],
      duplicates: [duplicate.id],
      eventName,
      status: duplicate.status,
      errorMessage: null,
    };
  }
}

export type LeadFormCrmSendLog = {
  id: string;
  workspaceId: string | null;
  eventName: string;
  eventOccurredAt: Date;
  sourcePayload: Prisma.JsonValue | null;
};

export type LeadFormCrmSendResult = {
  conversionEventLogId: string;
  workspaceId: string | null;
  status: "not_configured" | "sent" | "error" | "skipped";
  errorCode?:
    | "MissingMetaDestination"
    | "MetaCapiRejected"
    | "MetaCapiNetworkError"
    | "MetaCapiDeliveryUnknown";
  errorMessage: string | null;
};

/**
 * Posts a ready CRM event to the dataset of its connection, with the dataset
 * token (or the Graph token when none). Never the messaging route, never the
 * CAPI micro-batch (another dataset and token). A missing configuration is
 * "not_configured / MissingMetaDestination", which "Reenviar bloqueados"
 * resends after the fix. Single send: the log is claimed (ready_to_send ->
 * dispatching) before the post, like the manual conversion; a claim lost to
 * another worker skips, and a send interrupted mid-way is moved to
 * delivery_unknown by the manual dispatch recovery (never resent blindly).
 */
export async function sendLeadFormCrmEvent(
  deps: {
    prisma: Pick<Prisma.TransactionClient, "metaLeadSubmission" | "conversionEventLog">;
    decrypt: (token: EncryptedMetaToken) => string;
    graphVersion: string;
    fetcher?: typeof fetch;
  },
  log: LeadFormCrmSendLog,
  eventId: string,
  options: { testEventCode?: string | null } = {},
): Promise<LeadFormCrmSendResult> {
  const source =
    log.sourcePayload &&
    typeof log.sourcePayload === "object" &&
    !Array.isArray(log.sourcePayload)
      ? (log.sourcePayload as Record<string, unknown>)
      : {};
  const submission =
    log.workspaceId && typeof source.submissionId === "string"
      ? await deps.prisma.metaLeadSubmission.findFirst({
          where: { id: source.submissionId, workspaceId: log.workspaceId },
          ...submissionWithConnection,
        })
      : null;
  const connection = submission?.connection;
  const block = async (errorMessage: string): Promise<LeadFormCrmSendResult> => {
    await deps.prisma.conversionEventLog.updateMany({
      where: { id: log.id, status: "ready_to_send" },
      data: {
        status: "not_configured",
        errorCode: "MissingMetaDestination",
        errorMessage,
      },
    });
    return {
      conversionEventLogId: log.id,
      workspaceId: log.workspaceId,
      status: "not_configured",
      errorCode: "MissingMetaDestination",
      errorMessage,
    };
  };

  if (!submission || !connection)
    return block("Formulário do lead não encontrado");
  if (!connection.active)
    return block("Conexão de formulários pausada em Integrações");
  if (!connection.crmDatasetId)
    return block("Conexão sem dataset do CRM configurado");

  let token: string;
  try {
    token = deps.decrypt(
      connection.capiTokenEncrypted &&
        connection.capiTokenIv &&
        connection.capiTokenTag
        ? {
            encryptedAccessToken: connection.capiTokenEncrypted,
            tokenIv: connection.capiTokenIv,
            tokenTag: connection.capiTokenTag,
          }
        : {
            encryptedAccessToken: connection.graphTokenEncrypted,
            tokenIv: connection.graphTokenIv,
            tokenTag: connection.graphTokenTag,
          },
    );
  } catch {
    return block("Token da conexão ilegível; cadastre de novo");
  }

  const claimed = await deps.prisma.conversionEventLog.updateMany({
    where: { id: log.id, status: "ready_to_send" },
    data: {
      status: "dispatching",
      errorCode: "MetaCapiDeliveryUnknown",
      // Read by the stuck-dispatch recovery (no updatedAt column).
      errorMessage: manualDispatchingSince(new Date()),
    },
  });
  if (claimed.count !== 1)
    return {
      conversionEventLogId: log.id,
      workspaceId: log.workspaceId,
      status: "skipped",
      errorMessage: null,
    };

  const result = await postCrmEvent({
    datasetId: connection.crmDatasetId,
    token,
    version: deps.graphVersion,
    fetcher: deps.fetcher,
    body: buildCrmEventBody({
      lead: {
        metaLeadId: submission.metaLeadId,
        email: submission.email,
        phone: submission.phone,
        createdAt: submission.metaCreatedAt ?? submission.createdAt,
      },
      eventName: log.eventName,
      eventId,
      qualifiedAt: log.eventOccurredAt,
      testEventCode: options.testEventCode ?? null,
    }),
  });

  await deps.prisma.conversionEventLog.updateMany({
    where: { id: log.id, status: "dispatching" },
    data: {
      status: result.status,
      sentAt: result.status === "sent" ? new Date() : null,
      pixelId: connection.crmDatasetId,
      providerRequestPayload: result.requestPayload as Prisma.InputJsonValue,
      providerResponseSummary: result.responseSummary
        ? (result.responseSummary as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    },
  });

  return {
    conversionEventLogId: log.id,
    workspaceId: log.workspaceId,
    status: result.status,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    errorMessage: result.errorMessage,
  };
}
