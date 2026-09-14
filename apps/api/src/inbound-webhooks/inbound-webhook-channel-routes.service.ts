import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  InboundWebhookChannelCreateInputDto,
  InboundWebhookChannelDto,
  InboundWebhookChannelReadinessBlockerDto,
  InboundWebhookChannelReadinessDto,
  InboundWebhookChannelRouteDto,
  InboundWebhookChannelRouteInputDto,
  InboundWebhookChannelRoutesUpdateInputDto,
  InboundWebhookChannelStatusUpdateInputDto,
} from "@wpptrack/shared";
import { normalizePhoneIdentity } from "../common/phone/phone-identity";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  type InboundWebhookMetaRoutePreview,
  InboundWebhookMetaRouteReaderService,
} from "./inbound-webhook-meta-route-reader.service";
import {
  applyInboundWebhookChannelStatus,
  channelActivationInclude,
  type ExternalChannelSeatHook,
  metaRouteRequiredForProvider,
  requireInboundWebhookChannel,
  resourceNotFoundMessage,
} from "./inbound-webhook-production-activation";
import {
  provisionalChannelOrganizationId,
  provisionalChannelProviderChannelId,
} from "./inbound-webhook-provisional-channel";

const validRouteStatus = "valid";
const removedRouteStatus = "inactive";
const removedRouteReason = "route_removed";
const payloadExpiryWarningMs = 48 * 60 * 60 * 1_000;

const channelInclude = channelActivationInclude;

type PersistedChannel = Prisma.InboundWebhookChannelGetPayload<{
  include: typeof channelInclude;
}>;

type PersistedRoute = Prisma.InboundWebhookChannelRouteGetPayload<object>;

const channelReadinessEventSelect = {
  channelId: true,
  deliveryId: true,
  classification: true,
  replayItem: {
    select: {
      status: true,
    },
  },
  productionItem: {
    select: {
      status: true,
    },
  },
  delivery: {
    select: {
      payloadExpiresAt: true,
    },
  },
} satisfies Prisma.InboundWebhookEventSelect;

type ChannelReadinessEvent = Prisma.InboundWebhookEventGetPayload<{
  select: typeof channelReadinessEventSelect;
}>;

type NormalizedRouteInput = {
  routeKey: string;
  metaBusinessConnectionId: string;
  metaReportingAccountId: string | null;
  metaConversionDestinationId: string | null;
};

type RouteDecision =
  | {
      classification: "eligible_route_resolved";
      reason: "route_resolved";
      preview: ResolvedMetaRoutePreview;
    }
  | {
      classification: "eligible_route_unresolved";
      reason: string;
      conflict: boolean;
    };

type ResolvedMetaRoutePreview = InboundWebhookMetaRoutePreview & {
  status: "resolved";
  businessConnectionId: string;
  reportingAccountId: string;
  conversionDestinationId: string;
};

export type InboundWebhookRouteReevaluationResult = {
  examinedCount: number;
  updatedCount: number;
  resolvedCount: number;
  unresolvedCount: number;
  conflictCount: number;
};

