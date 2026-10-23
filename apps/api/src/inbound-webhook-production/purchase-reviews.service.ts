import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  PurchaseReviewDecisionInputDto,
  PurchaseReviewDto,
  PurchaseReviewItemsUpdateInputDto,
  PurchaseReviewListDto,
  PurchaseReviewListQueryDto,
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { ProviderConversionReviewApprovalService } from "../conversion-rules/provider-conversion-review-approval.service";
import { dateRangeInTimezone } from "../external-data/external-event-policy";

const purchaseReviewTimezone = "America/Sao_Paulo";
const hiddenReviewReasonCodes = [
  "empty_template_ignored",
  "ignored_untracked_lead",
] as const;
const visibleReviewReasonWhere = {
  OR: [
    { reasonCode: null },
    { reasonCode: { notIn: [...hiddenReviewReasonCodes] } },
  ],
} satisfies Prisma.PurchaseReviewWhereInput;

const actionableStatuses = ["review_required", "recognized", "failed"] as const;

const historyStatuses = [
  "approved",
  "sent",
  "duplicate",
  "rejected",
  "failed",
  "corrected_after_send",
] as const;

const reviewInclude = {
  providerRule: {
    include: {
      conversionRule: true,
      catalog: {
        include: {
          variants: true,
        },
      },
    },
  },
  channel: true,
  lead: true,
  conversionEventLog: {
    select: { status: true },
  },
  items: { orderBy: { position: "asc" } },
} satisfies Prisma.PurchaseReviewInclude;

type ReviewRecord = Prisma.PurchaseReviewGetPayload<{
  include: typeof reviewInclude;
}>;

