import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  conversionEventNameSchema,
  integrationEndpointKindFor,
  integrationUnattributedReasonLabel,
  type IntegrationDetectedProductListDto,
  type IntegrationEndpointCreateInputDto,
  type IntegrationEndpointDto,
  type IntegrationEndpointListDto,
  type IntegrationEndpointProviderDto,
  type IntegrationEndpointRoutingResultDto,
  type IntegrationEventPayloadDto,
  type IntegrationLegacyUrlDto,
  type IntegrationUnattributedEventListDto,
} from "@wpptrack/shared";
import {
  decryptIntegrationEvent,
  integrationEventPayloadExpiredMessage,
  integrationEventPayloadUnreadableMessage,
  maskSensitivePayload,
  parseIntegrationSale,
} from "./integration-event-inspection";
import { hashPhoneIdentity } from "../common/phone/phone-identity";
import { PrismaService } from "../common/prisma/prisma.service";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import {
  INBOUND_WEBHOOK_RAW_RETENTION_DAYS,
  parseInboundWebhooksConfig,
} from "../config/deployment-config";
import { ProviderConversionPaidLeadResolver } from "../conversion-rules/provider-conversion-paid-lead-resolver.service";
import { buildProviderPurchaseIdentity } from "../conversion-rules/provider-purchase-identity";
import { loadWorkspaceConversionCurrency } from "../currency/workspace-currency";
import { InboundConversionAutomationIngestionService } from "./inbound-conversion-automation-ingestion.service";
import {
  MAX_INBOUND_WEBHOOK_PAYLOAD_BYTES,
  matchesInboundWebhookSecret,
  parseInboundWebhookProviderAttempt,
} from "./inbound-webhook-ingestion.service";
import { InboundWebhookPayloadEncryptionService } from "./inbound-webhook-payload-encryption.service";
import {
  routeSalePlatformSale,
  routeUmblerEvent,
  routeUnnichatEvent,
  type IntegrationRouteDecision,
} from "./integration-endpoint-routing";
import { normalizeBraipBody } from "./providers/braip/braip-body";
import {
  isSalesPlatformProvider,
  parseSaleEventV1,
  type ParsedSaleAutomationV1,
  type SalesPlatformProvider,
} from "./providers/sales-platform-sale";
import {
  parseUmblerAutomationV1,
  type ParsedUmblerAutomationV1,
} from "./providers/umbler/umbler-automation-v1.parser";
import {
  parseUnnichatAutomationV1,
  type ParsedUnnichatAutomationV1,
} from "./providers/unnichat/unnichat-automation-v1.parser";

/** Same generic answer for a wrong token, an unknown or removed URL. */
const notFoundMessage = "Webhook não encontrado";
const unavailableMessage = "Webhook temporariamente indisponível";
const fallbackDedupeWindowMs = 5 * 60 * 1_000;
const AUTOMATION_PARSER_VERSION = "automation-v1";
/** Refused calls without a body kept: one row per reason per hour. */
const rejectionMetadataWindowMs = 60 * 60 * 1_000;
type IntegrationAuthRejection =
  | "token_missing"
  | "token_invalid"
  | "endpoint_removed"
  | "parser_retired";
/** Never store the body of these refusals (not authenticated / too big). */
const metadataOnlyRejections = new Set<string>([
  "token_missing",
  "token_invalid",
  "endpoint_removed",
  "parser_retired",
  "payload_too_large",
]);

/**
 * Fase 6.5 (SaaS #170): reason of a refused body of an authenticated call.
 * Kept only for Backoffice > Recebimentos das URLs únicas.
 */
function bodyRejectionReason(
  error: unknown,
  rawBody: Buffer | undefined,
): string {
  if (error instanceof PayloadTooLargeException) return "payload_too_large";
  if (error instanceof UnsupportedMediaTypeException)
    return "content_type_unsupported";
  if (!rawBody || rawBody.length === 0) return "body_empty";
  if (
    error instanceof BadRequestException &&
    error.message === "Payload JSON inválido"
  ) {
    return "body_invalid_json";
  }
  return "body_invalid";
}
const SECRET_CONTEXT = "integration-endpoint-secret";
const routedProviders = ["payt", "braip", "unnichat", "umbler"] as const;
const DAY_MS = 24 * 60 * 60 * 1_000;
/** What the rule decided that is not a conversion (review finding M3). */
const DECLINED_RULE_OUTCOMES = new Set<string>([
  "ignored",
  "blocked",
  "invalid_payload",
]);

type EndpointRecord = Prisma.IntegrationEndpointGetPayload<{
  include: { parserRelease: true };
}>;

type ParsedIntegrationEvent =
  | {
      ok: true;
      provider: SalesPlatformProvider;
      eventName: string;
      externalKey: string;
      sale: ParsedSaleAutomationV1;
    }
  | {
      ok: true;
      provider: "unnichat";
      eventName: string;
      externalKey: string;
      automation: ParsedUnnichatAutomationV1;
    }
  | {
      ok: true;
      provider: "umbler";
      eventName: string;
      externalKey: string;
      automation: ParsedUmblerAutomationV1;
      channelPhoneHint: string | null;
    }
  | {
      ok: false;
      status: "ignored" | "invalid";
      reasonCode: string;
      providerStatus: string | null;
    };

export type IntegrationEndpointIngestInput = {
  endpointId: string;
  token: unknown;
  contentType: string | undefined;
  providerAttempt: unknown;
  rawBody: Buffer | undefined;
};

