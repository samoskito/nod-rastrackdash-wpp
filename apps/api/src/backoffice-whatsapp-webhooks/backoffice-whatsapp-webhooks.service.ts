import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  backofficeWhatsappWebhookConnectionListSchema,
  backofficeWhatsappWebhookDetailSchema,
  backofficeWhatsappWebhookHistorySchema,
  type BackofficeWhatsappWebhookConnectionDto,
  type BackofficeWhatsappWebhookDetailDto,
  type BackofficeWhatsappWebhookHistoryDto,
  type BackofficeWhatsappWebhookHistoryItemDto,
  type BackofficeWhatsappWebhookHistoryQueryDto,
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";

const whatsappProviders = ["uazapi_byo", "waha", "zapi", "nod_api"] as const;

type WhatsappConnectionRecord = {
  id: string;
  name: string;
  provider: (typeof whatsappProviders)[number];
  status: "pending_payment" | "active" | "disconnected" | "suspended" | "error";
  webhookUrl: string | null;
  webhookTokenHash: string | null;
};

type WebhookLogRecord = {
  id: string;
  receivedAt: Date;
  status: string;
  source: BackofficeWhatsappWebhookHistoryItemDto["source"];
  eventType: string;
  externalEventId: string | null;
  leadId: string | null;
  errorCode: string | null;
  summaryPayload: unknown;
};

@Injectable()
export class BackofficeWhatsappWebhooksService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listConnections(
    workspaceId: string,
  ): Promise<BackofficeWhatsappWebhookConnectionDto[]> {
    const connections = (await this.prisma.whatsappInstance.findMany({
      where: {
        workspaceId,
        provider: { in: [...whatsappProviders] },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        provider: true,
        status: true,
        webhookUrl: true,
        webhookTokenHash: true,
      },
    })) as WhatsappConnectionRecord[];

    return backofficeWhatsappWebhookConnectionListSchema.parse(
      connections.map((connection) => ({
        id: connection.id,
        name: connection.name,
        provider: connection.provider,
        status: connection.status,
        webhookConfigured: Boolean(
          connection.webhookUrl && connection.webhookTokenHash,
        ),
      })),
    );
  }

  async listHistory(
    workspaceId: string,
    connectionId: string,
    query: BackofficeWhatsappWebhookHistoryQueryDto,
  ): Promise<BackofficeWhatsappWebhookHistoryDto> {
    const connection = await this.findConnection(workspaceId, connectionId);
    const where: Prisma.WebhookLogWhereInput = {
      workspaceId,
      whatsappInstanceId: connection.id,
    };
    const [total, records] = await Promise.all([
      this.prisma.webhookLog.count({ where }),
      this.prisma.webhookLog.findMany({
        where,
        orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          receivedAt: true,
          status: true,
          source: true,
          eventType: true,
          externalEventId: true,
          leadId: true,
          errorCode: true,
          summaryPayload: true,
        },
      }),
    ]);

    return backofficeWhatsappWebhookHistorySchema.parse({
      items: (records as WebhookLogRecord[]).map((record) =>
        this.toHistoryItem(record, connection.provider),
      ),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / query.pageSize),
      },
    });
  }

  async getWebhookDetail(
    workspaceId: string,
    connectionId: string,
    webhookLogId: string,
  ): Promise<BackofficeWhatsappWebhookDetailDto> {
    const connection = await this.findConnection(workspaceId, connectionId);
    const record = (await this.prisma.webhookLog.findFirst({
      where: {
        id: webhookLogId,
        workspaceId,
        whatsappInstanceId: connection.id,
      },
      select: {
        id: true,
        receivedAt: true,
        status: true,
        source: true,
        eventType: true,
        externalEventId: true,
        leadId: true,
        errorCode: true,
        summaryPayload: true,
      },
    })) as WebhookLogRecord | null;

    if (!record) {
      throw new NotFoundException("Webhook nao encontrado");
    }

    const payload = this.redactPayload(record.summaryPayload);
    return backofficeWhatsappWebhookDetailSchema.parse({
      webhook: this.toHistoryItem(record, connection.provider),
      payloadAvailable: payload !== null,
      payload,
    });
  }

  private async findConnection(
    workspaceId: string,
    connectionId: string,
  ): Promise<WhatsappConnectionRecord> {
    const connection = (await this.prisma.whatsappInstance.findFirst({
      where: {
        id: connectionId,
        workspaceId,
        provider: { in: [...whatsappProviders] },
      },
      select: {
        id: true,
        name: true,
        provider: true,
        status: true,
        webhookUrl: true,
        webhookTokenHash: true,
      },
    })) as WhatsappConnectionRecord | null;

    if (!connection) {
      throw new NotFoundException("Conexao WhatsApp nao encontrada");
    }
    return connection;
  }

  private toHistoryItem(
    record: WebhookLogRecord,
    provider: WhatsappConnectionRecord["provider"],
  ): BackofficeWhatsappWebhookHistoryItemDto {
    return {
      id: record.id,
      receivedAt: record.receivedAt.toISOString(),
      status: record.status,
      source: record.source,
      provider,
      eventType: record.eventType,
      externalEventId: record.externalEventId,
      leadId: record.leadId,
      errorCode: record.errorCode,
    };
  }

  private redactPayload(payload: unknown): Record<string, unknown> | null {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    return this.redactValue(payload) as Record<string, unknown>;
  }

  private redactValue(value: unknown): unknown {
    if (typeof value === "string") return this.redactString(value);
    if (Array.isArray(value)) return value.map((entry) => this.redactValue(entry));
    if (!value || typeof value !== "object") return value;

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
        this.isSensitiveKey(key) ? [] : [[key, this.redactValue(entry)]],
      ),
    );
  }

  private isSensitiveKey(key: string): boolean {
    return /(authorization|cookie|secret|token|api.?key|password|credential|phone|telephone|mobile|email|e-mail|webhook.*hash)/i.test(
      key,
    );
  }

  private redactString(value: string): string {
    return value
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
      .replace(/(?<!\d)(?:\+?\d[\d .()\-]{7,}\d)(?!\d)/g, "[redacted-phone]");
  }
}