@Injectable()
export class InboundWebhookChannelRoutesService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(InboundWebhookMetaRouteReaderService)
    private readonly metaRouteReader: InboundWebhookMetaRouteReaderService,
  ) {}

  async listChannels(
    workspaceId: string,
    connectionId: string,
  ): Promise<InboundWebhookChannelDto[]> {
    await this.requireConnection(this.prisma, workspaceId, connectionId);

    const channels = await this.prisma.inboundWebhookChannel.findMany({
      where: {
        workspaceId,
        connectionId,
      },
      include: channelInclude,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const readinessByChannel = await this.loadChannelReadiness(
      workspaceId,
      connectionId,
      channels,
    );

    return channels.map((channel) =>
      this.toChannelDto(channel, readinessByChannel.get(channel.id)),
    );
  }

  /**
   * Lets a manager register the connected number before any webhook has
   * arrived (P0.2), so conversion rules can be created immediately instead
   * of waiting for the first live lead. See inbound-webhook-provisional-channel.ts
   * for the placeholder identity strategy and how a later real webhook
   * merges into this same channel row.
   */
  async createProvisionalChannel(
    workspaceId: string,
    connectionId: string,
    input: InboundWebhookChannelCreateInputDto,
    actorUserId: string,
  ): Promise<InboundWebhookChannelDto> {
    const connection = await this.requireCreatableConnection(
      workspaceId,
      connectionId,
    );
    const normalizedPhone = normalizePhoneIdentity(input.connectedPhone);

    if (!normalizedPhone) {
      throw new BadRequestException("Numero de telefone invalido");
    }

    const channelName = input.channelName?.trim() || null;
    const now = new Date();

    const channel = await this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.inboundWebhookChannel.findFirst({
        where: {
          workspaceId,
          connectionId: connection.id,
          connectedPhone: normalizedPhone,
        },
        include: channelInclude,
      });

      if (existing) {
        if (!channelName || existing.channelName) {
          return existing;
        }

        return transaction.inboundWebhookChannel.update({
          where: { id: existing.id },
          data: { channelName },
          include: channelInclude,
        });
      }

      const created = await transaction.inboundWebhookChannel.create({
        data: {
          workspaceId,
          connectionId: connection.id,
          organizationId: provisionalChannelOrganizationId(connection.id),
          providerChannelId:
            provisionalChannelProviderChannelId(normalizedPhone),
          connectedPhone: normalizedPhone,
          channelName,
          status: "discovered",
          conversionEngineMode: "canonical",
          firstSeenAt: now,
          lastSeenAt: now,
        },
        include: channelInclude,
      });

      await this.createAudit(transaction, {
        workspaceId,
        actorUserId,
        action: "inbound_webhook.channel_provisioned",
        targetType: "InboundWebhookChannel",
        targetId: created.id,
        resultStatus: "created",
        beforeSummary: { channelId: null },
        afterSummary: this.channelRoutesAuditSummary(created, []),
      });

      return created;
    });

    const readinessByChannel = await this.loadChannelReadiness(
      workspaceId,
      connection.id,
      [channel],
    );

    return this.toChannelDto(channel, readinessByChannel.get(channel.id));
  }

  async replaceRoutes(
    workspaceId: string,
    channelId: string,
    input: InboundWebhookChannelRoutesUpdateInputDto,
    actorUserId: string,
  ): Promise<InboundWebhookChannelRouteDto[]> {
    const routes = await this.prisma.$transaction(async (transaction) => {
      const channel = await this.requireChannel(
        transaction,
        workspaceId,
        channelId,
      );
      const before = await transaction.inboundWebhookChannelRoute.findMany({
        where: {
          workspaceId,
          channelId,
          active: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      const normalizedRoutes = this.uniqueRouteInputs(input.routes);

      for (const route of normalizedRoutes) {
        await this.validateRouteReferences(transaction, workspaceId, route);
      }

      const validatedAt = new Date();
      const routeKeys = normalizedRoutes.map((route) => route.routeKey);
      await transaction.inboundWebhookChannelRoute.updateMany({
        where: {
          workspaceId,
          channelId,
          active: true,
          ...(routeKeys.length > 0
            ? {
                routeKey: {
                  notIn: routeKeys,
                },
              }
            : {}),
        },
        data: {
          active: false,
          validationStatus: removedRouteStatus,
          validationErrorCode: removedRouteReason,
          lastValidatedAt: validatedAt,
        },
      });

      for (const route of normalizedRoutes) {
        await transaction.inboundWebhookChannelRoute.upsert({
          where: {
            channelId_routeKey: {
              channelId,
              routeKey: route.routeKey,
            },
          },
          create: {
            workspaceId,
            channelId,
            routeKey: route.routeKey,
            metaBusinessConnectionWorkspaceId: workspaceId,
            metaBusinessConnectionId: route.metaBusinessConnectionId,
            metaReportingAccountWorkspaceId: route.metaReportingAccountId
              ? workspaceId
              : null,
            metaReportingAccountId: route.metaReportingAccountId,
            metaConversionDestinationWorkspaceId:
              route.metaConversionDestinationId ? workspaceId : null,
            metaConversionDestinationId: route.metaConversionDestinationId,
            active: true,
            validationStatus: validRouteStatus,
            validationErrorCode: null,
            lastValidatedAt: validatedAt,
            createdByUserId: actorUserId,
          },
          update: {
            metaBusinessConnectionWorkspaceId: workspaceId,
            metaBusinessConnectionId: route.metaBusinessConnectionId,
            metaReportingAccountWorkspaceId: route.metaReportingAccountId
              ? workspaceId
              : null,
            metaReportingAccountId: route.metaReportingAccountId,
            metaConversionDestinationWorkspaceId:
              route.metaConversionDestinationId ? workspaceId : null,
            metaConversionDestinationId: route.metaConversionDestinationId,
            active: true,
            validationStatus: validRouteStatus,
            validationErrorCode: null,
            lastValidatedAt: validatedAt,
          },
        });
      }

      const after = await transaction.inboundWebhookChannelRoute.findMany({
        where: {
          workspaceId,
          channelId,
          active: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });

      await this.createAudit(transaction, {
        workspaceId,
        actorUserId,
        action: "inbound_webhook.channel_routes_replaced",
        targetType: "InboundWebhookChannel",
        targetId: channel.id,
        resultStatus: "updated",
        beforeSummary: this.channelRoutesAuditSummary(channel, before),
        afterSummary: this.channelRoutesAuditSummary(channel, after),
      });

      return after;
    });

    await this.reevaluateOpenEvents(workspaceId, channelId);
    return routes.map((route) => this.toRouteDto(route));
  }

  async removeRoute(
    workspaceId: string,
    channelId: string,
    routeId: string,
    actorUserId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const channel = await this.requireChannel(
        transaction,
        workspaceId,
        channelId,
      );
      const route = await transaction.inboundWebhookChannelRoute.findFirst({
        where: {
          id: routeId,
          workspaceId,
          channelId,
          active: true,
        },
      });

      if (!route) {
        this.throwNotFound();
      }

      const changed = await transaction.inboundWebhookChannelRoute.updateMany({
        where: {
          id: routeId,
          workspaceId,
          channelId,
          active: true,
        },
        data: {
          active: false,
          validationStatus: removedRouteStatus,
          validationErrorCode: removedRouteReason,
          lastValidatedAt: new Date(),
        },
      });

      if (changed.count !== 1) {
        this.throwNotFound();
      }

      await this.createAudit(transaction, {
        workspaceId,
        actorUserId,
        action: "inbound_webhook.channel_route_removed",
        targetType: "InboundWebhookChannelRoute",
        targetId: route.id,
        resultStatus: "removed",
        beforeSummary: this.routeAuditSummary(route),
        afterSummary: this.routeAuditSummary({
          ...route,
          active: false,
          validationStatus: removedRouteStatus,
          validationErrorCode: removedRouteReason,
        }),
      });

      void channel;
    });

    await this.reevaluateOpenEvents(workspaceId, channelId);
  }

  async updateChannelStatus(
    workspaceId: string,
    channelId: string,
    input: InboundWebhookChannelStatusUpdateInputDto,
    actorUserId: string,
  ): Promise<InboundWebhookChannelDto> {
    await this.prisma.$transaction(async (transaction) => {
      const current = await this.requireChannel(
        transaction,
        workspaceId,
        channelId,
      );

      return applyInboundWebhookChannelStatus(transaction, {
        workspaceId,
        channelId,
        status: input.status,
        actorUserId,
        requireValidMetaRoute: metaRouteRequiredForProvider(
          current.connection.provider,
        ),
        seats: this.seatHook(),
      });
    });

    await this.reevaluateOpenEvents(workspaceId, channelId);
    const refreshed = await this.requireChannel(
      this.prisma,
      workspaceId,
      channelId,
    );
    const readinessByChannel = await this.loadChannelReadiness(
      workspaceId,
      refreshed.connectionId,
      [refreshed],
    );

    return this.toChannelDto(refreshed, readinessByChannel.get(refreshed.id));
  }

  async reevaluateUnresolvedEvents(
    workspaceId: string,
    channelId: string,
  ): Promise<InboundWebhookRouteReevaluationResult> {
    return this.reevaluateEvents(workspaceId, channelId, [
      "eligible_route_unresolved",
    ]);
  }

  async reevaluateOpenEvents(
    workspaceId: string,
    channelId: string,
  ): Promise<InboundWebhookRouteReevaluationResult> {
    return this.reevaluateEvents(workspaceId, channelId, [
      "eligible_route_resolved",
      "eligible_route_unresolved",
    ]);
  }

  async reevaluateWorkspaceOpenEvents(
    workspaceId: string,
  ): Promise<InboundWebhookRouteReevaluationResult> {
    const channels = await this.prisma.inboundWebhookChannel.findMany({
      where: {
        workspaceId,
        events: {
          some: {
            classification: {
              in: ["eligible_route_resolved", "eligible_route_unresolved"],
            },
            replayItem: null,
            productionItem: null,
          },
        },
      },
      select: { id: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const total: InboundWebhookRouteReevaluationResult = {
      examinedCount: 0,
      updatedCount: 0,
      resolvedCount: 0,
      unresolvedCount: 0,
      conflictCount: 0,
    };

    for (const channel of channels) {
      const result = await this.reevaluateOpenEvents(workspaceId, channel.id);

      total.examinedCount += result.examinedCount;
      total.updatedCount += result.updatedCount;
      total.resolvedCount += result.resolvedCount;
      total.unresolvedCount += result.unresolvedCount;
      total.conflictCount += result.conflictCount;
    }

    return total;
  }

  private async reevaluateEvents(
    workspaceId: string,
    channelId: string,
    classifications: Array<
      "eligible_route_resolved" | "eligible_route_unresolved"
    >,
  ): Promise<InboundWebhookRouteReevaluationResult> {
    let channel = await this.requireChannel(
      this.prisma,
      workspaceId,
      channelId,
    );
    const events = await this.prisma.inboundWebhookEvent.findMany({
      where: {
        workspaceId,
        channelId,
        classification: { in: classifications },
        replayItem: null,
        productionItem: null,
      },
      select: {
        id: true,
        adId: true,
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    });

    const learnedRoute = await this.learnRoutesFromEvents(
      channel,
      events.map((event) => event.adId),
    );

    if (learnedRoute) {
      channel = await this.requireChannel(this.prisma, workspaceId, channelId);
    }

    const decisions: Array<{
      eventId: string;
      decision: RouteDecision;
    }> = [];
    for (const event of events) {
      decisions.push({
        eventId: event.id,
        decision: await this.evaluateEventRoute(channel, event.adId),
      });
    }

    let updatedCount = 0;
    let resolvedCount = 0;
    let unresolvedCount = 0;
    let conflictCount = 0;

    if (decisions.length > 0) {
      await this.prisma.$transaction(async (transaction) => {
        for (const { eventId, decision } of decisions) {
          const changed = await transaction.inboundWebhookEvent.updateMany({
            where: {
              id: eventId,
              workspaceId,
              channelId,
              classification: { in: classifications },
              replayItem: null,
              productionItem: null,
            },
            data: this.eventRouteUpdate(workspaceId, decision),
          });

          if (changed.count !== 1) {
            continue;
          }

          updatedCount += 1;
          if (decision.classification === "eligible_route_resolved") {
            resolvedCount += 1;
          } else {
            unresolvedCount += 1;
            conflictCount += decision.conflict ? 1 : 0;
          }
        }
      });
    }

    return {
      examinedCount: events.length,
      updatedCount,
      resolvedCount,
      unresolvedCount,
      conflictCount,
    };
  }

  private async evaluateEventRoute(
    channel: PersistedChannel,
    adIdValue: string | null,
  ): Promise<RouteDecision> {
    if (channel.connection.status === "paused") {
      return this.unresolvedDecision("route_connection_paused");
    }

    if (channel.status === "paused") {
      return this.unresolvedDecision("route_channel_paused");
    }

    const adId = adIdValue?.trim();
    if (!adId) {
      return this.unresolvedDecision("route_ad_missing");
    }

    if (channel.routes.length === 0) {
      return this.unresolvedDecision("route_not_configured");
    }

    const previews: Array<
      | {
          status: "resolved";
          preview: InboundWebhookMetaRoutePreview & {
            status: "resolved";
            businessConnectionId: string;
            reportingAccountId: string;
            conversionDestinationId: string;
          };
        }
      | {
          status: "unresolved";
          reason: string;
        }
    > = [];

    for (const route of channel.routes) {
      if (!route.metaBusinessConnectionId) {
        previews.push({
          status: "unresolved",
          reason: "route_reference_missing",
        });
        continue;
      }

      try {
        const preview = await this.metaRouteReader.previewRoute({
          workspaceId: channel.workspaceId,
          adId,
          businessConnectionId: route.metaBusinessConnectionId,
          reportingAccountId: route.metaReportingAccountId,
          conversionDestinationId: route.metaConversionDestinationId,
        });

        if (this.previewMatchesRoute(preview, route)) {
          previews.push({
            status: "resolved",
            preview,
          });
        } else {
          previews.push({
            status: "unresolved",
            reason:
              preview.status === "unresolved"
                ? this.safeReason(preview.reason, "route_unresolved")
                : "route_preview_mismatch",
          });
        }
      } catch {
        previews.push({
          status: "unresolved",
          reason: "route_preview_failed",
        });
      }
    }

    const resolved = previews.filter(
      (
        preview,
      ): preview is Extract<
        (typeof previews)[number],
        { status: "resolved" }
      > => preview.status === "resolved",
    );

    if (resolved.length === 1) {
      return {
        classification: "eligible_route_resolved",
        reason: "route_resolved",
        preview: resolved[0].preview,
      };
    }

    if (resolved.length > 1) {
      return this.unresolvedDecision("route_conflict", true);
    }

    const reasons = new Set(
      previews
        .filter(
          (
            preview,
          ): preview is Extract<
            (typeof previews)[number],
            { status: "unresolved" }
          > => preview.status === "unresolved",
        )
        .map((preview) => preview.reason),
    );

    return this.unresolvedDecision(
      reasons.size === 1 ? [...reasons][0] : "route_unresolved",
    );
  }

  private async learnRoutesFromEvents(
    channel: PersistedChannel,
    adIdValues: Array<string | null>,
  ): Promise<boolean> {
    if (channel.connection.status === "paused" || channel.status === "paused") {
      return false;
    }

    const adIds = [
      ...new Set(
        adIdValues
          .map((adId) => adId?.trim() ?? "")
          .filter((adId) => adId.length > 0),
      ),
    ];
    const candidates = new Map<string, NormalizedRouteInput>();

    for (const adId of adIds) {
      try {
        const preview = await this.metaRouteReader.previewRoute({
          workspaceId: channel.workspaceId,
          adId,
        });

        if (!this.isResolvedPreview(preview)) {
          continue;
        }

        if (
          channel.routes.some((route) =>
            this.previewMatchesRoute(preview, route),
          )
        ) {
          continue;
        }

        const route = {
          metaBusinessConnectionId: preview.businessConnectionId,
          metaReportingAccountId: preview.reportingAccountId,
          metaConversionDestinationId: preview.conversionDestinationId,
        };
        const routeKey = this.routeKey(route);

        candidates.set(routeKey, { routeKey, ...route });
      } catch {
        // Observation stays isolated when a Meta route cannot be learned yet.
      }
    }

    if (candidates.size === 0) {
      return false;
    }

    return this.prisma.$transaction(async (transaction) => {
      const before = await transaction.inboundWebhookChannelRoute.findMany({
        where: {
          workspaceId: channel.workspaceId,
          channelId: channel.id,
          active: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      const existing = await transaction.inboundWebhookChannelRoute.findMany({
        where: {
          workspaceId: channel.workspaceId,
          channelId: channel.id,
          routeKey: { in: [...candidates.keys()] },
        },
        select: {
          routeKey: true,
          active: true,
          validationStatus: true,
        },
      });
      const existingByKey = new Map(
        existing.map((route) => [route.routeKey, route]),
      );
      let changed = false;
      const validatedAt = new Date();

      for (const route of candidates.values()) {
        const current = existingByKey.get(route.routeKey);

        if (current?.active && current.validationStatus === validRouteStatus) {
          continue;
        }

        await transaction.inboundWebhookChannelRoute.upsert({
          where: {
            channelId_routeKey: {
              channelId: channel.id,
              routeKey: route.routeKey,
            },
          },
          create: {
            workspaceId: channel.workspaceId,
            channelId: channel.id,
            routeKey: route.routeKey,
            metaBusinessConnectionWorkspaceId: channel.workspaceId,
            metaBusinessConnectionId: route.metaBusinessConnectionId,
            metaReportingAccountWorkspaceId: channel.workspaceId,
            metaReportingAccountId: route.metaReportingAccountId,
            metaConversionDestinationWorkspaceId: channel.workspaceId,
            metaConversionDestinationId: route.metaConversionDestinationId,
            active: true,
            validationStatus: validRouteStatus,
            validationErrorCode: null,
            lastValidatedAt: validatedAt,
            createdByUserId: null,
          },
          update: {
            metaBusinessConnectionWorkspaceId: channel.workspaceId,
            metaBusinessConnectionId: route.metaBusinessConnectionId,
            metaReportingAccountWorkspaceId: channel.workspaceId,
            metaReportingAccountId: route.metaReportingAccountId,
            metaConversionDestinationWorkspaceId: channel.workspaceId,
            metaConversionDestinationId: route.metaConversionDestinationId,
            active: true,
            validationStatus: validRouteStatus,
            validationErrorCode: null,
            lastValidatedAt: validatedAt,
          },
        });
        changed = true;
      }

      if (!changed) {
        return false;
      }

      const after = await transaction.inboundWebhookChannelRoute.findMany({
        where: {
          workspaceId: channel.workspaceId,
          channelId: channel.id,
          active: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });

      await this.createAudit(transaction, {
        workspaceId: channel.workspaceId,
        actorUserId: null,
        actorType: "system",
        action: "inbound_webhook.channel_routes_learned",
        targetType: "InboundWebhookChannel",
        targetId: channel.id,
        resultStatus: "updated",
        beforeSummary: this.channelRoutesAuditSummary(channel, before),
        afterSummary: this.channelRoutesAuditSummary(channel, after),
      });

      return true;
    });
  }

  private previewMatchesRoute(
    preview: InboundWebhookMetaRoutePreview,
    route: PersistedRoute,
  ): preview is ResolvedMetaRoutePreview {
    return (
      this.isResolvedPreview(preview) &&
      preview.businessConnectionId === route.metaBusinessConnectionId &&
      (route.metaReportingAccountId === null ||
        preview.reportingAccountId === route.metaReportingAccountId) &&
      (route.metaConversionDestinationId === null ||
        preview.conversionDestinationId === route.metaConversionDestinationId)
    );
  }

  private isResolvedPreview(
    preview: InboundWebhookMetaRoutePreview,
  ): preview is ResolvedMetaRoutePreview {
    return (
      preview.status === "resolved" &&
      preview.businessConnectionId !== null &&
      preview.reportingAccountId !== null &&
      preview.conversionDestinationId !== null
    );
  }

  private eventRouteUpdate(
    workspaceId: string,
    decision: RouteDecision,
  ): Prisma.InboundWebhookEventUncheckedUpdateManyInput {
    if (decision.classification === "eligible_route_resolved") {
      return {
        classification: decision.classification,
        classificationReason: decision.reason,
        resolvedBusinessConnectionWorkspaceId: workspaceId,
        resolvedBusinessConnectionId: decision.preview.businessConnectionId,
        resolvedReportingAccountWorkspaceId: workspaceId,
        resolvedReportingAccountId: decision.preview.reportingAccountId,
        resolvedConversionDestinationWorkspaceId: workspaceId,
        resolvedConversionDestinationId:
          decision.preview.conversionDestinationId,
      };
    }

    return {
      classification: decision.classification,
      classificationReason: decision.reason,
      resolvedBusinessConnectionWorkspaceId: null,
      resolvedBusinessConnectionId: null,
      resolvedReportingAccountWorkspaceId: null,
      resolvedReportingAccountId: null,
      resolvedConversionDestinationWorkspaceId: null,
      resolvedConversionDestinationId: null,
    };
  }

  private unresolvedDecision(reason: string, conflict = false): RouteDecision {
    return {
      classification: "eligible_route_unresolved",
      reason: this.safeReason(reason, "route_unresolved"),
      conflict,
    };
  }

  private safeReason(value: string, fallback: string): string {
    return /^[a-z0-9_]{1,120}$/u.test(value) ? value : fallback;
  }

  private uniqueRouteInputs(
    routes: InboundWebhookChannelRouteInputDto[],
  ): NormalizedRouteInput[] {
    const unique = new Map<string, NormalizedRouteInput>();

    for (const input of routes) {
      const metaBusinessConnectionId = input.metaBusinessConnectionId.trim();
      const metaReportingAccountId = this.normalizeOptionalId(
        input.metaReportingAccountId,
      );
      const metaConversionDestinationId = this.normalizeOptionalId(
        input.metaConversionDestinationId,
      );
      const routeKey = this.routeKey({
        metaBusinessConnectionId,
        metaReportingAccountId,
        metaConversionDestinationId,
      });

      unique.set(routeKey, {
        routeKey,
        metaBusinessConnectionId,
        metaReportingAccountId,
        metaConversionDestinationId,
      });
    }

    return [...unique.values()];
  }

  private normalizeOptionalId(value: string | null | undefined): string | null {
    if (value === null || value === undefined) {
      return null;
    }

    const normalized = value.trim();
    return normalized || null;
  }

  private routeKey(input: Omit<NormalizedRouteInput, "routeKey">): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          "v1",
          input.metaBusinessConnectionId,
          input.metaReportingAccountId,
          input.metaConversionDestinationId,
        ]),
        "utf8",
      )
      .digest("hex");
  }

  private async validateRouteReferences(
    transaction: Prisma.TransactionClient,
    workspaceId: string,
    route: NormalizedRouteInput,
  ): Promise<void> {
    const business = await transaction.metaBusinessConnection.findFirst({
      where: {
        id: route.metaBusinessConnectionId,
        workspaceId,
      },
      select: {
        id: true,
        workspaceId: true,
        status: true,
        credential: {
          select: {
            workspaceId: true,
            status: true,
          },
        },
      },
    });

    if (
      !business ||
      business.workspaceId !== workspaceId ||
      business.status !== "active" ||
      business.credential.workspaceId !== workspaceId ||
      business.credential.status !== "active"
    ) {
      this.throwNotFound();
    }

    if (route.metaReportingAccountId) {
      const account = await transaction.metaReportingAccount.findFirst({
        where: {
          id: route.metaReportingAccountId,
          workspaceId,
        },
        select: {
          id: true,
          workspaceId: true,
          businessConnectionId: true,
          active: true,
        },
      });

      if (
        !account ||
        account.workspaceId !== workspaceId ||
        !account.active ||
        account.businessConnectionId !== business.id
      ) {
        this.throwNotFound();
      }
    }

    if (route.metaConversionDestinationId) {
      const destination = await transaction.metaConversionDestination.findFirst(
        {
          where: {
            id: route.metaConversionDestinationId,
            workspaceId,
          },
          select: {
            id: true,
            workspaceId: true,
            status: true,
          },
        },
      );

      if (
        !destination ||
        destination.workspaceId !== workspaceId ||
        destination.status !== "configured"
      ) {
        this.throwNotFound();
      }
    }
  }

  private async requireConnection(
    client: Pick<PrismaService, "inboundWebhookConnection">,
    workspaceId: string,
    connectionId: string,
  ): Promise<void> {
    const connection = await client.inboundWebhookConnection.findFirst({
      where: {
        id: connectionId,
        workspaceId,
        removedAt: null,
      },
      select: {
        id: true,
      },
    });

    if (!connection) {
      this.throwNotFound();
    }
  }

  private async requireCreatableConnection(
    workspaceId: string,
    connectionId: string,
  ): Promise<{ id: string; provider: string }> {
    const connection = await this.prisma.inboundWebhookConnection.findFirst({
      where: {
        id: connectionId,
        workspaceId,
        removedAt: null,
      },
      select: {
        id: true,
        provider: true,
      },
    });

    if (!connection) {
      this.throwNotFound();
    }

    // UAZAPI/NOD channels are bridged automatically from the WhatsApp
    // instance; manual provisional creation only applies to Umbler/Gupshup.
    if (connection.provider === "uazapi") {
      throw new BadRequestException(
        "Este provedor cadastra o canal automaticamente",
      );
    }

    return connection;
  }

  private async requireChannel(
    client: Pick<PrismaService, "inboundWebhookChannel">,
    workspaceId: string,
    channelId: string,
  ): Promise<PersistedChannel> {
    return requireInboundWebhookChannel(client, workspaceId, channelId);
  }

  private throwNotFound(): never {
    throw new NotFoundException(resourceNotFoundMessage);
  }

  /**
   * Seat enforcement is resolved lazily: externalChannelEnforcementEnabled()
   * throws when enforcement is on without a seat service, so it must only run
   * at the points the activation flow actually bills a seat.
   */
  private seatHook(): ExternalChannelSeatHook {
    return {
      enforcementEnabled: () => this.externalChannelEnforcementEnabled(),
      activateSeat: () => {
        throw new Error(
          "External channel seat activation is unavailable once billing/ is removed.",
        );
      },
    };
  }

  private externalChannelEnforcementEnabled(): boolean {
    // rastrackdash sanitize (rewrite_rules.external-channel-seat-gate-noop):
    // billing/ is stripped in this edition, so external-channel seat
    // enforcement can never be enabled — hardcode the noop outcome instead
    // of inferring it from now-absent optional billing deps.
    return false;
  }

  private async loadChannelReadiness(
    workspaceId: string,
    connectionId: string,
    channels: PersistedChannel[],
  ): Promise<Map<string, InboundWebhookChannelReadinessDto>> {
    const channelIds = channels.map((channel) => channel.id);
    const now = new Date();
    const events =
      channelIds.length === 0
        ? []
        : await this.prisma.inboundWebhookEvent.findMany({
            where: {
              workspaceId,
              connectionId,
              channelId: {
                in: channelIds,
              },
              hasCtwa: true,
            },
            select: channelReadinessEventSelect,
            orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
          });
    const availableDeliveries =
      events.length === 0
        ? []
        : await this.prisma.inboundWebhookDelivery.findMany({
            where: {
              workspaceId,
              connectionId,
              id: {
                in: [...new Set(events.map((event) => event.deliveryId))],
              },
              payloadExpiresAt: {
                gt: now,
              },
              encryptedPayload: {
                not: null,
              },
              payloadIv: {
                not: null,
              },
              payloadTag: {
                not: null,
              },
              encryptionKeyVersion: {
                not: null,
              },
            },
            select: {
              id: true,
            },
          });
    const availableDeliveryIds = new Set(
      availableDeliveries.map((delivery) => delivery.id),
    );
    const eventsByChannel = new Map<string, ChannelReadinessEvent[]>();

    for (const event of events) {
      const current = eventsByChannel.get(event.channelId) ?? [];
      current.push(event);
      eventsByChannel.set(event.channelId, current);
    }

    return new Map(
      channels.map((channel) => [
        channel.id,
        this.channelReadiness(
          channel,
          eventsByChannel.get(channel.id) ?? [],
          now,
          availableDeliveryIds,
        ),
      ]),
    );
  }

  private channelReadiness(
    channel: PersistedChannel,
    events: ChannelReadinessEvent[],
    now: Date,
    availableDeliveryIds: ReadonlySet<string>,
  ): InboundWebhookChannelReadinessDto {
    const routeCount = channel.routes.length;
    const validRouteCount = channel.routes.filter(
      (route) => route.validationStatus === validRouteStatus,
    ).length;
    const routedEvents = events.filter(
      (event) => event.classification === "eligible_route_resolved",
    );
    const unresolvedEvents = events.filter(
      (event) => event.classification === "eligible_route_unresolved",
    );
    const alreadyMaterializedEvents = events.filter(
      (event) =>
        ["materialized", "duplicate"].includes(
          event.replayItem?.status ?? "",
        ) ||
        ["materialized", "duplicate"].includes(
          event.productionItem?.status ?? "",
        ),
    );
    const openEvents = events.filter(
      (event) =>
        !["materialized", "duplicate"].includes(
          event.replayItem?.status ?? "",
        ) &&
        !["materialized", "duplicate"].includes(
          event.productionItem?.status ?? "",
        ),
    );
    const retainedEvents = openEvents.filter((event) =>
      availableDeliveryIds.has(event.deliveryId),
    );
    const retainedRoutedEvents = routedEvents.filter(
      (event) =>
        event.replayItem === null &&
        event.productionItem === null &&
        availableDeliveryIds.has(event.deliveryId),
    );
    const nextPayloadExpiresAt = retainedEvents
      .map((event) => event.delivery.payloadExpiresAt)
      .sort((left, right) => left.getTime() - right.getTime())[0];
    const blockers: InboundWebhookChannelReadinessBlockerDto[] = [];

    if (channel.connection.status === "paused") {
      blockers.push("connection_paused");
    }
    if (channel.status === "paused") {
      blockers.push("channel_paused");
    }
    if (routeCount === 0) {
      blockers.push("route_not_configured");
    } else if (validRouteCount !== routeCount) {
      blockers.push("route_not_valid");
    }
    if (events.length === 0) {
      blockers.push("ctwa_not_observed");
    }
    if (unresolvedEvents.length > 0) {
      blockers.push("ctwa_unresolved");
    }
    if (openEvents.length > retainedEvents.length) {
      blockers.push("payload_unavailable");
    }
    if (
      nextPayloadExpiresAt &&
      nextPayloadExpiresAt.getTime() - now.getTime() <= payloadExpiryWarningMs
    ) {
      blockers.push("payload_expiring_soon");
    }

    const hardBlocked =
      channel.connection.status === "paused" ||
      channel.status === "paused" ||
      routeCount === 0 ||
      validRouteCount === 0;
    const state =
      events.length === 0
        ? "waiting"
        : alreadyMaterializedEvents.length === events.length
          ? "complete"
          : hardBlocked || retainedRoutedEvents.length === 0
            ? "blocked"
            : blockers.length > 0
              ? "partial"
              : "ready";

    return {
      state,
      blockers,
      routeCount,
      validRouteCount,
      totalCtwa: events.length,
      routedCtwa: routedEvents.length,
      unresolvedCtwa: unresolvedEvents.length,
      retainedCtwa: retainedEvents.length,
      retainedRoutedCtwa: retainedRoutedEvents.length,
      payloadUnavailableCtwa: openEvents.length - retainedEvents.length,
      alreadyMaterializedCtwa: alreadyMaterializedEvents.length,
      nextPayloadExpiresAt: nextPayloadExpiresAt?.toISOString() ?? null,
    };
  }

  private toChannelDto(
    channel: PersistedChannel,
    readiness?: InboundWebhookChannelReadinessDto,
  ): InboundWebhookChannelDto {
    return {
      id: channel.id,
      connectionId: channel.connectionId,
      organizationId: channel.organizationId,
      providerChannelId: channel.providerChannelId,
      connectedPhone: channel.connectedPhone,
      channelName: channel.channelName,
      whatsappInstanceId: channel.whatsappInstanceId,
      status: channel.status,
      productionActivatedAt:
        channel.productionActivatedAt?.toISOString() ?? null,
      firstSeenAt: channel.firstSeenAt.toISOString(),
      lastSeenAt: channel.lastSeenAt.toISOString(),
      routes: channel.routes.map((route) => this.toRouteDto(route)),
      readiness:
        readiness ?? this.channelReadiness(channel, [], new Date(), new Set()),
      createdAt: channel.createdAt.toISOString(),
      updatedAt: channel.updatedAt.toISOString(),
    };
  }

  private toRouteDto(route: PersistedRoute): InboundWebhookChannelRouteDto {
    return {
      id: route.id,
      channelId: route.channelId,
      metaBusinessConnectionId: route.metaBusinessConnectionId,
      metaReportingAccountId: route.metaReportingAccountId,
      metaConversionDestinationId: route.metaConversionDestinationId,
      active: route.active,
      validationStatus: route.validationStatus,
      validationErrorCode: route.validationErrorCode,
      lastValidatedAt: route.lastValidatedAt?.toISOString() ?? null,
      createdAt: route.createdAt.toISOString(),
      updatedAt: route.updatedAt.toISOString(),
    };
  }

  private channelRoutesAuditSummary(
    channel: Pick<PersistedChannel, "id" | "connectionId" | "status">,
    routes: PersistedRoute[],
  ): Prisma.InputJsonObject {
    return {
      channelId: channel.id,
      connectionId: channel.connectionId,
      channelStatus: channel.status,
      routeCount: routes.length,
      routes: routes.map((route) => this.routeAuditSummary(route)),
    };
  }

  private routeAuditSummary(
    route: Pick<
      PersistedRoute,
      | "id"
      | "channelId"
      | "metaBusinessConnectionId"
      | "metaReportingAccountId"
      | "metaConversionDestinationId"
      | "active"
      | "validationStatus"
      | "validationErrorCode"
    >,
  ): Prisma.InputJsonObject {
    return {
      routeId: route.id,
      channelId: route.channelId,
      metaBusinessConnectionId: route.metaBusinessConnectionId,
      metaReportingAccountId: route.metaReportingAccountId,
      metaConversionDestinationId: route.metaConversionDestinationId,
      active: route.active,
      validationStatus: route.validationStatus,
      validationErrorCode: route.validationErrorCode,
    };
  }

  private async createAudit(
    transaction: Prisma.TransactionClient,
    input: {
      workspaceId: string;
      actorUserId: string | null;
      actorType?: "user" | "system";
      action: string;
      targetType: string;
      targetId: string;
      resultStatus: string;
      beforeSummary: Prisma.InputJsonObject;
      afterSummary: Prisma.InputJsonObject;
    },
  ): Promise<void> {
    await transaction.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        actorType: input.actorType ?? "user",
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        reason: null,
        sourceIp: null,
        resultStatus: input.resultStatus,
        beforeSummary: input.beforeSummary,
        afterSummary: input.afterSummary,
      },
    });
  }
}

export { resourceNotFoundMessage };
