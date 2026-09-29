import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type {
  BackofficeInboundWebhookReplayBatchDto,
  BackofficeInboundWebhookReplayPreviewDto,
  InboundWebhookParserReleaseDto,
  InboundWebhookReplaySelectionDto,
} from "@wpptrack/shared";
// rastrackdash sanitize (rewrite_rules.platform-admin-user-local-type):
// auth/platform-admin.service.ts is stripped (multi-client staff model);
// this file only ever imported the PlatformAdminUser TYPE to type an
// `actor` parameter, never PlatformAdminService itself. Local structural
// type keeps certifyParserRelease/authorizeReplay/retryTransientFailures
// intact for a future single-owner bootstrap caller (F3.3/F6 TODO)
// instead of deleting real per-workspace business logic.
type PlatformAdminUser = { id: string; role: string };
import {
  hashPhoneIdentity,
  normalizePhoneIdentity,
} from "../common/phone/phone-identity";
import { PrismaService } from "../common/prisma/prisma.service";
import { ConversionEventsQueueService } from "../common/queue/conversion-events-queue.service";
import type { InboundWebhookReplayJobPayload } from "../common/queue/queue.constants";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { parseInboundWebhooksConfig } from "../config/deployment-config";
import { ConversionEventsService } from "../conversion-events/conversion-events.service";
import { InboundWebhookPayloadEncryptionService } from "../inbound-webhooks/inbound-webhook-payload-encryption.service";
import { inboundWebhookParserContext } from "../inbound-webhooks/providers/inbound-webhook-parser";
import type { ParsedInboundWebhookEvent } from "../inbound-webhooks/providers/inbound-webhook-parser";
import { InboundWebhookParserRegistry } from "../inbound-webhooks/providers/inbound-webhook-parser.registry";
import { LeadsService } from "../leads/leads.service";
import { InboundWebhookReplayQueueService } from "./inbound-webhook-replay-queue.service";

const REPLAY_BATCH_LIMIT = 500;
const REPLAY_CANDIDATE_SCAN_LIMIT = REPLAY_BATCH_LIMIT * 5;
const REPLAY_HISTORY_LIMIT = 10;
const replaySelectionLimits: Record<InboundWebhookReplaySelectionDto, number> =
  {
    canary_1: 1,
    canary_5: 5,
    canary_10: 10,
    remaining: REPLAY_BATCH_LIMIT,
  };
const transientReplayErrorCodes = [
  "inbound_webhook_replay_disabled",
  "inbound_webhook_replay_queue_unavailable",
  "inbound_webhook_replay_unexpected",
] as const;
const terminalItemStatuses = new Set([
  "materialized",
  "duplicate",
  "skipped",
  "failed",
]);
const replayItemInclude = {
  event: {
    include: {
      delivery: true,
      connection: {
        include: {
          parserRelease: true,
        },
      },
      channel: {
        include: {
          routes: {
            where: {
              active: true,
              validationStatus: "valid",
            },
          },
        },
      },
      resolvedBusinessConnection: {
        include: {
          credential: true,
        },
      },
      resolvedReportingAccount: true,
      resolvedConversionDestination: true,
    },
  },
} satisfies Prisma.InboundWebhookReplayItemInclude;

type ReplayItemRecord = Prisma.InboundWebhookReplayItemGetPayload<{
  include: typeof replayItemInclude;
}>;

class ReplayItemFailure extends Error {
  constructor(readonly code: string) {
    super("Inbound webhook replay item failed");
    this.name = "ReplayItemFailure";
  }
}

