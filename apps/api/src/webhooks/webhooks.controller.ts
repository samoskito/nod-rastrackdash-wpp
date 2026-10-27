import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  InternalServerErrorException,
  Logger,
  NotImplementedException,
  Optional,
  Param,
  Post,
  Query,
  RawBody,
  UnauthorizedException,
} from "@nestjs/common";
import { safeErrorName } from "../common/errors/safe-error-name";
import { ConversionEventsQueueService } from "../common/queue/conversion-events-queue.service";
import { PrismaService } from "../common/prisma/prisma.service";
import { hashPhoneIdentity } from "../common/phone/phone-identity";
import { ConversionEventsService } from "../conversion-events/conversion-events.service";
import { ConversionRulesService } from "../conversion-rules/conversion-rules.service";
import {
  leadSubmittedRuleOverrideEnabled,
  resolveLeadSubmittedRuleOverride,
} from "../conversion-rules/lead-submitted-rule-override";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { LicenseClientService } from "../licensing-client/license-client.service";
import { DiagnosticsService } from "../diagnostics/diagnostics.service";
import type {
  InboundWebhookParserResult,
  ParsedInboundWebhookEvent,
} from "../inbound-webhooks/providers/inbound-webhook-parser";
import { inboundParserProductionEligible } from "../inbound-webhooks/inbound-webhook-parser-eligibility";
import { parseWahaV1Webhook } from "../inbound-webhooks/providers/waha/waha-v1.parser";
import {
  parseWahaSessionStatusEvent,
  parseWahaV2Webhook,
  WAHA_V2_PARSER_VERSION,
  wahaV2UnresolvedContactLid,
  wahaV2UnresolvedTeamContactLid,
  withWahaResolvedContactPhone,
  withWahaResolvedTeamContactPhone,
} from "../inbound-webhooks/providers/waha/waha-v2.parser";
import { WahaLidResolverService } from "../integrations/whatsapp-providers/waha-lid-resolver.service";
import { parseZapiV1Webhook } from "../inbound-webhooks/providers/zapi/zapi-v1.parser";
import { mapWahaSessionStatus } from "../integrations/whatsapp-providers/waha-session-status";
import { UazapiProviderConversionService } from "../inbound-webhooks/uazapi-provider-conversion.service";
import { LeadsService } from "../leads/leads.service";
import {
  parseUazapiWebhook,
  type ParsedUazapiWebhook,
} from "./uazapi-webhook-parser";
import { computeCanonicalPayloadHash } from "./webhook-payload-hash";

type WebhookBody = Record<string, unknown>;

type VerifiedUazapiContext = {
  workspaceId: string;
  whatsappInstanceId: string;
  providerInstanceId: string | null;
};

// WAHA and Z-API are wired through their standalone v1 parsers rather than
// the full inbound-webhooks automation pipeline: this per-connection
// receiver only needs a single normalized message event to log to
// WebhookLog and, when eligible, create a lead.
type WiredMessageProvider = "waha" | "zapi";

const MESSAGE_PROVIDER_PARSERS: Record<
  WiredMessageProvider,
  (payload: unknown) => InboundWebhookParserResult
> = {
  waha: parseWahaV1Webhook,
  zapi: parseZapiV1Webhook,
};

// The body field each provider uses to claim the session/instance it is
// delivering for. Both are bound against the connection's persisted
// providerInstanceId before anything is parsed, logged, or converted.
const WIRED_MESSAGE_PROVIDER_BINDING_FIELD: Record<
  WiredMessageProvider,
  "session" | "instanceId"
> = {
  waha: "session",
  zapi: "instanceId",
};

type VerifiedConnectionContext = {
  workspaceId: string;
  whatsappInstanceId: string;
};

/**
 * Parser chosen for one delivery. WAHA uses v2 (GoWS) only while the
 * waha/v2 parser release is certified in the database; otherwise, and for
 * Z-API, the v1 parser keeps the previous behavior.
 */
type SelectedMessageParser = {
  version: string;
  parse: (payload: unknown) => InboundWebhookParserResult;
};

type VerifiedMetaContext = {
  workspaceId: string;
  pageId: string;
};

