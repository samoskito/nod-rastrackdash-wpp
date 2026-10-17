import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  MetaLeadFormConnectionCreateInputDto,
  MetaLeadFormConnectionDto,
  MetaLeadFormConnectionUpdateInputDto,
} from "@wpptrack/shared";
import { createHash } from "node:crypto";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  hashPhoneIdentity,
  hashPhoneIdentityVariants,
} from "../common/phone/phone-identity";
import { INTEGRATION_ENV } from "../integrations/integration.types";
import { MetaTokenEncryptionService } from "../integrations/meta/meta-token-encryption.service";
import { LeadsService } from "../leads/leads.service";
import {
  MetaLeadFormGraphClient,
  MetaLeadFormGraphError,
} from "./meta-lead-form-graph.client";
import {
  leadContact,
  routeLeadForm,
  type GraphLead,
  type LeadgenChange,
} from "./meta-leadgen";

export const META_LEAD_FORM_SOURCE = "meta_lead_form";

type Env = Record<string, string | undefined>;

type ConnectionRecord = Prisma.MetaLeadFormConnectionGetPayload<object>;

export type LeadgenIngestResult = {
  received: number;
  saved: number;
  duplicates: number;
  unrouted: number;
  fetchFailed: number;
};

function last4(token: string): string {
  return token.slice(-4);
}

