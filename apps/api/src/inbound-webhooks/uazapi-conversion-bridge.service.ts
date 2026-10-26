import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  BRIDGE_PARSER_VERSION,
  BRIDGE_PROVISIONED_EVENT,
  type BridgedWhatsappProvider,
} from "./bridged-whatsapp-providers";
import { bornChannelState, bornConnectionStatus } from "./production-direct";

export type UazapiBridgeInstance = {
  id: string;
  workspaceId: string;
  name: string;
  providerInstanceId: string | null;
  connectedPhone?: string | null;
  providerTokenEncrypted?: string | null;
  providerTokenIv?: string | null;
  providerTokenTag?: string | null;
};

export type UazapiBridgeResult = {
  connectionId: string;
  channelId: string;
};

/**
 * U2c: bridges a UAZAPI/NOD WhatsappInstance into an InboundWebhookConnection +
 * InboundWebhookChannel pair so it shows up in the same "Gatilhos" builder
 * (Settings) that Umbler/Gupshup use, and so message_phrase provider-conversion
 * rules can be scoped to it via ProviderConversionRuleConfig.channels.
 *
 * One instance <-> one connection <-> one channel (InboundWebhookChannel.
 * whatsappInstanceId is unique). Idempotent: safe to call on every webhook and
 * on every Settings load.
 *
 * WAHA (GoWS): the same bridge with `provider = "waha"`. The connection is a
 * "waha" InboundWebhookConnection on the certified waha/v2 parser release (the
 * receiver's), so the production gates (parser release of the connection's
 * own provider) hold exactly as for Uazapi.
 */
@Injectable()
export class UazapiConversionBridgeService {
  private readonly logger = new Logger(UazapiConversionBridgeService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async ensureBridge(
    instance: UazapiBridgeInstance,
    provider: BridgedWhatsappProvider = "uazapi",
  ): Promise<UazapiBridgeResult> {
    const existing = await this.findExisting(instance, provider);
    if (existing) return existing;
    const parserVersion = BRIDGE_PARSER_VERSION[provider];

    return this.prisma.$transaction(async (transaction) => {
      // Re-check inside the transaction: two concurrent webhooks for the same
      // instance must not create two connections.
      const current = await transaction.inboundWebhookChannel.findUnique({
        where: { whatsappInstanceId: instance.id },
        select: { id: true, connectionId: true, workspaceId: true },
      });
      if (current && current.workspaceId === instance.workspaceId) {
        return { connectionId: current.connectionId, channelId: current.id };
      }

      const release = await transaction.inboundWebhookParserRelease.upsert({
        where: {
          provider_version: {
            provider,
            version: parserVersion,
          },
        },
        create: {
          provider,
          version: parserVersion,
          // UAZAPI/WAHA team messages are evaluated straight off the decision
          // engine (no reparse step), so there is no separate parser
          // certification workflow to gate on here. WAHA's waha/v2 row is
          // normally already certified by its migration; `update: {}` never
          // overrides an operator's retirement.
          status: "certified",
          certifiedAt: new Date(),
        },
        update: {},
      });

      // Fase 6.1c (produção direta): a Uazapi e a WAHA foram validadas no
      // SaaS, então a ponte nasce em produção e o número com o envio ativo
      // (cada conexão tem um único número). Uma release retirada pelo
      // operador continua fora de produção.
      const bornAt = new Date();
      const status = bornConnectionStatus(release);
      const connection = await transaction.inboundWebhookConnection.create({
        data: {
          workspaceId: instance.workspaceId,
          provider,
          displayName:
            instance.name?.trim() || (provider === "waha" ? "WAHA" : "UAZAPI"),
          parserReleaseId: release.id,
          status,
          productionActivatedAt: status === "production" ? bornAt : null,
        },
        select: { id: true, status: true },
      });
      const channelState = bornChannelState(connection, release, bornAt);

      const channel = await transaction.inboundWebhookChannel.create({
        data: {
          workspaceId: instance.workspaceId,
          connectionId: connection.id,
          organizationId: instance.id,
          providerChannelId: instance.providerInstanceId || instance.id,
          // A connection test can provide the business's actual WhatsApp
          // number before any inbound event arrives. Existing webhook paths
          // retain their stable fallback until they provide that identity.
          connectedPhone:
            instance.connectedPhone?.trim() ||
            instance.providerInstanceId?.trim() ||
            instance.id,
          channelName: instance.name,
          whatsappInstanceId: instance.id,
          status: channelState.status,
          productionActivatedAt: channelState.productionActivatedAt,
        },
        select: { id: true },
      });

      // Durable event, committed with the bridge: a "Todos os números" rule
      // in production activates this number automatically
      // (GlobalRuleAutoActivationService reads it).
      await transaction.auditLog.create({
        data: {
          workspaceId: instance.workspaceId,
          actorUserId: null,
          actorType: "system",
          action: BRIDGE_PROVISIONED_EVENT[provider],
          targetType: "InboundWebhookChannel",
          targetId: channel.id,
          reason: null,
          sourceIp: null,
          resultStatus: status,
          afterSummary: {
            connectionId: connection.id,
            whatsappInstanceId: instance.id,
            provider,
          },
        },
      });

      this.logger.log(
        JSON.stringify({
          event:
            provider === "waha"
              ? "waha_conversion_bridge_provisioned"
              : "uazapi_conversion_bridge_provisioned",
          workspaceId: instance.workspaceId,
          whatsappInstanceId: instance.id,
          connectionId: connection.id,
          channelId: channel.id,
        }),
      );

      return { connectionId: connection.id, channelId: channel.id };
    });
  }

  private async findExisting(
    instance: UazapiBridgeInstance,
    provider: BridgedWhatsappProvider,
  ): Promise<UazapiBridgeResult | null> {
    const channel = await this.prisma.inboundWebhookChannel.findUnique({
      where: { whatsappInstanceId: instance.id },
      select: {
        id: true,
        connectionId: true,
        workspaceId: true,
        connectedPhone: true,
        providerChannelId: true,
        organizationId: true,
      },
    });

    if (!channel || channel.workspaceId !== instance.workspaceId) return null;

    // WAHA: the bridge starts with the session name as a placeholder phone
    // (its connection test reports no number). The first team message brings
    // the store's real number; record it once so the number shows its phone
    // and a global rule still runs once per phone. Uazapi keeps its behavior.
    const phone = instance.connectedPhone?.trim();
    const current = channel.connectedPhone?.trim() ?? "";
    if (
      provider === "waha" &&
      phone &&
      /^\d{8,15}$/u.test(phone) &&
      phone !== current &&
      (current === "" ||
        current === channel.providerChannelId?.trim() ||
        current === channel.organizationId?.trim())
    ) {
      await this.prisma.inboundWebhookChannel.updateMany({
        where: {
          id: channel.id,
          workspaceId: instance.workspaceId,
          connectedPhone: channel.connectedPhone,
        },
        data: { connectedPhone: phone },
      });
    }

    return { connectionId: channel.connectionId, channelId: channel.id };
  }
}