export type IntegrationEndpointIngestResult = {
  status: "accepted";
  eventId: string;
  duplicate: boolean;
  routing: "routed" | "unattributed" | "ignored" | "invalid";
  reasonCode: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Fase 5.3 (SaaS 613beb3, d3725adf, 4cad4963, 73a9a56, 46fb0df0): URL única
 * por plataforma (Payt) e por evento (Unnichat/Umbler). Recebe, guarda um
 * recibo idempotente com o produto e o destino ou motivo, e entrega o callback
 * ao processamento da regra dona (ingestRouted), sem caminho paralelo.
 *
 * Licença bloqueada: toda escrita HTTP (inclusive esta URL pública e o
 * "Tentar de novo") responde 423 na guarda global antes de chegar aqui.
 */
@Injectable()
export class IntegrationEndpointsService {
  private readonly logger = new Logger(IntegrationEndpointsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RUNTIME_ENV) private readonly env: RuntimeEnv,
    @Inject(InboundWebhookPayloadEncryptionService)
    private readonly encryption: InboundWebhookPayloadEncryptionService,
    @Inject(ProviderConversionPaidLeadResolver)
    private readonly paidLeads: ProviderConversionPaidLeadResolver,
    @Inject(InboundConversionAutomationIngestionService)
    private readonly automationIngestion: InboundConversionAutomationIngestionService,
  ) {}

  // ------------------------------------------------------------------ public

  async ingest(
    input: IntegrationEndpointIngestInput,
  ): Promise<IntegrationEndpointIngestResult> {
    this.assertFeatureEnabled();
    const receivedAt = new Date();
    const { endpoint, rejection } = await this.authenticate(
      input.endpointId,
      input.token,
    );
    // Missing/wrong token, removed URL, retired parser: the same 404 as
    // before; the attempt is recorded as METADATA ONLY (never the body), for
    // Backoffice > Recebimentos das URLs únicas (SaaS #170).
    if (rejection) {
      await this.recordRejection({
        endpoint,
        reasonCode: rejection,
        rawBody: null,
        receivedAt,
      });
      throw new NotFoundException(notFoundMessage);
    }
    // Braip (6.5): JSON or form-urlencoded, stored and routed as canonical
    // JSON (the Braip account key is dropped before storage).
    let rawBody: Buffer;
    try {
      rawBody =
        endpoint.provider === "braip"
          ? this.requireBraipBody(input.contentType, input.rawBody)
          : this.requireJsonBody(input.contentType, input.rawBody);
    } catch (error) {
      // Authenticated but unreadable body (415/400): kept as a refused
      // receipt with the body as received (encrypted, same retention).
      // Braip: metadata only. An unreadable Braip body never went through
      // the normalization that drops the account key (basic_authentication),
      // and that key is never stored, not even encrypted.
      await this.recordRejection({
        endpoint,
        reasonCode: bodyRejectionReason(error, input.rawBody),
        rawBody: endpoint.provider === "braip" ? null : (input.rawBody ?? null),
        receivedAt,
      });
      throw error;
    }
    const payload = JSON.parse(rawBody.toString("utf8")) as unknown;
    const providerAttempt = parseInboundWebhookProviderAttempt(
      input.providerAttempt,
    );
    const parsed = this.parse(endpoint, payload, receivedAt);
    const ingressKey = parsed.ok
      ? this.ingressKey(endpoint.id, parsed.externalKey)
      : this.fallbackIngressKey(endpoint.id, rawBody, receivedAt);

    const receipt = await this.recordReceipt({
      endpoint,
      ingressKey,
      parsed,
      rawBody,
      receivedAt,
    });
    if (!parsed.ok) {
      return {
        status: "accepted",
        eventId: receipt.id,
        duplicate: receipt.duplicate,
        routing: parsed.status,
        reasonCode: parsed.reasonCode,
      };
    }

    // A provider retry of a sale already delivered to a rule goes back to
    // THAT rule (its own duplicate handling counts the attempt); it is never
    // re-routed nor downgraded to "unattributed" if the rules changed since.
    if (receipt.duplicate && receipt.routedProviderRuleId) {
      await this.automationIngestion
        .ingestRouted({
          workspaceId: endpoint.workspaceId,
          providerRuleId: receipt.routedProviderRuleId,
          rawBody,
          providerAttempt,
          integrationEndpointId: endpoint.id,
          routedChannelId: receipt.routedChannelId,
        })
        .catch((error: unknown) => {
          if (!(error instanceof NotFoundException)) throw error;
          return null;
        });
      return {
        status: "accepted",
        eventId: receipt.id,
        duplicate: true,
        routing: "routed",
        reasonCode: null,
      };
    }

    const routed = await this.routeAndHandOff({
      endpoint,
      eventId: receipt.id,
      parsed,
      rawBody,
      providerAttempt,
      receivedAt,
    });
    return {
      status: "accepted",
      eventId: receipt.id,
      duplicate: receipt.duplicate,
      routing: routed.status,
      reasonCode: routed.reasonCode,
    };
  }

  /** "Tentar de novo": re-route a preserved event (e.g. after a new rule). */
  async retryEvent(
    workspaceId: string,
    eventId: string,
    actorUserId: string,
  ): Promise<IntegrationEndpointRoutingResultDto> {
    this.assertFeatureEnabled();
    const event = await this.prisma.integrationEndpointEvent.findFirst({
      where: { id: eventId, workspaceId },
      include: { integrationEndpoint: { include: { parserRelease: true } } },
    });
    if (!event || event.integrationEndpoint.removedAt) {
      throw new NotFoundException("Evento não encontrado");
    }
    if (event.status === "routed") {
      throw new ConflictException(
        "Este evento já foi entregue a uma regra; reprocesse pela regra",
      );
    }
    // "Tentar de novo" exists only for "Vendas sem atribuição" (unattributed
    // or pending). A refused call, an ignored status or an invalid read is
    // never routed from here (SaaS #170).
    if (event.status !== "unattributed" && event.status !== "pending") {
      throw new ConflictException(
        event.status === "rejected"
          ? "Este recebimento foi recusado na chegada e não pode ser reenviado"
          : "Somente eventos sem atribuição podem ser tentados de novo",
      );
    }
    const rawBody = this.decryptEventPayload(event);
    const payload = JSON.parse(rawBody.toString("utf8")) as unknown;
    const endpoint = event.integrationEndpoint;
    const parsed = this.parse(endpoint, payload, event.firstReceivedAt);
    if (!parsed.ok) {
      throw new ConflictException(
        "O payload guardado não corresponde a um evento suportado",
      );
    }
    const routed = await this.routeAndHandOff({
      endpoint,
      eventId: event.id,
      parsed,
      rawBody,
      providerAttempt: null,
      receivedAt: event.firstReceivedAt,
      // Same production gate as when it arrived: a sale from before the rule
      // went to production stays observed (the rule's reprocess may send it).
      occurrenceReceivedAt: event.firstReceivedAt,
    });
    await this.prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId,
        actorType: "user",
        action: "integration_endpoint.event_retried",
        targetType: "IntegrationEndpointEvent",
        targetId: event.id,
        reason: "Operator retried an unattributed integration event",
        sourceIp: null,
        resultStatus: routed.status,
        afterSummary: {
          reasonCode: routed.reasonCode,
          providerRuleId: routed.providerRuleId,
        },
      },
    });
    return {
      eventId: event.id,
      status: routed.status,
      reasonCode: routed.reasonCode,
      providerRuleId: routed.providerRuleId,
      deliveryId: routed.deliveryId,
    };
  }

  // -------------------------------------------------------------- management

  async list(
    workspaceId: string,
    canManage: boolean,
  ): Promise<IntegrationEndpointListDto> {
    const config = parseInboundWebhooksConfig(this.env);
    const enabled = config.enabled && config.conversionRulesEnabled;
    if (!enabled) {
      return { enabled: false, canManage, endpoints: [], legacyUrls: [] };
    }
    const endpoints = await this.prisma.integrationEndpoint.findMany({
      where: { workspaceId, removedAt: null },
      include: { parserRelease: true },
      orderBy: [{ provider: "asc" }, { createdAt: "asc" }],
    });
    const counts = endpoints.length
      ? await this.prisma.integrationEndpointEvent.groupBy({
          by: ["integrationEndpointId", "status"],
          where: {
            workspaceId,
            integrationEndpointId: { in: endpoints.map(({ id }) => id) },
          },
          _count: { _all: true },
        })
      : [];
    return {
      enabled,
      canManage,
      endpoints: endpoints.map((endpoint) =>
        this.endpointDto(
          endpoint,
          // Never in listings: "Mostrar URL" reveals it (audited).
          false,
          counts.filter((row) => row.integrationEndpointId === endpoint.id),
        ),
      ),
      legacyUrls: await this.legacyUrls(workspaceId),
    };
  }

  async ensure(
    workspaceId: string,
    input: IntegrationEndpointCreateInputDto,
    actorUserId: string,
  ): Promise<IntegrationEndpointDto> {
    this.assertFeatureEnabled();
    const eventName = isSalesPlatformProvider(input.provider)
      ? null
      : input.eventName!;
    const existing = await this.findLive(workspaceId, input.provider, eventName);
    if (existing) {
      // The answer carries the token: same audit as "Mostrar URL".
      await this.auditReveal(workspaceId, existing.id, actorUserId);
      return this.endpointDto(
        existing,
        true,
        await this.receiptCounts(workspaceId, existing.id),
      );
    }

    const parserRelease =
      await this.prisma.inboundWebhookParserRelease.findFirst({
        where: {
          provider: input.provider,
          version: AUTOMATION_PARSER_VERSION,
          status: { not: "retired" },
        },
      });
    if (!parserRelease) {
      throw new ConflictException(
        "Esta integração ainda não está disponível nesta instalacao",
      );
    }
    const id = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    try {
      const created = await this.prisma.$transaction(async (transaction) => {
        const endpoint = await transaction.integrationEndpoint.create({
          data: {
            id,
            workspaceId,
            provider: input.provider,
            kind: integrationEndpointKindFor(input.provider),
            eventName,
            parserReleaseId: parserRelease.id,
            ...this.secretFields(workspaceId, id, secret),
            createdByUserId: actorUserId,
          },
          include: { parserRelease: true },
        });
        await transaction.auditLog.create({
          data: {
            workspaceId,
            actorUserId,
            actorType: "user",
            action: "integration_endpoint.created",
            targetType: "IntegrationEndpoint",
            targetId: endpoint.id,
            reason: "Workspace integration URL created",
            sourceIp: null,
            resultStatus: "success",
            afterSummary: { provider: input.provider, eventName },
          },
        });
        return endpoint;
      });
      return this.endpointDto(created, true, []);
    } catch (error) {
      // Concurrent "Gerar URL" clicks: the partial unique index keeps one URL.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const winner = await this.findLive(
          workspaceId,
          input.provider,
          eventName,
        );
        if (winner) {
          await this.auditReveal(workspaceId, winner.id, actorUserId);
          return this.endpointDto(
            winner,
            true,
            await this.receiptCounts(workspaceId, winner.id),
          );
        }
      }
      throw error;
    }
  }

  /**
   * "Mostrar URL": the token is never in listings; a manager reveals it on
   * purpose and the reveal is audited (no token in the audit).
   */
  async reveal(
    workspaceId: string,
    endpointId: string,
    actorUserId: string,
  ): Promise<IntegrationEndpointDto> {
    this.assertFeatureEnabled();
    const endpoint = await this.requireOwned(workspaceId, endpointId);
    await this.auditReveal(workspaceId, endpoint.id, actorUserId);
    return this.endpointDto(
      endpoint,
      true,
      await this.receiptCounts(workspaceId, endpoint.id),
    );
  }

  /**
   * Receipts of one endpoint by status (SaaS #164). Every DTO that replaces
   * the listed endpoint on screen (Mostrar URL, Gerar URL de uma existente,
   * Gerar nova) carries the real counters: never zeros over the receipts
   * already kept.
   */
  private async receiptCounts(
    workspaceId: string,
    endpointId: string,
  ): Promise<Array<{ status: string; _count: { _all: number } }>> {
    const rows = await this.prisma.integrationEndpointEvent.groupBy({
      by: ["integrationEndpointId", "status"],
      where: { workspaceId, integrationEndpointId: endpointId },
      _count: { _all: true },
    });
    return rows;
  }

  private async auditReveal(
    workspaceId: string,
    endpointId: string,
    actorUserId: string,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId,
        actorType: "user",
        action: "integration_endpoint.url_revealed",
        targetType: "IntegrationEndpoint",
        targetId: endpointId,
        reason: "Integration manager displayed the workspace integration URL",
        sourceIp: null,
        resultStatus: "success",
        afterSummary: {},
      },
    });
  }

  async rotate(
    workspaceId: string,
    endpointId: string,
    actorUserId: string,
  ): Promise<IntegrationEndpointDto> {
    this.assertFeatureEnabled();
    const endpoint = await this.requireOwned(workspaceId, endpointId);
    const secret = randomBytes(32).toString("base64url");
    const updated = await this.prisma.$transaction(async (transaction) => {
      const next = await transaction.integrationEndpoint.update({
        where: { id: endpoint.id },
        data: {
          ...this.secretFields(workspaceId, endpoint.id, secret),
          secretVersion: { increment: 1 },
          rotatedAt: new Date(),
        },
        include: { parserRelease: true },
      });
      await transaction.auditLog.create({
        data: {
          workspaceId,
          actorUserId,
          actorType: "user",
          action: "integration_endpoint.rotated",
          targetType: "IntegrationEndpoint",
          targetId: endpoint.id,
          reason: "Workspace integration URL rotated",
          sourceIp: null,
          resultStatus: "success",
          afterSummary: { secretVersion: next.secretVersion },
        },
      });
      return next;
    });
    return this.endpointDto(
      updated,
      true,
      await this.receiptCounts(workspaceId, updated.id),
    );
  }

  async remove(
    workspaceId: string,
    endpointId: string,
    actorUserId: string,
  ): Promise<void> {
    this.assertFeatureEnabled();
    const endpoint = await this.requireOwned(workspaceId, endpointId);
    await this.prisma.$transaction([
      this.prisma.integrationEndpoint.update({
        where: { id: endpoint.id },
        data: { removedAt: new Date() },
      }),
      this.prisma.auditLog.create({
        data: {
          workspaceId,
          actorUserId,
          actorType: "user",
          action: "integration_endpoint.removed",
          targetType: "IntegrationEndpoint",
          targetId: endpoint.id,
          reason: "Workspace integration URL removed",
          sourceIp: null,
          resultStatus: "success",
          afterSummary: {
            provider: endpoint.provider,
            eventName: endpoint.eventName,
          },
        },
      }),
    ]);
  }

  /** Produtos detectados nas vendas recebidas (código, nome, oferta). */
  async listProducts(
    workspaceId: string,
    provider: SalesPlatformProvider,
  ): Promise<IntegrationDetectedProductListDto> {
    const rows = await this.prisma.integrationEndpointEvent.findMany({
      where: {
        workspaceId,
        provider,
        OR: [{ productCode: { not: null } }, { offerCode: { not: null } }],
      },
      distinct: ["productCode", "offerCode"],
      orderBy: [{ lastReceivedAt: "desc" }, { id: "desc" }],
      select: {
        productCode: true,
        productName: true,
        offerCode: true,
        offerName: true,
        lastReceivedAt: true,
      },
      take: 200,
    });
    return {
      products: rows.map((row) => ({
        provider,
        productCode: row.productCode,
        productName: row.productName,
        offerCode: row.offerCode,
        offerName: row.offerName,
        lastSeenAt: row.lastReceivedAt.toISOString(),
      })),
    };
  }

  /** "Vendas sem atribuição": eventos recebidos que não viraram conversão. */
  async listUnattributed(
    workspaceId: string,
    provider: IntegrationEndpointProviderDto | null,
  ): Promise<IntegrationUnattributedEventListDto> {
    // "pending": received but the routing did not finish (e.g. a 503 the
    // provider will retry); listed with its own reason, never blank.
    // "rejected" (refused calls) never show here: Backoffice only.
    const where = {
      workspaceId,
      status: { in: ["unattributed", "pending"] },
      ...(provider ? { provider } : {}),
    } satisfies Prisma.IntegrationEndpointEventWhereInput;
    const now = new Date();
    const [total, rows] = await Promise.all([
      this.prisma.integrationEndpointEvent.count({ where }),
      this.prisma.integrationEndpointEvent.findMany({
        where,
        orderBy: [{ lastReceivedAt: "desc" }, { id: "desc" }],
        take: 100,
      }),
    ]);
    const removedEndpointIds = new Set(
      rows.length
        ? (
            await this.prisma.integrationEndpoint.findMany({
              where: {
                workspaceId,
                id: { in: [...new Set(rows.map((row) => row.integrationEndpointId))] },
                removedAt: { not: null },
              },
              select: { id: true },
            })
          ).map((endpoint) => endpoint.id)
        : [],
    );
    return {
      total,
      items: rows.map((row) => ({
        id: row.id,
        provider: row.provider as IntegrationEndpointProviderDto,
        eventName: this.eventName(row.eventName),
        productCode: row.productCode,
        productName: row.productName,
        offerCode: row.offerCode,
        valueCents: row.valueCents,
        currency: row.currency,
        reasonCode: row.reasonCode ?? "routing_pending",
        reasonLabel: integrationUnattributedReasonLabel(
          row.reasonCode ?? "routing_pending",
        ),
        ruleReasonCode:
          row.reasonCode === "rule_declined" ? row.routingOutcome : null,
        attemptCount: row.attemptCount,
        firstReceivedAt: row.firstReceivedAt.toISOString(),
        lastReceivedAt: row.lastReceivedAt.toISOString(),
        // A removed URL cannot be retried ("Tentar de novo" answers 404).
        retryable: Boolean(
          row.encryptedPayload &&
            row.payloadExpiresAt > now &&
            !removedEndpointIds.has(row.integrationEndpointId),
        ),
      })),
    };
  }

  /**
   * "Ver dados recebidos" of a stored sale receipt ("Vendas sem atribuição",
   * porte do SaaS #169 sem a certificação): the payload with account keys
   * and secrets hidden, next to what the parser read from it. Audited like
   * the payload of a rule callback. An expired payload (retention) still
   * returns the stored summary, with a message. Read-only.
   */
  async readEventPayload(
    workspaceId: string,
    eventId: string,
    actorUserId: string,
  ): Promise<IntegrationEventPayloadDto> {
    const event = await this.prisma.integrationEndpointEvent.findFirst({
      where: { id: eventId, workspaceId },
    });
    if (
      !event ||
      !isSalesPlatformProvider(event.provider) ||
      event.status === "rejected"
    ) {
      throw new NotFoundException("Evento não encontrado");
    }
    const decrypted = decryptIntegrationEvent(this.encryption, event);
    const read = decrypted.ok
      ? parseIntegrationSale(event, decrypted.payload)
      : null;
    if (decrypted.ok) {
      await this.prisma.auditLog.create({
        data: {
          workspaceId,
          actorUserId,
          actorType: "user",
          action: "integration_endpoint.event.payload.read",
          targetType: "IntegrationEndpointEvent",
          targetId: event.id,
          reason: "Explicit workspace callback audit",
          sourceIp: null,
          resultStatus: "success",
          afterSummary: { provider: event.provider, status: event.status },
        },
      });
    }
    return {
      eventId: event.id,
      provider: event.provider as IntegrationEndpointProviderDto,
      status: event.status as IntegrationEventPayloadDto["status"],
      reasonLabel: integrationUnattributedReasonLabel(
        event.reasonCode ?? "routing_pending",
      ),
      receivedAt: event.firstReceivedAt.toISOString(),
      payloadExpiresAt: event.payloadExpiresAt.toISOString(),
      payloadAvailable: decrypted.ok,
      payloadMessage: decrypted.ok
        ? null
        : decrypted.kind === "expired"
          ? integrationEventPayloadExpiredMessage
          : integrationEventPayloadUnreadableMessage,
      payload: decrypted.ok ? maskSensitivePayload(decrypted.payload) : null,
      // Without the payload: what the receipt recorded when it arrived.
      parsed: read
        ? read.ok
          ? read.parsed
          : null
        : this.storedSaleSummary(event),
      parseError: read && !read.ok ? read.errorCode : null,
    };
  }

  private storedSaleSummary(event: {
    eventName: string | null;
    valueCents: number | null;
    currency: string | null;
    productCode: string | null;
    productName: string | null;
    offerCode: string | null;
    offerName: string | null;
    occurredAt: Date | null;
    providerStatus: string | null;
  }): IntegrationEventPayloadDto["parsed"] {
    if (!event.eventName) return null;
    return {
      eventName: event.eventName,
      valueCents: event.valueCents,
      currency: event.currency,
      valueSent: true,
      productCode: event.productCode,
      productName: event.productName,
      offerCode: event.offerCode,
      offerName: event.offerName,
      orderRef: null,
      occurredAt: event.occurredAt?.toISOString() ?? null,
      phoneMasked: null,
      providerStatus: event.providerStatus,
      test: false,
    };
  }

  // ----------------------------------------------------------------- routing

  private async routeAndHandOff(input: {
    endpoint: EndpointRecord;
    eventId: string;
    parsed: Extract<ParsedIntegrationEvent, { ok: true }>;
    rawBody: Buffer;
    providerAttempt: number | null;
    receivedAt: Date;
    /** "Tentar de novo": original receipt time for the production gate. */
    occurrenceReceivedAt?: Date;
  }): Promise<{
    status: "routed" | "unattributed" | "invalid";
    reasonCode: string | null;
    providerRuleId: string | null;
    deliveryId: string | null;
  }> {
    const { endpoint, parsed } = input;
    let decision: IntegrationRouteDecision;
    try {
      decision = await this.route(endpoint, parsed, input.receivedAt);
    } catch (error) {
      // Only identifiers and the error class: never a token or a payload.
      this.logger.error(
        JSON.stringify({
          event: "integration_endpoint.routing_failed",
          endpointId: endpoint.id,
          eventId: input.eventId,
          error: error instanceof Error ? error.name : "unknown",
        }),
      );
      // The receipt stays "pending": the provider retry re-runs the routing.
      throw new ServiceUnavailableException(unavailableMessage);
    }

    if (decision.status === "unattributed") {
      const status =
        decision.reasonCode === "event_mismatch" ? "invalid" : "unattributed";
      await this.updateReceipt(input.eventId, {
        status,
        reasonCode: decision.reasonCode,
        routedChannelId: decision.channelId,
      });
      return {
        status,
        reasonCode: decision.reasonCode,
        providerRuleId: null,
        deliveryId: null,
      };
    }

    // Same processing as the rule's own URL (no parallel path).
    let handedOff: Awaited<
      ReturnType<InboundConversionAutomationIngestionService["ingestRouted"]>
    >;
    try {
      handedOff = await this.automationIngestion.ingestRouted({
        workspaceId: endpoint.workspaceId,
        providerRuleId: decision.providerRuleId,
        rawBody: input.rawBody,
        providerAttempt: input.providerAttempt,
        integrationEndpointId: endpoint.id,
        routedChannelId: decision.channelId,
        ...(input.occurrenceReceivedAt
          ? { occurrenceReceivedAt: input.occurrenceReceivedAt }
          : {}),
        // The number the router proved for this callback.
        origin: {
          connectionId: decision.connectionId,
          channelId: decision.channelId,
        },
      });
    } catch (error) {
      if (error instanceof NotFoundException) handedOff = null;
      else if (error instanceof HttpException) throw error;
      else throw new ServiceUnavailableException(unavailableMessage);
    }
    if (!handedOff) {
      await this.updateReceipt(input.eventId, {
        status: "unattributed",
        reasonCode: "rule_unavailable",
        routedChannelId: decision.channelId,
      });
      return {
        status: "unattributed",
        reasonCode: "rule_unavailable",
        providerRuleId: decision.providerRuleId,
        deliveryId: null,
      };
    }
    // The rule has the last word: a callback it ignored, gave to another
    // rule, filtered out or blocked is NOT a conversion and goes to "sem
    // atribuição" with its own reason (the rule's code stays in
    // routingOutcome, and the delivery stays linked for the rule's history).
    const outcome = handedOff.ruleOutcome;
    if (
      outcome &&
      DECLINED_RULE_OUTCOMES.has(outcome.status)
    ) {
      await this.updateReceipt(input.eventId, {
        status: "unattributed",
        reasonCode: "rule_declined",
        routedChannelId: decision.channelId,
        routedProviderRuleId: decision.providerRuleId,
        routedDeliveryId: handedOff.deliveryId,
        routingOutcome: outcome.reasonCode ?? outcome.status,
      });
      return {
        status: "unattributed",
        reasonCode: "rule_declined",
        providerRuleId: decision.providerRuleId,
        deliveryId: handedOff.deliveryId,
      };
    }
    await this.updateReceipt(input.eventId, {
      status: "routed",
      reasonCode: null,
      routedChannelId: decision.channelId,
      routedProviderRuleId: decision.providerRuleId,
      routedDeliveryId: handedOff.deliveryId,
      routingOutcome: outcome?.status ?? handedOff.observationStatus,
    });
    await this.prisma.integrationEndpoint.updateMany({
      where: { id: endpoint.id, workspaceId: endpoint.workspaceId },
      data: { lastRoutedAt: new Date() },
    });
    return {
      status: "routed",
      reasonCode: null,
      providerRuleId: decision.providerRuleId,
      deliveryId: handedOff.deliveryId,
    };
  }

  private route(
    endpoint: EndpointRecord,
    parsed: Extract<ParsedIntegrationEvent, { ok: true }>,
    receivedAt: Date,
  ): Promise<IntegrationRouteDecision> {
    switch (parsed.provider) {
      case "payt":
      case "braip":
        return routeSalePlatformSale(this.prisma, this.paidLeads, {
          workspaceId: endpoint.workspaceId,
          sale: parsed.sale,
          receivedAt,
        });
      case "unnichat":
        return routeUnnichatEvent(this.prisma, this.paidLeads, {
          workspaceId: endpoint.workspaceId,
          eventName: parsed.eventName,
          automation: parsed.automation,
          receivedAt,
        });
      case "umbler":
        return routeUmblerEvent(this.prisma, {
          workspaceId: endpoint.workspaceId,
          eventName: parsed.eventName,
          automation: parsed.automation,
          channelPhoneHint: parsed.channelPhoneHint,
          receivedAt,
        });
    }
  }

  private parse(
    endpoint: EndpointRecord,
    payload: unknown,
    // Arrival of the postback: caps a Payt event time in the future.
    receivedAt?: Date,
  ): ParsedIntegrationEvent {
    switch (endpoint.provider) {
      case "payt":
      case "braip": {
        const platform = endpoint.provider;
        const sale = parseSaleEventV1(platform, payload, { receivedAt });
        if (!sale.ok) {
          return sale.kind === "status_not_supported"
            ? {
                ok: false,
                status: "ignored",
                reasonCode: "status_not_supported",
                providerStatus: sale.providerStatus ?? null,
              }
            : {
                ok: false,
                status: "invalid",
                reasonCode: sale.errorCode,
                providerStatus: null,
              };
        }
        return {
          ok: true,
          provider: platform,
          eventName: sale.value.eventName,
          // One sale (seller + order + event) is one receipt.
          externalKey: buildProviderPurchaseIdentity({
            workspaceId: endpoint.workspaceId,
            provider: platform,
            accountRef: sale.value.accountRef,
            orderRef: sale.value.orderRef,
            eventName: sale.value.eventName,
          }),
          sale: sale.value,
        };
      }
      case "unnichat": {
        const automation = parseUnnichatAutomationV1(payload);
        if (!automation.ok || !endpoint.eventName) {
          return {
            ok: false,
            status: "invalid",
            reasonCode: "unnichat_automation_v1_invalid_payload",
            providerStatus: null,
          };
        }
        return {
          ok: true,
          provider: "unnichat",
          eventName: endpoint.eventName,
          externalKey: automation.value.externalExecutionKey,
          automation: automation.value,
        };
      }
      case "umbler": {
        const automation = parseUmblerAutomationV1(payload);
        if (!automation.ok || !endpoint.eventName) {
          return {
            ok: false,
            status: "invalid",
            reasonCode: "umbler_automation_v1_invalid_payload",
            providerStatus: null,
          };
        }
        const channel = asRecord(asRecord(payload)?.channel);
        return {
          ok: true,
          provider: "umbler",
          eventName: endpoint.eventName,
          externalKey: automation.value.externalExecutionKey,
          automation: automation.value,
          channelPhoneHint:
            typeof channel?.phone === "string" ? channel.phone : null,
        };
      }
      default:
        return {
          ok: false,
          status: "invalid",
          reasonCode: "integration_provider_unsupported",
          providerStatus: null,
        };
    }
  }

  // ---------------------------------------------------------------- receipts

  private async recordReceipt(input: {
    endpoint: EndpointRecord;
    ingressKey: string;
    parsed: ParsedIntegrationEvent;
    rawBody: Buffer;
    receivedAt: Date;
  }): Promise<{
    id: string;
    duplicate: boolean;
    routedProviderRuleId: string | null;
    routedChannelId: string | null;
  }> {
    const { endpoint, parsed } = input;
    const existing = await this.findReceipt(endpoint.id, input.ingressKey);
    if (existing) {
      await this.touchReceipt(endpoint, existing.id, input.receivedAt);
      return {
        id: existing.id,
        duplicate: true,
        routedProviderRuleId:
          existing.status === "routed" ? existing.routedProviderRuleId : null,
        routedChannelId: existing.routedChannelId,
      };
    }
    const id = randomUUID();
    const encrypted = this.encryption.encrypt(input.rawBody, {
      workspaceId: endpoint.workspaceId,
      connectionId: `integration:${endpoint.id}`,
      deliveryId: id,
    });
    const sale = parsed.ok && "sale" in parsed ? parsed.sale : null;
    const phone = parsed.ok
      ? "sale" in parsed
        ? parsed.sale.phone
        : parsed.automation.phone
      : null;
    // A sale without a declared currency is shown in the workspace "Moeda das
    // conversões" (BRL by default), like the conversion it becomes (Fase 5.1).
    const saleCurrency = sale
      ? (sale.currency ??
        (sale.valueCents != null
          ? await loadWorkspaceConversionCurrency(
              this.prisma,
              endpoint.workspaceId,
            )
          : null))
      : null;
    try {
      await this.prisma.$transaction([
        this.prisma.integrationEndpointEvent.create({
          data: {
            id,
            workspaceId: endpoint.workspaceId,
            integrationEndpointId: endpoint.id,
            provider: endpoint.provider,
            ingressKey: input.ingressKey,
            externalKey: parsed.ok ? parsed.externalKey : null,
            eventName: parsed.ok ? parsed.eventName : null,
            providerStatus: parsed.ok
              ? (sale?.providerStatus ?? null)
              : parsed.providerStatus,
            // Parsed events start "pending" (with a reason) until routed.
            status: parsed.ok ? "pending" : parsed.status,
            reasonCode: parsed.ok ? "routing_pending" : parsed.reasonCode,
            productCode: sale?.product?.code ?? null,
            productName: sale?.product?.name ?? null,
            offerCode: sale?.offer?.code ?? null,
            offerName: sale?.offer?.name ?? null,
            valueCents: sale?.valueCents ?? null,
            currency: saleCurrency,
            contactIdentityHash: phone
              ? (hashPhoneIdentity(phone) ?? null)
              : null,
            occurredAt: parsed.ok
              ? "sale" in parsed
                ? parsed.sale.occurredAt
                : parsed.automation.occurredAt
              : null,
            firstReceivedAt: input.receivedAt,
            lastReceivedAt: input.receivedAt,
            ...encrypted,
            payloadExpiresAt: new Date(
              input.receivedAt.getTime() +
                INBOUND_WEBHOOK_RAW_RETENTION_DAYS * DAY_MS,
            ),
          },
        }),
        this.prisma.integrationEndpoint.updateMany({
          where: { id: endpoint.id, workspaceId: endpoint.workspaceId },
          data: { lastDeliveryAt: input.receivedAt },
        }),
      ]);
      return {
        id,
        duplicate: false,
        routedProviderRuleId: null,
        routedChannelId: null,
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const winner = await this.findReceipt(endpoint.id, input.ingressKey);
        if (winner) {
          await this.touchReceipt(endpoint, winner.id, input.receivedAt);
          return {
            id: winner.id,
            duplicate: true,
            routedProviderRuleId:
              winner.status === "routed" ? winner.routedProviderRuleId : null,
            routedChannelId: winner.routedChannelId,
          };
        }
      }
      throw new ServiceUnavailableException(unavailableMessage);
    }
  }

  private async findReceipt(endpointId: string, ingressKey: string) {
    try {
      return await this.prisma.integrationEndpointEvent.findUnique({
        where: {
          integrationEndpointId_ingressKey: {
            integrationEndpointId: endpointId,
            ingressKey,
          },
        },
        select: {
          id: true,
          status: true,
          routedProviderRuleId: true,
          routedChannelId: true,
        },
      });
    } catch {
      throw new ServiceUnavailableException(unavailableMessage);
    }
  }

  private async touchReceipt(
    endpoint: EndpointRecord,
    eventId: string,
    receivedAt: Date,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.integrationEndpointEvent.update({
        where: { id: eventId },
        data: { attemptCount: { increment: 1 }, lastReceivedAt: receivedAt },
      }),
      this.prisma.integrationEndpoint.updateMany({
        where: { id: endpoint.id, workspaceId: endpoint.workspaceId },
        data: { lastDeliveryAt: receivedAt },
      }),
    ]);
  }

  private async updateReceipt(
    eventId: string,
    data: {
      status: "routed" | "unattributed" | "invalid";
      reasonCode: string | null;
      routedChannelId?: string | null;
      routedProviderRuleId?: string | null;
      routedDeliveryId?: string | null;
      routingOutcome?: string | null;
    },
  ): Promise<void> {
    await this.prisma.integrationEndpointEvent.update({
      where: { id: eventId },
      data: {
        status: data.status,
        reasonCode: data.reasonCode,
        routedChannelId: data.routedChannelId ?? null,
        routedProviderRuleId: data.routedProviderRuleId ?? null,
        routedDeliveryId: data.routedDeliveryId ?? null,
        routingOutcome: data.routingOutcome ?? null,
      },
    });
  }

  private decryptEventPayload(event: {
    id: string;
    workspaceId: string;
    integrationEndpointId: string;
    encryptedPayload: string | null;
    payloadIv: string | null;
    payloadTag: string | null;
    encryptionKeyVersion: number | null;
    payloadExpiresAt: Date;
  }): Buffer {
    if (
      event.payloadExpiresAt <= new Date() ||
      !event.encryptedPayload ||
      !event.payloadIv ||
      !event.payloadTag ||
      event.encryptionKeyVersion === null
    ) {
      throw new ConflictException(
        "O payload deste evento não está mais disponível",
      );
    }
    try {
      return this.encryption.decrypt(
        {
          encryptedPayload: event.encryptedPayload,
          payloadIv: event.payloadIv,
          payloadTag: event.payloadTag,
          encryptionKeyVersion: event.encryptionKeyVersion,
        },
        {
          workspaceId: event.workspaceId,
          connectionId: `integration:${event.integrationEndpointId}`,
          deliveryId: event.id,
        },
      );
    } catch {
      throw new ConflictException("O payload deste evento não pode ser lido");
    }
  }

  // ----------------------------------------------------------------- helpers

  /**
   * Finds the endpoint of a public call. Unknown id: 404 with nothing
   * recorded (no workspace to attach it to). Known endpoint refused (token,
   * removed URL, retired parser): returned with the rejection reason so the
   * caller records the attempt's metadata before answering the same 404.
   */
  private async authenticate(
    endpointId: string,
    token: unknown,
  ): Promise<{
    endpoint: EndpointRecord;
    rejection: IntegrationAuthRejection | null;
  }> {
    let endpoint: EndpointRecord | null;
    try {
      endpoint =
        typeof endpointId === "string" && endpointId.length <= 64
          ? await this.prisma.integrationEndpoint.findUnique({
              where: { id: endpointId },
              include: { parserRelease: true },
            })
          : null;
    } catch {
      throw new ServiceUnavailableException(unavailableMessage);
    }
    // Constant-time comparison, also against a dummy hash when the URL does
    // not exist, so a wrong token and an unknown URL look the same.
    const tokenMatches = matchesInboundWebhookSecret(
      endpoint?.secretHash,
      token,
    );
    if (
      !endpoint ||
      !(routedProviders as readonly string[]).includes(endpoint.provider)
    ) {
      throw new NotFoundException(notFoundMessage);
    }
    const rejection: IntegrationAuthRejection | null = !tokenMatches
      ? typeof token === "string" && token.length > 0
        ? "token_invalid"
        : "token_missing"
      : endpoint.removedAt !== null
        ? "endpoint_removed"
        : endpoint.parserRelease.status === "retired"
          ? "parser_retired"
          : null;
    return { endpoint, rejection };
  }

  /**
   * Refused call (4xx) of a known endpoint, kept for the Backoffice audit
   * ("Recebimentos das URLs únicas") as status "rejected" (SaaS #170).
   * Without a valid token only metadata is written (never the body); after
   * authentication the body is kept encrypted with the same retention as
   * every receipt. Repeated refusals collapse into one row per reason and
   * time window (attemptCount), so a flood of bad calls cannot grow the
   * table. Never changes the HTTP answer: a storage failure is only logged.
   * Does not touch the endpoint's "último recebimento" shown in the panel.
   */
  private async recordRejection(input: {
    endpoint: EndpointRecord;
    reasonCode: string;
    rawBody: Buffer | null;
    receivedAt: Date;
  }): Promise<void> {
    const { endpoint, reasonCode, receivedAt } = input;
    const body =
      input.rawBody &&
      input.rawBody.length > 0 &&
      input.rawBody.length <= MAX_INBOUND_WEBHOOK_PAYLOAD_BYTES &&
      !metadataOnlyRejections.has(reasonCode)
        ? input.rawBody
        : null;
    const hash = createHash("sha256")
      .update(
        body
          ? "integration-endpoint-rejected-v1\0"
          : "integration-endpoint-rejected-meta-v1\0",
        "utf8",
      )
      .update(endpoint.id, "utf8")
      .update("\0", "utf8")
      .update(reasonCode, "utf8")
      .update("\0", "utf8")
      .update(
        String(
          Math.floor(
            receivedAt.getTime() /
              (body ? fallbackDedupeWindowMs : rejectionMetadataWindowMs),
          ),
        ),
        "utf8",
      );
    if (body) hash.update("\0", "utf8").update(body);
    const ingressKey = hash.digest("hex");
    try {
      const existing = await this.findReceipt(endpoint.id, ingressKey);
      if (existing) {
        await this.prisma.integrationEndpointEvent.update({
          where: { id: existing.id },
          data: { attemptCount: { increment: 1 }, lastReceivedAt: receivedAt },
        });
        return;
      }
      const id = randomUUID();
      await this.prisma.integrationEndpointEvent.create({
        data: {
          id,
          workspaceId: endpoint.workspaceId,
          integrationEndpointId: endpoint.id,
          provider: endpoint.provider,
          ingressKey,
          externalKey: null,
          eventName: null,
          providerStatus: null,
          status: "rejected",
          reasonCode,
          firstReceivedAt: receivedAt,
          lastReceivedAt: receivedAt,
          ...(body
            ? this.encryption.encrypt(body, {
                workspaceId: endpoint.workspaceId,
                connectionId: `integration:${endpoint.id}`,
                deliveryId: id,
              })
            : {}),
          payloadExpiresAt: new Date(
            receivedAt.getTime() + INBOUND_WEBHOOK_RAW_RETENTION_DAYS * DAY_MS,
          ),
        },
      });
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: "integration_endpoint.rejection_not_recorded",
          endpointId: endpoint.id,
          reasonCode,
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  }

  /** Braip (6.5): JSON or form-urlencoded body, converted to canonical JSON. */
  private requireBraipBody(
    contentType: string | undefined,
    rawBody: Buffer | undefined,
  ): Buffer {
    if (!rawBody || rawBody.length === 0) {
      throw new BadRequestException("Payload obrigatório");
    }
    if (rawBody.length > MAX_INBOUND_WEBHOOK_PAYLOAD_BYTES) {
      throw new PayloadTooLargeException("Payload do webhook excede o limite");
    }
    const normalized = normalizeBraipBody(contentType, rawBody);
    if (!normalized.ok) {
      if (normalized.errorCode === "braip_body_unsupported") {
        throw new UnsupportedMediaTypeException(
          "Webhook requer JSON ou application/x-www-form-urlencoded",
        );
      }
      throw new BadRequestException("Payload inválido");
    }
    return normalized.body;
  }

  private requireJsonBody(
    contentType: string | undefined,
    rawBody: Buffer | undefined,
  ): Buffer {
    const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      throw new UnsupportedMediaTypeException(
        "Webhook requer Content-Type application/json",
      );
    }
    if (!rawBody || rawBody.length === 0) {
      throw new BadRequestException("Payload JSON obrigatório");
    }
    if (rawBody.length > MAX_INBOUND_WEBHOOK_PAYLOAD_BYTES) {
      throw new PayloadTooLargeException("Payload do webhook excede o limite");
    }
    try {
      JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new BadRequestException("Payload JSON inválido");
    }
    return rawBody;
  }

  private assertFeatureEnabled(): void {
    const config = parseInboundWebhooksConfig(this.env);
    if (!config.enabled || !config.conversionRulesEnabled) {
      throw new NotFoundException(notFoundMessage);
    }
  }

  private ingressKey(endpointId: string, externalKey: string): string {
    return createHash("sha256")
      .update("integration-endpoint-v1\0", "utf8")
      .update(endpointId, "utf8")
      .update("\0", "utf8")
      .update(externalKey, "utf8")
      .digest("hex");
  }

  private fallbackIngressKey(
    endpointId: string,
    rawBody: Buffer,
    receivedAt: Date,
  ): string {
    const bucket = Math.floor(receivedAt.getTime() / fallbackDedupeWindowMs);
    return createHash("sha256")
      .update("integration-endpoint-fallback-v1\0", "utf8")
      .update(endpointId, "utf8")
      .update("\0", "utf8")
      .update(String(bucket), "utf8")
      .update("\0", "utf8")
      .update(rawBody)
      .digest("hex");
  }

  private secretFields(workspaceId: string, endpointId: string, secret: string) {
    const encrypted = this.encryption.encrypt(Buffer.from(secret, "utf8"), {
      workspaceId,
      connectionId: SECRET_CONTEXT,
      deliveryId: endpointId,
    });
    return {
      secretHash: createHash("sha256").update(secret, "utf8").digest("hex"),
      secretCiphertext: encrypted.encryptedPayload,
      secretIv: encrypted.payloadIv,
      secretTag: encrypted.payloadTag,
      secretKeyVersion: encrypted.encryptionKeyVersion,
    };
  }

  private revealUrl(endpoint: EndpointRecord): string | null {
    const config = parseInboundWebhooksConfig(this.env);
    if (!config.enabled || !config.apiPublicUrl) return null;
    try {
      const secret = this.encryption
        .decrypt(
          {
            encryptedPayload: endpoint.secretCiphertext,
            payloadIv: endpoint.secretIv,
            payloadTag: endpoint.secretTag,
            encryptionKeyVersion: endpoint.secretKeyVersion,
          },
          {
            workspaceId: endpoint.workspaceId,
            connectionId: SECRET_CONTEXT,
            deliveryId: endpoint.id,
          },
        )
        .toString("utf8");
      const url = new URL(
        `/webhooks/inbound/integrations/${encodeURIComponent(endpoint.id)}`,
        config.apiPublicUrl,
      );
      url.searchParams.set("token", secret);
      return url.toString();
    } catch {
      return null;
    }
  }

  private endpointDto(
    endpoint: EndpointRecord,
    withUrl: boolean,
    counts: Array<{ status: string; _count: { _all: number } }>,
  ): IntegrationEndpointDto {
    const count = (status: string) =>
      counts.find((row) => row.status === status)?._count._all ?? 0;
    const stats = {
      routed: count("routed"),
      unattributed: count("unattributed") + count("pending"),
      ignored: count("ignored"),
      invalid: count("invalid"),
    };
    return {
      id: endpoint.id,
      provider: endpoint.provider as IntegrationEndpointProviderDto,
      kind: endpoint.kind,
      eventName: this.eventName(endpoint.eventName),
      url: withUrl ? this.revealUrl(endpoint) : null,
      secretVersion: endpoint.secretVersion,
      parserCertified: endpoint.parserRelease.status === "certified",
      lastDeliveryAt: endpoint.lastDeliveryAt?.toISOString() ?? null,
      lastRoutedAt: endpoint.lastRoutedAt?.toISOString() ?? null,
      rotatedAt: endpoint.rotatedAt?.toISOString() ?? null,
      createdAt: endpoint.createdAt.toISOString(),
      stats: {
        received:
          stats.routed + stats.unattributed + stats.ignored + stats.invalid,
        ...stats,
      },
    };
  }

  private eventName(value: string | null) {
    const parsed = conversionEventNameSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  private findLive(
    workspaceId: string,
    provider: IntegrationEndpointProviderDto,
    eventName: string | null,
  ) {
    return this.prisma.integrationEndpoint.findFirst({
      where: { workspaceId, provider, eventName, removedAt: null },
      include: { parserRelease: true },
    });
  }

  private async requireOwned(
    workspaceId: string,
    endpointId: string,
  ): Promise<EndpointRecord> {
    const endpoint = await this.prisma.integrationEndpoint.findFirst({
      where: { id: endpointId, workspaceId, removedAt: null },
      include: { parserRelease: true },
    });
    if (!endpoint) throw new NotFoundException("Endereço não encontrado");
    return endpoint;
  }

  /**
   * Rules still reachable by their own (per-rule/per-number) URL, with the
   * last delivery received there, for the "Desativar URL antiga" checklist.
   * A disabled URL that never received anything (rule created for the
   * integration URL) is left out.
   */
  private async legacyUrls(
    workspaceId: string,
  ): Promise<IntegrationLegacyUrlDto[]> {
    const rules = await this.prisma.providerConversionRuleConfig.findMany({
      where: {
        workspaceId,
        removedAt: null,
        conversionRule: { triggerType: "provider_automation" },
        parserRelease: {
          is: {
            provider: { in: [...routedProviders] },
            version: AUTOMATION_PARSER_VERSION,
          },
        },
        endpoint: {
          is: {
            removedAt: null,
            OR: [
              { publicUrlDisabledAt: null },
              { lastDeliveryAt: { not: null } },
            ],
          },
        },
      },
      select: {
        id: true,
        scope: true,
        crossConnectionScope: true,
        conversionRule: { select: { name: true, eventName: true } },
        parserRelease: { select: { provider: true } },
        channels: { select: { channelId: true } },
        endpoint: {
          select: { lastDeliveryAt: true, publicUrlDisabledAt: true },
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 200,
    });
    return rules.flatMap((rule) => {
      const eventName = this.eventName(rule.conversionRule.eventName);
      const provider = rule.parserRelease?.provider;
      if (
        !eventName ||
        !rule.endpoint ||
        !provider ||
        !(routedProviders as readonly string[]).includes(provider)
      )
        return [];
      return [
        {
          providerRuleId: rule.id,
          ruleName: rule.conversionRule.name,
          eventName,
          provider: provider as IntegrationEndpointProviderDto,
          scope: rule.scope,
          channelIds: rule.channels.map((channel) => channel.channelId),
          lastDeliveryAt: rule.endpoint.lastDeliveryAt?.toISOString() ?? null,
          publicUrlDisabledAt:
            rule.endpoint.publicUrlDisabledAt?.toISOString() ?? null,
        },
      ];
    });
  }
}
