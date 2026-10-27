import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  integrationEndpointKindFor,
  integrationReceiptReasonLabel,
  type BackofficeIntegrationEventDto,
  type BackofficeIntegrationEventListDto,
  type BackofficeIntegrationEventQueryDto,
  type IntegrationEndpointEventStatusDto,
  type IntegrationEndpointProviderDto,
  type IntegrationEventPayloadDto,
} from "@wpptrack/shared";
import type { PlatformAdminUser } from "../auth/platform-admin.service";
import { PrismaService } from "../common/prisma/prisma.service";
import { INBOUND_WEBHOOK_RAW_RETENTION_DAYS } from "../config/deployment-config";
import { InboundWebhookPayloadEncryptionService } from "./inbound-webhook-payload-encryption.service";
import {
  decryptIntegrationEvent,
  decryptIntegrationEventForViewer,
  integrationEventPayloadExpiredMessage,
  integrationEventPayloadUnreadableMessage,
  maskSensitivePayload,
  parseIntegrationSale,
} from "./integration-event-inspection";
import { isSalesPlatformProvider } from "./providers/sales-platform-sale";

const dayMs = 86_400_000;
const retentionMs = INBOUND_WEBHOOK_RAW_RETENTION_DAYS * dayMs;
const workspaceMatchLimit = 20;

/** Refused before reading the body: only metadata was ever stored. */
export const integrationEventPayloadNeverStoredMessage =
  "Recebimento recusado antes da leitura (token ausente ou errado, URL removida ou corpo acima do limite): por segurança só os metadados foram guardados, nunca o conteúdo.";

type EventRow = Prisma.IntegrationEndpointEventGetPayload<{
  include: { workspace: { select: { name: true } } };
}>;

/** Cursor = "<payloadExpiresAt ms>_<id>" in base64url. */
function encodeCursor(row: { payloadExpiresAt: Date; id: string }): string {
  return Buffer.from(
    `${row.payloadExpiresAt.getTime()}_${row.id}`,
    "utf8",
  ).toString("base64url");
}

function decodeCursor(
  cursor: string | undefined,
): { at: Date; id: string } | null {
  if (!cursor) return null;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^(\d{1,15})_([A-Za-z0-9_-]{1,64})$/u.exec(decoded);
  if (!match) return null;
  return { at: new Date(Number(match[1])), id: match[2]! };
}

/**
 * Backoffice "Recebimentos das URLs únicas" (porte do SaaS #170, fase 6.5):
 * every receipt of the workspace integration URLs (sales platforms and
 * per-event automation URLs) across the workspaces of this installation, for
 * platform admins only (the controller checks). No private-integration
 * filter (the student edition has none) and no certification: read-only.
 *
 * Index use: receipts are listed newest first by `payloadExpiresAt`, which
 * is written once as firstReceivedAt + INBOUND_WEBHOOK_RAW_RETENTION_DAYS
 * (never updated; the purge only clears the payload columns) and is indexed
 * on its own, so the cross-workspace page is a bounded backward index scan,
 * no migration needed. Retention: the payload is cleared after
 * INBOUND_WEBHOOK_RAW_RETENTION_DAYS and unrouted receipts (rejected
 * included) are deleted after INTEGRATION_RECEIPT_RETENTION_DAYS.
 */
