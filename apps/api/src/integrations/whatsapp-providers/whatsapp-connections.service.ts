import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import type { Prisma, WorkspaceRole } from "@prisma/client";
import type {
  WhatsappConnectionCreateInputDto,
  WhatsappConnectionCredentialsUpdateDto,
  WhatsappConnectionDto,
  WhatsappConnectionEditInputDto,
  WhatsappConnectionEditMetadataDto,
  WhatsappConnectionTestResultDto,
  WhatsappConnectionWebhookTokenRotateResultDto,
  WhatsappConnectionUpdateInputDto,
} from "@wpptrack/shared";
import { PrismaService } from "../../common/prisma/prisma.service";
import type { IntegrationEnv } from "../integration.types";
import { INTEGRATION_ENV } from "../integration.types";
import { MetaTokenEncryptionService } from "../meta/meta-token-encryption.service";
import { WorkspaceAccessPolicyService } from "../../workspaces/workspace-access-policy.service";
import { WhatsappProviderRegistry } from "./whatsapp-provider.registry";
import type {
  WhatsappProviderConfig,
  WhatsappProviderId,
} from "./whatsapp-provider.types";
import { normalizeProviderBaseUrl } from "./whatsapp-provider-http";

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
  ) {}

  async listConnections(workspaceId: string): Promise<WhatsappConnectionDto[]> {
    const connections = (await this.prisma.whatsappInstance.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
    })) as WhatsappConnectionRecord[];
    return connections
      .filter((connection) => this.isProvider(connection.provider))
      .map((connection) => this.toDto(connection));
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
        "O provider da conexao nao pode ser alterado",
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
        ? (input.credentials.instanceId ?? null)
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
          : (existing.providerInstanceId ?? this.extractConfigInstanceId(config)),
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
        "O provider da conexao nao pode ser alterado",
      );
    }
    const previousConfig = this.decryptConfig(existing);
    const credentials = this.mergeEditCredentials(input, previousConfig);
    const config = this.toProviderConfig(input.provider, credentials);
    const encrypted = this.encryptConfig(config);
    const providerInstanceId =
      input.provider === "uazapi_byo"
        ? (input.credentials.instanceId ?? null)
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

    try {
      const config = this.decryptConfig(connection);
      const adapter = this.registry.require(
        this.requireProvider(connection.provider),
      );
      const health = await adapter.getHealth(config ?? undefined);
      status = health.status;
      message = health.message;
    } catch (error) {
      message =
        error instanceof Error
          ? error.message
          : "Erro ao testar conexao WhatsApp";
    }

    const updated = await this.prisma.whatsappInstance.update({
      where: { id: connection.id },
      data: { lastHealthStatus: status, lastHealthCheckedAt: checkedAt },
    });
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
    };
  }

  async rotateWebhookToken(
    actor: WorkspaceActor,
    id: string,
  ): Promise<WhatsappConnectionWebhookTokenRotateResultDto> {
    this.assertCanManage(actor);
    const existing = await this.findForWorkspace(actor.workspaceId, id);
    const webhookToken = randomBytes(32).toString("base64url");
    const webhookEndpoint = this.buildWebhookEndpoint(existing.id);
    const updated = (await this.prisma.whatsappInstance.update({
      where: { id: existing.id },
      data: {
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
    };
  }

  private async findForWorkspace(
    workspaceId: string,
    id: string,
  ): Promise<WhatsappConnectionRecord> {
    const connection = (await this.prisma.whatsappInstance.findFirst({
      where: { id, workspaceId },
    })) as WhatsappConnectionRecord | null;
    if (!connection || !this.isProvider(connection.provider))
      throw new NotFoundException("Conexao WhatsApp nao encontrada");
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
      throw new BadRequestException("URL base do provider WhatsApp invalida");
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
        "Configuracao cifrada da conexao esta incompleta",
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
        "Configuracao cifrada da conexao e invalida",
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
            "Token da conexao WhatsApp e obrigatorio",
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
            "API key da conexao WhatsApp e obrigatoria",
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
            "Token da conexao WhatsApp e obrigatorio",
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
            "Instance token da conexao WhatsApp e obrigatorio",
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
        "Sessao da conexao WhatsApp (WAHA) e obrigatoria",
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
        `Instance ID da conexao WhatsApp (${label}) e obrigatorio`,
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
      throw new BadRequestException("API_PUBLIC_URL invalida");
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
      throw new NotFoundException("Conexao WhatsApp nao encontrada");
    }
  }

  private requireProvider(provider: string): WhatsappProviderId {
    if (!this.isProvider(provider)) {
      throw new NotFoundException("Conexao WhatsApp nao encontrada");
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
