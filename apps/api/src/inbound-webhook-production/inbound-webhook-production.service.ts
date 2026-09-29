import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
// rastrackdash sanitize (rewrite_rules.external-channel-billing-access-stub):
// billing/ is stripped in this edition; ExternalChannelBillingAccessService
// was a REQUIRED (non-@Optional) constructor dependency here, so removing
// just the import isn't enough — this local always-allow stand-in matches
// ExternalChannelBillingAccessService.isEnforced() === false once
// PackageBillingConfiguration is gone, and keeps
// ExternalChannelBillingAccessError as a real class so the existing
// instanceof error-code narrowing below still compiles (it is now
// unreachable, since assertProductionAccess() never throws).
class ExternalChannelBillingAccessError extends Error {
  constructor(readonly code: string) {
    super("External WhatsApp channel billing access denied");
    this.name = "ExternalChannelBillingAccessError";
  }
}
class ExternalChannelBillingAccessStub {
  async assertProductionAccess(
    _workspaceId: string,
    _channelId: string,
  ): Promise<void> {
    // no-op: external-channel billing enforcement is always disabled once
    // billing/ is removed.
  }
}
import {
  hashPhoneIdentity,
  normalizePhoneIdentity,
} from "../common/phone/phone-identity";
import { PrismaService } from "../common/prisma/prisma.service";
import { ConversionEventsQueueService } from "../common/queue/conversion-events-queue.service";
import type { InboundWebhookProductionJobPayload } from "../common/queue/queue.constants";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { parseInboundWebhooksConfig } from "../config/deployment-config";
import { ConversionEventsService } from "../conversion-events/conversion-events.service";
import { InboundWebhookPayloadEncryptionService } from "../inbound-webhooks/inbound-webhook-payload-encryption.service";
import { inboundWebhookParserContext } from "../inbound-webhooks/providers/inbound-webhook-parser";
import type { ParsedInboundWebhookEvent } from "../inbound-webhooks/providers/inbound-webhook-parser";
import { InboundWebhookParserRegistry } from "../inbound-webhooks/providers/inbound-webhook-parser.registry";
import { LeadsService } from "../leads/leads.service";

const terminalStatuses = new Set(["materialized", "duplicate"]);
const productionItemInclude = {
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
} satisfies Prisma.InboundWebhookProductionItemInclude;

type ProductionItemRecord = Prisma.InboundWebhookProductionItemGetPayload<{
  include: typeof productionItemInclude;
}>;

class ProductionItemFailure extends Error {
  constructor(readonly code: string) {
    super("Inbound webhook production item failed");
    this.name = "ProductionItemFailure";
  }
}

@Injectable()
export class InboundWebhookProductionService {
  private readonly billingAccess = new ExternalChannelBillingAccessStub();

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
    @Inject(RUNTIME_ENV)
    private readonly env: RuntimeEnv = process.env,
  ) {}

  async processItem(
    input: Readonly<InboundWebhookProductionJobPayload>,
  ): Promise<{ status: "materialized" | "duplicate" | "unchanged" }> {
    this.assertJobPayload(input);

    if (!this.productionEnabled()) {
      throw new ProductionItemFailure("inbound_webhook_production_disabled");
    }

    const item = await this.prisma.inboundWebhookProductionItem.findFirst({
      where: {
        id: input.productionItemId,
        workspaceId: input.workspaceId,
      },
      include: productionItemInclude,
    });

    if (!item) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_item_not_found",
      );
    }

    if (terminalStatuses.has(item.status)) {
      return { status: "unchanged" };
    }

    await this.prisma.inboundWebhookProductionItem.update({
      where: { id: item.id },
      data: {
        status: "processing",
        errorCode: null,
        attemptCount: { increment: 1 },
        lastAttemptedAt: new Date(),
      },
    });

    try {
      const result = await this.materialize(item);
      const status = result.duplicate ? "duplicate" : "materialized";

      await this.prisma.inboundWebhookProductionItem.update({
        where: { id: item.id },
        data: {
          status,
          leadId: result.leadId,
          conversionEventLogId: result.conversionEventLogId,
          errorCode: null,
          processedAt: new Date(),
        },
      });

      return { status };
    } catch (error) {
      const code = this.productionErrorCode(error);

      await this.prisma.inboundWebhookProductionItem.update({
        where: { id: item.id },
        data: {
          status: "failed",
          errorCode: code,
          processedAt: new Date(),
        },
      });

      throw new ProductionItemFailure(code);
    }
  }

  private async materialize(item: ProductionItemRecord): Promise<{
    leadId: string;
    conversionEventLogId: string;
    duplicate: boolean;
  }> {
    const event = item.event;
    const connection = event.connection;
    const delivery = event.delivery;
    const channel = event.channel;
    const business = event.resolvedBusinessConnection;
    const reporting = event.resolvedReportingAccount;
    const destination = event.resolvedConversionDestination;
    const routeStillActive = channel.routes.some(
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
      throw new ProductionItemFailure(
        "inbound_webhook_production_event_ineligible",
      );
    }

    if (
      connection.removedAt ||
      connection.status !== "production" ||
      !connection.productionActivatedAt ||
      connection.parserRelease.status !== "certified" ||
      connection.parserRelease.version !== delivery.parserVersion ||
      channel.status !== "active" ||
      !channel.productionActivatedAt ||
      delivery.firstReceivedAt < connection.productionActivatedAt ||
      delivery.firstReceivedAt < channel.productionActivatedAt
    ) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_context_changed",
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
      throw new ProductionItemFailure(
        "inbound_webhook_production_route_invalid",
      );
    }

    if (!this.payloadAvailable(delivery, now)) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_payload_unavailable",
      );
    }

    await this.billingAccess.assertProductionAccess(
      event.workspaceId,
      event.channelId,
    );

    const parsedEvent = this.reparseEvent(item);
    const phone = normalizePhoneIdentity(parsedEvent.contact.phoneNumber);
    const phoneHash = hashPhoneIdentity(parsedEvent.contact.phoneNumber);

    if (!phone || !phoneHash || !parsedEvent.ctwaClid || !parsedEvent.adId) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_identity_invalid",
      );
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
      throw new ProductionItemFailure(
        "inbound_webhook_production_route_invalid",
      );
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
      throw new ProductionItemFailure(
        "inbound_webhook_production_lead_invalid",
      );
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
        processingMode: "live_production",
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

  private reparseEvent(item: ProductionItemRecord): ParsedInboundWebhookEvent {
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
      throw new ProductionItemFailure(
        "inbound_webhook_production_payload_invalid",
      );
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
      throw new ProductionItemFailure(
        "inbound_webhook_production_event_mismatch",
      );
    }

    return parsedEvent;
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

  private productionEnabled(): boolean {
    const config = parseInboundWebhooksConfig(this.env);

    return config.enabled && config.productionEnabled;
  }

  private assertJobPayload(
    input: Readonly<InboundWebhookProductionJobPayload>,
  ): void {
    if (
      !input ||
      !this.identifier(input.productionItemId) ||
      !this.identifier(input.workspaceId)
    ) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_context_invalid",
      );
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

  private productionErrorCode(error: unknown): string {
    if (
      (error instanceof ProductionItemFailure ||
        error instanceof ExternalChannelBillingAccessError) &&
      /^[a-z0-9_]{1,120}$/u.test(error.code)
    ) {
      return error.code;
    }

    return "inbound_webhook_production_unexpected";
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
}
