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
  leadFetchErrorText,
  leadFetchFailureKind,
  MetaLeadFormGraphClient,
  MetaLeadFormGraphError,
  storedLeadFetchFailureKind,
  type LeadFetchFailureKind,
} from "./meta-lead-form-graph.client";
import {
  leadContact,
  routeLeadForm,
  type GraphLead,
  type LeadgenChange,
} from "./meta-leadgen";

export const META_LEAD_FORM_SOURCE = "meta_lead_form";

export const META_LEAD_FORM_DELETE_BLOCKED_MESSAGE =
  "Esta Página já recebeu formulários. Desative a conexão para parar de receber; o histórico fica guardado.";

type Env = Record<string, string | undefined>;

type ConnectionRecord = Prisma.MetaLeadFormConnectionGetPayload<object>;

export type LeadgenIngestResult = {
  received: number;
  saved: number;
  duplicates: number;
  unrouted: number;
  /** Passageiras (rede, 5xx, limite de uso): o webhook responde 503. */
  fetchFailed: number;
  /**
   * Permanentes (token morto, falta de permissão, lead ilegível): gravadas
   * como fetch_failed, o webhook responde 200 e a tela da conexão avisa.
   */
  fetchFailedPermanent?: number;
};

/** Aviso da tela da conexão depois de uma leitura que falhou de vez. */
export type MetaLeadFormFetchProblem = "reconnect" | "permission";

/**
 * Releitura dos leads que falharam (1.3.1): a Meta não reenvia um lead
 * respondido com 200, então depois de trocar o token (ou assinar a Página de
 * novo) os fetch_failed recentes da conexão são lidos de novo pelo leadgen_id.
 * A Meta guarda os leads por 90 dias; 7 dias acompanham o prazo do envio à
 * Meta e o aviso da tela.
 */
export const LEAD_REFETCH_WINDOW_DAYS = 7;
/** Leads por rodada: cada leitura leva até 8 s na Graph. */
export const LEAD_REFETCH_BATCH = 25;
/** Tempo máximo de uma rodada (a tela espera a resposta). */
const LEAD_REFETCH_BUDGET_MS = 25_000;

