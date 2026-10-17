import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  ConversionEventNameDto,
  LeadManualMetaSendDto,
  LeadStatusDto,
  LeadStatusUpdateResultDto,
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { ConversionEventsQueueService } from "../common/queue/conversion-events-queue.service";
import {
  ConversionEventsService,
  MANUAL_STATUS_TRIGGER,
  META_LEAD_FORM_CRM_TRIGGER,
} from "../conversion-events/conversion-events.service";

/** Status the operator can set that also tells Meta about the lead. */
const META_EVENT_BY_STATUS: Partial<
  Record<LeadStatusDto, ConversionEventNameDto>
> = {
  qualified: "QualifiedLead",
};

/** Once Meta has the qualification, the lead cannot go back to these. */
const STATUSES_BEFORE_QUALIFICATION: ReadonlySet<LeadStatusDto> = new Set([
  "new",
  "active",
  "lost",
]);

const NOT_APPLICABLE: LeadManualMetaSendDto = {
  outcome: "not_applicable",
  eventName: null,
  conversionEventLogId: null,
  errorCode: null,
  errorMessage: null,
};

type StatusLead = {
  id: string;
  phoneHash: string;
  campaignId: string | null;
  adSetId: string | null;
  adId: string | null;
  ctwaClid: string | null;
};

export type UpdateLeadStatusInput = {
  workspaceId: string;
  leadId: string;
  status: LeadStatusDto;
  actorUserId: string;
};

@Injectable()
export class LeadStatusService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConversionEventsService)
    private readonly conversionEvents: ConversionEventsService,
    @Inject(ConversionEventsQueueService)
    private readonly conversionEventsQueue: ConversionEventsQueueService,
  ) {}

  async updateStatus(
    input: UpdateLeadStatusInput,
  ): Promise<LeadStatusUpdateResultDto> {
    const lead = await this.prisma.lead.findFirst({
      where: { id: input.leadId, workspaceId: input.workspaceId },
      select: {
        id: true,
        phoneHash: true,
        campaignId: true,
        adSetId: true,
        adId: true,
        ctwaClid: true,
      },
    });

    if (!lead) {
      throw new NotFoundException("Lead nao encontrado");
    }

    if (STATUSES_BEFORE_QUALIFICATION.has(input.status)) {
      // The lead screen derives the status from the events, so a recorded
      // qualification would win anyway: refuse instead of pretending.
      const qualification = await this.prisma.conversionEventLog.findFirst({
        where: {
          workspaceId: input.workspaceId,
          leadId: lead.id,
          sourceTrigger: { not: "manual_test" },
          OR: [
            { eventName: { in: ["QualifiedLead", "Purchase"] } },
            // The CRM stage has the connection's own event name, and an
            // imported Dashboard Leads send keeps the name it was sent with.
            { sourceTrigger: { in: [META_LEAD_FORM_CRM_TRIGGER, MANUAL_STATUS_TRIGGER] } },
          ],
        },
        select: { id: true },
      });

      if (qualification) {
        throw new ConflictException(
          "Lead ja qualificado com evento registrado; o status nao pode voltar",
        );
      }
    }

    await this.prisma.lead.update({
      where: { id: lead.id },
      data: {
        status: input.status,
        statusChangedAt: new Date(),
        statusChangedByUserId: input.actorUserId,
      },
    });

    const eventName = META_EVENT_BY_STATUS[input.status];
    if (!eventName) {
      return {
        status: input.status,
        metaSend: NOT_APPLICABLE,
        crmSend: null,
      };
    }

    const submission = await this.prisma.metaLeadSubmission.findFirst({
      where: {
        workspaceId: input.workspaceId,
        leadId: lead.id,
        fetchStatus: "fetched",
      },
      orderBy: [{ metaCreatedAt: "desc" }, { createdAt: "desc" }],
      select: { id: true },
    });
    // A form-only lead has no WhatsApp conversation: only the CRM event applies.
    const metaSend =
      lead.ctwaClid || !submission
        ? await this.sendMessagingEvent(input, lead, eventName)
        : NOT_APPLICABLE;
    const crmSend = submission
      ? await this.sendCrmEvent(input, lead, submission.id)
      : null;

    return { status: input.status, metaSend, crmSend };
  }

  private async sendMessagingEvent(
    input: UpdateLeadStatusInput,
    lead: StatusLead,
    eventName: ConversionEventNameDto,
  ): Promise<LeadManualMetaSendDto> {
    const recorded = await this.conversionEvents.recordManualStatusConversion({
      workspaceId: input.workspaceId,
      leadId: lead.id,
      phoneHash: lead.phoneHash,
      eventName,
      actorUserId: input.actorUserId,
      campaignId: lead.campaignId,
      adSetId: lead.adSetId,
      adId: lead.adId,
      ctwaClid: lead.ctwaClid,
    });

    return this.dispatch(input.workspaceId, eventName, recorded, null);
  }

  private async sendCrmEvent(
    input: UpdateLeadStatusInput,
    lead: StatusLead,
    submissionId: string,
  ): Promise<LeadManualMetaSendDto> {
    const recorded = await this.conversionEvents.recordLeadFormCrmConversion({
      workspaceId: input.workspaceId,
      leadId: lead.id,
      phoneHash: lead.phoneHash,
      submissionId,
      actorUserId: input.actorUserId,
    });
    const logId = recorded.created[0] ?? recorded.duplicates[0] ?? null;
    const log = logId
      ? await this.prisma.conversionEventLog.findUnique({
          where: { id: logId },
          select: { eventName: true },
        })
      : null;

    return this.dispatch(
      input.workspaceId,
      log?.eventName ?? null,
      recorded,
      recorded.errorMessage,
    );
  }

  private async dispatch(
    workspaceId: string,
    eventName: string | null,
    recorded: { created: string[]; duplicates: string[] },
    errorMessage: string | null,
  ): Promise<LeadManualMetaSendDto> {
    const logId = recorded.created[0] ?? recorded.duplicates[0] ?? null;

    if (recorded.created.length === 0) {
      return {
        outcome: "already_recorded",
        eventName,
        conversionEventLogId: logId,
        errorCode: null,
        errorMessage: null,
      };
    }

    const [readyLogId] = await this.conversionEvents.listReadyLogIds(
      recorded.created,
    );

    if (!readyLogId) {
      const log = logId
        ? await this.prisma.conversionEventLog.findUnique({
            where: { id: logId },
            select: { errorCode: true },
          })
        : null;

      return {
        outcome: "not_eligible",
        eventName,
        conversionEventLogId: logId,
        errorCode: log?.errorCode ?? null,
        errorMessage,
      };
    }

    await this.conversionEventsQueue.enqueueSend(readyLogId, workspaceId);

    return {
      outcome: "queued",
      eventName,
      conversionEventLogId: readyLogId,
      errorCode: null,
      errorMessage: null,
    };
  }
}
