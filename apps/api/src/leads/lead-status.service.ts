import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  ConversionEventNameDto,
  LeadStatusDto,
  LeadStatusUpdateResultDto,
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { ConversionEventsQueueService } from "../common/queue/conversion-events-queue.service";
import { ConversionEventsService } from "../conversion-events/conversion-events.service";

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
          eventName: { in: ["QualifiedLead", "Purchase"] },
          sourceTrigger: { not: "manual_test" },
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
        metaSend: {
          outcome: "not_applicable",
          eventName: null,
          conversionEventLogId: null,
          errorCode: null,
        },
      };
    }

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
    const logId = recorded.created[0] ?? recorded.duplicates[0] ?? null;

    if (recorded.created.length === 0) {
      return {
        status: input.status,
        metaSend: {
          outcome: "already_recorded",
          eventName,
          conversionEventLogId: logId,
          errorCode: null,
        },
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
        status: input.status,
        metaSend: {
          outcome: "not_eligible",
          eventName,
          conversionEventLogId: logId,
          errorCode: log?.errorCode ?? null,
        },
      };
    }

    await this.conversionEventsQueue.enqueueSend(readyLogId, input.workspaceId);

    return {
      status: input.status,
      metaSend: {
        outcome: "queued",
        eventName,
        conversionEventLogId: readyLogId,
        errorCode: null,
      },
    };
  }
}