@Controller("webhooks")
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    @Inject(DiagnosticsService)
    private readonly diagnosticsService: DiagnosticsService,
    @Inject(ConversionRulesService)
    private readonly conversionRulesService: ConversionRulesService,
    @Inject(ConversionEventsService)
    private readonly conversionEventsService: ConversionEventsService,
    @Inject(ConversionEventsQueueService)
    private readonly conversionEventsQueueService: ConversionEventsQueueService,
    @Inject(LeadsService)
    private readonly leadsService: LeadsService,
    @Inject(UazapiProviderConversionService)
    private readonly uazapiProviderConversion: UazapiProviderConversionService,
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(WahaLidResolverService)
    private readonly wahaLidResolver?: WahaLidResolverService,
    @Optional()
    @Inject(LicenseClientService)
    private readonly license?: LicenseClientService,
    @Optional()
    @Inject(RUNTIME_ENV)
    private readonly env: RuntimeEnv = process.env,
  ) {}

  @Get("meta")
  verifyMetaWebhook(
    @Query("hub.mode") mode?: string,
    @Query("hub.verify_token") verifyToken?: string,
    @Query("hub.challenge") challenge?: string,
  ) {
    const expectedToken = process.env.META_WEBHOOK_VERIFY_TOKEN;

    if (
      !expectedToken ||
      mode !== "subscribe" ||
      verifyToken !== expectedToken ||
      !challenge
    ) {
      throw new UnauthorizedException("Meta webhook token inválido");
    }

    return challenge;
  }

  @Post("uazapi")
  @HttpCode(202)
  recordUazapi(
    @Body() body: WebhookBody,
    @Headers("x-workspace-id") workspaceId?: string,
    @Headers("x-wpptrack-webhook-token") webhookToken?: string,
    @Headers("authorization") authorization?: string,
    @Query("token") queryToken?: string,
  ) {
    this.assertUazapiWebhookToken(
      webhookToken ?? this.getBearerToken(authorization) ?? queryToken,
    );

    return this.recordUazapiWebhook(body, undefined, workspaceId);
  }

  @Post("uazapi/instances/:instanceId")
  @HttpCode(202)
  async recordUazapiInstance(
    @Param("instanceId") instanceId: string,
    @Body() body: WebhookBody,
    @Headers("x-wpptrack-webhook-token") webhookToken?: string,
    @Headers("authorization") authorization?: string,
    @Query("token") queryToken?: string,
  ) {
    const instance = await this.prisma.whatsappInstance.findFirst({
      where: {
        id: instanceId,
        provider: "uazapi",
      },
      select: {
        id: true,
        workspaceId: true,
        providerInstanceId: true,
        webhookTokenHash: true,
      },
    });
    const receivedToken =
      webhookToken ?? this.getBearerToken(authorization) ?? queryToken;

    if (
      !instance?.webhookTokenHash ||
      !receivedToken ||
      this.hashToken(receivedToken) !== instance.webhookTokenHash
    ) {
      throw new UnauthorizedException("Webhook Uazapi não autorizado");
    }

    return this.recordUazapiWebhook(body, {
      workspaceId: instance.workspaceId,
      whatsappInstanceId: instance.id,
      providerInstanceId: instance.providerInstanceId,
    });
  }

  /**
   * Per-connection receiver used by provider onboarding. The endpoint never
   * trusts a workspace supplied in the payload: the active instance owns the
   * workspace context and its stored SHA-256 token hash authenticates the
   * request. Providers without a wired ingestion path must fail rather than
   * acknowledging and discarding a delivery.
   */
  @Post("whatsapp/:id")
  @HttpCode(202)
  async recordWhatsappConnection(
    @Param("id") id: string,
    @Body() body: WebhookBody,
    @Headers("x-wpptrack-webhook-token") webhookToken?: string,
    @Headers("authorization") authorization?: string,
    @Query("token") queryToken?: string,
  ) {
    const instance = await this.prisma.whatsappInstance.findFirst({
      where: { id },
      select: {
        id: true,
        workspaceId: true,
        provider: true,
        providerInstanceId: true,
        webhookTokenHash: true,
        status: true,
      },
    });
    // Uazapi BYO only supports a webhook URL field, so accept its one-time
    // token from the query string as a final fallback. Dedicated headers keep
    // precedence for providers that support them.
    const receivedToken =
      webhookToken ?? this.getBearerToken(authorization) ?? queryToken;

    if (
      !instance ||
      instance.status !== "active" ||
      !instance.webhookTokenHash ||
      !receivedToken ||
      !this.matchesTokenHash(receivedToken, instance.webhookTokenHash)
    ) {
      throw new UnauthorizedException("Webhook WhatsApp não autorizado");
    }

    const payloadWorkspaceId = this.firstString(body.workspaceId);
    const payloadConnectionId = this.firstString(body.whatsappInstanceId);
    if (
      (payloadWorkspaceId && payloadWorkspaceId !== instance.workspaceId) ||
      (payloadConnectionId && payloadConnectionId !== instance.id)
    ) {
      throw new UnauthorizedException("Webhook WhatsApp não autorizado");
    }

    if (instance.provider === "uazapi_byo") {
      return this.recordUazapiWebhook(body, {
        workspaceId: instance.workspaceId,
        whatsappInstanceId: instance.id,
        providerInstanceId: instance.providerInstanceId,
      });
    }

    if (this.isWiredMessageProvider(instance.provider)) {
      this.assertProviderInstanceBinding(
        instance.provider,
        body,
        instance.providerInstanceId,
      );

      const parser = await this.selectMessageParser(instance.provider);

      return this.recordProviderMessageWebhook(
        instance.provider,
        body,
        {
          workspaceId: instance.workspaceId,
          whatsappInstanceId: instance.id,
        },
        parser,
      );
    }

    throw new NotImplementedException(
      `Receiver inbound para ${instance.provider} ainda não está disponível`,
    );
  }

  private isWiredMessageProvider(
    provider: string,
  ): provider is WiredMessageProvider {
    return provider === "waha" || provider === "zapi";
  }

  /**
   * WAHA: the certified waha/v2 release (GoWS) is the receiver's parser.
   * Without that row (migration not applied) or with the release in
   * observation/retired, the receiver keeps v1 - the behavior shipped
   * before v2 - instead of failing every delivery.
   */
  private async selectMessageParser(
    provider: WiredMessageProvider,
  ): Promise<SelectedMessageParser> {
    if (provider === "waha") {
      const release = await this.prisma.inboundWebhookParserRelease.findUnique({
        where: {
          provider_version: {
            provider: "waha",
            version: WAHA_V2_PARSER_VERSION,
          },
        },
        select: { provider: true, version: true, status: true },
      });

      if (release && inboundParserProductionEligible(release)) {
        return { version: WAHA_V2_PARSER_VERSION, parse: parseWahaV2Webhook };
      }
    }

    return { version: "v1", parse: MESSAGE_PROVIDER_PARSERS[provider] };
  }

  /**
   * WAHA (`payload.session`) and Z-API (`body.instanceId`) deliveries must
   * bind to the connection's persisted providerInstanceId before anything
   * is parsed, logged, or converted. A connection whose providerInstanceId
   * has not been configured yet, or a payload that omits the field or
   * disagrees with it, is rejected outright: the webhook token alone would
   * otherwise let a delivery for one WAHA session/Z-API instance be
   * ingested under a differently-configured connection sharing the same
   * token. Fails closed in every case.
   */
  private assertProviderInstanceBinding(
    provider: WiredMessageProvider,
    body: WebhookBody,
    providerInstanceId: string | null,
  ): void {
    const claimed = this.firstString(
      body[WIRED_MESSAGE_PROVIDER_BINDING_FIELD[provider]],
    );

    if (!providerInstanceId || !claimed || claimed !== providerInstanceId) {
      throw new UnauthorizedException("Webhook WhatsApp não autorizado");
    }
  }

  @Post("meta")
  @HttpCode(202)
  async recordMeta(
    @Body() body: WebhookBody,
    @RawBody() rawBody: Buffer | undefined,
    @Headers("x-hub-signature-256") signature?: string,
    @Headers("x-workspace-id") workspaceId?: string,
  ) {
    this.assertMetaWebhookSignature(rawBody, signature);
    const context = await this.resolveMetaContext(body);

    if (workspaceId && workspaceId !== context.workspaceId) {
      throw new UnauthorizedException("Webhook Meta não autorizado");
    }

    return this.recordMetaWebhook(body, context);
  }

  private recordMetaWebhook(body: WebhookBody, context: VerifiedMetaContext) {
    const meta = this.getMetaWebhookMetadata(body);
    const externalEventId =
      meta.externalEventId ??
      this.firstString(body.id) ??
      this.firstString(body.eventId) ??
      this.firstString(body.externalEventId);

    return this.diagnosticsService.recordWebhookLog({
      workspaceId: context.workspaceId,
      source: "meta",
      eventType: meta.eventType,
      externalEventId,
      idempotencyKey: externalEventId
        ? `meta:${context.workspaceId}:${context.pageId}:${externalEventId}`
        : undefined,
      campaignId: meta.campaignId,
      adSetId: meta.adSetId,
      adId: meta.adId,
      summaryPayload: body,
    });
  }

  private getMetaWebhookMetadata(body: WebhookBody): {
    eventType: string;
    externalEventId?: string;
    campaignId?: string;
    adSetId?: string;
    adId?: string;
  } {
    const change = this.getFirstMetaChange(body);
    const value = change?.value;

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const valueObject = value as Record<string, unknown>;
      const field = this.firstString(change?.field);
      const isLeadgen =
        field === "leadgen" ||
        Boolean(this.firstString(valueObject.leadgen_id));

      if (isLeadgen) {
        return {
          eventType: "meta.leadgen",
          externalEventId:
            this.firstString(valueObject.leadgen_id) ??
            this.firstString(valueObject.id),
          campaignId:
            this.firstString(valueObject.campaign_id) ??
            this.firstString(valueObject.campaignId),
          adSetId:
            this.firstString(valueObject.adset_id) ??
            this.firstString(valueObject.ad_set_id) ??
            this.firstString(valueObject.adgroup_id) ??
            this.firstString(valueObject.adSetId),
          adId:
            this.firstString(valueObject.ad_id) ??
            this.firstString(valueObject.adId),
        };
      }
    }

    return {
      eventType:
        this.firstString(body.object) ??
        this.firstString(body.event) ??
        "meta.webhook",
    };
  }

  private getFirstMetaChange(
    body: WebhookBody,
  ): Record<string, unknown> | null {
    const entries = Array.isArray(body.entry) ? body.entry : [];

    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }

      const changes = (entry as Record<string, unknown>).changes;

      if (!Array.isArray(changes)) {
        continue;
      }

      for (const change of changes) {
        if (change && typeof change === "object" && !Array.isArray(change)) {
          return change as Record<string, unknown>;
        }
      }
    }

    return null;
  }

  private assertMetaWebhookSignature(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ) {
    const appSecret = process.env.META_APP_SECRET;
    const signatureHex = signature?.startsWith("sha256=")
      ? signature.slice("sha256=".length)
      : undefined;

    if (
      !appSecret ||
      !rawBody ||
      !signatureHex ||
      !/^[a-f0-9]{64}$/i.test(signatureHex)
    ) {
      throw new UnauthorizedException("Webhook Meta não autorizado");
    }

    const expectedSignature = createHmac("sha256", appSecret)
      .update(rawBody)
      .digest();
    const receivedSignature = Buffer.from(signatureHex, "hex");

    if (
      receivedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(receivedSignature, expectedSignature)
    ) {
      throw new UnauthorizedException("Webhook Meta não autorizado");
    }
  }

  private async resolveMetaContext(
    body: WebhookBody,
  ): Promise<VerifiedMetaContext> {
    const entries = Array.isArray(body.entry) ? body.entry : [];
    const pageIds = Array.from(
      new Set(
        entries
          .map((entry) => this.firstString(this.recordValue(entry)?.id))
          .filter((pageId): pageId is string => Boolean(pageId)),
      ),
    );

    if (pageIds.length !== 1) {
      throw new UnauthorizedException("Webhook Meta não autorizado");
    }

    const destinations = await this.prisma.metaConversionDestination.findMany({
      where: {
        pageId: pageIds[0],
      },
      select: {
        workspaceId: true,
      },
      take: 2,
    });

    if (destinations.length !== 1) {
      throw new UnauthorizedException("Webhook Meta não autorizado");
    }

    return {
      workspaceId: destinations[0].workspaceId,
      pageId: pageIds[0],
    };
  }

  private assertUazapiWebhookToken(receivedToken?: string) {
    const expectedToken = process.env.UAZAPI_WEBHOOK_AUTH_TOKEN;

    if (
      !expectedToken ||
      !receivedToken ||
      this.hashToken(receivedToken) !== this.hashToken(expectedToken)
    ) {
      throw new UnauthorizedException("Webhook Uazapi não autorizado");
    }
  }

  private getBearerToken(authorization?: string): string | undefined {
    if (!authorization?.startsWith("Bearer ")) {
      return undefined;
    }

    return this.firstString(authorization.slice("Bearer ".length));
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private matchesTokenHash(receivedToken: string, expectedHash: string): boolean {
    const receivedHash = Buffer.from(this.hashToken(receivedToken), "utf8");
    const storedHash = Buffer.from(expectedHash, "utf8");

    return (
      receivedHash.length === storedHash.length &&
      timingSafeEqual(receivedHash, storedHash)
    );
  }

  private async recordUazapiWebhook(
    body: WebhookBody,
    verifiedContext?: VerifiedUazapiContext,
    claimedWorkspaceId?: string,
  ) {
    const parsed = parseUazapiWebhook(body);
    const resolvedContext =
      verifiedContext ??
      (await this.resolveUazapiContext(parsed.providerInstanceId));

    if (!resolvedContext) {
      throw new UnauthorizedException("Webhook Uazapi não autorizado");
    }

    this.assertUazapiContextMatches(
      body,
      parsed.providerInstanceId,
      claimedWorkspaceId,
      resolvedContext,
    );

    const attribution = await this.resolveUazapiMetaAttribution(
      resolvedContext.workspaceId,
      {
        campaignId: parsed.campaignId,
        adSetId: parsed.adSetId,
        adId: parsed.adId,
      },
    );

    const diagnostic = await this.diagnosticsService.recordWebhookLog({
      workspaceId: resolvedContext.workspaceId,
      whatsappInstanceId: resolvedContext.whatsappInstanceId,
      source: "uazapi",
      eventType: parsed.eventType,
      externalEventId: parsed.externalEventId,
      idempotencyKey: parsed.externalEventId
        ? [
            "uazapi",
            resolvedContext.workspaceId,
            resolvedContext.whatsappInstanceId,
            parsed.externalEventId,
          ].join(":")
        : undefined,
      leadId: parsed.leadId,
      phoneHash: parsed.phoneHash,
      campaignId: attribution.campaignId,
      adSetId: attribution.adSetId,
      adId: attribution.adId,
      summaryPayload: body,
    });

    if (diagnostic.status === "duplicate") {
      return {
        ...diagnostic,
        conversion: {
          created: [],
          duplicates: [],
          queued: [],
        },
      };
    }

    const message = this.recordValue(body.message);
    if (message !== undefined) {
      await this.touchBridgedChannel(resolvedContext);
    }
    const isInboundMessage =
      message !== undefined &&
      message.fromMe === false &&
      parsed.isGroupChat !== true;
    const isTeamMessage =
      message !== undefined &&
      message.fromMe === true &&
      parsed.isGroupChat !== true;

    // U2c: attendant (fromMe=true) messages evaluate message_phrase
    // Checkout/Purchase conversion rules against the paid lead of the contact
    // being messaged; never creates or touches a platform lead.
    if (isTeamMessage) {
      await this.evaluateUazapiTeamMessage(resolvedContext, parsed);
    }

    // Labels can arrive on chat updates as well as inbound CTWA messages.
    // They are evaluated independently of lead creation, and the conversion
    // service fails closed unless the contact resolves to a paid lead.
    if (
      parsed.labelEventKind === "chat_labels" &&
      parsed.phone &&
      !parsed.isGroupChat
    ) {
      await this.evaluateUazapiLabels(resolvedContext, parsed);
    }

    // Product rule: Uazapi only creates platform leads for paid CTWA inbound messages.
    if (!isInboundMessage || !parsed.ctwaClid) {
      return {
        ...diagnostic,
        conversion: {
          created: [],
          duplicates: [],
          queued: [],
        },
      };
    }

    const triggerInput = {
      messageText: parsed.messageText,
      labels: parsed.labels,
    };
    const rules = await this.conversionRulesService.evaluateTriggers(
      resolvedContext.workspaceId,
      triggerInput,
    );
    const lead = await this.leadsService.upsertFromWhatsappWebhook({
      workspaceId: resolvedContext.workspaceId,
      whatsappInstanceId: resolvedContext.whatsappInstanceId,
      name: parsed.contactName,
      phone: parsed.phone,
      phoneHash: parsed.phoneHash,
      source: "uazapi",
      labels: triggerInput.labels,
      campaignId: attribution.campaignId,
      adSetId: attribution.adSetId,
      adId: attribution.adId,
      ctwaClid: parsed.ctwaClid,
      ctwaSourceUrl: parsed.ctwaSourceUrl,
      occurredAt: new Date(),
    });
    const deferToProviderRule = await this.bridgedLeadSubmittedOverride(
      "uazapi",
      resolvedContext,
      attribution.adId,
    );
    const automatic =
      await this.conversionEventsService.recordAutomaticLeadSubmitted({
        workspaceId: resolvedContext.workspaceId,
        leadId: lead?.id ?? parsed.leadId,
        phoneHash: parsed.phoneHash,
        campaignId: attribution.campaignId,
        adSetId: attribution.adSetId,
        adId: attribution.adId,
        ctwaClid: parsed.ctwaClid,
        deferToProviderRule,
      });
    const conversion = await this.conversionEventsService.recordRuleMatches({
      workspaceId: resolvedContext.workspaceId,
      rules,
      leadId: lead?.id ?? parsed.leadId,
      phoneHash: parsed.phoneHash,
      campaignId: attribution.campaignId,
      adSetId: attribution.adSetId,
      adId: attribution.adId,
      ctwaClid: parsed.ctwaClid,
    });
    const readyLogIds = await this.conversionEventsService.listReadyLogIds([
      ...automatic.created,
      ...conversion.created,
    ]);
    const queued = await Promise.all(
      readyLogIds.map((logId) =>
        this.conversionEventsQueueService.enqueueSend(
          logId,
          resolvedContext.workspaceId,
        ),
      ),
    );

    return {
      ...diagnostic,
      conversion: {
        ...conversion,
        automatic,
        queued,
      },
    };
  }

  /**
   * WAHA/Z-API receiver: the connection is already authenticated by
   * recordWhatsappConnection, so this only needs to parse, log to
   * WebhookLog, and (for a paid CTWA inbound message) create a lead. Unlike
   * Uazapi's shared endpoint there is no provider-instance lookup to do:
   * the workspace/connection context comes straight from the verified
   * instance.
   */
  private async recordProviderMessageWebhook(
    provider: WiredMessageProvider,
    body: WebhookBody,
    context: VerifiedConnectionContext,
    parser: SelectedMessageParser = {
      version: "v1",
      parse: MESSAGE_PROVIDER_PARSERS[provider],
    },
  ) {
    const isWahaV2 =
      provider === "waha" && parser.version === WAHA_V2_PARSER_VERSION;
    let parsed = parser.parse(body);
    let contactResolvedByLid = false;

    // Clique de anúncio com contato só por LID: tenta o telefone na WAHA do
    // aluno (prazo curto, nunca quebra a ingestão) antes de desistir.
    if (
      isWahaV2 &&
      parsed.classificationReason === "ctwa_contact_phone_unresolved" &&
      this.wahaLidResolver
    ) {
      const lid = wahaV2UnresolvedContactLid(body);
      const phone = lid
        ? await this.wahaLidResolver.resolvePhone({ ...context, lid })
        : null;

      if (phone) {
        const reparsed = parser.parse(withWahaResolvedContactPhone(body, phone));

        if (reparsed.events.length > 0) {
          parsed = reparsed;
          contactResolvedByLid = true;
        }
      }
    }

    // Mensagem do time para um contato só com LID (sem RecipientAlt): o
    // telefone vem da WAHA do aluno, como no clique de anúncio, para a regra
    // de frase achar o lead. Sem resposta, segue sem evento (sem regra).
    if (
      isWahaV2 &&
      parsed.classificationReason === "contact_phone_unresolved" &&
      this.wahaLidResolver
    ) {
      const lid = wahaV2UnresolvedTeamContactLid(body);
      const phone = lid
        ? await this.wahaLidResolver.resolvePhone({ ...context, lid })
        : null;

      if (phone) {
        const reparsed = parser.parse(
          withWahaResolvedTeamContactPhone(body, phone),
        );

        if (
          reparsed.events.length > 0 &&
          reparsed.events[0]?.message.direction === "outbound"
        ) {
          parsed = reparsed;
          contactResolvedByLid = true;
        }
      }
    }
    const event = parsed.events[0] ?? null;
    const phoneHash = event
      ? hashPhoneIdentity(event.contact.phoneNumber)
      : undefined;
    const emptyConversion = { created: [], duplicates: [], queued: [] };
    // Idempotency hardening: fingerprint the payload so a same-externalId
    // replay with a genuinely different body (rather than a plain retry) is
    // quarantined instead of silently treated as a duplicate.
    const payloadHash = computeCanonicalPayloadHash(body);
    // WAHA delivers the same message twice (message and message.any). With
    // v2 the event name is part of the key, so the second copy is its own
    // log row instead of a payload-mismatch conflict with the first.
    const idempotencyParts = isWahaV2
      ? [parsed.providerEventType ?? "unknown", parsed.externalDeliveryId]
      : [parsed.externalDeliveryId];

    if (isWahaV2) {
      await this.recordWahaSessionStatus(body, context);
    }

    const diagnostic = await this.diagnosticsService.recordWebhookLog({
      workspaceId: context.workspaceId,
      whatsappInstanceId: context.whatsappInstanceId,
      source: provider,
      eventType: parsed.providerEventType ?? `${provider}.webhook`,
      externalEventId: parsed.externalDeliveryId ?? undefined,
      idempotencyKey: parsed.externalDeliveryId
        ? [
            provider,
            context.workspaceId,
            context.whatsappInstanceId,
            ...idempotencyParts,
          ].join(":")
        : undefined,
      payloadHash,
      phoneHash,
      adId: event?.adId ?? parsed.normalizedSummary.adId ?? undefined,
      // v2 keeps only the structural summary: the GoWS body carries the raw
      // WhatsApp message (texts, names, LIDs, media keys and thumbnails).
      summaryPayload: isWahaV2
        ? this.wahaV2LogSummary(body, parsed, contactResolvedByLid)
        : body,
    });

    if (diagnostic.status === "duplicate" || diagnostic.status === "conflict") {
      return { ...diagnostic, conversion: emptyConversion };
    }

    // A WAHA message (contact or team) marks its bridged number as alive:
    // the canonical channel of a phone prefers the one still receiving.
    if (isWahaV2 && event) {
      await this.touchBridgedChannel(context);
    }

    // From here on this request holds the WebhookLog claim and must settle
    // it. A downstream failure has to land as "failed" so the provider's
    // retry can reclaim and reprocess the very same delivery: left in
    // flight, every retry would be answered as a duplicate and the delivery
    // would be lost. The error still propagates, so the provider sees a
    // non-2xx and retries. Settling is never optional in either direction:
    // an unsettled delivery is answered with a non-2xx, never a success.
    let conversion: Awaited<ReturnType<typeof this.convertProviderMessage>>;

    try {
      conversion = await this.convertProviderMessage(
        provider,
        event,
        phoneHash,
        context,
        isWahaV2,
      );
    } catch (error) {
      await this.settleProviderDeliveryFailed(
        provider,
        diagnostic.webhookLogId,
        context,
        error,
      );

      throw error;
    }

    // Settling is outside the try on purpose: a settlement problem is its
    // own incident, not a downstream failure to be re-recorded as one.
    await this.settleProviderDeliveryProcessed(
      provider,
      diagnostic.webhookLogId,
      context,
    );

    return { ...diagnostic, conversion };
  }

  /**
   * WAHA `session.status`: mirrors the session state of the student's own
   * WAHA on the connection (same mapping as "Testar conexão"). Only the
   * connection's own session counts: the receiver already bound
   * body.session to providerInstanceId.
   */
  private async recordWahaSessionStatus(
    body: WebhookBody,
    context: VerifiedConnectionContext,
  ): Promise<void> {
    const sessionStatus = parseWahaSessionStatusEvent(body);

    if (!sessionStatus) {
      return;
    }

    // Entregas podem chegar fora de ordem (retentativas da WAHA): só um
    // status mais novo que o último registrado substitui o atual.
    const occurredAt = sessionStatus.occurredAt ?? new Date();

    await this.prisma.whatsappInstance.updateMany({
      where: {
        id: context.whatsappInstanceId,
        workspaceId: context.workspaceId,
        OR: [
          { lastHealthCheckedAt: null },
          { lastHealthCheckedAt: { lt: occurredAt } },
        ],
      },
      data: {
        lastHealthStatus: mapWahaSessionStatus(sessionStatus.status),
        lastHealthCheckedAt: occurredAt,
      },
    });
  }

  private wahaV2LogSummary(
    body: WebhookBody,
    parsed: InboundWebhookParserResult,
    contactResolvedByLid = false,
  ): Record<string, unknown> {
    const event = parsed.events[0];
    const sessionStatus = parseWahaSessionStatusEvent(body);

    return {
      parser: { provider: parsed.provider, version: parsed.parserVersion },
      engine: this.firstString(body.engine)?.slice(0, 20) ?? null,
      event: parsed.providerEventType,
      classification: parsed.classification,
      classificationReason: parsed.classificationReason,
      ...(sessionStatus ? { sessionStatus: sessionStatus.status } : {}),
      ...(event
        ? {
            messageDirection: event.message.direction,
            messageType: event.message.messageType,
            hasCtwa: event.hasCtwa,
            adId: event.adId,
            contactHasLid: Boolean(event.contact.lid),
            ...(contactResolvedByLid ? { contactPhoneFromLidLookup: true } : {}),
          }
        : parsed.normalizedSummary.hasCtwa !== undefined
          ? {
              hasCtwa: parsed.normalizedSummary.hasCtwa,
              adId: parsed.normalizedSummary.adId ?? null,
            }
          : {}),
    };
  }

  /**
   * Downstream half of the WAHA/Z-API receiver, run while holding the
   * WebhookLog claim. Kept separate from recordProviderMessageWebhook so
   * every step of it - attribution, rules, lead, conversion, enqueue - is
   * covered by the same failure/retry accounting.
   */
  private async convertProviderMessage(
    provider: WiredMessageProvider,
    event: ParsedInboundWebhookEvent | null,
    phoneHash: string | undefined,
    context: VerifiedConnectionContext,
    adWithoutClidCreatesLead = false,
  ) {
    const emptyConversion = { created: [], duplicates: [], queued: [] };

    // WAHA v2: a mensagem do time (`message.any` com fromMe) entra no MESMO
    // pipeline das regras de frase da Uazapi (ponte, decisão congelada,
    // execução e envio). Nunca cria lead. A cópia `message` do fromMe já foi
    // descartada pelo parser, e a reentrega do webhook bate no WebhookLog e,
    // depois, na decisão congelada da ocorrência: uma execução só.
    if (
      provider === "waha" &&
      adWithoutClidCreatesLead &&
      event?.message.direction === "outbound" &&
      event.providerEventType === "message.any"
    ) {
      const teamMessage = await this.evaluateWahaTeamMessage(context, event);

      return { ...emptyConversion, teamMessage };
    }

    if (!event || event.message.direction !== "inbound") {
      return emptyConversion;
    }

    // WAHA v2 (decisão de produto, igual ao Rastrackapp): um clique de
    // anúncio que chega só com sourceID, sem ctwa_clid (anúncios no Status
    // do WhatsApp), também é lead de anúncio, atribuído pelo adId. Sem clid
    // nada vai à Meta: o LeadSubmitted e as regras exigem ctwa_clid, e o
    // ctwaPayload nunca é usado no lugar dele (a Meta o rejeita, 2804087).
    if (!event.ctwaClid && adWithoutClidCreatesLead && event.adId) {
      return this.recordAdLeadWithoutClid(event, phoneHash, context);
    }

    // Product rule (mirrors Uazapi): only a paid CTWA inbound message
    // creates a platform lead. Organic messages (no ctwaClid) and messages
    // sent from the connected number itself (fromMe) never do; group chats
    // never reach here because the parsers decline to emit an event for
    // them. Nothing left to do is still a processed delivery.
    if (!event.ctwaClid) {
      return emptyConversion;
    }

    const attribution = await this.resolveUazapiMetaAttribution(
      context.workspaceId,
      { adId: event.adId ?? undefined },
    );
    const triggerInput = {
      messageText: event.message.text ?? undefined,
      labels: [] as string[],
    };
    const rules = await this.conversionRulesService.evaluateTriggers(
      context.workspaceId,
      triggerInput,
    );
    const lead = await this.leadsService.upsertFromWhatsappWebhook({
      workspaceId: context.workspaceId,
      whatsappInstanceId: context.whatsappInstanceId,
      name: event.contact.name ?? undefined,
      // The WhatsApp push name only fills an empty lead name; it never
      // overwrites a name the team already set.
      preserveExistingName: true,
      phone: event.contact.phoneNumber,
      phoneHash,
      source: provider,
      labels: triggerInput.labels,
      campaignId: attribution.campaignId,
      adSetId: attribution.adSetId,
      adId: attribution.adId,
      ctwaClid: event.ctwaClid,
      ctwaSourceUrl: event.ad?.sourceUrl ?? undefined,
      occurredAt: event.occurredAt,
    });
    // nod: the WAHA bridge number follows the same "Lead recebido pela
    // regra" as Uazapi (Z-API has no bridge, so it never defers).
    const deferToProviderRule =
      provider === "waha"
        ? await this.bridgedLeadSubmittedOverride(
            "waha",
            context,
            attribution.adId,
          )
        : null;
    const automatic =
      await this.conversionEventsService.recordAutomaticLeadSubmitted({
        workspaceId: context.workspaceId,
        leadId: lead?.id,
        phoneHash,
        campaignId: attribution.campaignId,
        adSetId: attribution.adSetId,
        adId: attribution.adId,
        ctwaClid: event.ctwaClid,
        deferToProviderRule,
      });
    const conversion = await this.conversionEventsService.recordRuleMatches({
      workspaceId: context.workspaceId,
      rules,
      leadId: lead?.id,
      phoneHash,
      campaignId: attribution.campaignId,
      adSetId: attribution.adSetId,
      adId: attribution.adId,
      ctwaClid: event.ctwaClid,
    });
    const readyLogIds = await this.conversionEventsService.listReadyLogIds([
      ...automatic.created,
      ...conversion.created,
    ]);
    const queued = await Promise.all(
      readyLogIds.map((logId) =>
        this.conversionEventsQueueService.enqueueSend(
          logId,
          context.workspaceId,
        ),
      ),
    );

    return {
      ...conversion,
      automatic,
      queued,
    };
  }

  /**
   * Lead de anúncio sem ctwa_clid (WAHA v2, só sourceID): grava o lead com o
   * adId (campanha/conjunto resolvidos pelo anúncio sincronizado) e a
   * sourceURL. Não avalia regras nem envia evento à Meta.
   */
  private async recordAdLeadWithoutClid(
    event: ParsedInboundWebhookEvent,
    phoneHash: string | undefined,
    context: VerifiedConnectionContext,
  ) {
    const attribution = await this.resolveUazapiMetaAttribution(
      context.workspaceId,
      { adId: event.adId ?? undefined },
    );

    await this.leadsService.upsertFromWhatsappWebhook({
      workspaceId: context.workspaceId,
      whatsappInstanceId: context.whatsappInstanceId,
      name: event.contact.name ?? undefined,
      preserveExistingName: true,
      phone: event.contact.phoneNumber,
      phoneHash,
      source: event.provider,
      labels: [],
      campaignId: attribution.campaignId,
      adSetId: attribution.adSetId,
      adId: attribution.adId,
      ctwaSourceUrl: event.ad?.sourceUrl ?? undefined,
      occurredAt: event.occurredAt,
    });

    return { created: [], duplicates: [], queued: [] };
  }

  /**
   * Settles a delivery whose downstream processing threw.
   *
   * The write is what makes the provider's retry reprocessable, so it is
   * never best-effort: if it cannot be written the row is stuck in flight
   * and every retry of this delivery will be answered as a duplicate, i.e.
   * the delivery is lost while the provider is told 2xx. That is strictly
   * worse than the downstream failure, so it is reported as its own incident
   * and raised instead of being logged away behind the original error, which
   * is kept as the cause.
   *
   * A settlement that simply matched no row (claim already taken over) is a
   * different case: nothing is stuck, the downstream error still propagates,
   * and it is only recorded.
   */
  private async settleProviderDeliveryFailed(
    provider: WiredMessageProvider,
    webhookLogId: string,
    context: VerifiedConnectionContext,
    error: unknown,
  ): Promise<void> {
    let settled: boolean;

    try {
      settled = await this.diagnosticsService.markWebhookLogFailed(
        webhookLogId,
        error,
      );
    } catch (markError) {
      throw this.reportDeliveryStuckInFlight(
        provider,
        webhookLogId,
        context,
        markError,
        error,
      );
    }

    if (!settled) {
      this.logSettlementIncident("whatsapp_receiver_failure_claim_lost", {
        provider,
        webhookLogId,
        context,
      });
    }
  }

  /**
   * Settles a delivery whose downstream processing completed. The conditional
   * UPDATE is the proof this request still held the claim, so its result is
   * checked: a delivery this request did not settle must never be answered as
   * a success. Both "the claim was gone" and "the write never landed" fail
   * the request instead.
   */
  private async settleProviderDeliveryProcessed(
    provider: WiredMessageProvider,
    webhookLogId: string,
    context: VerifiedConnectionContext,
  ): Promise<void> {
    let settled: boolean;

    try {
      settled =
        await this.diagnosticsService.markWebhookLogProcessed(webhookLogId);
    } catch (markError) {
      throw this.reportDeliveryStuckInFlight(
        provider,
        webhookLogId,
        context,
        markError,
      );
    }

    if (settled) {
      return;
    }

    this.logSettlementIncident("whatsapp_receiver_processed_claim_lost", {
      provider,
      webhookLogId,
      context,
    });

    throw new ConflictException(
      "Entrega de webhook não pode ser concluída: a reivindicação do registro foi perdida",
    );
  }

  /**
   * The row could not be settled at all, so it stays "received" and the
   * delivery is not recoverable by retry until it is settled. Reported by
   * error class only - provider and ORM errors quote payloads, phones and
   * tokens - and raised with a static message for the same reason.
   */
  private reportDeliveryStuckInFlight(
    provider: WiredMessageProvider,
    webhookLogId: string,
    context: VerifiedConnectionContext,
    markError: unknown,
    downstreamError?: unknown,
  ): InternalServerErrorException {
    this.logSettlementIncident("whatsapp_receiver_delivery_stuck_in_flight", {
      provider,
      webhookLogId,
      context,
      markError,
      downstreamError,
    });

    return new InternalServerErrorException(
      "Falha ao registrar o resultado do webhook",
      { cause: markError },
    );
  }

  private logSettlementIncident(
    event: string,
    details: {
      provider: WiredMessageProvider;
      webhookLogId: string;
      context: VerifiedConnectionContext;
      markError?: unknown;
      downstreamError?: unknown;
    },
  ): void {
    this.logger.error(
      JSON.stringify({
        event,
        provider: details.provider,
        workspaceId: details.context.workspaceId,
        whatsappInstanceId: details.context.whatsappInstanceId,
        webhookLogId: details.webhookLogId,
        ...(details.markError !== undefined
          ? { errorName: safeErrorName(details.markError) }
          : {}),
        ...(details.downstreamError !== undefined
          ? { downstreamErrorName: safeErrorName(details.downstreamError) }
          : {}),
      }),
    );
  }

  private async evaluateUazapiTeamMessage(
    context: VerifiedUazapiContext,
    parsed: ParsedUazapiWebhook,
  ): Promise<void> {
    if (!parsed.phone || !parsed.messageText) {
      return;
    }

    try {
      const instance = await this.prisma.whatsappInstance.findFirst({
        where: {
          id: context.whatsappInstanceId,
          workspaceId: context.workspaceId,
        },
        select: {
          id: true,
          workspaceId: true,
          name: true,
          providerInstanceId: true,
        },
      });

      if (!instance) {
        return;
      }

      await this.uazapiProviderConversion.evaluateTeamMessage({
        workspaceId: context.workspaceId,
        instance,
        phone: parsed.phone,
        messageText: parsed.messageText,
        externalMessageId: parsed.externalEventId,
        occurredAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: "uazapi_team_message_evaluation_failed",
          workspaceId: context.workspaceId,
          whatsappInstanceId: context.whatsappInstanceId,
          errorName: error instanceof Error ? error.name : "unknown",
        }),
      );
    }
  }

  /**
   * Last activity of the number bridged from this WhatsApp connection
   * (Uazapi/WAHA), used to pick the live channel when the same phone has an
   * old connection that stopped receiving. At most one write per minute per
   * number; best-effort (never fails the delivery).
   */
  /**
   * Porte do SaaS #155 ("Lead recebido pela regra"): an active production
   * LeadSubmitted provider rule covering this bridged number (Uazapi BYO or
   * WAHA, connected by server URL + token) sends the LeadSubmitted instead of
   * the entry. Read-only: uses the existing bridge channel and never creates
   * one (no bridge means no rule can cover the number yet, so the entry
   * sends as today). The rule send needs the lead's ad route, a usable
   * license and the WhatsApp connection active (checked by the resolver).
   */
  private async bridgedLeadSubmittedOverride(
    provider: "uazapi" | "waha",
    context: { workspaceId: string; whatsappInstanceId: string },
    adId: string | null | undefined,
  ): Promise<{
    ruleIds: string[];
    provider: "uazapi" | "waha";
    channelId: string;
    connectionId: string;
  } | null> {
    if (!leadSubmittedRuleOverrideEnabled(this.env)) return null;
    if (!adId || !this.license) return null;
    try {
      const channel = await this.prisma.inboundWebhookChannel.findUnique({
        where: { whatsappInstanceId: context.whatsappInstanceId },
        select: {
          id: true,
          workspaceId: true,
          connectionId: true,
          connection: { select: { provider: true } },
        },
      });
      if (
        !channel ||
        channel.workspaceId !== context.workspaceId ||
        channel.connection?.provider !== provider
      )
        return null;
      const override = await resolveLeadSubmittedRuleOverride(
        this.prisma,
        {
          workspaceId: context.workspaceId,
          channel: {
            id: channel.id,
            connectionId: channel.connectionId,
            provider,
          },
          destination: { kind: "ad_route", adId },
        },
        { env: this.env, license: this.license },
      );
      return override
        ? {
            ruleIds: override.ruleIds,
            provider,
            channelId: channel.id,
            connectionId: channel.connectionId,
          }
        : null;
    } catch {
      return null;
    }
  }

  private async touchBridgedChannel(context: {
    workspaceId: string;
    whatsappInstanceId: string;
  }): Promise<void> {
    const now = new Date();
    try {
      await this.prisma.inboundWebhookChannel.updateMany({
        where: {
          workspaceId: context.workspaceId,
          whatsappInstanceId: context.whatsappInstanceId,
          lastSeenAt: { lt: new Date(now.getTime() - 60_000) },
        },
        data: { lastSeenAt: now },
      });
    } catch {
      // best-effort
    }
  }

  /**
   * Regras de frase da equipe numa conexão WAHA: mesmo serviço da Uazapi com
   * o provedor "waha". O contato é o telefone que o parser v2 resolveu
   * (RecipientAlt, to, Chat ou o LID consultado na WAHA). Corre dentro da
   * reivindicação do WebhookLog: uma falha marca a entrega como falha e a
   * retentativa da WAHA reprocessa a mesma mensagem sem duplicar (decisão
   * congelada por ocorrência).
   */
  private async evaluateWahaTeamMessage(
    context: VerifiedConnectionContext,
    event: ParsedInboundWebhookEvent,
  ): Promise<{ evaluated: boolean; eligibleExecutionId: string | null }> {
    const none = { evaluated: false, eligibleExecutionId: null };
    const phone = event.contact.phoneNumber?.trim();
    const messageText = event.message.text?.trim();

    if (!phone || !messageText) {
      return none;
    }

    const instance = await this.prisma.whatsappInstance.findFirst({
      where: {
        id: context.whatsappInstanceId,
        workspaceId: context.workspaceId,
        provider: "waha",
      },
      select: {
        id: true,
        workspaceId: true,
        name: true,
        providerInstanceId: true,
      },
    });

    if (!instance) {
      return none;
    }

    return this.uazapiProviderConversion.evaluateTeamMessage({
      workspaceId: context.workspaceId,
      provider: "waha",
      instance: {
        ...instance,
        connectedPhone: event.channel.connectedPhone || null,
      },
      phone,
      messageText,
      externalMessageId: event.externalMessageId,
      occurredAt: event.occurredAt,
    });
  }

  private async evaluateUazapiLabels(
    context: VerifiedUazapiContext,
    parsed: ParsedUazapiWebhook,
  ): Promise<void> {
    if (!parsed.phone) return;

    try {
      const instance = await this.prisma.whatsappInstance.findFirst({
        where: {
          id: context.whatsappInstanceId,
          workspaceId: context.workspaceId,
        },
        select: {
          id: true,
          workspaceId: true,
          name: true,
          providerInstanceId: true,
          providerTokenEncrypted: true,
          providerTokenIv: true,
          providerTokenTag: true,
        },
      });
      if (!instance) return;

      await this.uazapiProviderConversion.evaluateLabels({
        workspaceId: context.workspaceId,
        instance,
        phone: parsed.phone,
        labelIds: parsed.waLabelIds,
        waChatId: parsed.waChatId,
        externalEventId: parsed.externalEventId,
        occurredAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: "uazapi_label_evaluation_failed",
          workspaceId: context.workspaceId,
          whatsappInstanceId: context.whatsappInstanceId,
          errorName: error instanceof Error ? error.name : "unknown",
        }),
      );
    }
  }

  private async resolveUazapiMetaAttribution(
    workspaceId: string,
    input: {
      campaignId?: string;
      adSetId?: string;
      adId?: string;
    },
  ): Promise<{
    campaignId?: string;
    adSetId?: string;
    adId?: string;
  }> {
    if (!input.adId) {
      return input;
    }

    const ad = await this.prisma.metaAd.findFirst({
      where: {
        workspaceId,
        adId: input.adId,
      },
      select: {
        campaignId: true,
        adSetId: true,
      },
    });

    if (!ad) {
      return input;
    }

    return {
      adId: input.adId,
      campaignId: input.campaignId ?? ad.campaignId ?? undefined,
      adSetId: input.adSetId ?? ad.adSetId ?? undefined,
    };
  }

  private firstString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
  }

  private recordValue(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private assertUazapiContextMatches(
    body: WebhookBody,
    providerInstanceId: string | undefined,
    claimedWorkspaceId: string | undefined,
    context: VerifiedUazapiContext,
  ) {
    const workspace = this.recordValue(body.workspace);
    const claimedWorkspaceIds = [
      claimedWorkspaceId,
      this.firstString(body.workspaceId),
      this.firstString(body.workspace_id),
      this.firstString(workspace?.id),
      this.firstString(workspace?.workspaceId),
    ].filter((value): value is string => Boolean(value));
    const claimedLocalInstanceIds = [
      this.firstString(body.whatsappInstanceId),
      this.firstString(body.whatsapp_instance_id),
    ].filter((value): value is string => Boolean(value));

    if (
      claimedWorkspaceIds.some(
        (workspaceId) => workspaceId !== context.workspaceId,
      ) ||
      claimedLocalInstanceIds.some(
        (instanceId) => instanceId !== context.whatsappInstanceId,
      ) ||
      (providerInstanceId && providerInstanceId !== context.providerInstanceId)
    ) {
      throw new UnauthorizedException("Webhook Uazapi não autorizado");
    }
  }

  private async resolveUazapiContext(
    providerInstanceId?: string,
  ): Promise<VerifiedUazapiContext | null> {
    if (!providerInstanceId) {
      return null;
    }

    const instances = await this.prisma.whatsappInstance.findMany({
      where: {
        provider: "uazapi",
        providerInstanceId,
      },
      select: {
        id: true,
        workspaceId: true,
        providerInstanceId: true,
      },
      take: 2,
    });

    return instances.length === 1
      ? {
          workspaceId: instances[0].workspaceId,
          whatsappInstanceId: instances[0].id,
          providerInstanceId: instances[0].providerInstanceId,
        }
      : null;
  }
}