export type MetaLeadFormRefetchResult = {
  /** Leituras tentadas nesta rodada. */
  attempted: number;
  /** Leads lidos e gravados (o lead aparece em Leads). */
  recovered: number;
  /** Continuam sem leitura (o motivo fica no recebimento). */
  failed: number;
  /** Ainda com falha de leitura nos últimos 7 dias, depois desta rodada. */
  remaining: number;
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
    const latest = connections.length
      ? await this.prisma.metaLeadSubmission.findMany({
          where: {
            workspaceId,
            connectionId: { in: connections.map((item) => item.id) },
          },
          distinct: ["connectionId"],
          orderBy: [{ connectionId: "asc" }, { updatedAt: "desc" }],
          select: {
            connectionId: true,
            fetchStatus: true,
            fetchError: true,
            updatedAt: true,
          },
        })
      : [];
    const latestById = new Map(latest.map((item) => [item.connectionId, item]));
    const pending = connections.length
      ? await this.prisma.metaLeadSubmission.groupBy({
          by: ["connectionId"],
          where: {
            workspaceId,
            fetchStatus: "fetch_failed",
            createdAt: { gte: refetchWindowStart() },
          },
          _count: { _all: true },
        })
      : [];
    const pendingById = new Map(
      pending.map((item) => [item.connectionId, item._count._all]),
    );

    return connections.map((connection) =>
      this.toDto(
        connection,
        statsById.get(connection.id),
        metaLeadFormFetchProblem(connection, latestById.get(connection.id)),
        pendingById.get(connection.id) ?? 0,
      ),
    );
  }

  async createConnection(
    workspaceId: string,
    userId: string,
    input: MetaLeadFormConnectionCreateInputDto,
  ): Promise<MetaLeadFormConnectionDto> {
    // A lead id is unique in the installation: one Page answers to one
    // workspace only, or its leads would be unroutable (ambiguous).
    const elsewhere = await this.prisma.metaLeadFormConnection.findFirst({
      where: { pageId: input.pageId, workspaceId: { not: workspaceId } },
      select: { id: true },
    });
    if (elsewhere) {
      throw new ConflictException(
        "Esta Página já está conectada em outro workspace desta instalação",
      );
    }
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
          graphTokenUpdatedAt: new Date(),
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
          "Esta Página já tem uma conexão de formulários neste workspace",
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
              graphTokenUpdatedAt: new Date(),
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

    // Token novo: os leads que falharam por token morto ficam presos (a Meta
    // não reenvia), então são lidos de novo agora.
    if (graph) await this.refetchAfterTokenChange(connection);

    return this.toDto(connection);
  }

  /**
   * Removes only a connection that never received a form submission. With
   * submissions the history must stay: the answer is 409 and the way out is
   * to deactivate. The check and the delete are one statement, so a lead
   * arriving in between is never cascaded away.
   */
  async deleteConnection(workspaceId: string, connectionId: string) {
    await this.requireConnection(workspaceId, connectionId);
    const deleted = await this.prisma.metaLeadFormConnection.deleteMany({
      where: { id: connectionId, workspaceId, submissions: { none: {} } },
    });
    if (deleted.count === 0) {
      throw new ConflictException(META_LEAD_FORM_DELETE_BLOCKED_MESSAGE);
    }
  }

  /**
   * Deactivated: the Page stops receiving leads (the webhook answers 2xx and
   * ignores them) and every submission stays. The Page stays reserved for
   * this workspace, so reactivating never conflicts with another workspace.
   */
  async setConnectionActive(
    workspaceId: string,
    connectionId: string,
    active: boolean,
  ): Promise<MetaLeadFormConnectionDto> {
    await this.requireConnection(workspaceId, connectionId);
    const connection = await this.prisma.metaLeadFormConnection.update({
      where: { id: connectionId },
      data: { active },
    });
    const [stats] = await this.prisma.metaLeadSubmission.groupBy({
      by: ["connectionId"],
      where: { workspaceId, connectionId },
      _count: { _all: true },
      _max: { createdAt: true },
    });

    return this.toDto(connection, stats);
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
          ? `A Meta recusou a assinatura da Página: ${error.message}`
          : "Falha de comunicação com a Meta",
      );
    }

    const updated = await this.prisma.metaLeadFormConnection.update({
      where: { id: connection.id },
      data: { pageSubscribedAt: new Date() },
    });
    // A assinatura confirmou que o token abre a Página: relê os leads que
    // ficaram sem leitura.
    await this.refetchAfterTokenChange(updated);

    return this.toDto(updated);
  }

  /**
   * "Ler de novo": relê pelo leadgen_id os leads desta conexão que falharam
   * na leitura nos últimos 7 dias (até 25 por clique). Idempotente: grava no
   * mesmo recebimento (metaLeadId único) e junta ao mesmo lead pelo telefone.
   */
  async refetchFailedSubmissions(
    workspaceId: string,
    connectionId: string,
  ): Promise<MetaLeadFormRefetchResult> {
    const connection = await this.requireConnection(workspaceId, connectionId);
    if (!connection.active) {
      throw new ConflictException(
        "Conexão desativada: reative para ler os leads de novo",
      );
    }
    return this.retryFailedReads(connection);
  }

  /** Nunca derruba o salvamento: a falha fica no log e o botão continua. */
  private async refetchAfterTokenChange(connection: ConnectionRecord) {
    if (!connection.active) return;
    try {
      const result = await this.retryFailedReads(connection);
      if (result.attempted > 0) {
        this.logger.log(
          `releitura de formulários conexao=${connection.id} tentados=${result.attempted} lidos=${result.recovered} faltam=${result.remaining}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `releitura de formulários conexao=${connection.id} falhou: ${
          error instanceof Error ? error.constructor.name : typeof error
        }`,
      );
    }
  }

  /**
   * Relê os fetch_failed recentes da conexão, os menos tentados primeiro
   * (updatedAt), para um lead ilegível não segurar os outros. Para no
   * primeiro erro que vale para todos (token, permissão, limite, rede).
   */
  private async retryFailedReads(
    connection: ConnectionRecord,
  ): Promise<MetaLeadFormRefetchResult> {
    const where = {
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      fetchStatus: "fetch_failed",
      createdAt: { gte: refetchWindowStart() },
    } satisfies Prisma.MetaLeadSubmissionWhereInput;
    const pending = await this.prisma.metaLeadSubmission.findMany({
      where,
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: LEAD_REFETCH_BATCH,
      select: {
        metaLeadId: true,
        pageId: true,
        formId: true,
        adId: true,
        adSetId: true,
        metaCreatedAt: true,
      },
    });
    const result: MetaLeadFormRefetchResult = {
      attempted: 0,
      recovered: 0,
      failed: 0,
      remaining: 0,
    };
    const startedAt = Date.now();

    for (const item of pending) {
      if (Date.now() - startedAt > LEAD_REFETCH_BUDGET_MS) break;
      // Lido no meio do caminho (outro clique): não lê de novo.
      const current = await this.prisma.metaLeadSubmission.findUnique({
        where: { metaLeadId: item.metaLeadId },
        select: { fetchStatus: true },
      });
      if (current?.fetchStatus !== "fetch_failed") continue;

      result.attempted++;
      const outcome = await this.saveSubmission(connection, {
        leadgen_id: item.metaLeadId,
        page_id: item.pageId,
        ...(item.formId ? { form_id: item.formId } : {}),
        ...(item.adId ? { ad_id: item.adId } : {}),
        ...(item.adSetId ? { adgroup_id: item.adSetId } : {}),
        ...(item.metaCreatedAt
          ? { created_time: Math.floor(item.metaCreatedAt.getTime() / 1000) }
          : {}),
      });
      if (outcome === "saved") {
        result.recovered++;
        continue;
      }
      result.failed++;
      // Só "permanent" é do próprio lead; o resto falharia igual nos outros.
      if (outcome !== "permanent") break;
    }

    result.remaining = await this.prisma.metaLeadSubmission.count({ where });
    return result;
  }

  /** True when an active connection exists for one of these Pages. */
  async hasActiveConnectionForPages(pageIds: string[]): Promise<boolean> {
    return (await this.activeConnectionPages(pageIds)).size > 0;
  }

  /** Pages (of these) whose connection is deactivated: their leads are ignored. */
  async inactiveConnectionPages(
    pageIds: string[],
    workspaceId?: string,
  ): Promise<Set<string>> {
    if (pageIds.length === 0) return new Set();
    const found = await this.prisma.metaLeadFormConnection.findMany({
      where: {
        pageId: { in: pageIds },
        active: false,
        ...(workspaceId ? { workspaceId } : {}),
      },
      select: { pageId: true },
    });
    return new Set(found.map((row) => row.pageId));
  }

  /** Pages (of these) with an active connection, optionally in one workspace. */
  async activeConnectionPages(
    pageIds: string[],
    workspaceId?: string,
  ): Promise<Set<string>> {
    if (pageIds.length === 0) return new Set();
    const found = await this.prisma.metaLeadFormConnection.findMany({
      where: {
        pageId: { in: pageIds },
        active: true,
        ...(workspaceId ? { workspaceId } : {}),
      },
      select: { pageId: true },
    });
    return new Set(found.map((row) => row.pageId));
  }

  /**
   * Saves each announced submission (signature already verified). A Graph
   * read failure is kept as fetch_failed and retried on the next delivery of
   * the same lead. Only a transient one (network, 5xx, usage limit) counts in
   * fetchFailed, so the webhook answers 503 and Meta redelivers; a permanent
   * one (dead token, missing permission) counts in fetchFailedPermanent: the
   * webhook answers 200 and the connection screen asks to reconnect. A
   * database failure throws so Meta redelivers the batch.
   */
  async ingestLeadgen(
    changes: LeadgenChange[],
    options: { workspaceId?: string } = {},
  ): Promise<LeadgenIngestResult> {
    const result: LeadgenIngestResult = {
      received: changes.length,
      saved: 0,
      duplicates: 0,
      unrouted: 0,
      fetchFailed: 0,
      fetchFailedPermanent: 0,
    };
    const pageIds = Array.from(new Set(changes.map((change) => change.page_id)));
    const connections = await this.prisma.metaLeadFormConnection.findMany({
      where: {
        pageId: { in: pageIds },
        active: true,
        ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      },
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
          `leadgen não roteado (${route.reason}) pagina=${change.page_id} form=${change.form_id ?? "-"}`,
        );
        continue;
      }

      const outcome = await this.saveSubmission(route.connection, change);
      if (outcome === "saved") result.saved++;
      else if (outcome === "transient") result.fetchFailed++;
      else result.fetchFailedPermanent = (result.fetchFailedPermanent ?? 0) + 1;
    }

    return result;
  }

  private async saveSubmission(
    connection: ConnectionRecord,
    change: LeadgenChange,
  ): Promise<"saved" | LeadFetchFailureKind> {
    let lead: GraphLead | null = null;
    let fetchError: string | null = null;
    let failure: LeadFetchFailureKind | null = null;

    let token: string | null = null;
    try {
      token = this.graphToken(connection);
    } catch {
      // The stored token no longer opens (encryption key changed): only
      // saving the token again fixes it, redelivering never does.
      failure = "reconnect";
      fetchError = leadFetchErrorText(failure, "Token salvo ilegível");
    }
    if (token !== null) {
      try {
        lead = await this.graph.fetchLead(change.leadgen_id, token);
      } catch (error) {
        failure = leadFetchFailureKind(error);
        fetchError = leadFetchErrorText(
          failure,
          error instanceof Error ? error.message : "Falha na Graph API",
        );
      }
    }
    if (failure) {
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

    if (!lead) {
      // Uma falha nunca apaga uma leitura que deu certo em paralelo (dois
      // "Ler de novo", token novo junto com o webhook): só regrava quem
      // ainda está fetch_failed.
      const current = await this.prisma.metaLeadSubmission.findUnique({
        where: { metaLeadId: change.leadgen_id },
        select: { fetchStatus: true },
      });
      if (current) {
        await this.prisma.metaLeadSubmission.updateMany({
          where: { metaLeadId: change.leadgen_id, fetchStatus: "fetch_failed" },
          data,
        });
        return failure ?? "transient";
      }
    }

    await this.prisma.metaLeadSubmission.upsert({
      where: { metaLeadId: change.leadgen_id },
      create: { metaLeadId: change.leadgen_id, ...data },
      update: data,
    });

    return lead ? "saved" : (failure ?? "transient");
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
      throw new NotFoundException("Conexão de formulários não encontrada");
    }
    return connection;
  }

  private webhookUrl(): string {
    const base = (this.env.API_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
    return `${base || "<URL pública da API>"}/webhooks/meta`;
  }

  private toDto(
    connection: ConnectionRecord,
    stats?: { _count: { _all: number }; _max: { createdAt: Date | null } },
    fetchProblem: MetaLeadFormFetchProblem | null = null,
    pendingFetchCount?: number,
  ): MetaLeadFormConnectionDto {
    return {
      fetchProblem,
      ...(pendingFetchCount !== undefined ? { pendingFetchCount } : {}),
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

/** Início da janela de releitura (7 dias). */
export function refetchWindowStart(now = new Date()): Date {
  return new Date(now.getTime() - LEAD_REFETCH_WINDOW_DAYS * 24 * 60 * 60_000);
}

/**
 * The latest submission of the Page failed for good (dead token or missing
 * permission) after the Graph token was last saved: the screen asks to
 * reconnect the Page or grant the permission. Saving a new token or a later
 * lead read successfully clears it; editing the label or reactivating does
 * not (1.3.1: compared with graphTokenUpdatedAt, not updatedAt).
 */
export function metaLeadFormFetchProblem(
  connection: { graphTokenUpdatedAt?: Date | null; createdAt: Date },
  latest:
    | { fetchStatus: string; fetchError: string | null; updatedAt: Date }
    | undefined,
): MetaLeadFormFetchProblem | null {
  if (!latest || latest.fetchStatus !== "fetch_failed") return null;
  const tokenSavedAt = connection.graphTokenUpdatedAt ?? connection.createdAt;
  if (latest.updatedAt < tokenSavedAt) return null;
  const kind = storedLeadFetchFailureKind(latest.fetchError);
  return kind === "reconnect" || kind === "permission" ? kind : null;
}
