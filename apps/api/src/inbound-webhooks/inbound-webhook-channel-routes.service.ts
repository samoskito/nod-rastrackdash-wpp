import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
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
  CTWA_DESTINATION_AD_HINT_REASON,
  CTWA_DESTINATION_REASON,
  ctwaAdUnknown,
  resolveCtwaDestination,
} from "./authorized-ctwa-destination";
import { isBridgedWhatsappProvider } from "./bridged-whatsapp-providers";
import {
  effectiveUnnichatMetaRouting,
  lockUnnichatMetaPolicy,
  type EffectiveMetaRouting,
} from "./inbound-webhook-effective-meta-routing";
import {
  inboundMetaRouteEligible,
  inboundMetaRouteMatches,
} from "./inbound-webhook-meta-route-eligibility";
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
/** Reasons that, alone, justify a "blocked" state and tell what to fix. */
const actionableReadinessBlockers: ReadonlySet<InboundWebhookChannelReadinessBlockerDto> =
  new Set([
    "connection_paused",
    "channel_paused",
    "route_not_configured",
    "route_not_valid",
    "ctwa_unresolved",
    "ctwa_ad_unavailable",
    "payload_unavailable",
    "ctwa_send_failed",
  ]);
/** Notes that explain the channel but never downgrade a sendable one. */
const informativeReadinessBlockers: ReadonlySet<InboundWebhookChannelReadinessBlockerDto> =
  new Set(["ctwa_in_progress", "ctwa_not_eligible"]);
// GET /channels above this duration is logged as a warning.
const slowChannelListingMs = 2_000;
// Bounded fallback when the readiness aggregate fails.
const readinessFallbackWindowDays = 90;
const readinessFallbackMaxEvents = 5_000;

const channelInclude = channelActivationInclude;

type PersistedChannel = Prisma.InboundWebhookChannelGetPayload<{
  include: typeof channelInclude;
}>;

type PersistedRoute = Prisma.InboundWebhookChannelRouteGetPayload<object>;

/** Fase 4b (Unnichat): effective routing of the number plus whether it has a
 * unique authorized page/pixel destination for CTWA leads without ad id. */
type EntryReadinessPolicy = EffectiveMetaRouting & {
  ctwaDestinationReadiness?: {
    status: "verified" | "not_ready";
    reason: string;
  };
};

/**
 * Per-channel CTWA readiness counters, aggregated in SQL (one row per channel)
 * instead of loading every CTWA event of the connection into memory (porte do
 * #165 do SaaS). Each field mirrors exactly what the former in-memory filters
 * counted:
 * - done: replay or production item already materialized/duplicate;
 * - open: not done;
 * - available: the delivery still holds an encrypted, unexpired payload.
 *
 * `retainedRoutedUntouched` is the number of CTWA a new replay could still
 * send right now: route resolved, never attempted (no replay nor production
 * item) and original payload still preserved. When it is 0 while CTWA remain
 * open, the open ones are explained by exactly one of: unresolved route, ad
 * unavailable, payload no longer preserved, an attempt in progress
 * (`inProgressOpen`), an attempt that failed/was skipped (`sendFailedOpen`)
 * or a non-eligible triage classification (`notEligibleOpen`) (porte do #179).
 */
export type ChannelReadinessSummary = {
  total: number;
  routed: number;
  unresolved: number;
  alreadyMaterialized: number;
  adUnavailableOpen: number;
  retainedOpen: number;
  retainedRoutedUntouched: number;
  /** Open CTWA with a replay/production item still queued or processing. */
  inProgressOpen: number;
  /** Open CTWA whose replay/production attempt failed or was skipped. */
  sendFailedOpen: number;
  /** Open, never attempted CTWA classified as not eligible (ignored_*, ...). */
  notEligibleOpen: number;
  nextPayloadExpiresAt: Date | null;
};

type ChannelReadinessSummaryRow = ChannelReadinessSummary & {
  channelId: string;
};

