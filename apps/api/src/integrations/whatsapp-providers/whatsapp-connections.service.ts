import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import type { Prisma, WorkspaceRole } from "@prisma/client";
import {
  WAHA_GOWS_WEBHOOK_EVENTS,
  WAHA_WEBHOOK_TOKEN_HEADER,
  type WhatsappConnectionCreateInputDto,
  type WhatsappConnectionCredentialsUpdateDto,
  type WhatsappConnectionDto,
  type WhatsappConnectionEditInputDto,
  type WhatsappConnectionEditMetadataDto,
  type WhatsappConnectionTestResultDto,
  type WhatsappConnectionWebhookConfigureResultDto,
  type WhatsappConnectionWebhookTokenRotateResultDto,
  type WhatsappConnectionUpdateInputDto,
  type WhatsappInstanceActivityDto,
} from "@wpptrack/shared";
import { PrismaService } from "../../common/prisma/prisma.service";
import type { IntegrationEnv } from "../integration.types";
import { INTEGRATION_ENV } from "../integration.types";
import { MetaTokenEncryptionService } from "../meta/meta-token-encryption.service";
import { WorkspaceAccessPolicyService } from "../../workspaces/workspace-access-policy.service";
import { WhatsappProviderRegistry } from "./whatsapp-provider.registry";
import { UazapiByoAdapter } from "./uazapi-byo.adapter";
import type {
  WhatsappProviderConfig,
  WhatsappProviderId,
} from "./whatsapp-provider.types";
import { normalizeProviderBaseUrl } from "./whatsapp-provider-http";
import { UazapiConversionBridgeService } from "../../inbound-webhooks/uazapi-conversion-bridge.service";
import {
  DISCONNECT_ALERT_PROVIDERS,
  readDisconnectAlertStates,
  type WhatsappDisconnectAlertState,
} from "../../ops-alerts/instance-disconnect-streak";

type WorkspaceActor = {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  canManageMembers?: boolean;
};