@Injectable()
export class PurchaseReviewsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProviderConversionReviewApprovalService)
    private readonly canonicalApproval: ProviderConversionReviewApprovalService,
  ) {}

  async list(
    workspaceId: string,
    query: PurchaseReviewListQueryDto,
  ): Promise<PurchaseReviewListDto> {
    const statusWhere: Prisma.PurchaseReviewWhereInput = query.status
      ? { status: query.status }
      : query.view === "actionable"
        ? { status: { in: [...actionableStatuses] } }
        : query.view === "history"
          ? { status: { in: [...historyStatuses] } }
          : {};
    const where: Prisma.PurchaseReviewWhereInput = {
      workspaceId,
      AND: [visibleReviewReasonWhere],
      ...statusWhere,
      ...(query.providerRuleId ? { providerRuleId: query.providerRuleId } : {}),
      ...(query.channelId ? { channelId: query.channelId } : {}),
      ...this.dateWhere(query.since, query.until),
    };
    const skip = (query.page - 1) * query.pageSize;
    const [reviews, totalItems, pendingCount] = await Promise.all([
      this.prisma.purchaseReview.findMany({
        where,
        include: reviewInclude,
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        skip,
        take: query.pageSize,
      }),
      this.prisma.purchaseReview.count({ where }),
      this.prisma.purchaseReview.count({
        where: {
          workspaceId,
          AND: [visibleReviewReasonWhere],
          status: { in: [...actionableStatuses] },
        },
      }),
    ]);

    return {
      reviews: reviews.map((review) => this.toDto(review)),
      pendingCount,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / query.pageSize),
      },
    };
  }

  async get(workspaceId: string, reviewId: string): Promise<PurchaseReviewDto> {
    return this.toDto(await this.requireReview(workspaceId, reviewId));
  }

  async updateItems(
    workspaceId: string,
    reviewId: string,
    input: PurchaseReviewItemsUpdateInputDto,
    actorUserId: string,
  ): Promise<PurchaseReviewDto> {
    await this.prisma.$transaction(async (transaction) => {
      const review = await this.requireReview(
        workspaceId,
        reviewId,
        transaction,
      );
      const correctedAfterSend = review.conversionEventLog?.status === "sent";
      if (review.conversionEventLogId && !correctedAfterSend) {
        throw new ConflictException(
          "A compra já está na fila da Meta e não pode ser alterada agora",
        );
      }
      if (
        !correctedAfterSend &&
        ![...actionableStatuses, "approved"].includes(
          review.status as (typeof actionableStatuses)[number] | "approved",
        )
      ) {
        throw new ConflictException("Esta compra não aceita mais edição");
      }

      const resolved = this.resolveItems(review, input);
      const previousValueCents = review.effectiveValueCents;
      await transaction.purchaseReviewItem.deleteMany({
        where: { workspaceId, purchaseReviewId: review.id },
      });
      await transaction.purchaseReviewItem.createMany({
        data: resolved.items.map((item, index) => ({
          workspaceId,
          purchaseReviewId: review.id,
          position: index + 1,
          catalogVariantWorkspaceId: workspaceId,
          catalogVariantId: item.variant.id,
          attributeValues: item.attributeValues as Prisma.InputJsonValue,
          quantity: item.quantity,
          unitValueCents: item.variant.valueCents,
          subtotalValueCents: item.subtotalValueCents,
          contentName: item.contentName,
        })),
      });

      if (correctedAfterSend) {
        if (!previousValueCents || !review.conversionEventLogId) {
          throw new ConflictException(
            "O evento enviado não possui valor original auditável",
          );
        }
        await transaction.purchaseValueAdjustment.create({
          data: {
            workspaceId,
            purchaseReviewId: review.id,
            conversionEventLogId: review.conversionEventLogId,
            previousValueCents,
            effectiveValueCents: resolved.totalValueCents,
            actorUserId,
            reason: input.reason,
          },
        });
      }

      const updated = await transaction.purchaseReview.updateMany({
        where: { id: review.id, workspaceId, version: review.version },
        data: {
          status: correctedAfterSend ? "corrected_after_send" : "recognized",
          classificationCode: "recognized",
          reasonCode: null,
          calculatedValueCents: resolved.totalValueCents,
          effectiveValueCents: resolved.totalValueCents,
          decisionReason: input.reason,
          decidedByUserId: actorUserId,
          decidedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException(
          "A revisão mudou enquanto era editada. Atualize a página.",
        );
      }

      await this.audit(transaction, {
        workspaceId,
        actorUserId,
        action: correctedAfterSend
          ? "purchase_review.corrected_after_send"
          : "purchase_review.items_updated",
        reviewId,
        reason: input.reason,
        beforeValueCents: previousValueCents,
        afterValueCents: resolved.totalValueCents,
      });
    });

    return this.get(workspaceId, reviewId);
  }

  async reject(
    workspaceId: string,
    reviewId: string,
    input: PurchaseReviewDecisionInputDto,
    actorUserId: string,
  ): Promise<PurchaseReviewDto> {
    await this.prisma.$transaction(async (transaction) => {
      const review = await this.requireReview(
        workspaceId,
        reviewId,
        transaction,
      );
      if (
        review.conversionEventLogId ||
        ![...actionableStatuses, "approved"].includes(
          review.status as (typeof actionableStatuses)[number] | "approved",
        )
      ) {
        throw new ConflictException("Esta compra não pode mais ser rejeitada");
      }

      await transaction.purchaseReview.update({
        where: { id: review.id },
        data: {
          status: "rejected",
          reasonCode: "rejected_by_user",
          decisionReason: input.reason,
          decidedByUserId: actorUserId,
          decidedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (review.providerExecutionId) {
        await transaction.providerConversionRuleExecution.updateMany({
          where: {
            id: review.providerExecutionId,
            workspaceId,
            status: { in: ["observed", "eligible", "blocked", "failed"] },
          },
          data: {
            status: "blocked",
            reasonCode: "purchase_review_rejected",
            processedAt: new Date(),
          },
        });
      }
      await this.audit(transaction, {
        workspaceId,
        actorUserId,
        action: "purchase_review.rejected",
        reviewId,
        reason: input.reason,
        beforeValueCents: review.effectiveValueCents,
        afterValueCents: null,
      });
    });

    return this.get(workspaceId, reviewId);
  }

  async prepareApproval(
    workspaceId: string,
    reviewId: string,
    input: PurchaseReviewDecisionInputDto,
    actorUserId: string,
  ): Promise<{ providerConversionExecutionId: string }> {
    const canonical = await this.canonicalApproval.prepareApproval({
      workspaceId,
      reviewId,
      decision: input,
      actorUserId,
    });
    if (canonical) return canonical;

    return this.prisma.$transaction(async (transaction) => {
      const review = await this.requireReview(
        workspaceId,
        reviewId,
        transaction,
      );
      if (review.conversionEventLogId) {
        throw new ConflictException("Esta compra já possui um evento Meta");
      }
      const catalogReview =
        review.providerRule.conversionRule.triggerType === "structured_catalog";
      if (
        ![...actionableStatuses, "approved"].includes(
          review.status as (typeof actionableStatuses)[number] | "approved",
        ) ||
        !review.providerExecutionId ||
        !review.effectiveValueCents ||
        (catalogReview &&
          (review.items.length === 0 ||
            review.items.some(
              (item) =>
                !item.catalogVariantId ||
                !item.unitValueCents ||
                !item.subtotalValueCents,
            )))
      ) {
        throw new BadRequestException(
          "Revise todos os itens e valores antes de aprovar",
        );
      }

      const updated = await transaction.purchaseReview.updateMany({
        where: { id: review.id, workspaceId, version: review.version },
        data: {
          status: "approved",
          reasonCode: null,
          decisionReason: input.reason,
          decidedByUserId: actorUserId,
          decidedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException(
          "A revisão mudou enquanto era aprovada. Atualize a página.",
        );
      }
      await transaction.providerConversionRuleExecution.update({
        where: { id: review.providerExecutionId },
        data: {
          status: "eligible",
          reasonCode: "purchase_review_approved",
          valueCents: review.effectiveValueCents,
          currency: review.currency,
          processedAt: null,
        },
      });
      await this.audit(transaction, {
        workspaceId,
        actorUserId,
        action: "purchase_review.approved",
        reviewId,
        reason: input.reason,
        beforeValueCents: review.effectiveValueCents,
        afterValueCents: review.effectiveValueCents,
      });

      return {
        providerConversionExecutionId: review.providerExecutionId,
      };
    });
  }

  private resolveItems(
    review: ReviewRecord,
    input: PurchaseReviewItemsUpdateInputDto,
  ): {
    items: Array<{
      variant: NonNullable<
        ReviewRecord["providerRule"]["catalog"]
      >["variants"][number];
      attributeValues: string[];
      quantity: number;
      subtotalValueCents: number;
      contentName: string;
    }>;
    totalValueCents: number;
  } {
    const catalog = review.providerRule.catalog;
    if (!catalog?.active) {
      throw new ConflictException("O catalogo desta regra nao esta ativo");
    }
    const variants = new Map(
      catalog.variants
        .filter((variant) => variant.active)
        .map((variant) => [variant.id, variant]),
    );
    const items = input.items.map((item) => {
      const variant = variants.get(item.catalogVariantId);
      if (!variant) {
        throw new BadRequestException(
          "Uma das variantes não pertence ao catálogo desta regra",
        );
      }
      const attributeValues = this.stringArray(variant.attributeValues);
      return {
        variant,
        attributeValues,
        quantity: item.quantity,
        subtotalValueCents: variant.valueCents * item.quantity,
        contentName:
          variant.contentName ??
          `${catalog.productName} | ${attributeValues.join(" | ")}`.slice(
            0,
            180,
          ),
      };
    });
    const totalValueCents = items.reduce(
      (total, item) => total + item.subtotalValueCents,
      0,
    );
    if (!Number.isSafeInteger(totalValueCents) || totalValueCents <= 0) {
      throw new BadRequestException("O total da compra é inválido");
    }
    return { items, totalValueCents };
  }

  private requireReview(
    workspaceId: string,
    reviewId: string,
    client: Pick<Prisma.TransactionClient, "purchaseReview"> = this.prisma,
  ): Promise<ReviewRecord> {
    return client.purchaseReview
      .findFirst({
        where: { id: reviewId, workspaceId },
        include: reviewInclude,
      })
      .then((review) => {
        if (!review)
          throw new NotFoundException("Revisão de compra não encontrada");
        return review;
      });
  }

  private toDto(review: ReviewRecord): PurchaseReviewDto {
    return {
      id: review.id,
      workspaceId: review.workspaceId,
      providerRuleId: review.providerRuleId,
      ruleName: review.providerRule.conversionRule.name,
      sourceDeliveryId: review.sourceDeliveryId,
      channelId: review.channelId,
      channelName:
        review.channel?.channelName ?? review.channel?.connectedPhone ?? null,
      occurredAt: review.occurredAt.toISOString(),
      sourceType: review.sourceType,
      messageAuthorType: review.messageAuthorType,
      matchedTriggerPhrase: review.matchedTriggerPhrase,
      status: review.status,
      classificationCode: review.classificationCode,
      reasonCode: review.reasonCode,
      leadId: review.leadId,
      leadName: review.lead?.name ?? null,
      phoneDisplay: review.lead?.phoneDisplay ?? null,
      items: review.items.map((item) => ({
        id: item.id,
        position: item.position,
        catalogVariantId: item.catalogVariantId,
        attributeValues: this.stringArray(item.attributeValues),
        quantity: item.quantity,
        unitValueCents: item.unitValueCents,
        subtotalValueCents: item.subtotalValueCents,
        contentName: item.contentName,
      })),
      calculatedValueCents: review.calculatedValueCents,
      effectiveValueCents: review.effectiveValueCents,
      observedPaymentValueCents: review.observedPaymentValueCents,
      currency: review.currency,
      conversionEventLogId: review.conversionEventLogId,
      decisionReason: review.decisionReason,
      decidedAt: review.decidedAt?.toISOString() ?? null,
      createdAt: review.createdAt.toISOString(),
      updatedAt: review.updatedAt.toISOString(),
    };
  }

  private dateWhere(
    since?: string,
    until?: string,
  ): Pick<Prisma.PurchaseReviewWhereInput, "occurredAt"> {
    if (!since && !until) return {};
    return {
      occurredAt: dateRangeInTimezone(since, until, purchaseReviewTimezone),
    };
  }

  private stringArray(value: Prisma.JsonValue): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  }

  private async audit(
    transaction: Prisma.TransactionClient,
    input: {
      workspaceId: string;
      actorUserId: string;
      action: string;
      reviewId: string;
      reason: string;
      beforeValueCents: number | null;
      afterValueCents: number | null;
    },
  ): Promise<void> {
    await transaction.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        actorType: "user",
        action: input.action,
        targetType: "PurchaseReview",
        targetId: input.reviewId,
        reason: input.reason,
        resultStatus: "success",
        beforeSummary: {
          effectiveValueCents: input.beforeValueCents,
        },
        afterSummary: {
          effectiveValueCents: input.afterValueCents,
        },
      },
    });
  }
}