@Injectable()
export class BackofficeIntegrationEventsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(InboundWebhookPayloadEncryptionService)
    private readonly encryption: InboundWebhookPayloadEncryptionService,
  ) {}

  async list(
    query: BackofficeIntegrationEventQueryDto,
    actor: PlatformAdminUser,
  ): Promise<BackofficeIntegrationEventListDto> {
    const matched = await this.matchWorkspaces(
      query.workspace ?? query.workspaceId,
    );
    if (matched && matched.length === 0) {
      return { items: [], nextCursor: null, matchedWorkspaces: [] };
    }

    const where: Prisma.IntegrationEndpointEventWhereInput[] = [];
    if (matched) where.push({ workspaceId: { in: matched.map(({ id }) => id) } });
    if (query.provider) where.push({ provider: query.provider });
    if (query.eventName) where.push({ eventName: query.eventName });
    switch (query.status) {
      case "all":
        break;
      case "duplicate":
        where.push({ attemptCount: { gt: 1 } });
        break;
      default:
        where.push({ status: query.status });
    }
    if (query.from) {
      // payloadExpiresAt >= firstReceivedAt always: a correct lower bound
      // that also stops the backward index scan.
      where.push({ firstReceivedAt: { gte: query.from.date } });
      where.push({ payloadExpiresAt: { gte: query.from.date } });
    }
    if (query.to) {
      const end = query.to.dayOnly
        ? new Date(query.to.date.getTime() + dayMs)
        : query.to.date;
      where.push({ firstReceivedAt: { lt: end } });
      where.push({
        payloadExpiresAt: { lt: new Date(end.getTime() + retentionMs) },
      });
    }
    const cursor = decodeCursor(query.cursor);
    if (cursor) {
      where.push({
        OR: [
          { payloadExpiresAt: { lt: cursor.at } },
          { payloadExpiresAt: cursor.at, id: { lt: cursor.id } },
        ],
      });
    }

    const rows: EventRow[] = await this.prisma.integrationEndpointEvent.findMany(
      {
        where: where.length > 0 ? { AND: where } : {},
        orderBy: [{ payloadExpiresAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
        include: { workspace: { select: { name: true } } },
      },
    );
    const page = rows.slice(0, query.limit);
    const ruleNames = await this.ruleNames(page);
    const now = new Date();
    const items = page.map((row) => this.itemDto(row, ruleNames, now));

    await this.prisma.auditLog.create({
      data: {
        workspaceId: matched?.length === 1 ? matched[0]!.id : null,
        actorUserId: actor.id,
        actorType: "platform_admin",
        action: "backoffice.integration_events.list",
        targetType: "IntegrationEndpointEvent",
        targetId: "list",
        reason: "Backoffice audit of the integration URLs receipts",
        sourceIp: null,
        resultStatus: "success",
        afterSummary: {
          provider: query.provider ?? null,
          status: query.status,
          eventName: query.eventName ?? null,
          workspaces: matched?.map(({ id }) => id) ?? null,
          count: items.length,
        },
      },
    });

    return {
      items,
      nextCursor:
        rows.length > query.limit && page.length > 0
          ? encodeCursor(page[page.length - 1]!)
          : null,
      ...(matched ? { matchedWorkspaces: matched } : {}),
    };
  }

  /**
   * "Ver dados recebidos" from the Backoffice: any workspace (platform
   * admin), account keys/secrets hidden (also tokens inside URLs), audited on
   * the receipt's workspace.
   */
  async readPayload(
    eventId: string,
    actor: PlatformAdminUser,
  ): Promise<IntegrationEventPayloadDto> {
    const event = await this.prisma.integrationEndpointEvent.findUnique({
      where: { id: eventId },
    });
    if (!event) throw new NotFoundException("Recebimento não encontrado");

    const viewer = decryptIntegrationEventForViewer(this.encryption, event);
    const sales = isSalesPlatformProvider(event.provider);
    const read =
      viewer.ok && viewer.json && sales
        ? parseIntegrationSale(event, viewer.payload)
        : null;

    if (viewer.ok) {
      await this.prisma.auditLog.create({
        data: {
          workspaceId: event.workspaceId,
          actorUserId: actor.id,
          actorType: "platform_admin",
          action: "integration_endpoint.event.payload.read",
          targetType: "IntegrationEndpointEvent",
          targetId: event.id,
          reason: "Backoffice audit of the integration URLs receipts",
          sourceIp: null,
          resultStatus: "success",
          afterSummary: {
            provider: event.provider,
            status: event.status,
            via: "backoffice",
          },
        },
      });
    }

    return {
      eventId: event.id,
      provider: event.provider as IntegrationEndpointProviderDto,
      status: event.status as IntegrationEndpointEventStatusDto,
      reasonLabel: event.reasonCode
        ? integrationReceiptReasonLabel(event.reasonCode)
        : event.status === "routed"
          ? "Entregue à regra"
          : integrationReceiptReasonLabel(null),
      receivedAt: event.firstReceivedAt.toISOString(),
      payloadExpiresAt: event.payloadExpiresAt.toISOString(),
      payloadAvailable: viewer.ok,
      payloadMessage: viewer.ok
        ? null
        : viewer.kind === "absent"
          ? integrationEventPayloadNeverStoredMessage
          : viewer.kind === "expired"
            ? integrationEventPayloadExpiredMessage
            : integrationEventPayloadUnreadableMessage,
      payload: viewer.ok
        ? viewer.json
          ? maskSensitivePayload(viewer.payload)
          : viewer.payload
        : null,
      parsed: read?.ok ? read.parsed : null,
      parseError: read && !read.ok ? read.errorCode : null,
    };
  }

  /** Client search: exact workspace id, else part of the name. */
  private async matchWorkspaces(
    search: string | undefined,
  ): Promise<Array<{ id: string; name: string }> | null> {
    if (!search) return null;
    return this.prisma.workspace.findMany({
      where: {
        OR: [
          { id: search },
          { name: { contains: search, mode: "insensitive" } },
        ],
      },
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: workspaceMatchLimit,
    });
  }

  private async ruleNames(rows: EventRow[]): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        rows
          .map((row) => row.routedProviderRuleId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (ids.length === 0) return new Map();
    const rules = await this.prisma.providerConversionRuleConfig.findMany({
      where: { id: { in: ids } },
      select: { id: true, conversionRule: { select: { name: true } } },
    });
    return new Map(rules.map((rule) => [rule.id, rule.conversionRule.name]));
  }

  private itemDto(
    row: EventRow,
    ruleNames: Map<string, string>,
    now: Date,
  ): BackofficeIntegrationEventDto {
    const provider = row.provider as IntegrationEndpointProviderDto;
    const sales = isSalesPlatformProvider(provider);
    // Pedido and masked phone are not columns: read from the payload while
    // it is kept (sales platforms only).
    const decrypted =
      sales && row.encryptedPayload
        ? decryptIntegrationEvent(this.encryption, row, now)
        : null;
    const read =
      decrypted?.ok ? parseIntegrationSale(row, decrypted.payload) : null;
    const parsed = read?.ok ? read.parsed : null;
    const ruleName = row.routedProviderRuleId
      ? (ruleNames.get(row.routedProviderRuleId) ?? null)
      : null;

    return {
      id: row.id,
      workspaceId: row.workspaceId,
      workspaceName: row.workspace?.name ?? null,
      provider,
      kind: integrationEndpointKindFor(provider),
      status: row.status as IntegrationEndpointEventStatusDto,
      reasonCode: row.reasonCode,
      resultLabel: this.resultLabel(row, ruleName),
      providerStatus: parsed?.providerStatus ?? row.providerStatus,
      eventName: row.eventName,
      valueCents: row.valueCents,
      currency: row.currency,
      orderRef: parsed?.orderRef ?? null,
      phoneMasked: parsed?.phoneMasked ?? null,
      productName: row.productName,
      productCode: row.productCode,
      routedRuleId: row.routedProviderRuleId,
      routedRuleName: ruleName,
      attemptCount: row.attemptCount,
      firstReceivedAt: row.firstReceivedAt.toISOString(),
      lastReceivedAt: row.lastReceivedAt.toISOString(),
      payloadAvailable: Boolean(
        row.encryptedPayload && row.payloadExpiresAt > now,
      ),
      payloadExpiresAt: row.payloadExpiresAt.toISOString(),
    };
  }

  private resultLabel(row: EventRow, ruleName: string | null): string {
    const reason = integrationReceiptReasonLabel(row.reasonCode);
    switch (row.status) {
      case "routed":
        return `Com regra: ${ruleName ?? row.routedProviderRuleId ?? "—"}`;
      case "unattributed":
        return `Sem atribuição: ${reason}`;
      case "pending":
        return `Pendente: ${reason}`;
      case "ignored":
        return `Ignorado: ${reason}`;
      case "invalid":
        return `Inválido: ${reason}`;
      case "rejected":
        return `Recusado: ${reason}`;
      default:
        return reason;
    }
  }
}
