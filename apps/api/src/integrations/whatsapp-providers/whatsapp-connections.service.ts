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
      adapterInput.provider === "nod_api"
        ? (adapterInput.credentials?.instanceId ?? null)
        : null;
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
    const updated = (await this.prisma.whatsappInstance.update({
      where: { id: existing.id },
      data: {
        ...encrypted,
        providerInstanceId:
          input.provider === "uazapi_byo"
            ? (input.credentials.instanceId ?? null)
            : input.provider === "zapi" || input.provider === "nod_api"
              ? input.credentials.instanceId
              : existing.providerInstanceId,
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
            ...(credentials as { instanceId?: string; instanceToken?: string }),
          },
        };
    }
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