@Injectable()
export class MetaLeadFormsService {
  private readonly logger = new Logger(MetaLeadFormsService.name);
  private readonly graph: MetaLeadFormGraphClient;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MetaTokenEncryptionService)
    private readonly encryption: MetaTokenEncryptionService,
    @Inject(LeadsService) private readonly leads: LeadsService,
    @Inject(INTEGRATION_ENV) private readonly env: Env = process.env,
    @Optional() graph?: MetaLeadFormGraphClient,
  ) {
    this.graph = graph ?? new MetaLeadFormGraphClient(env);
  }

  async listConnections(
    workspaceId: string,
  ): Promise<MetaLeadFormConnectionDto[]> {
    const connections = await this.prisma.metaLeadFormConnection.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
    });
    const stats = connections.length
      ? await this.prisma.metaLeadSubmission.groupBy({
          by: ["connectionId"],
          where: { workspaceId },
          _count: { _all: true },
          _max: { createdAt: true },
        })
      : [];
    const statsById = new Map(stats.map((item) => [item.connectionId, item]));

    return connections.map((connection) =>
      this.toDto(connection, statsById.get(connection.id)),
    );
  }

  async createConnection(
    workspaceId: string,
    userId: string,
    input: MetaLeadFormConnectionCreateInputDto,
  ): Promise<MetaLeadFormConnectionDto> {
    const graph = this.encryption.encrypt(input.graphToken);
    const capi = input.capiToken ? this.encryption.encrypt(input.capiToken) : null;

    try {
      const connection = await this.prisma.metaLeadFormConnection.create({
        data: {
          workspaceId,
          label: input.label,
          pageId: input.pageId,
          formIds: Array.from(new Set(input.formIds)),
          crmDatasetId: input.crmDatasetId ?? null,
          qualifiedEventName: input.qualifiedEventName,
          graphTokenEncrypted: graph.encryptedAccessToken,
          graphTokenIv: graph.tokenIv,
          graphTokenTag: graph.tokenTag,
          graphTokenLast4: last4(input.graphToken),
          capiTokenEncrypted: capi?.encryptedAccessToken ?? null,
          capiTokenIv: capi?.tokenIv ?? null,
          capiTokenTag: capi?.tokenTag ?? null,
          capiTokenLast4: input.capiToken ? last4(input.capiToken) : null,
          createdByUserId: userId,
        },
      });

      return this.toDto(connection);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException(
          "Esta Pagina ja tem uma conexao de formularios neste workspace",
        );
      }
      throw error;
    }
  }

  async updateConnection(
    workspaceId: string,
    connectionId: string,
    input: MetaLeadFormConnectionUpdateInputDto,
  ): Promise<MetaLeadFormConnectionDto> {
    await this.requireConnection(workspaceId, connectionId);
    const graph = input.graphToken
      ? this.encryption.encrypt(input.graphToken)
      : null;
    const capi = input.capiToken ? this.encryption.encrypt(input.capiToken) : null;

    const connection = await this.prisma.metaLeadFormConnection.update({
      where: { id: connectionId },
      data: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.formIds !== undefined
          ? { formIds: Array.from(new Set(input.formIds)) }
          : {}),
        ...(input.crmDatasetId !== undefined
          ? { crmDatasetId: input.crmDatasetId }
          : {}),
        ...(input.qualifiedEventName !== undefined
          ? { qualifiedEventName: input.qualifiedEventName }
          : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(graph && input.graphToken
          ? {
              graphTokenEncrypted: graph.encryptedAccessToken,
              graphTokenIv: graph.tokenIv,
              graphTokenTag: graph.tokenTag,
              graphTokenLast4: last4(input.graphToken),
            }
          : {}),
        ...(input.capiToken === null
          ? {
              capiTokenEncrypted: null,
              capiTokenIv: null,
              capiTokenTag: null,
              capiTokenLast4: null,
            }
          : capi && input.capiToken
            ? {
                capiTokenEncrypted: capi.encryptedAccessToken,
                capiTokenIv: capi.tokenIv,
                capiTokenTag: capi.tokenTag,
                capiTokenLast4: last4(input.capiToken),
              }
            : {}),
      },
    });

    return this.toDto(connection);
  }

  async deleteConnection(workspaceId: string, connectionId: string) {
    await this.requireConnection(workspaceId, connectionId);
    await this.prisma.metaLeadFormConnection.delete({
      where: { id: connectionId },
    });
  }

  /** Subscribes the app to the Page "leadgen" webhook field. */
  async subscribePage(
    workspaceId: string,
    connectionId: string,
  ): Promise<MetaLeadFormConnectionDto> {
    const connection = await this.requireConnection(workspaceId, connectionId);

    try {
      await this.graph.subscribePage(
        connection.pageId,
        this.graphToken(connection),
      );
    } catch (error) {
      throw new BadGatewayException(
        error instanceof MetaLeadFormGraphError
          ? `A Meta recusou a assinatura da Pagina: ${error.message}`
          : "Falha de comunicacao com a Meta",
      );
    }

    const updated = await this.prisma.metaLeadFormConnection.update({
      where: { id: connection.id },
      data: { pageSubscribedAt: new Date() },
    });

    return this.toDto(updated);
  }

  /** True when an active connection exists for one of these Pages. */
  async hasActiveConnectionForPages(pageIds: string[]): Promise<boolean> {
    if (pageIds.length === 0) return false;
    const found = await this.prisma.metaLeadFormConnection.findFirst({
      where: { pageId: { in: pageIds }, active: true },
      select: { id: true },
    });
    return Boolean(found);
  }

  /**
   * Saves each announced submission (signature already verified). A Graph
   * read failure is kept as fetch_failed and retried on the next delivery of
   * the same lead; a database failure throws so Meta redelivers the batch.
   */
  async ingestLeadgen(changes: LeadgenChange[]): Promise<LeadgenIngestResult> {
    const result: LeadgenIngestResult = {
      received: changes.length,
      saved: 0,
      duplicates: 0,
      unrouted: 0,
      fetchFailed: 0,
    };
    const pageIds = Array.from(new Set(changes.map((change) => change.page_id)));
    const connections = await this.prisma.metaLeadFormConnection.findMany({
      where: { pageId: { in: pageIds }, active: true },
    });

    for (const change of changes) {
      const existing = await this.prisma.metaLeadSubmission.findUnique({
        where: { metaLeadId: change.leadgen_id },
        select: { fetchStatus: true },
      });
      if (existing && existing.fetchStatus !== "fetch_failed") {
        result.duplicates++;
        continue;
      }

      const route = routeLeadForm(connections, change.page_id, change.form_id);
      if (!route.connection) {
        result.unrouted++;
        this.logger.warn(
          `leadgen nao roteado (${route.reason}) pagina=${change.page_id} form=${change.form_id ?? "-"}`,
        );
        continue;
      }

      const outcome = await this.saveSubmission(route.connection, change);
      if (outcome === "fetch_failed") result.fetchFailed++;
      else result.saved++;
    }

    return result;
  }

  private async saveSubmission(
    connection: ConnectionRecord,
    change: LeadgenChange,
  ): Promise<"saved" | "fetch_failed"> {
    let lead: GraphLead | null = null;
    let fetchError: string | null = null;

    try {
      lead = await this.graph.fetchLead(
        change.leadgen_id,
        this.graphToken(connection),
      );
    } catch (error) {
      fetchError =
        error instanceof Error ? error.message.slice(0, 300) : "Falha na Graph API";
      this.logger.error(
        `leadgen ${change.leadgen_id}: leitura na Graph API falhou: ${fetchError}`,
      );
    }

    const contact = lead
      ? leadContact(lead)
      : { fullName: null, email: null, phone: null };
    const campaignId = lead?.campaign_id ?? null;
    const adSetId = lead?.adset_id ?? change.adgroup_id ?? null;
    const adId = lead?.ad_id ?? change.ad_id ?? null;
    const createdAt = lead?.created_time
      ? new Date(lead.created_time)
      : change.created_time
        ? new Date(change.created_time * 1000)
        : null;
    const leadId = lead
      ? await this.upsertPerson(connection.workspaceId, {
          metaLeadId: change.leadgen_id,
          ...contact,
          campaignId,
          adSetId,
          adId,
        })
      : null;
    const data = {
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      leadId,
      pageId: change.page_id,
      formId: lead?.form_id ?? change.form_id ?? null,
      campaignId,
      adSetId,
      adId,
      fullName: contact.fullName,
      email: contact.email,
      phone: contact.phone,
      fieldData: lead?.field_data
        ? (lead.field_data as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      metaCreatedAt:
        createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
      fetchStatus: lead ? "fetched" : "fetch_failed",
      fetchError,
    };

    await this.prisma.metaLeadSubmission.upsert({
      where: { metaLeadId: change.leadgen_id },
      create: { metaLeadId: change.leadgen_id, ...data },
      update: data,
    });

    return lead ? "saved" : "fetch_failed";
  }

  /**
   * One Lead per person: a form filled by someone who already talks on
   * WhatsApp joins that Lead (any Brazilian 9th-digit variant of the phone)
   * and keeps its WhatsApp attribution and source.
   */
  private async upsertPerson(
    workspaceId: string,
    input: {
      metaLeadId: string;
      fullName: string | null;
      phone: string | null;
      campaignId: string | null;
      adSetId: string | null;
      adId: string | null;
    },
  ): Promise<string | null> {
    const variants = input.phone ? hashPhoneIdentityVariants([input.phone]) : [];
    const existing = variants.length
      ? await this.prisma.lead.findFirst({
          where: { workspaceId, phoneHash: { in: variants } },
          select: { id: true, phoneHash: true },
          orderBy: { createdAt: "asc" },
        })
      : null;
    // Without a usable phone the submission still needs a stable identity.
    const phoneHash =
      existing?.phoneHash ??
      hashPhoneIdentity(input.phone ?? undefined) ??
      createHash("sha256").update(`meta_lead:${input.metaLeadId}`).digest("hex");

    const lead = await this.leads.upsertFromWhatsappWebhook({
      workspaceId,
      name: input.fullName ?? undefined,
      phone: existing || !hashPhoneIdentity(input.phone ?? undefined)
        ? undefined
        : (input.phone ?? undefined),
      phoneHash,
      source: META_LEAD_FORM_SOURCE,
      recordMessageTimestamps: false,
      preserveExistingSource: true,
      preserveExistingName: true,
      ...(existing
        ? {}
        : {
            campaignId: input.campaignId ?? undefined,
            adSetId: input.adSetId ?? undefined,
            adId: input.adId ?? undefined,
          }),
    });

    return lead?.id ?? null;
  }

  graphToken(connection: ConnectionRecord): string {
    return this.encryption.decrypt({
      encryptedAccessToken: connection.graphTokenEncrypted,
      tokenIv: connection.graphTokenIv,
      tokenTag: connection.graphTokenTag,
    });
  }

  private async requireConnection(
    workspaceId: string,
    connectionId: string,
  ): Promise<ConnectionRecord> {
    const connection = await this.prisma.metaLeadFormConnection.findFirst({
      where: { id: connectionId, workspaceId },
    });
    if (!connection) {
      throw new NotFoundException("Conexao de formularios nao encontrada");
    }
    return connection;
  }

  private webhookUrl(): string {
    const base = (this.env.API_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
    return `${base || "<API_PUBLIC_URL>"}/webhooks/meta`;
  }

  private toDto(
    connection: ConnectionRecord,
    stats?: { _count: { _all: number }; _max: { createdAt: Date | null } },
  ): MetaLeadFormConnectionDto {
    return {
      id: connection.id,
      label: connection.label,
      pageId: connection.pageId,
      formIds: connection.formIds,
      crmDatasetId: connection.crmDatasetId,
      qualifiedEventName: connection.qualifiedEventName,
      graphTokenLast4: connection.graphTokenLast4,
      capiTokenLast4: connection.capiTokenLast4,
      active: connection.active,
      pageSubscribedAt: connection.pageSubscribedAt?.toISOString() ?? null,
      webhookUrl: this.webhookUrl(),
      submissionCount: stats?._count._all ?? 0,
      lastSubmissionAt: stats?._max.createdAt?.toISOString() ?? null,
      createdAt: connection.createdAt.toISOString(),
      updatedAt: connection.updatedAt.toISOString(),
    };
  }
}