@Injectable()
export class InboundWebhookReplayService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(InboundWebhookPayloadEncryptionService)
    private readonly payloadEncryption: InboundWebhookPayloadEncryptionService,
    @Inject(InboundWebhookParserRegistry)
    private readonly parserRegistry: InboundWebhookParserRegistry,
    @Inject(LeadsService)
    private readonly leads: LeadsService,
    @Inject(ConversionEventsService)
    private readonly conversions: ConversionEventsService,
    @Inject(ConversionEventsQueueService)
    private readonly conversionQueue: ConversionEventsQueueService,
    @Inject(InboundWebhookReplayQueueService)
    private readonly replayQueue: InboundWebhookReplayQueueService,
    @Inject(RUNTIME_ENV)
    private readonly env: RuntimeEnv = process.env,
  ) {}

  async certifyParserRelease(
    releaseId: string,
    actor: PlatformAdminUser,
    sourceIp: string | null,
  ): Promise<InboundWebhookParserReleaseDto> {
    const release = await this.prisma.inboundWebhookParserRelease.findUnique({
      where: { id: releaseId },
    });

    if (!release) {
      throw new NotFoundException("Parser nao encontrado");
    }

    if (release.status === "retired") {
      throw new ConflictException("Parser retirado nao pode ser certificado");
    }

    if (release.status !== "certified") {
      const evidence = await this.prisma.inboundWebhookDelivery.count({
        where: {
          provider: release.provider,
          parserVersion: release.version,
          status: "processed",
          connection: {
            parserReleaseId: release.id,
            removedAt: null,
          },
          events: {
            some: {
              hasCtwa: true,
            },
          },
        },
      });

      if (evidence === 0) {
        throw new BadRequestException(
          "O parser precisa de um payload CTWA real processado antes da certificacao",
        );
      }
    }

    const certifiedAt = release.certifiedAt ?? new Date();
    const certified =
      release.status === "certified"
        ? release
        : await this.prisma.$transaction(async (tx) => {
            const updated = await tx.inboundWebhookParserRelease.update({
              where: { id: release.id },
              data: {
                status: "certified",
                certifiedByUserId: actor.id,
                certifiedAt,
              },
            });

            await tx.auditLog.create({
              data: {
                workspaceId: null,
                actorUserId: actor.id,
                actorType: actor.role,
                action: "inbound_webhook.parser.certify",
                targetType: "inbound_webhook_parser_release",
                targetId: release.id,
                sourceIp: this.sourceIp(sourceIp),
                resultStatus: "success",
                beforeSummary: {
                  provider: release.provider,
                  version: release.version,
                  status: release.status,
                },
                afterSummary: {
                  provider: release.provider,
                  version: release.version,
                  status: "certified",
                },
              },
            });

            return updated;
          });

    return this.parserReleaseDto(certified);
  }

  async getPreview(
    connectionId: string,
  ): Promise<BackofficeInboundWebhookReplayPreviewDto> {
    const connection = await this.loadConnection(connectionId);
    const now = new Date();
    const [events, channels, recentBatches] = await Promise.all([
      this.prisma.inboundWebhookEvent.findMany({
        where: {
          workspaceId: connection.workspaceId,
          connectionId: connection.id,
          hasCtwa: true,
        },
        select: {
          occurredAt: true,
          channelId: true,
          adId: true,
          classification: true,
          resolvedBusinessConnectionId: true,
          resolvedReportingAccountId: true,
          resolvedConversionDestinationId: true,
          resolvedBusinessConnection: {
            select: {
              status: true,
              credential: {
                select: {
                  status: true,
                },
              },
            },
          },
          resolvedReportingAccount: {
            select: {
              active: true,
              adAccountId: true,
              businessConnectionId: true,
            },
          },
          resolvedConversionDestination: {
            select: {
              status: true,
            },
          },
          channel: {
            select: {
              id: true,
              channelName: true,
              connectedPhone: true,
              productionActivatedAt: true,
              routes: {
                where: {
                  active: true,
                  validationStatus: "valid",
                },
                select: {
                  metaBusinessConnectionId: true,
                  metaReportingAccountId: true,
                  metaConversionDestinationId: true,
                },
              },
            },
          },
          replayItem: {
            select: {
              id: true,
              status: true,
            },
          },
          productionItem: {
            select: {
              id: true,
              status: true,
            },
          },
          delivery: {
            select: {
              firstReceivedAt: true,
              payloadExpiresAt: true,
              encryptedPayload: true,
              payloadIv: true,
              payloadTag: true,
              encryptionKeyVersion: true,
            },
          },
        },
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      }),
      this.prisma.inboundWebhookChannel.findMany({
        where: {
          workspaceId: connection.workspaceId,
          connectionId: connection.id,
        },
        select: {
          id: true,
          channelName: true,
          connectedPhone: true,
        },
        orderBy: [{ channelName: "asc" }, { connectedPhone: "asc" }],
      }),
      this.prisma.inboundWebhookReplayBatch.findMany({
        where: {
          workspaceId: connection.workspaceId,
          connectionId: connection.id,
        },
        include: {
          items: {
            where: {
              status: "failed",
              errorCode: {
                in: [...transientReplayErrorCodes],
              },
              event: {
                delivery: {
                  payloadExpiresAt: { gt: now },
                  encryptedPayload: { not: null },
                  payloadIv: { not: null },
                  payloadTag: { not: null },
                  encryptionKeyVersion: { not: null },
                },
              },
            },
            select: { id: true },
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: REPLAY_HISTORY_LIMIT,
      }),
    ]);
    const ads = await this.prisma.metaAd.findMany({
      where: {
        workspaceId: connection.workspaceId,
        adId: {
          in: [
            ...new Set(
              events
                .map((event) => event.adId)
                .filter((adId): adId is string => adId !== null),
            ),
          ],
        },
      },
      select: {
        adId: true,
        adAccountId: true,
      },
    });
    const adAccountsByAd = new Map(ads.map((ad) => [ad.adId, ad.adAccountId]));
    const payloadAvailable = (event: (typeof events)[number]) =>
      this.payloadAvailable(event.delivery, now);
    const routeResolved = (event: (typeof events)[number]) =>
      this.routeReady(
        event,
        event.adId ? (adAccountsByAd.get(event.adId) ?? null) : null,
      );
    const insideReplayWindow = (event: (typeof events)[number]) =>
      this.replayWindowEligible(event, connection);
    const nextPayloadExpiresAt = events
      .filter(
        (event) =>
          (event.replayItem === null ||
            ["queued", "processing", "failed"].includes(
              event.replayItem.status,
            )) &&
          event.productionItem === null &&
          insideReplayWindow(event) &&
          event.delivery.payloadExpiresAt.getTime() > now.getTime() &&
          payloadAvailable(event),
      )
      .map((event) => event.delivery.payloadExpiresAt)
      .sort((left, right) => left.getTime() - right.getTime())[0];
    const alreadyMaterialized = (event: (typeof events)[number]) =>
      event.replayItem?.status === "materialized" ||
      event.replayItem?.status === "duplicate" ||
      event.productionItem?.status === "materialized" ||
      event.productionItem?.status === "duplicate";
    const eligible = (event: (typeof events)[number]) =>
      event.adId !== null &&
      routeResolved(event) &&
      payloadAvailable(event) &&
      insideReplayWindow(event) &&
      event.replayItem === null &&
      event.productionItem === null;

    return {
      connection: {
        id: connection.id,
        workspaceId: connection.workspaceId,
        provider: connection.provider,
        displayName: connection.displayName,
        parserVersion: connection.parserRelease.version,
        parserReleaseStatus: connection.parserRelease.status,
        status: connection.status,
        productionActivatedAt:
          connection.productionActivatedAt?.toISOString() ?? null,
        lastDeliveryAt: connection.lastDeliveryAt?.toISOString() ?? null,
        lastSuccessfulParseAt:
          connection.lastSuccessfulParseAt?.toISOString() ?? null,
        createdAt: connection.createdAt.toISOString(),
        updatedAt: connection.updatedAt.toISOString(),
      },
      parserRelease: this.parserReleaseDto(connection.parserRelease),
      replayEnabled: this.replayEnabled(),
      counts: {
        totalCtwa: events.length,
        routeResolved: events.filter(routeResolved).length,
        routeUnresolved: events.filter((event) => !routeResolved(event)).length,
        payloadAvailable: events.filter(payloadAvailable).length,
        payloadExpired: events.filter(
          (event) => event.delivery.payloadExpiresAt.getTime() <= now.getTime(),
        ).length,
        payloadUnavailable: events.filter(
          (event) =>
            event.delivery.payloadExpiresAt.getTime() > now.getTime() &&
            !payloadAvailable(event),
        ).length,
        alreadyMaterialized: events.filter(alreadyMaterialized).length,
        eligible: events.filter(eligible).length,
      },
      oldestOccurredAt: events[0]?.occurredAt.toISOString() ?? null,
      newestOccurredAt:
        events[events.length - 1]?.occurredAt.toISOString() ?? null,
      nextPayloadExpiresAt: nextPayloadExpiresAt?.toISOString() ?? null,
      channels: channels.map((channel) => {
        const channelEvents = events.filter(
          (event) => event.channelId === channel.id,
        );

        return {
          id: channel.id,
          displayName: channel.channelName ?? channel.connectedPhone,
          connectedPhone: channel.connectedPhone,
          totalCtwa: channelEvents.length,
          routeResolved: channelEvents.filter(routeResolved).length,
          routeUnresolved: channelEvents.filter(
            (event) => !routeResolved(event),
          ).length,
          payloadAvailable: channelEvents.filter(payloadAvailable).length,
          alreadyMaterialized: channelEvents.filter(alreadyMaterialized).length,
          eligible: channelEvents.filter(eligible).length,
        };
      }),
      latestBatch: recentBatches[0]
        ? this.batchDto({
            ...recentBatches[0],
            retryableFailedCount: recentBatches[0].items.length,
          })
        : null,
      recentBatches: recentBatches.map((batch) =>
        this.batchDto({
          ...batch,
          retryableFailedCount: batch.items.length,
        }),
      ),
    };
  }

  async authorizeReplay(
    connectionId: string,
    confirmation: string,
    selection: InboundWebhookReplaySelectionDto,
    channelId: string,
    actor: PlatformAdminUser,
    sourceIp: string | null,
  ): Promise<BackofficeInboundWebhookReplayBatchDto> {
    this.assertReplayEnabled();
    const connection = await this.loadConnection(connectionId);
    const requestedLimit = this.replaySelectionLimit(selection);
    const replayChannelId = channelId.trim();

    if (!replayChannelId) {
      throw new BadRequestException(
        "Selecione um canal para autorizar o replay",
      );
    }

    if (confirmation !== connection.displayName) {
      throw new BadRequestException(
        "Digite exatamente o nome da conexao para autorizar",
      );
    }

    if (!["observation", "production"].includes(connection.status)) {
      throw new ConflictException(
        "A conexao precisa estar em observacao ou producao para o replay controlado",
      );
    }

    if (connection.parserRelease.status !== "certified") {
      throw new ConflictException(
        "Certifique o parser antes de autorizar o replay",
      );
    }

    const channelExists = await this.prisma.inboundWebhookChannel.count({
      where: {
        id: replayChannelId,
        workspaceId: connection.workspaceId,
        connectionId: connection.id,
      },
    });

    if (channelExists !== 1) {
      throw new BadRequestException("Canal invalido para esta conexao");
    }

    const now = new Date();
    let batch;

    try {
      batch = await this.prisma.$transaction(async (tx) => {
        const activeBatch = await tx.inboundWebhookReplayBatch.findFirst({
          where: {
            workspaceId: connection.workspaceId,
            connectionId: connection.id,
            status: {
              in: ["queued", "processing"],
            },
          },
          select: { id: true },
        });

        if (activeBatch) {
          throw new ConflictException(
            "Esta conexao ja possui um replay em andamento",
          );
        }

        const candidates = await tx.inboundWebhookEvent.findMany({
          where: {
            workspaceId: connection.workspaceId,
            connectionId: connection.id,
            channelId: replayChannelId,
            hasCtwa: true,
            adId: { not: null },
            classification: "eligible_route_resolved",
            resolvedBusinessConnectionId: { not: null },
            resolvedReportingAccountId: { not: null },
            resolvedConversionDestinationId: { not: null },
            replayItem: { is: null },
            productionItem: { is: null },
            delivery: {
              payloadExpiresAt: { gt: now },
              encryptedPayload: { not: null },
              payloadIv: { not: null },
              payloadTag: { not: null },
              encryptionKeyVersion: { not: null },
            },
          },
          select: {
            id: true,
            adId: true,
            classification: true,
            resolvedBusinessConnectionId: true,
            resolvedReportingAccountId: true,
            resolvedConversionDestinationId: true,
            resolvedBusinessConnection: {
              select: {
                status: true,
                credential: {
                  select: {
                    status: true,
                  },
                },
              },
            },
            resolvedReportingAccount: {
              select: {
                active: true,
                adAccountId: true,
                businessConnectionId: true,
              },
            },
            resolvedConversionDestination: {
              select: {
                status: true,
              },
            },
            channel: {
              select: {
                productionActivatedAt: true,
                routes: {
                  where: {
                    active: true,
                    validationStatus: "valid",
                  },
                  select: {
                    metaBusinessConnectionId: true,
                    metaReportingAccountId: true,
                    metaConversionDestinationId: true,
                  },
                },
              },
            },
            delivery: {
              select: {
                firstReceivedAt: true,
              },
            },
          },
          orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
          take: REPLAY_CANDIDATE_SCAN_LIMIT,
        });
        const ads = await tx.metaAd.findMany({
          where: {
            workspaceId: connection.workspaceId,
            adId: {
              in: candidates
                .map((event) => event.adId)
                .filter((adId): adId is string => adId !== null),
            },
          },
          select: {
            adId: true,
            adAccountId: true,
          },
        });
        const adAccountsByAd = new Map(
          ads.map((ad) => [ad.adId, ad.adAccountId]),
        );
        const events = candidates
          .filter((event) => this.replayWindowEligible(event, connection))
          .filter((event) =>
            this.routeReady(
              event,
              event.adId ? (adAccountsByAd.get(event.adId) ?? null) : null,
            ),
          )
          .slice(0, requestedLimit);

        if (events.length === 0) {
          throw new BadRequestException(
            "Nenhum evento possui rota completa e payload disponivel",
          );
        }

        const created = await tx.inboundWebhookReplayBatch.create({
          data: {
            workspaceId: connection.workspaceId,
            connectionId: connection.id,
            channelId: replayChannelId,
            requestedByUserId: actor.id,
            selection,
            requestedLimit,
            status: "queued",
          },
        });
        const inserted = await tx.inboundWebhookReplayItem.createMany({
          data: events.map((event) => ({
            workspaceId: connection.workspaceId,
            batchId: created.id,
            eventId: event.id,
            status: "queued" as const,
          })),
          skipDuplicates: true,
        });

        if (inserted.count === 0) {
          throw new ConflictException(
            "Os eventos elegiveis ja pertencem a outro replay",
          );
        }

        const updated = await tx.inboundWebhookReplayBatch.update({
          where: { id: created.id },
          data: { totalItems: inserted.count },
        });

        await tx.auditLog.create({
          data: {
            workspaceId: connection.workspaceId,
            actorUserId: actor.id,
            actorType: actor.role,
            action: "inbound_webhook.replay.authorize",
            targetType: "inbound_webhook_replay_batch",
            targetId: created.id,
            sourceIp: this.sourceIp(sourceIp),
            resultStatus: "queued",
            afterSummary: {
              connectionId: connection.id,
              channelId: replayChannelId,
              parserReleaseId: connection.parserRelease.id,
              selection,
              requestedLimit,
              itemCount: inserted.count,
              batchLimit: REPLAY_BATCH_LIMIT,
            },
          },
        });

        return updated;
      });
    } catch (error) {
      if (this.prismaErrorCode(error) === "P2002") {
        throw new ConflictException(
          "Esta conexao ja possui um replay em andamento",
        );
      }

      throw error;
    }

    try {
      await this.replayQueue.enqueueBatch({
        workspaceId: batch.workspaceId,
        batchId: batch.id,
      });
    } catch {
      await this.removeUnqueuedBatch(batch.id, batch.workspaceId);
      throw new ServiceUnavailableException(
        "Nao foi possivel iniciar o replay; tente novamente",
      );
    }

    return this.batchDto(batch);
  }

  async retryTransientFailures(
    connectionId: string,
    batchId: string,
    confirmation: string,
    actor: PlatformAdminUser,
    sourceIp: string | null,
  ): Promise<BackofficeInboundWebhookReplayBatchDto> {
    this.assertReplayEnabled();
    const connection = await this.loadConnection(connectionId);

    if (confirmation !== connection.displayName) {
      throw new BadRequestException(
        "Digite exatamente o nome da conexao para recuperar o lote",
      );
    }

    const now = new Date();
    const reset = await this.prisma.$transaction(async (tx) => {
      const batch = await tx.inboundWebhookReplayBatch.findFirst({
        where: {
          id: batchId,
          workspaceId: connection.workspaceId,
          connectionId: connection.id,
          status: {
            in: ["completed_with_failures", "failed"],
          },
        },
      });

      if (!batch) {
        throw new ConflictException(
          "O lote nao esta disponivel para recuperacao",
        );
      }

      const activeBatch = await tx.inboundWebhookReplayBatch.findFirst({
        where: {
          workspaceId: connection.workspaceId,
          connectionId: connection.id,
          id: { not: batch.id },
          status: {
            in: ["queued", "processing"],
          },
        },
        select: { id: true },
      });

      if (activeBatch) {
        throw new ConflictException(
          "Esta conexao ja possui um replay em andamento",
        );
      }

      const items = await tx.inboundWebhookReplayItem.findMany({
        where: {
          workspaceId: connection.workspaceId,
          batchId: batch.id,
          status: "failed",
          errorCode: {
            in: [...transientReplayErrorCodes],
          },
          event: {
            delivery: {
              payloadExpiresAt: { gt: now },
              encryptedPayload: { not: null },
              payloadIv: { not: null },
              payloadTag: { not: null },
              encryptionKeyVersion: { not: null },
            },
          },
        },
        select: { id: true },
      });

      if (items.length === 0) {
        throw new BadRequestException(
          "Nenhuma falha transitoria possui payload disponivel",
        );
      }

      const itemIds = items.map((item) => item.id);
      await tx.inboundWebhookReplayItem.updateMany({
        where: {
          workspaceId: connection.workspaceId,
          batchId: batch.id,
          id: { in: itemIds },
        },
        data: {
          status: "queued",
          errorCode: null,
          processedAt: null,
        },
      });
      const updated = await tx.inboundWebhookReplayBatch.update({
        where: { id: batch.id },
        data: {
          status: "queued",
          failedCount: {
            decrement: items.length,
          },
          retryableFailedCount: 0,
          retryCount: {
            increment: 1,
          },
          completedAt: null,
          lastRetriedAt: now,
        },
      });

      await tx.auditLog.create({
        data: {
          workspaceId: connection.workspaceId,
          actorUserId: actor.id,
          actorType: actor.role,
          action: "inbound_webhook.replay.retry_transient",
          targetType: "inbound_webhook_replay_batch",
          targetId: batch.id,
          sourceIp: this.sourceIp(sourceIp),
          resultStatus: "queued",
          afterSummary: {
            connectionId: connection.id,
            retryItemCount: items.length,
            retryCount: updated.retryCount,
          },
        },
      });

      return {
        batch: updated,
        itemIds,
      };
    });

    try {
      await this.replayQueue.enqueueBatch({
        workspaceId: reset.batch.workspaceId,
        batchId: reset.batch.id,
      });
    } catch {
      await this.markRetryQueueUnavailable(reset.batch, reset.itemIds);
      throw new ServiceUnavailableException(
        "Nao foi possivel recuperar o lote; tente novamente",
      );
    }

    return this.batchDto(reset.batch);
  }

  async processBatch(
    input: Readonly<InboundWebhookReplayJobPayload>,
  ): Promise<BackofficeInboundWebhookReplayBatchDto> {
    this.assertJobPayload(input);

    if (!this.replayEnabled()) {
      return this.failEntireBatch(input, "inbound_webhook_replay_disabled");
    }

    const batch = await this.prisma.inboundWebhookReplayBatch.findFirst({
      where: {
        id: input.batchId,
        workspaceId: input.workspaceId,
      },
    });

    if (!batch) {
      throw new ReplayItemFailure("inbound_webhook_replay_batch_not_found");
    }

    if (
      ["completed", "completed_with_failures", "failed"].includes(batch.status)
    ) {
      return this.batchDto(batch);
    }

    await this.prisma.inboundWebhookReplayBatch.update({
      where: { id: batch.id },
      data: {
        status: "processing",
        startedAt: batch.startedAt ?? new Date(),
      },
    });

    const items = await this.prisma.inboundWebhookReplayItem.findMany({
      where: {
        workspaceId: batch.workspaceId,
        batchId: batch.id,
        status: {
          in: ["queued", "processing"],
        },
      },
      select: { id: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    for (const item of items) {
      await this.processItem(batch.id, batch.workspaceId, item.id);
    }

    return this.finishBatch(batch.id, batch.workspaceId);
  }

  private async processItem(
    batchId: string,
    workspaceId: string,
    itemId: string,
  ): Promise<void> {
    const item = await this.prisma.inboundWebhookReplayItem.findFirst({
      where: {
        id: itemId,
        batchId,
        workspaceId,
      },
      include: replayItemInclude,
    });

    if (!item || terminalItemStatuses.has(item.status)) {
      return;
    }

    await this.prisma.inboundWebhookReplayItem.update({
      where: { id: item.id },
      data: {
        status: "processing",
        errorCode: null,
        attemptCount: {
          increment: 1,
        },
        lastAttemptedAt: new Date(),
      },
    });

    try {
      const result = await this.materialize(item);

      await this.prisma.inboundWebhookReplayItem.update({
        where: { id: item.id },
        data: {
          status: result.duplicate ? "duplicate" : "materialized",
          leadId: result.leadId,
          conversionEventLogId: result.conversionEventLogId,
          errorCode: null,
          processedAt: new Date(),
        },
      });
    } catch (error) {
      await this.prisma.inboundWebhookReplayItem.update({
        where: { id: item.id },
        data: {
          status: "failed",
          errorCode: this.replayErrorCode(error),
          processedAt: new Date(),
        },
      });
    }
  }

  private async materialize(item: ReplayItemRecord): Promise<{
    leadId: string;
    conversionEventLogId: string;
    duplicate: boolean;
  }> {
    const event = item.event;
    const connection = event.connection;
    const delivery = event.delivery;
    const business = event.resolvedBusinessConnection;
    const reporting = event.resolvedReportingAccount;
    const destination = event.resolvedConversionDestination;
    const routeStillActive = event.channel.routes.some(
      (route) =>
        route.metaBusinessConnectionId === event.resolvedBusinessConnectionId &&
        route.metaReportingAccountId === event.resolvedReportingAccountId &&
        route.metaConversionDestinationId ===
          event.resolvedConversionDestinationId,
    );
    const now = new Date();

    if (
      event.classification !== "eligible_route_resolved" ||
      !event.hasCtwa ||
      !event.adId
    ) {
      throw new ReplayItemFailure("inbound_webhook_replay_event_ineligible");
    }

    if (
      connection.removedAt ||
      !["observation", "production"].includes(connection.status) ||
      connection.parserRelease.status !== "certified" ||
      connection.parserRelease.version !== delivery.parserVersion
    ) {
      throw new ReplayItemFailure("inbound_webhook_replay_context_changed");
    }

    if (!this.replayWindowEligible(event, connection)) {
      throw new ReplayItemFailure(
        "inbound_webhook_replay_outside_historical_window",
      );
    }

    if (
      !business ||
      business.status !== "active" ||
      business.credential.status !== "active" ||
      !reporting ||
      !reporting.active ||
      reporting.businessConnectionId !== business.id ||
      !destination ||
      destination.status !== "configured" ||
      !routeStillActive
    ) {
      throw new ReplayItemFailure("inbound_webhook_replay_route_invalid");
    }

    if (!this.payloadAvailable(delivery, now)) {
      throw new ReplayItemFailure("inbound_webhook_replay_payload_unavailable");
    }

    const parsedEvent = this.reparseEvent(item);
    const phone = normalizePhoneIdentity(parsedEvent.contact.phoneNumber);
    const phoneHash = hashPhoneIdentity(parsedEvent.contact.phoneNumber);

    if (!phone || !phoneHash || !parsedEvent.ctwaClid || !parsedEvent.adId) {
      throw new ReplayItemFailure("inbound_webhook_replay_identity_invalid");
    }

    const ad = await this.prisma.metaAd.findFirst({
      where: {
        workspaceId: event.workspaceId,
        adId: event.adId,
      },
      select: {
        campaignId: true,
        adSetId: true,
        adAccountId: true,
      },
    });

    if (!ad || ad.adAccountId !== reporting.adAccountId) {
      throw new ReplayItemFailure("inbound_webhook_replay_route_invalid");
    }

    const lead = await this.leads.upsertFromWhatsappWebhook({
      workspaceId: event.workspaceId,
      name: parsedEvent.contact.name ?? undefined,
      phone,
      source: event.provider,
      preserveExistingSource: true,
      preserveEarliestFirstMessageAt: true,
      campaignId: ad.campaignId ?? undefined,
      adSetId: ad.adSetId ?? undefined,
      adId: event.adId,
      ctwaClid: parsedEvent.ctwaClid,
      ctwaSourceUrl: parsedEvent.ad?.sourceUrl ?? undefined,
      ctwaThumbnailUrl: parsedEvent.ad?.thumbnailUrl ?? undefined,
      occurredAt: event.occurredAt,
      firstMessageAt: event.occurredAt,
      lastMessageAt: event.occurredAt,
    });

    if (!lead) {
      throw new ReplayItemFailure("inbound_webhook_replay_lead_invalid");
    }

    const conversion = await this.conversions.recordExternalConversion({
      workspaceId: event.workspaceId,
      externalConnectorId: null,
      sourceEventId: event.externalMessageId ?? event.id,
      sourceTrigger: `inbound_webhook:${event.provider}`,
      eventName: "LeadSubmitted",
      eventId: this.metaEventId(event.provider, connection.id, event.dedupeKey),
      dedupeKey: `inbound-webhook:${connection.id}:${event.dedupeKey}`,
      leadId: lead.id,
      phoneHash,
      businessSource: "paid",
      metaAccountId: reporting.adAccountId,
      metaBusinessConnectionId: business.id,
      metaConversionDestinationId: destination.id,
      campaignId: ad.campaignId ?? null,
      adSetId: ad.adSetId ?? null,
      adId: event.adId,
      ctwaClid: parsedEvent.ctwaClid,
      eventOccurredAt: event.occurredAt,
      sourcePayload: {
        provider: event.provider,
        connectionId: connection.id,
        inboundEventId: event.id,
        channelId: event.channelId,
        classification: event.classification,
        hasCtwa: true,
        adId: event.adId,
      },
    });

    if (conversion.deliveryStatus === "ready_to_send") {
      await this.conversionQueue.enqueueSend(
        conversion.conversionEventLogId,
        event.workspaceId,
      );
    }

    return {
      leadId: lead.id,
      conversionEventLogId: conversion.conversionEventLogId,
      duplicate: conversion.status === "duplicate",
    };
  }

  private reparseEvent(item: ReplayItemRecord): ParsedInboundWebhookEvent {
    const { delivery, connection } = item.event;
    const decrypted = this.payloadEncryption.decrypt(
      {
        encryptedPayload: delivery.encryptedPayload!,
        payloadIv: delivery.payloadIv!,
        payloadTag: delivery.payloadTag!,
        encryptionKeyVersion: delivery.encryptionKeyVersion!,
      },
      {
        workspaceId: delivery.workspaceId,
        connectionId: delivery.connectionId,
        deliveryId: delivery.id,
      },
    );
    let payload: unknown;

    try {
      payload = JSON.parse(decrypted.toString("utf8"));
    } catch {
      throw new ReplayItemFailure("inbound_webhook_replay_payload_invalid");
    }

    const parser = this.parserRegistry.resolve({
      provider: connection.provider,
      parserVersion: connection.parserRelease.version,
      parserReleaseStatus: connection.parserRelease.status,
    });
    const result = parser.parse(
      payload,
      inboundWebhookParserContext(delivery.workspaceId),
    );
    const parsedEvent = result.events.find(
      (candidate) => candidate.dedupeKey === item.event.dedupeKey,
    );

    if (
      result.error ||
      !parsedEvent ||
      parsedEvent.provider !== item.event.provider ||
      parsedEvent.externalMessageId !== item.event.externalMessageId
    ) {
      throw new ReplayItemFailure("inbound_webhook_replay_event_mismatch");
    }

    return parsedEvent;
  }

  private async finishBatch(
    batchId: string,
    workspaceId: string,
  ): Promise<BackofficeInboundWebhookReplayBatchDto> {
    const [
      materializedCount,
      duplicateCount,
      skippedCount,
      failedCount,
      retryableFailedCount,
    ] = await Promise.all([
      this.itemCount(batchId, workspaceId, "materialized"),
      this.itemCount(batchId, workspaceId, "duplicate"),
      this.itemCount(batchId, workspaceId, "skipped"),
      this.itemCount(batchId, workspaceId, "failed"),
      this.prisma.inboundWebhookReplayItem.count({
        where: {
          batchId,
          workspaceId,
          status: "failed",
          errorCode: {
            in: [...transientReplayErrorCodes],
          },
        },
      }),
    ]);
    const status =
      skippedCount > 0 || failedCount > 0
        ? "completed_with_failures"
        : "completed";
    const completed = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.inboundWebhookReplayBatch.update({
        where: { id: batchId },
        data: {
          status,
          materializedCount,
          duplicateCount,
          skippedCount,
          failedCount,
          retryableFailedCount,
          completedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          workspaceId,
          actorUserId: null,
          actorType: "system",
          action: "inbound_webhook.replay.materialize",
          targetType: "inbound_webhook_replay_batch",
          targetId: batchId,
          resultStatus: status,
          afterSummary: {
            totalItems: updated.totalItems,
            materializedCount,
            duplicateCount,
            skippedCount,
            failedCount,
            retryableFailedCount,
          },
        },
      });

      return updated;
    });

    return this.batchDto(completed);
  }

  private async failEntireBatch(
    input: Readonly<InboundWebhookReplayJobPayload>,
    errorCode: string,
  ): Promise<BackofficeInboundWebhookReplayBatchDto> {
    const result = await this.prisma.$transaction(async (tx) => {
      const batch = await tx.inboundWebhookReplayBatch.findFirst({
        where: {
          id: input.batchId,
          workspaceId: input.workspaceId,
        },
      });

      if (!batch) {
        throw new ReplayItemFailure("inbound_webhook_replay_batch_not_found");
      }

      await tx.inboundWebhookReplayItem.updateMany({
        where: {
          workspaceId: batch.workspaceId,
          batchId: batch.id,
          status: {
            in: ["queued", "processing"],
          },
        },
        data: {
          status: "failed",
          errorCode,
          processedAt: new Date(),
        },
      });
      const failedCount = await tx.inboundWebhookReplayItem.count({
        where: {
          workspaceId: batch.workspaceId,
          batchId: batch.id,
          status: "failed",
        },
      });
      const retryableFailedCount = await tx.inboundWebhookReplayItem.count({
        where: {
          workspaceId: batch.workspaceId,
          batchId: batch.id,
          status: "failed",
          errorCode: {
            in: [...transientReplayErrorCodes],
          },
        },
      });

      return tx.inboundWebhookReplayBatch.update({
        where: { id: batch.id },
        data: {
          status: "failed",
          failedCount,
          retryableFailedCount,
          completedAt: new Date(),
        },
      });
    });

    return this.batchDto(result);
  }

  private itemCount(
    batchId: string,
    workspaceId: string,
    status: "materialized" | "duplicate" | "skipped" | "failed",
  ): Promise<number> {
    return this.prisma.inboundWebhookReplayItem.count({
      where: { batchId, workspaceId, status },
    });
  }

  private async removeUnqueuedBatch(
    batchId: string,
    workspaceId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.inboundWebhookReplayItem.deleteMany({
        where: { batchId, workspaceId },
      });
      await tx.inboundWebhookReplayBatch.deleteMany({
        where: { id: batchId, workspaceId, status: "queued" },
      });
      await tx.auditLog.create({
        data: {
          workspaceId,
          actorUserId: null,
          actorType: "system",
          action: "inbound_webhook.replay.enqueue",
          targetType: "inbound_webhook_replay_batch",
          targetId: batchId,
          resultStatus: "failed",
          reason: "inbound_webhook_replay_queue_unavailable",
        },
      });
    });
  }

  private async markRetryQueueUnavailable(
    batch: {
      id: string;
      workspaceId: string;
    },
    itemIds: string[],
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.inboundWebhookReplayItem.updateMany({
        where: {
          workspaceId: batch.workspaceId,
          batchId: batch.id,
          id: { in: itemIds },
          status: "queued",
        },
        data: {
          status: "failed",
          errorCode: "inbound_webhook_replay_queue_unavailable",
          processedAt: new Date(),
        },
      });
      const failedCount = await tx.inboundWebhookReplayItem.count({
        where: {
          workspaceId: batch.workspaceId,
          batchId: batch.id,
          status: "failed",
        },
      });
      const retryableFailedCount = await tx.inboundWebhookReplayItem.count({
        where: {
          workspaceId: batch.workspaceId,
          batchId: batch.id,
          status: "failed",
          errorCode: {
            in: [...transientReplayErrorCodes],
          },
        },
      });

      await tx.inboundWebhookReplayBatch.update({
        where: { id: batch.id },
        data: {
          status: "completed_with_failures",
          failedCount,
          retryableFailedCount,
          completedAt: new Date(),
        },
      });
      await tx.auditLog.create({
        data: {
          workspaceId: batch.workspaceId,
          actorUserId: null,
          actorType: "system",
          action: "inbound_webhook.replay.retry_enqueue",
          targetType: "inbound_webhook_replay_batch",
          targetId: batch.id,
          resultStatus: "failed",
          reason: "inbound_webhook_replay_queue_unavailable",
        },
      });
    });
  }

  private async loadConnection(connectionId: string) {
    const connection = await this.prisma.inboundWebhookConnection.findFirst({
      where: {
        id: connectionId,
        removedAt: null,
      },
      include: {
        parserRelease: true,
      },
    });

    if (!connection) {
      throw new NotFoundException("Conexao nao encontrada");
    }

    return connection;
  }

  private parserReleaseDto(release: {
    id: string;
    provider: InboundWebhookParserReleaseDto["provider"];
    version: string;
    status: "observation_only" | "certified" | "retired";
    certifiedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): InboundWebhookParserReleaseDto {
    return {
      id: release.id,
      provider: release.provider,
      version: release.version,
      status: release.status,
      certifiedAt: release.certifiedAt?.toISOString() ?? null,
      createdAt: release.createdAt.toISOString(),
      updatedAt: release.updatedAt.toISOString(),
    };
  }

  private batchDto(batch: {
    id: string;
    workspaceId: string;
    connectionId: string;
    channelId: string | null;
    requestedByUserId: string;
    selection: InboundWebhookReplaySelectionDto;
    requestedLimit: number;
    status:
      | "queued"
      | "processing"
      | "completed"
      | "completed_with_failures"
      | "failed";
    totalItems: number;
    materializedCount: number;
    duplicateCount: number;
    skippedCount: number;
    failedCount: number;
    retryableFailedCount: number;
    retryCount: number;
    startedAt: Date | null;
    completedAt: Date | null;
    lastRetriedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): BackofficeInboundWebhookReplayBatchDto {
    return {
      id: batch.id,
      workspaceId: batch.workspaceId,
      connectionId: batch.connectionId,
      channelId: batch.channelId,
      requestedByUserId: batch.requestedByUserId,
      selection: batch.selection,
      requestedLimit: batch.requestedLimit,
      status: batch.status,
      totalItems: batch.totalItems,
      materializedCount: batch.materializedCount,
      duplicateCount: batch.duplicateCount,
      skippedCount: batch.skippedCount,
      failedCount: batch.failedCount,
      retryableFailedCount: batch.retryableFailedCount,
      retryCount: batch.retryCount,
      startedAt: batch.startedAt?.toISOString() ?? null,
      completedAt: batch.completedAt?.toISOString() ?? null,
      lastRetriedAt: batch.lastRetriedAt?.toISOString() ?? null,
      createdAt: batch.createdAt.toISOString(),
      updatedAt: batch.updatedAt.toISOString(),
    };
  }

  private routeReady(
    event: {
      classification: string;
      resolvedBusinessConnectionId: string | null;
      resolvedReportingAccountId: string | null;
      resolvedConversionDestinationId: string | null;
      resolvedBusinessConnection: {
        status: string;
        credential: {
          status: string;
        };
      } | null;
      resolvedReportingAccount: {
        active: boolean;
        adAccountId: string;
        businessConnectionId: string | null;
      } | null;
      resolvedConversionDestination: {
        status: string;
      } | null;
      channel: {
        routes: Array<{
          metaBusinessConnectionId: string | null;
          metaReportingAccountId: string | null;
          metaConversionDestinationId: string | null;
        }>;
      };
    },
    currentAdAccountId: string | null,
  ): boolean {
    const business = event.resolvedBusinessConnection;
    const reporting = event.resolvedReportingAccount;
    const destination = event.resolvedConversionDestination;

    return Boolean(
      event.classification === "eligible_route_resolved" &&
      event.resolvedBusinessConnectionId &&
      event.resolvedReportingAccountId &&
      event.resolvedConversionDestinationId &&
      business?.status === "active" &&
      business.credential.status === "active" &&
      reporting?.active &&
      reporting.businessConnectionId === event.resolvedBusinessConnectionId &&
      currentAdAccountId &&
      reporting.adAccountId === currentAdAccountId &&
      destination?.status === "configured" &&
      event.channel.routes.some(
        (route) =>
          route.metaBusinessConnectionId ===
            event.resolvedBusinessConnectionId &&
          route.metaReportingAccountId === event.resolvedReportingAccountId &&
          route.metaConversionDestinationId ===
            event.resolvedConversionDestinationId,
      ),
    );
  }

  private replayWindowEligible(
    event: {
      delivery: {
        firstReceivedAt: Date;
      };
      channel: {
        productionActivatedAt: Date | null;
      };
    },
    connection: {
      status: string;
      productionActivatedAt: Date | null;
    },
  ): boolean {
    if (connection.status === "observation") {
      return true;
    }

    if (
      connection.status !== "production" ||
      !connection.productionActivatedAt
    ) {
      return false;
    }

    const channelActivatedAt = event.channel.productionActivatedAt;

    return Boolean(
      !channelActivatedAt ||
      event.delivery.firstReceivedAt.getTime() <
        connection.productionActivatedAt.getTime() ||
      event.delivery.firstReceivedAt.getTime() < channelActivatedAt.getTime(),
    );
  }

  private payloadAvailable(
    delivery: {
      payloadExpiresAt: Date;
      encryptedPayload: string | null;
      payloadIv: string | null;
      payloadTag: string | null;
      encryptionKeyVersion: number | null;
    },
    now: Date,
  ): boolean {
    return Boolean(
      delivery.payloadExpiresAt.getTime() > now.getTime() &&
      delivery.encryptedPayload &&
      delivery.payloadIv &&
      delivery.payloadTag &&
      delivery.encryptionKeyVersion,
    );
  }

  private replayEnabled(): boolean {
    const config = parseInboundWebhooksConfig(this.env);

    return config.enabled && config.replayEnabled;
  }

  private replaySelectionLimit(
    selection: InboundWebhookReplaySelectionDto,
  ): number {
    return replaySelectionLimits[selection];
  }

  private assertReplayEnabled(): void {
    if (!this.replayEnabled()) {
      throw new ServiceUnavailableException(
        "Replay controlado desativado neste ambiente",
      );
    }
  }

  private assertJobPayload(
    input: Readonly<InboundWebhookReplayJobPayload>,
  ): void {
    if (
      !input ||
      !this.identifier(input.batchId) ||
      !this.identifier(input.workspaceId)
    ) {
      throw new ReplayItemFailure("inbound_webhook_replay_context_invalid");
    }
  }

  private identifier(value: unknown): value is string {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 255 &&
      !value.includes("\0")
    );
  }

  private replayErrorCode(error: unknown): string {
    return error instanceof ReplayItemFailure &&
      /^[a-z0-9_]{1,120}$/u.test(error.code)
      ? error.code
      : "inbound_webhook_replay_unexpected";
  }

  private prismaErrorCode(error: unknown): string | null {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      typeof error.code !== "string"
    ) {
      return null;
    }

    return error.code;
  }

  private metaEventId(
    provider: string,
    connectionId: string,
    dedupeKey: string,
  ): string {
    const digest = createHash("sha256")
      .update(`${connectionId}\0${dedupeKey}`, "utf8")
      .digest("hex");

    return `${provider}_lead_${digest}`;
  }

  private sourceIp(value: string | null): string | null {
    const normalized = value?.trim();

    return normalized &&
      normalized.length <= 128 &&
      !/[\u0000-\u001f\u007f]/u.test(normalized)
      ? normalized
      : null;
  }
}