type WhatsappConnectionRecord = {
  id: string;
  workspaceId: string;
  name: string;
  displayName: string | null;
  provider: string;
  providerInstanceId: string | null;
  configEncrypted: string | null;
  configIv: string | null;
  configTag: string | null;
  webhookUrl: string | null;
  status: "pending_payment" | "active" | "disconnected" | "suspended" | "error";
  lastHealthStatus: string | null;
  lastHealthCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type AdapterWhatsappConnectionCreateInput = Exclude<
  WhatsappConnectionCreateInputDto,
  { provider: "gupshup" | "umbler" }
>;
type WhatsappConnectionCredentials =
  | AdapterWhatsappConnectionCreateInput["credentials"]
  | WhatsappConnectionCredentialsUpdateDto["credentials"];

/**
 * Fase 6.3b (porte do SaaS #125): conexões com atividade por número. A Uazapi
 * BYO e a WAHA gravam o lead e o webhook com a conexão (direto ou pela ponte
 * das regras de frase), com estas origens.
 */
const ACTIVITY_LEAD_SOURCE: Partial<Record<WhatsappProviderId, string>> = {
  uazapi_byo: "uazapi",
  waha: "waha",
};

const ACTIVITY_QUERY_ERROR =
  "Não foi possível consultar a atividade desta conexão WhatsApp";

const PROVIDERS: readonly WhatsappProviderId[] = [
  "uazapi_byo",
  "waha",
  "zapi",
  "nod_api",
];

@Injectable()
export class WhatsappConnectionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly encryption: MetaTokenEncryptionService,
    private readonly registry: WhatsappProviderRegistry,
    private readonly accessPolicy: WorkspaceAccessPolicyService,
    @Inject(INTEGRATION_ENV) private readonly env: IntegrationEnv = process.env,
    @Optional() private readonly uazapiByo?: UazapiByoAdapter,
    @Optional() private readonly uazapiBridge?: UazapiConversionBridgeService,
  ) {}

  async listConnections(workspaceId: string): Promise<WhatsappConnectionDto[]> {
    const connections = (await this.prisma.whatsappInstance.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
    })) as WhatsappConnectionRecord[];
    const listed = connections.filter((connection) =>
      this.isProvider(connection.provider),
    );
    // Fase 6.1c (porte do SaaS #63): desconexão confirmada pelo alerta (2
    // leituras seguidas) das conexões ativas Uazapi BYO e WAHA.
    let alerts = new Map<string, WhatsappDisconnectAlertState>();
    try {
      alerts = await readDisconnectAlertStates(
        this.prisma as never,
        workspaceId,
        listed
          .filter(
            (connection) =>
              connection.status === "active" &&
              (DISCONNECT_ALERT_PROVIDERS as readonly string[]).includes(
                connection.provider,
              ),
          )
          .map((connection) => connection.id),
      );
    } catch {
      // O aviso é informativo: a lista de conexões nunca falha por ele.
    }
    return listed.map((connection) => ({
      ...this.toDto(connection),
      ...(alerts.has(connection.id)
        ? { disconnectAlert: alerts.get(connection.id) }
        : {}),
    }));
  }

  /**
   * Fase 6.3b (porte do SaaS #125, adaptado): atividade de uma conexão Uazapi
   * BYO ou WAHA do workspace. Lead.whatsappInstanceId é a conexão atual do
   * lead (não o histórico das mensagens): a atividade segue a conexão gravada
   * em cada lead de anúncio (CTWA). Só leitura: vale com a licença bloqueada
   * e para conexões removidas (o histórico continua).
   */
  async getActivity(
    workspaceId: string,
    id: string,
    now = new Date(),
  ): Promise<WhatsappInstanceActivityDto> {
    let connection: WhatsappConnectionRecord;
    try {
      connection = await this.findForWorkspace(workspaceId, id);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }

      throw new InternalServerErrorException(ACTIVITY_QUERY_ERROR);
    }

    const source =
      ACTIVITY_LEAD_SOURCE[connection.provider as WhatsappProviderId];

    if (!source) {
      throw new ForbiddenException(
        "Atividade disponível apenas para conexões Uazapi e WAHA",
      );
    }

    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const leadScope = {
      workspaceId,
      whatsappInstanceId: connection.id,
      source,
      ctwaClid: { not: null },
    };
    const window = (since: Date) => ({
      OR: [
        { firstMessageAt: { gte: since, lte: now } },
        { firstMessageAt: null, createdAt: { gte: since, lte: now } },
      ],
    });

    try {
      const [
        leads24h,
        leads7d,
        leadsTotal,
        lastFirstMessageLead,
        lastCreatedLead,
        lastWebhook,
      ] = await Promise.all([
        this.prisma.lead.count({ where: { ...leadScope, ...window(since24h) } }),
        this.prisma.lead.count({ where: { ...leadScope, ...window(since7d) } }),
        this.prisma.lead.count({ where: leadScope }),
        this.prisma.lead.findFirst({
          where: { ...leadScope, firstMessageAt: { not: null } },
          orderBy: { firstMessageAt: "desc" },
          select: { firstMessageAt: true },
        }),
        this.prisma.lead.findFirst({
          where: { ...leadScope, firstMessageAt: null },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),
        this.prisma.webhookLog.findFirst({
          where: {
            workspaceId,
            whatsappInstanceId: connection.id,
            source: source as "uazapi" | "waha",
          },
          orderBy: { receivedAt: "desc" },
          select: { receivedAt: true },
        }),
      ]);
      const lastLeadAt = [
        lastFirstMessageLead?.firstMessageAt ?? null,
        lastCreatedLead?.createdAt ?? null,
      ].reduce<Date | null>(
        (latest, candidate) =>
          !candidate || (latest && latest >= candidate) ? latest : candidate,
        null,
      );

      return {
        leads24h,
        leads7d,
        leadsTotal,
        lastLeadAt: lastLeadAt?.toISOString() ?? null,
        lastWebhookAt: lastWebhook?.receivedAt.toISOString() ?? null,
      };
    } catch {
      throw new InternalServerErrorException(ACTIVITY_QUERY_ERROR);
    }
  }

  async createConnection(
    actor: WorkspaceActor,
    input: WhatsappConnectionCreateInputDto,
  ): Promise<WhatsappConnectionDto> {
    this.assertCanManage(actor);
    const adapterInput = input as AdapterWhatsappConnectionCreateInput;
    const config = this.toProviderConfig(
      adapterInput.provider,
      adapterInput.credentials,
    );
    const providerInstanceId =
      adapterInput.provider === "uazapi_byo"
        ? (adapterInput.credentials?.instanceId ?? null)
        : this.deriveProviderInstanceId(
            adapterInput.provider,
            adapterInput.credentials,
          );
    const encrypted = this.encryptConfig(config);
    const created = (await this.prisma.whatsappInstance.create({
      data: {
        workspaceId: actor.workspaceId,
        name: input.name,
        displayName: input.displayName ?? null,
        provider: input.provider,
        providerInstanceId,
        status: "active",
        ...encrypted,
      },
    })) as WhatsappConnectionRecord;

    await this.recordAudit({
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: "whatsapp_connection.create",
      targetId: created.id,
      afterSummary: { provider: created.provider, status: created.status },
    });
    return this.toDto(created);
  }

  async updateConnection(
    actor: WorkspaceActor,
    id: string,
    input: WhatsappConnectionUpdateInputDto,
  ): Promise<WhatsappConnectionDto> {
    this.assertCanManage(actor);
    const existing = await this.findForWorkspace(actor.workspaceId, id);
    const updated = (await this.prisma.whatsappInstance.update({
      where: { id: existing.id },
      data: input,
    })) as WhatsappConnectionRecord;
    await this.recordAudit({
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: "whatsapp_connection.update",
      targetId: updated.id,
      beforeSummary: this.metadataSummary(existing),
      afterSummary: this.metadataSummary(updated),
    });
    return this.toDto(updated);
  }

  async updateCredentials(
    actor: WorkspaceActor,
    id: string,
    input: WhatsappConnectionCredentialsUpdateDto,
  ): Promise<WhatsappConnectionDto> {
    this.assertCanManage(actor);
    const existing = await this.findForWorkspace(actor.workspaceId, id);
    if (existing.provider !== input.provider) {
      throw new ConflictException(
        "O provider da conexão não pode ser alterado",
      );
    }
    if (
      input.provider === "nod_api" &&
      (!input.credentials.instanceId || !input.credentials.instanceToken)
    ) {
      throw new BadRequestException(
        "NOD API requer instanceId e instanceToken",
      );
    }
    const config = this.toProviderConfig(input.provider, input.credentials);
    const encrypted = this.encryptConfig(config);
    const providerInstanceId =
      input.provider === "uazapi_byo"
        ? (input.credentials.instanceId ?? existing.providerInstanceId)
        : this.deriveProviderInstanceId(input.provider, input.credentials);
    const updated = (await this.prisma.whatsappInstance.update({
      where: { id: existing.id },
      data: {
        ...encrypted,
        providerInstanceId,
      },
    })) as WhatsappConnectionRecord;
    await this.recordAudit({
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: "whatsapp_connection.credentials_update",
      targetId: updated.id,
      afterSummary: { provider: updated.provider, credentialsUpdated: true },
    });
    return this.toDto(updated);
  }

  async getEditableConnection(
    actor: WorkspaceActor,
    id: string,
  ): Promise<WhatsappConnectionEditMetadataDto> {
    this.assertCanManage(actor);
    const existing = await this.findForWorkspace(actor.workspaceId, id);
    const config = this.decryptConfig(existing);
    return {
      id: existing.id,
      provider: this.requireProvider(existing.provider),
      name: existing.name,
      displayName: existing.displayName,
      baseUrl: this.extractConfigBaseUrl(config),
      // providerInstanceId now also carries the WAHA session (see
      // createConnection/editConnection), which belongs in the `session`
      // field below, not `instanceId` - the edit form never renders an
      // Instance ID input for waha, but the DTO contract still shouldn't
      // duplicate it there.
      instanceId:
        existing.provider === "waha"
          ? this.extractConfigInstanceId(config)
          : (existing.providerInstanceId ??
            this.extractConfigInstanceId(config)),
      session: this.extractConfigSession(config),
    };
  }

  async editConnection(
    actor: WorkspaceActor,
    id: string,
    input: WhatsappConnectionEditInputDto,
  ): Promise<WhatsappConnectionDto> {
    this.assertCanManage(actor);
    const existing = await this.findForWorkspace(actor.workspaceId, id);
    if (existing.provider !== input.provider) {
      throw new ConflictException(
        "O provider da conexão não pode ser alterado",
      );
    }
    const previousConfig = this.decryptConfig(existing);
    const credentials = this.mergeEditCredentials(input, previousConfig);
    const config = this.toProviderConfig(input.provider, credentials);
    const encrypted = this.encryptConfig(config);
    const providerInstanceId =
      input.provider === "uazapi_byo"
        ? (input.credentials.instanceId ?? existing.providerInstanceId)
        : this.deriveProviderInstanceId(input.provider, credentials);
    const updated = (await this.prisma.whatsappInstance.update({
      where: { id: existing.id },
      data: {
        name: input.name,
        displayName: input.displayName ?? null,
        ...encrypted,
        providerInstanceId,
      },
    })) as WhatsappConnectionRecord;
    await this.recordAudit({
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: "whatsapp_connection.edit",
      targetId: updated.id,
      beforeSummary: this.metadataSummary(existing),
      afterSummary: this.metadataSummary(updated),
    });
    return this.toDto(updated);
  }

  async deactivateConnection(actor: WorkspaceActor, id: string): Promise<void> {
    this.assertCanManage(actor);
    const existing = await this.findForWorkspace(actor.workspaceId, id);
    await this.prisma.whatsappInstance.update({
      where: { id: existing.id },
      data: { status: "suspended" },
    });
    await this.recordAudit({
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: "whatsapp_connection.delete",
      targetId: existing.id,
      beforeSummary: this.metadataSummary(existing),
      afterSummary: { ...this.metadataSummary(existing), status: "suspended" },
    });
  }

  async testConnection(
    actor: WorkspaceActor,
    id: string,
  ): Promise<WhatsappConnectionTestResultDto> {
    this.assertCanManage(actor);
    const connection = await this.findForWorkspace(actor.workspaceId, id);
    const checkedAt = new Date();
    let status = "error";
    let message: string | undefined;
    let providerStatus: string | undefined;
    let uazapiIdentity:
      | { providerInstanceId: string | null; connectedPhone: string | null }
      | undefined;

    try {
      const config = this.decryptConfig(connection);
      const health =
        connection.provider === "uazapi_byo" &&
        config?.provider === "uazapi_byo" &&
        this.uazapiByo
          ? await this.testUazapiConnection(config, (identity) => {
              uazapiIdentity = identity;
            })
          : await this.registry
              .require(this.requireProvider(connection.provider))
              .getHealth(config ?? undefined);
      status = health.status;
      message = health.message;
      providerStatus = health.providerStatus;
    } catch (error) {
      message =
        error instanceof Error
          ? error.message
          : "Erro ao testar conexão WhatsApp";
    }

    const providerInstanceId = uazapiIdentity?.providerInstanceId?.trim();
    const updated = await this.prisma.whatsappInstance.update({
      where: { id: connection.id },
      data: {
        lastHealthStatus: status,
        lastHealthCheckedAt: checkedAt,
        ...(providerInstanceId ? { providerInstanceId } : {}),
      },
    });
    if (
      status === "connected" &&
      uazapiIdentity?.connectedPhone?.trim() &&
      this.uazapiBridge
    ) {
      await this.uazapiBridge.ensureBridge({
        id: updated.id,
        workspaceId: connection.workspaceId,
        name: connection.name,
        providerInstanceId: providerInstanceId ?? connection.providerInstanceId,
        connectedPhone: uazapiIdentity.connectedPhone,
      });
    }
    // WAHA: a working session bridges the number right away, so it shows in
    // Conversões (phrase rules) and a "Todos os números" rule activates it
    // before the first team message. Best-effort: the receiver bridges it on
    // the first team message anyway.
    if (
      status === "connected" &&
      connection.provider === "waha" &&
      this.uazapiBridge
    ) {
      try {
        await this.uazapiBridge.ensureBridge(
          {
            id: updated.id,
            workspaceId: connection.workspaceId,
            name: connection.name,
            providerInstanceId: connection.providerInstanceId,
          },
          "waha",
        );
      } catch {
        // see above
      }
    }
    await this.recordAudit({
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: "whatsapp_connection.test",
      targetId: connection.id,
      afterSummary: { provider: connection.provider, healthStatus: status },
    });

    return {
      connectionId: updated.id,
      provider: this.requireProvider(connection.provider),
      status,
      checkedAt: checkedAt.toISOString(),
      ...(message ? { message: this.redactMessage(message) } : {}),
      ...(providerStatus && /^[A-Za-z_]{1,40}$/u.test(providerStatus)
        ? { providerStatus }
        : {}),
    };
  }

  /**
   * Fase 6.1c (porte do SaaS #63): leitura do status de uma conexão Uazapi
   * BYO ou WAHA para o alerta de desconexão, como ator de sistema. Só lê:
   * não grava saúde, auditoria nem ponte. Usa a API de status do próprio
   * provedor (Uazapi: status da instância; WAHA: sessão). Falha de leitura
   * lança o erro (o alerta nunca dispara por erro de leitura).
   */
  async readConnectionStatusForAlert(
    workspaceId: string,
    id: string,
  ): Promise<{
    provider: WhatsappProviderId;
    status: string;
    providerStatus: string | null;
  }> {
    const connection = await this.findForWorkspace(workspaceId, id);
    const provider = this.requireProvider(connection.provider);
    const config = this.decryptConfig(connection);
    if (!config) {
      return { provider, status: "error", providerStatus: null };
    }
    if (provider === "uazapi_byo" && config.provider === "uazapi_byo") {
      const result = this.uazapiByo
        ? await this.uazapiByo.testSavedConnection(config)
        : null;
      if (result) {
        return {
          provider,
          status: result.health.status,
          providerStatus: this.safeSessionStatus(
            result.providerStatusText ?? null,
          ),
        };
      }
    }
    const health = await this.registry.require(provider).getHealth(config);
    return {
      provider,
      status: health.status,
      providerStatus: this.safeSessionStatus(health.providerStatus ?? null),
    };
  }

  /**
   * WAHA (motor GoWS): configura o webhook da sessão direto na WAHA do
   * aluno. Gera um token novo, salva o webhook na WAHA (eventos message,
   * message.any e session.status, token no cabeçalho
   * X-Wpptrack-Webhook-Token) preservando o resto da configuração da
   * sessão, e só então grava o hash do token. Se a WAHA recusar, nada muda
   * no app: o token anterior continua valendo e a tela oferece o modo manual.
   * Nunca cria sessão nem pede QR.
   */
  async configureWebhook(
    actor: WorkspaceActor,
    id: string,
  ): Promise<WhatsappConnectionWebhookConfigureResultDto> {
    this.assertCanManage(actor);
    const existing = await this.findForWorkspace(actor.workspaceId, id);
    if (existing.provider !== "waha") {
      throw new BadRequestException(
        "A configuração automática do webhook está disponível só para a WAHA",
      );
    }
    const config = this.decryptConfig(existing);
    const session = this.requireWahaSession(
      this.extractConfigSession(config) ?? undefined,
    );
    const adapter = this.registry.require("waha");
    if (!config || !adapter.configureWebhook) {
      throw new BadRequestException(
        "Informe a URL do servidor, a API key e a sessão da WAHA",
      );
    }
    const webhookEndpoint = this.buildWebhookEndpoint(existing.id);
    const webhookToken = randomBytes(32).toString("base64url");
    let result: Awaited<
      ReturnType<NonNullable<typeof adapter.configureWebhook>>
    >;
    try {
      result = await adapter.configureWebhook(config, {
        url: webhookEndpoint,
        token: webhookToken,
      });
    } catch {
      result = {
        configured: false,
        reason: "unreachable",
        message: "Não foi possível falar com a WAHA. Confira a URL do servidor.",
      };
    }

    if (!result.configured) {
      await this.recordAudit({
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        action: "whatsapp_connection.webhook_configure_failed",
        targetId: existing.id,
        afterSummary: { provider: existing.provider, reason: result.reason },
      });
      return {
        connectionId: existing.id,
        provider: "waha",
        configured: false,
        webhookEndpoint,
        events: [...WAHA_GOWS_WEBHOOK_EVENTS],
        sessionStatus: this.safeSessionStatus(result.sessionStatus),
        reason: result.reason,
        message: this.redactMessage(result.message),
      };
    }

    const updated = (await this.prisma.whatsappInstance.update({
      where: { id: existing.id },
      data: {
        providerInstanceId: session,
        webhookTokenHash: createHash("sha256")
          .update(webhookToken, "utf8")
          .digest("hex"),
        webhookUrl: webhookEndpoint,
      },
    })) as WhatsappConnectionRecord;
    await this.recordAudit({
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: "whatsapp_connection.webhook_configured",
      targetId: updated.id,
      beforeSummary: this.metadataSummary(existing),
      afterSummary: {
        ...this.metadataSummary(updated),
        webhookTokenRotated: true,
        mode: "automatic",
      },
    });

    return {
      connectionId: updated.id,
      provider: "waha",
      configured: true,
      webhookEndpoint,
      events: [...WAHA_GOWS_WEBHOOK_EVENTS],
      sessionStatus: this.safeSessionStatus(result.sessionStatus),
    };
  }

  private safeSessionStatus(value: string | null | undefined): string | null {
    return value && /^[A-Za-z_]{1,40}$/u.test(value) ? value : null;
  }

  private async testUazapiConnection(
    config: Extract<WhatsappProviderConfig, { provider: "uazapi_byo" }>,
    setIdentity: (identity: {
      providerInstanceId: string | null;
      connectedPhone: string | null;
    }) => void,
  ) {
    const result = await this.uazapiByo?.testSavedConnection(config);
    if (!result) {
      return this.registry.require("uazapi_byo").getHealth(config);
    }
    setIdentity(result);
    return result.health;
  }

  async rotateWebhookToken(
    actor: WorkspaceActor,
    id: string,
  ): Promise<WhatsappConnectionWebhookTokenRotateResultDto> {
    this.assertCanManage(actor);
    const existing = await this.findForWorkspace(actor.workspaceId, id);
    const webhookToken = randomBytes(32).toString("base64url");
    const webhookEndpoint = this.buildWebhookEndpoint(existing.id);
    // WAHA connections created before providerInstanceId was bound to the
    // configured session can still hold the authoritative session in their
    // encrypted config. Repair that derived column only while an authorized
    // manager explicitly (re)configures the receiver; the public receiver
    // remains strictly bound to the persisted value.
    const providerInstanceId =
      existing.provider === "waha"
        ? this.requireWahaSession(
            this.extractConfigSession(this.decryptConfig(existing)) ??
              undefined,
          )
        : existing.providerInstanceId;
    const updated = (await this.prisma.whatsappInstance.update({
      where: { id: existing.id },
      data: {
        providerInstanceId,
        webhookTokenHash: createHash("sha256")
          .update(webhookToken, "utf8")
          .digest("hex"),
        webhookUrl: webhookEndpoint,
      },
    })) as WhatsappConnectionRecord;

    await this.recordAudit({
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: "whatsapp_connection.webhook_token_rotated",
      targetId: updated.id,
      beforeSummary: this.metadataSummary(existing),
      afterSummary: {
        ...this.metadataSummary(updated),
        webhookTokenRotated: true,
      },
    });

    return {
      connection: this.toDto(updated),
      webhookEndpoint,
      webhookToken,
      ...(existing.provider === "waha"
        ? {
            wahaManualSetup: {
              webhookUrl: webhookEndpoint,
              webhookUrlWithToken: this.withQueryToken(
                webhookEndpoint,
                webhookToken,
              ),
              events: [...WAHA_GOWS_WEBHOOK_EVENTS],
              tokenHeaderName: WAHA_WEBHOOK_TOKEN_HEADER,
            },
          }
        : {}),
    };
  }

  private withQueryToken(endpoint: string, token: string): string {
    const url = new URL(endpoint);
    url.searchParams.set("token", token);
    return url.toString();
  }

  private async findForWorkspace(
    workspaceId: string,
    id: string,
  ): Promise<WhatsappConnectionRecord> {
    const connection = (await this.prisma.whatsappInstance.findFirst({
      where: { id, workspaceId },
    })) as WhatsappConnectionRecord | null;
    if (!connection || !this.isProvider(connection.provider))
      throw new NotFoundException("Conexão WhatsApp não encontrada");
    return connection;
  }

  private toProviderConfig(
    provider: WhatsappProviderId,
    credentials: WhatsappConnectionCredentials,
  ): WhatsappProviderConfig {
    const config = (() => {
      switch (provider) {
        case "uazapi_byo":
          return {
            provider,
            config: credentials as {
              baseUrl: string;
              token: string;
              instanceId?: string;
            },
          };
        case "waha":
          return {
            provider,
            config: credentials as {
              baseUrl: string;
              apiKey: string;
              session?: string;
            },
          };
        case "zapi":
          return {
            provider,
            config: credentials as {
              baseUrl: string;
              instanceId: string;
              token: string;
            },
          };
        case "nod_api":
          return {
            provider,
            config: {
              enabled: true,
              ...(credentials as {
                instanceId?: string;
                instanceToken?: string;
              }),
            },
          };
      }
    })();

    if (
      (config.provider === "uazapi_byo" ||
        config.provider === "waha" ||
        config.provider === "zapi") &&
      !normalizeProviderBaseUrl(config.config.baseUrl)
    ) {
      throw new BadRequestException("URL base do provider WhatsApp inválida");
    }

    return config;
  }

  private encryptConfig(
    config: WhatsappProviderConfig,
  ): Pick<
    WhatsappConnectionRecord,
    "configEncrypted" | "configIv" | "configTag"
  > {
    const encrypted = this.encryption.encrypt(JSON.stringify(config));
    return {
      configEncrypted: encrypted.encryptedAccessToken,
      configIv: encrypted.tokenIv,
      configTag: encrypted.tokenTag,
    };
  }

  private decryptConfig(
    connection: WhatsappConnectionRecord,
  ): WhatsappProviderConfig | null {
    if (
      !connection.configEncrypted &&
      !connection.configIv &&
      !connection.configTag
    ) {
      return null;
    }
    if (
      !connection.configEncrypted ||
      !connection.configIv ||
      !connection.configTag
    ) {
      throw new BadRequestException(
        "Configuração cifrada da conexão está incompleta",
      );
    }
    const value = JSON.parse(
      this.encryption.decrypt({
        encryptedAccessToken: connection.configEncrypted,
        tokenIv: connection.configIv,
        tokenTag: connection.configTag,
      }),
    ) as WhatsappProviderConfig;
    if (
      !this.isProvider(value.provider) ||
      value.provider !== connection.provider
    ) {
      throw new BadRequestException(
        "Configuração cifrada da conexão é inválida",
      );
    }
    return value;
  }

  // Merges the edit payload's non-secret fields with the previously stored
  // secret when the payload omits it — "campo secreto vazio = manter
  // atual; preenchido = substituir". Throws if there is no secret to fall
  // back to (a connection must always have one after create).
  private mergeEditCredentials(
    input: WhatsappConnectionEditInputDto,
    previous: WhatsappProviderConfig | null,
  ): AdapterWhatsappConnectionCreateInput["credentials"] {
    switch (input.provider) {
      case "uazapi_byo": {
        const prevConfig =
          previous?.provider === "uazapi_byo" ? previous.config : undefined;
        const token = input.credentials.token ?? prevConfig?.token;
        if (!token) {
          throw new BadRequestException(
            "Token da conexão WhatsApp é obrigatório",
          );
        }
        return {
          baseUrl: input.credentials.baseUrl,
          token,
          instanceId: input.credentials.instanceId,
        };
      }
      case "waha": {
        const prevConfig =
          previous?.provider === "waha" ? previous.config : undefined;
        const apiKey = input.credentials.apiKey ?? prevConfig?.apiKey;
        if (!apiKey) {
          throw new BadRequestException(
            "API key da conexão WhatsApp é obrigatória",
          );
        }
        return {
          baseUrl: input.credentials.baseUrl,
          apiKey,
          session: this.requireWahaSession(input.credentials.session),
        };
      }
      case "zapi": {
        const prevConfig =
          previous?.provider === "zapi" ? previous.config : undefined;
        const token = input.credentials.token ?? prevConfig?.token;
        if (!token) {
          throw new BadRequestException(
            "Token da conexão WhatsApp é obrigatório",
          );
        }
        return {
          baseUrl: input.credentials.baseUrl,
          instanceId: input.credentials.instanceId,
          token,
        };
      }
      case "nod_api": {
        const prevConfig =
          previous?.provider === "nod_api" ? previous.config : undefined;
        const instanceToken =
          input.credentials.instanceToken ?? prevConfig?.instanceToken;
        if (!instanceToken) {
          throw new BadRequestException(
            "Instance token da conexão WhatsApp é obrigatório",
          );
        }
        return {
          instanceId: input.credentials.instanceId,
          instanceToken,
        };
      }
    }
  }

  // Single source of truth for deriving the plaintext providerInstanceId
  // column from per-provider credentials, applied consistently across
  // createConnection/updateCredentials/editConnection. Only waha/zapi/nod_api
  // are handled here — each has a mandatory identifier and a missing one is
  // rejected rather than silently persisted as null/empty. Uazapi is
  // intentionally out of scope: its instanceId stays optional and is derived
  // inline by each caller, unchanged.
  private deriveProviderInstanceId(
    provider: "waha" | "zapi" | "nod_api",
    credentials: { instanceId?: string; session?: string } | undefined,
  ): string {
    switch (provider) {
      case "waha":
        return this.requireWahaSession(credentials?.session);
      case "zapi":
        return this.requireProviderIdentifier(credentials?.instanceId, "Z-API");
      case "nod_api":
        return this.requireProviderIdentifier(
          credentials?.instanceId,
          "NOD API",
        );
    }
  }

  // WAHA webhook deliveries are bound to the connection's persisted
  // providerInstanceId (see webhooks.controller.ts's
  // assertProviderInstanceBinding): the receiver rejects any payload whose
  // top-level `session` doesn't match it, and fails closed outright when
  // providerInstanceId hasn't been configured. A WAHA connection must
  // therefore always be created/edited with a session, or its webhook
  // endpoint would be unreachable (401) forever.
  private requireWahaSession(session: string | undefined): string {
    const trimmed = session?.trim();
    if (!trimmed) {
      throw new BadRequestException(
        "Sessão da conexão WhatsApp (WAHA) é obrigatória",
      );
    }
    return trimmed;
  }

  // Same fail-closed contract as requireWahaSession, generalized for
  // Z-API/NOD API's instanceId: webhook receiver binding (Z-API) and future
  // provisioning (NOD API) both depend on providerInstanceId being a real,
  // non-blank value.
  private requireProviderIdentifier(
    value: string | undefined,
    label: string,
  ): string {
    const trimmed = value?.trim();
    if (!trimmed) {
      throw new BadRequestException(
        `Instance ID da conexão WhatsApp (${label}) é obrigatório`,
      );
    }
    return trimmed;
  }

  private extractConfigBaseUrl(
    config: WhatsappProviderConfig | null,
  ): string | null {
    if (!config) return null;
    if (
      config.provider === "uazapi_byo" ||
      config.provider === "waha" ||
      config.provider === "zapi"
    ) {
      return config.config.baseUrl ?? null;
    }
    return null;
  }

  private extractConfigInstanceId(
    config: WhatsappProviderConfig | null,
  ): string | null {
    if (!config) return null;
    if (
      config.provider === "uazapi_byo" ||
      config.provider === "zapi" ||
      config.provider === "nod_api"
    ) {
      return config.config.instanceId ?? null;
    }
    return null;
  }

  private extractConfigSession(
    config: WhatsappProviderConfig | null,
  ): string | null {
    if (!config || config.provider !== "waha") return null;
    return config.config.session ?? null;
  }

  private toDto(connection: WhatsappConnectionRecord): WhatsappConnectionDto {
    return {
      id: connection.id,
      name: connection.name,
      displayName: connection.displayName,
      provider: this.requireProvider(connection.provider),
      status: connection.status,
      lastHealthStatus: connection.lastHealthStatus,
      lastHealthCheckedAt:
        connection.lastHealthCheckedAt?.toISOString() ?? null,
      connectedPhone: null,
      createdAt: connection.createdAt.toISOString(),
    };
  }

  private buildWebhookEndpoint(connectionId: string): string {
    const apiPublicUrl = this.env.API_PUBLIC_URL?.trim();
    if (!apiPublicUrl) {
      throw new BadRequestException(
        "API_PUBLIC_URL precisa estar configurada para gerar o webhook",
      );
    }

    let base: URL;
    try {
      base = new URL(apiPublicUrl);
    } catch {
      throw new BadRequestException("API_PUBLIC_URL inválida");
    }

    if (base.protocol !== "http:" && base.protocol !== "https:") {
      throw new BadRequestException("API_PUBLIC_URL deve usar http ou https");
    }

    return new URL(
      `/webhooks/whatsapp/${encodeURIComponent(connectionId)}`,
      base,
    ).toString();
  }

  private assertCanManage(actor: WorkspaceActor): void {
    if (
      !this.accessPolicy.getPermissions(actor.role, actor.canManageMembers)
        .canManageIntegrations
    ) {
      throw new NotFoundException("Conexão WhatsApp não encontrada");
    }
  }

  private requireProvider(provider: string): WhatsappProviderId {
    if (!this.isProvider(provider)) {
      throw new NotFoundException("Conexão WhatsApp não encontrada");
    }
    return provider;
  }

  private isProvider(provider: string): provider is WhatsappProviderId {
    return (PROVIDERS as readonly string[]).includes(provider);
  }
  private metadataSummary(
    connection: WhatsappConnectionRecord,
  ): Record<string, unknown> {
    return {
      name: connection.name,
      displayName: connection.displayName,
      provider: connection.provider,
      status: connection.status,
      webhookConfigured: Boolean(connection.webhookUrl),
    };
  }
  private redactMessage(message: string): string {
    return message
      .replace(
        /(token|api[-_ ]?key|authorization)\s*[:=]\s*[^\s,]+/gi,
        "$1=[redacted]",
      )
      .slice(0, 500);
  }
  private async recordAudit(input: {
    workspaceId: string;
    actorUserId: string;
    action: string;
    targetId: string;
    beforeSummary?: Record<string, unknown>;
    afterSummary: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          actorType: "user",
          action: input.action,
          targetType: "WhatsappInstance",
          targetId: input.targetId,
          reason: null,
          sourceIp: null,
          resultStatus: "success",
          ...(input.beforeSummary
            ? { beforeSummary: input.beforeSummary as Prisma.InputJsonValue }
            : {}),
          afterSummary: input.afterSummary as Prisma.InputJsonValue,
        },
      });
    } catch {
      /* audit must not reveal credentials or break onboarding */
    }
  }
}
