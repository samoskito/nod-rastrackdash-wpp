import {
  BadGatewayException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { GhlPipelineOptionsDto } from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { InboundWebhookPayloadEncryptionService } from "./inbound-webhook-payload-encryption.service";
import {
  GhlApiError,
  GhlPipelinesAdapter,
  type GhlPipeline,
} from "./providers/gohighlevel/gohighlevel-pipelines.adapter";

const TOKEN_CONTEXT = "gohighlevel-token-v1";
/** Current stage names per connection: short cache so a call never waits on GHL twice. */
export const GHL_STAGE_CACHE_TTL_MS = 10 * 60 * 1_000;
/** A failed or token-less lookup is retried sooner. */
export const GHL_STAGE_CACHE_FAILURE_TTL_MS = 60 * 1_000;
const connectionNotFound = "Conexao GoHighLevel nao encontrada";

const errorMessages: Record<GhlApiError["code"], string> = {
  ghl_unauthorized:
    "O GoHighLevel recusou o token. Gere um novo em Configurações → Private Integrations e salve de novo.",
  ghl_forbidden:
    "O token não tem permissão para ler oportunidades. Marque o escopo de leitura de oportunidades (opportunities.readonly).",
  ghl_rate_limited:
    "O GoHighLevel pediu uma pausa. Tente recarregar em alguns instantes.",
  ghl_transport:
    "Não deu para falar com o GoHighLevel agora. Tente recarregar em instantes.",
  ghl_invalid_response:
    "O GoHighLevel respondeu num formato inesperado. Tente recarregar em instantes.",
};

/**
 * GoHighLevel connection (one per location): the optional Private Integration
 * Token (read scope, encrypted at rest) that lets the rule screen list the
 * location's pipelines and stages. Without it the rule simply has no stage
 * filter. The token never leaves this class: the API only says whether it is
 * configured.
 */
@Injectable()
export class GoHighLevelPipelinesService {
  private readonly stageCache = new Map<
    string,
    { at: number; ttl: number; pipelines: GhlPipeline[] | null }
  >();
  /** Test seam for the cache clock. */
  now: () => number = Date.now;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(InboundWebhookPayloadEncryptionService)
    private readonly encryption: InboundWebhookPayloadEncryptionService,
    @Inject(GhlPipelinesAdapter) private readonly adapter: GhlPipelinesAdapter,
  ) {}

  private async requireConnection(workspaceId: string, connectionId: string) {
    const connection = await this.prisma.inboundWebhookConnection.findFirst({
      where: {
        id: connectionId,
        workspaceId,
        provider: "gohighlevel",
        removedAt: null,
      },
      select: {
        id: true,
        workspaceId: true,
        ghlTokenCiphertext: true,
        ghlTokenIv: true,
        ghlTokenTag: true,
        ghlTokenKeyVersion: true,
      },
    });
    if (!connection) throw new NotFoundException(connectionNotFound);
    return connection;
  }

  async saveToken(
    workspaceId: string,
    connectionId: string,
    token: string | null,
  ): Promise<{ tokenConfigured: boolean }> {
    const connection = await this.requireConnection(workspaceId, connectionId);
    const data = token
      ? (() => {
          const encrypted = this.encryption.encrypt(
            Buffer.from(token, "utf8"),
            {
              workspaceId,
              connectionId: TOKEN_CONTEXT,
              deliveryId: connection.id,
            },
          );
          return {
            ghlTokenCiphertext: encrypted.encryptedPayload,
            ghlTokenIv: encrypted.payloadIv,
            ghlTokenTag: encrypted.payloadTag,
            ghlTokenKeyVersion: encrypted.encryptionKeyVersion,
          };
        })()
      : {
          ghlTokenCiphertext: null,
          ghlTokenIv: null,
          ghlTokenTag: null,
          ghlTokenKeyVersion: null,
        };
    await this.prisma.inboundWebhookConnection.update({
      where: { id: connection.id },
      data,
    });
    return { tokenConfigured: token !== null };
  }

  async listPipelines(
    workspaceId: string,
    connectionId: string,
  ): Promise<GhlPipelineOptionsDto> {
    const connection = await this.requireConnection(workspaceId, connectionId);
    const token = this.decryptToken(connection);
    if (!token) return { tokenConfigured: false, pipelines: [] };
    const channel = await this.prisma.inboundWebhookChannel.findFirst({
      where: { workspaceId, connectionId: connection.id },
      select: { providerChannelId: true },
      orderBy: { createdAt: "asc" },
    });
    if (!channel) throw new NotFoundException(connectionNotFound);
    try {
      const pipelines = await this.adapter.listPipelines(
        channel.providerChannelId,
        token,
      );
      return { tokenConfigured: true, pipelines };
    } catch (error) {
      const code =
        error instanceof GhlApiError ? error.code : "ghl_transport";
      throw new BadGatewayException({ code, message: errorMessages[code] });
    }
  }

  /**
   * Refreshes the connection's pipelines/stages cache (10 min; 1 min after a
   * failure or without a token). Never throws: a call is never held back by
   * this lookup.
   */
  async warmStageNames(
    workspaceId: string,
    connectionId: string,
  ): Promise<void> {
    const cached = this.stageCache.get(connectionId);
    if (cached && this.now() - cached.at < cached.ttl) return;
    try {
      const connection = await this.requireConnection(workspaceId, connectionId);
      const token = this.decryptToken(connection);
      const channel = token
        ? await this.prisma.inboundWebhookChannel.findFirst({
            where: { workspaceId, connectionId: connection.id },
            select: { providerChannelId: true },
            orderBy: { createdAt: "asc" },
          })
        : null;
      if (!token || !channel) {
        this.stageCache.set(connectionId, {
          at: this.now(),
          ttl: GHL_STAGE_CACHE_FAILURE_TTL_MS,
          pipelines: null,
        });
        return;
      }
      const pipelines = await this.adapter.listPipelines(
        channel.providerChannelId,
        token,
      );
      this.stageCache.set(connectionId, {
        at: this.now(),
        ttl: GHL_STAGE_CACHE_TTL_MS,
        pipelines,
      });
    } catch {
      this.stageCache.set(connectionId, {
        at: this.now(),
        ttl: GHL_STAGE_CACHE_FAILURE_TTL_MS,
        pipelines: null,
      });
    }
  }

  /**
   * Current name of a saved stage (by id) from the cache; null without a
   * usable cache (no token, API failure, stage gone): the caller then uses
   * the stage name saved with the rule.
   */
  peekStageName(
    connectionId: string,
    pipelineId: string,
    stageId: string,
  ): string | null {
    const pipelines = this.stageCache.get(connectionId)?.pipelines;
    const pipeline = pipelines?.find((item) => item.id === pipelineId);
    return pipeline?.stages.find((stage) => stage.id === stageId)?.name ?? null;
  }

  private decryptToken(connection: {
    id: string;
    workspaceId: string;
    ghlTokenCiphertext: string | null;
    ghlTokenIv: string | null;
    ghlTokenTag: string | null;
    ghlTokenKeyVersion: number | null;
  }): string | null {
    if (
      !connection.ghlTokenCiphertext ||
      !connection.ghlTokenIv ||
      !connection.ghlTokenTag ||
      connection.ghlTokenKeyVersion === null
    ) {
      return null;
    }
    try {
      return this.encryption
        .decrypt(
          {
            encryptedPayload: connection.ghlTokenCiphertext,
            payloadIv: connection.ghlTokenIv,
            payloadTag: connection.ghlTokenTag,
            encryptionKeyVersion: connection.ghlTokenKeyVersion,
          },
          {
            workspaceId: connection.workspaceId,
            connectionId: TOKEN_CONTEXT,
            deliveryId: connection.id,
          },
        )
        .toString("utf8");
    } catch {
      return null;
    }
  }
}