const emptyReadinessSummary: ChannelReadinessSummary = {
  total: 0,
  routed: 0,
  unresolved: 0,
  alreadyMaterialized: 0,
  adUnavailableOpen: 0,
  retainedOpen: 0,
  retainedRoutedUntouched: 0,
  inProgressOpen: 0,
  sendFailedOpen: 0,
  notEligibleOpen: 0,
  nextPayloadExpiresAt: null,
};

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
      // Fase 4b (Unnichat): CTWA entry routed to the number's unique
      // authorized page/pixel destination (no reporting account).
      classification: "eligible_route_resolved";
      reason:
        typeof CTWA_DESTINATION_REASON | typeof CTWA_DESTINATION_AD_HINT_REASON;
      preview: {
        businessConnectionId: string;
        reportingAccountId: null;
        conversionDestinationId: string;
      };
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
  private readonly logger = new Logger(InboundWebhookChannelRoutesService.name);

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

    const startedAt = Date.now();
    let channelCount: number | null = null;
    let readinessMs: number | null = null;
    try {
      const channels = await this.prisma.inboundWebhookChannel.findMany({
        where: {
          workspaceId,
          connectionId,
        },
        include: channelInclude,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      channelCount = channels.length;
      const readinessStartedAt = Date.now();
      const readinessByChannel = await this.loadChannelReadiness(
        workspaceId,
        connectionId,
        channels,
      );
      readinessMs = Date.now() - readinessStartedAt;
      const result = channels.map((channel) =>
        this.toChannelDto(channel, readinessByChannel.get(channel.id)),
      );
      const durationMs = Date.now() - startedAt;
      const line = JSON.stringify({
        event: "inbound_webhook.channels_listed",
        connectionId,
        channelCount,
        readinessMs,
        durationMs,
      });
      if (durationMs >= slowChannelListingMs) this.logger.warn(line);
      else this.logger.log(line);
      return result;
    } catch (error) {
      // Structured, PII-free: identifiers and timings only, never payloads,
      // phones or raw driver messages (which may echo query parameters).
      this.logger.error(
        JSON.stringify({
          event: "inbound_webhook.channels_list_failed",
          connectionId,
          channelCount,
          readinessMs,
          durationMs: Date.now() - startedAt,
          errorName: error instanceof Error ? error.name : typeof error,
          errorCode:
            typeof error === "object" && error !== null && "code" in error
              ? String((error as { code: unknown }).code)
              : null,
        }),
      );
      throw error;
    }
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
      throw new BadRequestException("Número de telefone inválido");
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
      if (input.routingMode && channel.connection.provider !== "unnichat")
        throw new ConflictException(
          "Modo de herança disponível apenas para Unnichat",
        );
      // Unnichat: an omitted routingMode keeps the channel's current mode. A
      // NULL (legacy) mode keeps its EFFECTIVE source; an unknown legacy
      // source is never widened to inheritance and requires an explicit mode.
      let routingMode: "inherit_workspace" | "channel_override" | undefined;
      if (channel.connection.provider === "unnichat") {
        const current =
          input.routingMode ??
          channel.metaRoutingMode ??
          (await effectiveUnnichatMetaRouting(transaction, channel)).source;
        if (current === "legacy_unknown")
          throw new ConflictException({
            statusCode: 409,
            error: "Conflict",
            code: "channel_routing_mode_required",
            message:
              "Informe o modo de roteamento (automático ou rotas manuais) deste canal",
          });
        routingMode = current;
      }
      if (routingMode === "inherit_workspace" && input.routes.length)
        throw new ConflictException(
          input.routingMode
            ? "Herança não aceita rotas locais como override"
            : "Informe routingMode channel_override para salvar rotas manuais neste canal",
        );
      if (routingMode) {
        await transaction.inboundWebhookChannel.updateMany({
          where: { id: channelId, workspaceId },
          data: { metaRoutingMode: routingMode },
        });
      }
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
      if (channel.connection.provider === "unnichat") {
        // Removing a saved route is a manual override decision: the number
        // never silently starts inheriting the workspace afterwards.
        const policy = await effectiveUnnichatMetaRouting(transaction, channel);
        if (policy.source === "channel_override") {
          await transaction.inboundWebhookChannelRoute.updateMany({
            where: {
              workspaceId,
              channelId,
              active: true,
              id: {
                notIn: policy.routes.flatMap((route) =>
                  route.id ? [route.id] : [],
                ),
              },
            },
            data: {
              active: false,
              validationStatus: removedRouteStatus,
              validationErrorCode: removedRouteReason,
            },
          });
        }
        await transaction.inboundWebhookChannel.updateMany({
          where: { id: channelId, workspaceId },
          data: { metaRoutingMode: "channel_override" },
        });
      }
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
        if (channel.connection.provider === "unnichat")
          await lockUnnichatMetaPolicy(
            transaction,
            workspaceId,
            events.flatMap((event) => (event.adId ? [event.adId] : [])),
          );
        for (const entry of decisions) {
          const eventId = entry.eventId;
          const decision =
            channel.connection.provider === "unnichat"
              ? await new InboundWebhookChannelRoutesService(
                  transaction as PrismaService,
                  new InboundWebhookMetaRouteReaderService(
                    transaction as PrismaService,
                  ),
                ).evaluateEventRoute(
                  await this.requireChannel(
                    transaction,
                    workspaceId,
                    channelId,
                  ),
                  events.find((event) => event.id === eventId)!.adId,
                )
              : entry.decision;
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

  /** Must run on a transaction-bound instance under lockUnnichatMetaPolicy
   * (see refreshStaleCtwaAdHint). An ad-hint decision whose ad became known
   * after classification is re-evaluated in place, so the SAME production or
   * replay item (same Meta event ID) follows the canonical decision instead
   * of failing route_invalid forever (open-event reevaluation skips events
   * that already own an item). */
  async refreshStaleAdHintDecision(event: {
    id: string;
    workspaceId: string;
    channelId: string;
    provider: string;
    adId: string | null;
    classificationReason: string | null;
  }): Promise<boolean> {
    const adId = event.adId?.trim();
    if (
      !adId ||
      event.provider !== "unnichat" ||
      event.classificationReason !== CTWA_DESTINATION_AD_HINT_REASON ||
      (await ctwaAdUnknown(this.metaRouteReader, event.workspaceId, adId))
    )
      return false;
    const channel = await this.requireChannel(
      this.prisma,
      event.workspaceId,
      event.channelId,
    );
    const decision = await this.evaluateEventRoute(channel, adId);
    const changed = await this.prisma.inboundWebhookEvent.updateMany({
      where: {
        id: event.id,
        workspaceId: event.workspaceId,
        channelId: event.channelId,
        classificationReason: CTWA_DESTINATION_AD_HINT_REASON,
      },
      data: this.eventRouteUpdate(event.workspaceId, decision),
    });
    return changed.count === 1;
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
      // Fase 4b: an Unnichat CTWA entry without ad id (ctwa_clid present) is
      // routed to the number's unique authorized page/pixel destination.
      if (channel.connection.provider === "unnichat") {
        const r = await resolveCtwaDestination(this.prisma, channel);
        return r.kind === "authorized_ctwa_destination"
          ? {
              classification: "eligible_route_resolved",
              reason: CTWA_DESTINATION_REASON,
              preview: {
                businessConnectionId: r.businessConnectionId,
                reportingAccountId: null,
                conversionDestinationId: r.destinationId,
              },
            }
          : this.unresolvedDecision(r.reason);
      }
      return this.unresolvedDecision("route_ad_missing");
    }

    const decision = await this.evaluateAdRoute(channel, adId);
    if (
      decision.classification === "eligible_route_resolved" ||
      channel.connection.provider !== "unnichat"
    )
      return decision;
    return this.ctwaAdHintFallback(channel, adId, decision);
  }

  /** Owner rule: CTWA CAPI needs only pixel + page_id + ctwa_clid. An ad id
   * the workspace does not know (never synced, or its account is not a
   * configured reporting account) must not block the lead when the channel
   * still has exactly one authorized (pixel, page) destination. The ad id stays
   * on the event only as an attribution hint. A KNOWN ad with an explicit
   * configuration problem keeps its canonical reason; ambiguity never guesses. */
  private async ctwaAdHintFallback(
    channel: PersistedChannel,
    adId: string,
    canonical: RouteDecision,
  ): Promise<RouteDecision> {
    if (!(await ctwaAdUnknown(this.metaRouteReader, channel.workspaceId, adId)))
      return canonical;
    const r = await resolveCtwaDestination(this.prisma, channel);
    if (r.kind === "authorized_ctwa_destination")
      return {
        classification: "eligible_route_resolved",
        reason: CTWA_DESTINATION_AD_HINT_REASON,
        preview: {
          businessConnectionId: r.businessConnectionId,
          reportingAccountId: null,
          conversionDestinationId: r.destinationId,
        },
      };
    return r.reason === "ctwa_destination_ambiguous"
      ? this.unresolvedDecision(r.reason)
      : canonical;
  }

  private async evaluateAdRoute(
    channel: PersistedChannel,
    adId: string,
  ): Promise<RouteDecision> {
    if (channel.connection.provider === "unnichat") {
      const policy = await effectiveUnnichatMetaRouting(this.prisma, channel);
      if (!policy.eligible)
        return this.unresolvedDecision("route_not_configured");
      if (policy.source === "inherit_workspace") {
        const preview = await this.metaRouteReader.previewRoute({
          workspaceId: channel.workspaceId,
          adId,
        });
        return this.isResolvedPreview(preview)
          ? {
              classification: "eligible_route_resolved",
              reason: "route_resolved",
              preview,
            }
          : this.unresolvedDecision(
              preview.status === "unresolved"
                ? this.safeReason(preview.reason, "route_unresolved")
                : "route_unresolved",
            );
      }
      channel = {
        ...channel,
        routes: policy.routes.filter(
          (route) =>
            route.active !== false &&
            route.validationStatus === validRouteStatus,
        ) as PersistedRoute[],
      };
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
      if (
        !route.active ||
        route.validationStatus !== validRouteStatus ||
        route.workspaceId !== channel.workspaceId ||
        !route.metaBusinessConnectionId
      ) {
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
    // A saved route is an operator's scope, including wildcard restrictions.
    // Learning must never expand it to other accounts, BMs or destinations.
    if (
      channel.routes.length > 0 ||
      channel.connection.status === "paused" ||
      channel.status === "paused"
    ) {
      return false;
    }
    // Unnichat inheritance is virtual; overrides and unknown legacy cannot
    // learn a wider scope.
    if (channel.connection.provider === "unnichat") return false;

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
      route.active &&
      route.validationStatus === validRouteStatus &&
      inboundMetaRouteMatches(route, preview)
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
        resolvedReportingAccountWorkspaceId: decision.preview.reportingAccountId
          ? workspaceId
          : null,
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
    if (
      !(await inboundMetaRouteEligible(transaction, workspaceId, {
        ...route,
        workspaceId,
        active: true,
        validationStatus: validRouteStatus,
      }))
    ) {
      this.throwNotFound();
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
    // instance. Data Crazy payloads carry no business phone, only an instance
    // id, so a phone-keyed provisional channel could never be merged.
    // Unnichat binds its number when the connection is created (Fase 4b).
    if (
      connection.provider === "uazapi" ||
      connection.provider === "waha" ||
      connection.provider === "data_crazy" ||
      connection.provider === "unnichat"
    ) {
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
    // Porte do #103 do SaaS, com a ponte WAHA: a ponte Uazapi/WAHA não passa
    // pelo pipeline genérico de observação (o CTWA vira lead direto pelo
    // webhook da instância), então InboundWebhookEvent fica vazio. Os leads
    // CTWA da instância contam como já materializados.
    const bridgeProvider = channels[0]?.connection.provider;
    const isBridgedConnection = isBridgedWhatsappProvider(bridgeProvider);
    const materializedCtwaByInstance = isBridgedConnection
      ? await this.bridgedCtwaLeadCounts(
          workspaceId,
          bridgeProvider,
          channels.flatMap((channel) =>
            channel.whatsappInstanceId ? [channel.whatsappInstanceId] : [],
          ),
        )
      : new Map<string, number>();
    const summaryByChannel =
      channelIds.length === 0 || isBridgedConnection
        ? new Map<string, ChannelReadinessSummary>()
        : await this.loadChannelReadinessSummariesGuarded(
            workspaceId,
            connectionId,
            channelIds,
            now,
          );

    return new Map(
      await Promise.all(
        channels.map(async (channel) => {
          const readiness = this.channelReadiness(
            channel,
            summaryByChannel.get(channel.id) ?? emptyReadinessSummary,
            now,
            materializedCtwaByInstance.get(channel.whatsappInstanceId ?? "") ??
              0,
            (
              await Promise.all(
                channel.routes.map((route) =>
                  inboundMetaRouteEligible(this.prisma, workspaceId, route),
                ),
              )
            ).filter(Boolean).length,
            channel.connection.provider === "unnichat"
              ? await this.effectiveEntryReadiness(channel)
              : undefined,
          );
          // CRM-only readiness (Kommo/Pipedrive channel binding): whether this
          // number may use the verified unique workspace page/pixel. It never
          // changes the entry readiness above.
          return [
            channel.id,
            {
              ...readiness,
              crmDestinationReadiness:
                await this.crmDestinationReadiness(channel),
            },
          ] as const;
        }),
      ),
    );
  }

  /** CTWA leads of each bridged instance (Uazapi/WAHA), by instance id. */
  private async bridgedCtwaLeadCounts(
    workspaceId: string,
    provider: string,
    whatsappInstanceIds: string[],
  ): Promise<Map<string, number>> {
    if (whatsappInstanceIds.length === 0) return new Map();
    const rows = await this.prisma.lead.groupBy({
      by: ["whatsappInstanceId"],
      where: {
        workspaceId,
        whatsappInstanceId: { in: whatsappInstanceIds },
        source: provider,
        ctwaClid: { not: null },
      },
      _count: { _all: true },
    });
    return new Map(
      rows.flatMap((row) =>
        row.whatsappInstanceId === null
          ? []
          : [[row.whatsappInstanceId, row._count._all] as const],
      ),
    );
  }

  /**
   * The aggregate never takes the whole listing down: on a SQL error it logs
   * `channels_readiness_sql_failed` (ids and error code only) and falls back
   * to a bounded Prisma read. The fallback only sees the last
   * {@link readinessFallbackWindowDays} days (at most
   * {@link readinessFallbackMaxEvents} CTWA events), so its counters describe
   * that recent window, not the whole history.
   */
  private async loadChannelReadinessSummariesGuarded(
    workspaceId: string,
    connectionId: string,
    channelIds: string[],
    now: Date,
  ): Promise<Map<string, ChannelReadinessSummary>> {
    try {
      return await this.loadChannelReadinessSummaries(
        workspaceId,
        connectionId,
        channelIds,
        now,
      );
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: "inbound_webhook.channels_readiness_sql_failed",
          connectionId,
          channelCount: channelIds.length,
          errorName: error instanceof Error ? error.name : typeof error,
          errorCode:
            typeof error === "object" && error !== null && "code" in error
              ? String((error as { code: unknown }).code)
              : null,
        }),
      );
      return this.loadRecentChannelReadinessSummaries(
        workspaceId,
        connectionId,
        channelIds,
        now,
      );
    }
  }

  /** Bounded fallback (recent window, capped rows) of the SQL aggregate. */
  private async loadRecentChannelReadinessSummaries(
    workspaceId: string,
    connectionId: string,
    channelIds: string[],
    now: Date,
  ): Promise<Map<string, ChannelReadinessSummary>> {
    const since = new Date(
      now.getTime() - readinessFallbackWindowDays * 24 * 60 * 60 * 1_000,
    );
    const events = await this.prisma.inboundWebhookEvent.findMany({
      where: {
        workspaceId,
        connectionId,
        channelId: { in: channelIds },
        hasCtwa: true,
        occurredAt: { gte: since },
      },
      select: {
        channelId: true,
        deliveryId: true,
        classification: true,
        classificationReason: true,
        replayItem: { select: { status: true } },
        productionItem: { select: { status: true } },
        delivery: { select: { payloadExpiresAt: true } },
      },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: readinessFallbackMaxEvents,
    });
    const available =
      events.length === 0
        ? []
        : await this.prisma.inboundWebhookDelivery.findMany({
            where: {
              workspaceId,
              connectionId,
              id: { in: [...new Set(events.map((item) => item.deliveryId))] },
              payloadExpiresAt: { gt: now },
              encryptedPayload: { not: null },
              payloadIv: { not: null },
              payloadTag: { not: null },
              encryptionKeyVersion: { not: null },
            },
            select: { id: true },
          });
    const availableIds = new Set(available.map((item) => item.id));
    const finished = (status?: string | null) =>
      status === "materialized" || status === "duplicate";
    const inFlight = (status?: string | null) =>
      status === "queued" || status === "processing";
    const result = new Map<string, ChannelReadinessSummary>();
    for (const item of events) {
      const summary = result.get(item.channelId) ?? {
        ...emptyReadinessSummary,
      };
      const done =
        finished(item.replayItem?.status) ||
        finished(item.productionItem?.status);
      const retained = availableIds.has(item.deliveryId);
      const untouched =
        item.replayItem === null && item.productionItem === null;
      summary.total += 1;
      if (item.classification === "eligible_route_resolved") summary.routed += 1;
      if (item.classification === "eligible_route_unresolved")
        summary.unresolved += 1;
      if (done) summary.alreadyMaterialized += 1;
      if (!done && item.classificationReason === "route_ad_missing")
        summary.adUnavailableOpen += 1;
      if (!done && retained) {
        summary.retainedOpen += 1;
        const expiresAt = item.delivery.payloadExpiresAt;
        if (
          !summary.nextPayloadExpiresAt ||
          expiresAt < summary.nextPayloadExpiresAt
        ) {
          summary.nextPayloadExpiresAt = expiresAt;
        }
      }
      if (
        item.classification === "eligible_route_resolved" &&
        untouched &&
        retained
      ) {
        summary.retainedRoutedUntouched += 1;
      }
      if (!done) {
        if (
          inFlight(item.replayItem?.status) ||
          inFlight(item.productionItem?.status)
        ) {
          summary.inProgressOpen += 1;
        } else if (!untouched) {
          summary.sendFailedOpen += 1;
        } else if (
          item.classification !== "eligible_route_resolved" &&
          item.classification !== "eligible_route_unresolved"
        ) {
          summary.notEligibleOpen += 1;
        }
      }
      result.set(item.channelId, summary);
    }
    return result;
  }

  /**
   * One aggregate query per listing (porte do #165 do SaaS): Postgres counts
   * the connection's CTWA events per channel and returns one row per channel,
   * so neither the events nor their delivery ids ever reach Node. The previous
   * implementation loaded every CTWA event (plus replay/production/delivery
   * relations) and then sent all their delivery ids back in a second
   * `IN (...)` query, which grows without bound with the age and traffic of
   * the connection. Covers every connection that writes InboundWebhookEvent
   * (Umbler, Unnichat, Gupshup, Data Crazy, Meta Cloud); the Uazapi/WAHA
   * bridge is counted from its CTWA leads instead.
   *
   * Semantics are unchanged (no time window): every counter matches the former
   * in-memory filters. The event scan is driven by the existing
   * `InboundWebhookEvent(channelId, occurredAt)` index; replay/production items
   * are joined through their unique `eventId` and deliveries through the
   * primary key, with the payload-availability predicate in the join.
   *
   * Identifiers match schema.prisma/migrations (no @@map/@map on these
   * models). Enum columns are compared as text. "now" is sent as an ISO
   * string and converted to UTC `timestamp` (the columns are TIMESTAMP(3)
   * holding UTC, as Prisma writes them), independent of the session time
   * zone. COUNT(...) is cast to int and still normalized with Number().
   */
  private async loadChannelReadinessSummaries(
    workspaceId: string,
    connectionId: string,
    channelIds: string[],
    now: Date,
  ): Promise<Map<string, ChannelReadinessSummary>> {
    const rows = await this.prisma.$queryRaw<ChannelReadinessSummaryRow[]>`
      SELECT
        s."channelId" AS "channelId",
        COUNT(*)::int AS "total",
        COUNT(*) FILTER (
          WHERE s."classification" = 'eligible_route_resolved'
        )::int AS "routed",
        COUNT(*) FILTER (
          WHERE s."classification" = 'eligible_route_unresolved'
        )::int AS "unresolved",
        COUNT(*) FILTER (WHERE s."done")::int AS "alreadyMaterialized",
        COUNT(*) FILTER (
          WHERE NOT s."done" AND s."classificationReason" = 'route_ad_missing'
        )::int AS "adUnavailableOpen",
        COUNT(*) FILTER (
          WHERE NOT s."done" AND s."availableExpiresAt" IS NOT NULL
        )::int AS "retainedOpen",
        COUNT(*) FILTER (
          WHERE s."classification" = 'eligible_route_resolved'
            AND s."untouched"
            AND s."availableExpiresAt" IS NOT NULL
        )::int AS "retainedRoutedUntouched",
        COUNT(*) FILTER (
          WHERE NOT s."done" AND s."inFlight"
        )::int AS "inProgressOpen",
        COUNT(*) FILTER (
          WHERE NOT s."done" AND NOT s."inFlight" AND NOT s."untouched"
        )::int AS "sendFailedOpen",
        COUNT(*) FILTER (
          WHERE NOT s."done"
            AND s."untouched"
            AND s."classification" NOT IN (
              'eligible_route_resolved',
              'eligible_route_unresolved'
            )
        )::int AS "notEligibleOpen",
        MIN(s."availableExpiresAt") FILTER (
          WHERE NOT s."done"
        ) AS "nextPayloadExpiresAt"
      FROM (
        SELECT
          e."channelId",
          e."classification"::text AS "classification",
          e."classificationReason",
          (
            COALESCE(r."status"::text IN ('materialized', 'duplicate'), false)
            OR COALESCE(p."status"::text IN ('materialized', 'duplicate'), false)
          ) AS "done",
          (r."id" IS NULL AND p."id" IS NULL) AS "untouched",
          (
            COALESCE(r."status"::text IN ('queued', 'processing'), false)
            OR COALESCE(p."status"::text IN ('queued', 'processing'), false)
          ) AS "inFlight",
          d."payloadExpiresAt" AS "availableExpiresAt"
        FROM "InboundWebhookEvent" e
        LEFT JOIN "InboundWebhookReplayItem" r ON r."eventId" = e."id"
        LEFT JOIN "InboundWebhookProductionItem" p ON p."eventId" = e."id"
        LEFT JOIN "InboundWebhookDelivery" d
          ON d."id" = e."deliveryId"
          AND d."workspaceId" = ${workspaceId}
          AND d."connectionId" = ${connectionId}
          AND d."payloadExpiresAt" > (CAST(${now.toISOString()} AS timestamptz) AT TIME ZONE 'UTC')
          AND d."encryptedPayload" IS NOT NULL
          AND d."payloadIv" IS NOT NULL
          AND d."payloadTag" IS NOT NULL
          AND d."encryptionKeyVersion" IS NOT NULL
        WHERE e."workspaceId" = ${workspaceId}
          AND e."connectionId" = ${connectionId}
          AND e."channelId" IN (${Prisma.join(channelIds)})
          AND e."hasCtwa" = true
      ) s
      GROUP BY s."channelId"
    `;

    return new Map(
      rows.map((row) => [
        row.channelId,
        {
          total: Number(row.total),
          routed: Number(row.routed),
          unresolved: Number(row.unresolved),
          alreadyMaterialized: Number(row.alreadyMaterialized),
          adUnavailableOpen: Number(row.adUnavailableOpen),
          retainedOpen: Number(row.retainedOpen),
          retainedRoutedUntouched: Number(row.retainedRoutedUntouched),
          inProgressOpen: Number(row.inProgressOpen ?? 0),
          sendFailedOpen: Number(row.sendFailedOpen ?? 0),
          notEligibleOpen: Number(row.notEligibleOpen ?? 0),
          nextPayloadExpiresAt:
            row.nextPayloadExpiresAt === null
              ? null
              : new Date(row.nextPayloadExpiresAt),
        },
      ]),
    );
  }

  /** Fase 4b (Unnichat): readiness follows the number's effective routing
   * (inherit the workspace or its own override) and the unique authorized
   * page/pixel destination used by CTWA leads without ad id. */
  private async effectiveEntryReadiness(
    channel: PersistedChannel,
  ): Promise<EntryReadinessPolicy> {
    const policy = await effectiveUnnichatMetaRouting(this.prisma, channel);
    const destination = await resolveCtwaDestination(this.prisma, channel);
    return {
      ...policy,
      eligible:
        policy.eligible || destination.kind === "authorized_ctwa_destination",
      ctwaDestinationReadiness:
        destination.kind === "authorized_ctwa_destination"
          ? { status: "verified", reason: "authorized_ctwa_destination" }
          : { status: "not_ready", reason: destination.reason },
    };
  }

  private async crmDestinationReadiness(
    channel: PersistedChannel,
  ): Promise<{ status: "verified" | "not_ready"; reason: string }> {
    try {
      const destination = await resolveCtwaDestination(this.prisma, channel, {
        crmAnyProvider: true,
      });
      return destination.kind === "authorized_ctwa_destination"
        ? { status: "verified", reason: "authorized_ctwa_destination" }
        : { status: "not_ready", reason: destination.reason };
    } catch {
      // Readiness is informative: a lookup failure never breaks the listing.
      return { status: "not_ready", reason: "crm_destination_unavailable" };
    }
  }

  private channelReadiness(
    channel: PersistedChannel,
    summary: ChannelReadinessSummary,
    now: Date,
    materializedBridgeCtwa = 0,
    validRouteCount = 0,
    policy?: EntryReadinessPolicy,
  ): InboundWebhookChannelReadinessDto {
    const routeCount = channel.routes.length;
    const openCount = summary.total - summary.alreadyMaterialized;
    const retainedCount = summary.retainedOpen;
    const retainedRoutedCount = summary.retainedRoutedUntouched;
    const unresolvedCount = summary.unresolved;
    const adUnavailableCount = summary.adUnavailableOpen;
    const nextPayloadExpiresAt = summary.nextPayloadExpiresAt ?? undefined;
    // Uazapi/WAHA bridge (porte do #103): CTWA leads created straight from the
    // instance webhook count as already materialized.
    const alreadyMaterializedCtwa =
      summary.alreadyMaterialized + materializedBridgeCtwa;
    const totalCtwa = summary.total + materializedBridgeCtwa;
    const routedCtwa = summary.routed + materializedBridgeCtwa;
    const blockers: InboundWebhookChannelReadinessBlockerDto[] = [];

    if (channel.connection.status === "paused") {
      blockers.push("connection_paused");
    }
    if (channel.status === "paused") {
      blockers.push("channel_paused");
    }
    // Ponte Uazapi/WAHA: o destino Meta é resolvido por anúncio no envio, sem
    // rota salva no canal; "rota não configurada" não se aplica a ela.
    const bridged = isBridgedWhatsappProvider(channel.connection.provider);
    if (!bridged && (policy ? !policy.eligible : routeCount === 0)) {
      blockers.push("route_not_configured");
    } else if (
      !bridged &&
      policy?.source !== "inherit_workspace" &&
      validRouteCount !== routeCount
    ) {
      blockers.push("route_not_valid");
    }
    if (totalCtwa === 0) {
      blockers.push("ctwa_not_observed");
    }
    if (adUnavailableCount > 0) {
      blockers.push("ctwa_ad_unavailable");
    }
    if (unresolvedCount > 0) {
      blockers.push("ctwa_unresolved");
    }
    if (openCount > retainedCount) {
      blockers.push("payload_unavailable");
    }
    if (
      nextPayloadExpiresAt &&
      nextPayloadExpiresAt.getTime() - now.getTime() <= payloadExpiryWarningMs
    ) {
      blockers.push("payload_expiring_soon");
    }
    // Porte do #179: "Bloqueado" sempre com motivo.
    if (summary.sendFailedOpen > 0) {
      blockers.push("ctwa_send_failed");
    }
    if (summary.inProgressOpen > 0) {
      blockers.push("ctwa_in_progress");
    }
    if (summary.notEligibleOpen > 0) {
      blockers.push("ctwa_not_eligible");
    }

    const hardBlocked =
      channel.connection.status === "paused" ||
      channel.status === "paused" ||
      (policy ? !policy.eligible : routeCount === 0 || validRouteCount === 0);
    // With nothing left that a new replay could send, the channel is only
    // "blocked" when an actionable reason explains it. CTWA still being
    // processed or ignored by triage are not a block: they leave it partial.
    const actionableBlocked = blockers.some((blocker) =>
      actionableReadinessBlockers.has(blocker),
    );
    // Informative notes never downgrade a channel that can be sent.
    const degradingBlockers = blockers.filter(
      (blocker) => !informativeReadinessBlockers.has(blocker),
    );
    const state =
      totalCtwa === 0
        ? "waiting"
        : alreadyMaterializedCtwa === totalCtwa
          ? "complete"
          : hardBlocked || (retainedRoutedCount === 0 && actionableBlocked)
            ? "blocked"
            : retainedRoutedCount === 0 || degradingBlockers.length > 0
              ? "partial"
              : "ready";

    return {
      state,
      blockers,
      routeCount,
      validRouteCount,
      ...(policy
        ? {
            routingSource: policy.source,
            effectiveRouteEligible: policy.eligible,
            ...(policy.ctwaDestinationReadiness
              ? { ctwaDestinationReadiness: policy.ctwaDestinationReadiness }
              : {}),
          }
        : {}),
      // Porte do #165: sempre presente (o motivo ctwa_ad_unavailable vale
      // para qualquer provedor, não só Unnichat).
      adUnavailableCtwa: adUnavailableCount,
      totalCtwa,
      routedCtwa,
      unresolvedCtwa: unresolvedCount,
      retainedCtwa: retainedCount,
      retainedRoutedCtwa: retainedRoutedCount,
      inProgressCtwa: summary.inProgressOpen,
      sendFailedCtwa: summary.sendFailedOpen,
      notEligibleCtwa: summary.notEligibleOpen,
      payloadUnavailableCtwa: openCount - retainedCount,
      alreadyMaterializedCtwa,
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
        readiness ??
        this.channelReadiness(channel, emptyReadinessSummary, new Date()),
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

/** Re-evaluates a stale ad-hint decision inside the caller's transaction (the
 * caller already holds lockUnnichatMetaPolicy). true = the event changed and
 * must be reloaded before materialization. */
export function refreshStaleCtwaAdHint(
  transaction: Prisma.TransactionClient,
  event: Parameters<
    InboundWebhookChannelRoutesService["refreshStaleAdHintDecision"]
  >[0],
): Promise<boolean> {
  return new InboundWebhookChannelRoutesService(
    transaction as PrismaService,
    new InboundWebhookMetaRouteReaderService(transaction as PrismaService),
  ).refreshStaleAdHintDecision(event);
}
