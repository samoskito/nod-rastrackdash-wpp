import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import {
  CRM_BASE_STAGE_EVENT,
  CRM_COLUMN_PAGE_SIZE,
  CRM_CONVERSATIONS_COLUMN_KEY,
  CRM_CONVERSATIONS_COLUMN_LABEL,
  CRM_DEFAULT_PERIOD_DAYS,
  CRM_INVALID_TARGET_MESSAGE,
  CRM_BOARD_CACHE_TTL_MS,
  CRM_MAX_PERIOD_DAYS,
  CRM_MAX_PERIOD_MESSAGE,
  crmPeriodDays,
  CRM_MOVE_ERROR_CODES,
  conversionEventDisplayLabel,
  conversionEventNameSchema,
  conversionEventValuePolicy,
  crmMoveCheck,
  type ConversionEventNameDto,
  type CrmBoardDto,
  type CrmBoardQueryDto,
  type CrmColumnDto,
  type CrmColumnPageDto,
  type CrmColumnQueryDto,
  type CrmLeadCardDto,
  type FunnelStageConfigurationDto,
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { FunnelConfigurationService } from "../conversion-rules/funnel-configuration.service";
import { dateRangeInTimezone } from "../external-data/external-event-policy";
import {
  firstContactScopeCorrections,
  resolveRuleOverrideReportMode,
  withFirstContactAttribution,
} from "../leads/lead-cohort";
import {
  CRM_BASE_RANK,
  CRM_CONVERSATIONS_RANK,
  crmBoardSql,
  crmColumnSql,
  crmLeadStageSql,
  decodeCrmCursor,
  encodeCrmCursor,
  type CrmPlacedRow,
  type CrmPlacementInput,
  type CrmStageRank,
} from "./crm-board-query";

const CRM_TIMEZONE = "America/Sao_Paulo";
/** Board query slower than this is logged as a warning. */
export const CRM_BOARD_SLOW_QUERY_MS = 2_000;

/**
 * nod: http(s) URL or null (same rule as the lead detail). The SaaS also drops
 * expired signed Meta CDN URLs and serves stored thumbnails (Fase 6.4, not
 * ported yet), so the card shows the empty thumbnail when the URL expired.
 */
function publicHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** A column of the board without its cards (layout of the Jornada). */
export type CrmColumnLayout = Omit<CrmColumnDto, "total" | "cards" | "nextCursor">;

type CrmLayout = {
  journeyConfigured: boolean;
  columns: CrmColumnLayout[];
  stages: CrmStageRank[];
};

type CrmResolvedRange = { since: string; until: string; gte: Date; lte: Date };

type CardLeadRow = {
  id: string;
  name: string | null;
  phoneDisplay: string | null;
  campaignId: string | null;
  adSetId: string | null;
  adId: string | null;
  ctwaThumbnailUrl: string | null;
  whatsappInstanceId: string | null;
};

type BoardRow = CrmPlacedRow & { total?: number; afterCursor?: number };

/** "YYYY-MM-DD" of `date` in the reporting timezone. */
export function crmCalendarDate(date: Date, timezone = CRM_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function shiftCalendarDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days))
    .toISOString()
    .slice(0, 10);
}

/** Period of lead arrival: default the last 30 days (design §3). */
export function resolveCrmRange(
  query: Pick<CrmBoardQueryDto, "since" | "until">,
  now: Date = new Date(),
): CrmResolvedRange {
  const until = query.until ?? crmCalendarDate(now);
  const since =
    query.since ?? shiftCalendarDate(until, -(CRM_DEFAULT_PERIOD_DAYS - 1));
  const span = crmPeriodDays(since, until);
  if (!Number.isFinite(span) || span < 1)
    throw new BadRequestException("O início do período é depois do fim.");
  if (span > CRM_MAX_PERIOD_DAYS)
    throw new BadRequestException(CRM_MAX_PERIOD_MESSAGE);
  const range = dateRangeInTimezone(since, until, CRM_TIMEZONE);
  return { since, until, gte: range.gte!, lte: range.lte! };
}

/**
 * Columns of the board from the Jornada (design §1): the base stage
 * (LeadSubmitted, "Leads novos") first, then every other visible stage in the
 * Jornada order; in the rule override mode "Conversas iniciadas" before them.
 */
export function crmLayoutFromJourney(
  stages: FunnelStageConfigurationDto[],
  ruleOverride: boolean,
): CrmLayout {
  const visible = stages.filter((stage) => stage.visible);
  if (visible.length === 0)
    return { journeyConfigured: false, columns: [], stages: [] };
  const base = stages.find((stage) => stage.eventName === CRM_BASE_STAGE_EVENT);
  const ordered: Array<
    Pick<
      FunnelStageConfigurationDto,
      | "eventName"
      | "label"
      | "defaultValueCents"
      | "defaultCurrency"
      | "defaultContentName"
    >
  > = [
    base ?? {
      eventName: CRM_BASE_STAGE_EVENT,
      label: conversionEventDisplayLabel(CRM_BASE_STAGE_EVENT),
    },
    ...visible.filter((stage) => stage.eventName !== CRM_BASE_STAGE_EVENT),
  ];
  const columns: CrmColumnLayout[] = ordered.map((stage, index) => ({
    key: stage.eventName,
    kind: "stage" as const,
    eventName: stage.eventName,
    label: stage.label,
    rank: CRM_BASE_RANK + index,
    readOnly: false,
    requiresValue: conversionEventValuePolicy(stage.eventName) === "required",
    defaultValueCents: stage.defaultValueCents ?? null,
    defaultCurrency: stage.defaultCurrency ?? null,
    defaultContentName: stage.defaultContentName ?? null,
  }));
  if (ruleOverride)
    columns.unshift({
      key: CRM_CONVERSATIONS_COLUMN_KEY,
      kind: "conversations",
      eventName: null,
      label: CRM_CONVERSATIONS_COLUMN_LABEL,
      rank: CRM_CONVERSATIONS_RANK,
      readOnly: true,
      requiresValue: false,
      defaultValueCents: null,
      defaultCurrency: null,
      defaultContentName: null,
    });
  return {
    journeyConfigured: true,
    columns,
    stages: columns.flatMap((column) =>
      column.eventName ? [{ eventName: column.eventName, rank: column.rank }] : [],
    ),
  };
}

@Injectable()
export class CrmBoardService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FunnelConfigurationService)
    private readonly funnel: FunnelConfigurationService,
    @Optional()
    @Inject(RUNTIME_ENV)
    private readonly env: RuntimeEnv = process.env,
  ) {}

  private readonly logger = new Logger(CrmBoardService.name);
  /**
   * Short cache of the board (design §11 mitigation): the 60 s auto-refresh
   * of several open tabs/users of a workspace hits the aggregated query at
   * most once per CRM_BOARD_CACHE_TTL_MS per filter set. User-independent
   * (canMoveCards is applied per request); this instance only; dropped when
   * a manual conversion of the workspace is created/canceled here.
   */
  private readonly cache = new Map<
    string,
    { expiresAt: number; board: Omit<CrmBoardDto, "canMoveCards"> }
  >();
  private static readonly CACHE_MAX_ENTRIES = 500;

  /** Drops every cached board of the workspace (manual conversion here). */
  invalidateWorkspace(workspaceId: string): void {
    const prefix = `${workspaceId}\u0000`;
    for (const key of this.cache.keys())
      if (key.startsWith(prefix)) this.cache.delete(key);
  }

  async getBoard(
    workspaceId: string,
    query: CrmBoardQueryDto,
    access: { canMoveCards: boolean },
    now: Date = new Date(),
  ): Promise<CrmBoardDto> {
    const range = resolveCrmRange(query, now);
    const key = [
      workspaceId,
      range.since,
      range.until,
      query.whatsappInstanceId ?? "",
      query.campaignId ?? "",
    ].join("\u0000");
    const bypass = query.fresh === "1" || query.fresh === "true";
    const cached = this.cache.get(key);
    if (!bypass && cached && cached.expiresAt > now.getTime())
      return { ...cached.board, canMoveCards: access.canMoveCards };
    const board = await this.buildBoard(workspaceId, query, range, now);
    if (this.cache.size >= CrmBoardService.CACHE_MAX_ENTRIES)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, {
      expiresAt: now.getTime() + CRM_BOARD_CACHE_TTL_MS,
      board,
    });
    return { ...board, canMoveCards: access.canMoveCards };
  }

  private async buildBoard(
    workspaceId: string,
    query: CrmBoardQueryDto,
    range: CrmResolvedRange,
    now: Date,
  ): Promise<Omit<CrmBoardDto, "canMoveCards">> {
    const ruleOverride = await resolveRuleOverrideReportMode(
      this.prisma,
      workspaceId,
      range,
      this.env,
    );
    const [layout, instances] = await Promise.all([
      this.layout(workspaceId, ruleOverride),
      this.instances(workspaceId),
    ]);
    const base = {
      mode: ruleOverride ? ("rule_override" as const) : ("default" as const),
      range: { since: range.since, until: range.until },
      showWhatsappNumber: this.showWhatsappNumber(instances),
      generatedAt: now.toISOString(),
    };
    if (!layout.journeyConfigured)
      return { ...base, journeyConfigured: false, columns: [] };

    const input = await this.placementInput(
      workspaceId,
      query,
      layout,
      ruleOverride,
      range,
    );
    const startedAt = Date.now();
    const rows = input
      ? await this.prisma.$queryRaw<BoardRow[]>(
          crmBoardSql(input, CRM_COLUMN_PAGE_SIZE + 1),
        )
      : [];
    this.logQuery(workspaceId, rows, Date.now() - startedAt, layout, query);
    const cards = await this.hydrateCards(
      workspaceId,
      rows,
      layout,
      instances,
      ruleOverride,
    );
    return {
      ...base,
      journeyConfigured: true,
      columns: layout.columns.map((column) => {
        const columnRows = rows.filter((row) => row.stageRank === column.rank);
        const page = columnRows.slice(0, CRM_COLUMN_PAGE_SIZE);
        const last = page[page.length - 1];
        return {
          ...column,
          total: Number(columnRows[0]?.total ?? 0),
          cards: page.flatMap((row) => {
            const card = cards.get(row.leadId);
            return card ? [card] : [];
          }),
          nextCursor:
            columnRows.length > CRM_COLUMN_PAGE_SIZE && last
              ? encodeCrmCursor(last)
              : null,
        };
      }),
    };
  }

  /**
   * Structured log of the aggregated query (no PII: ids, counts, duration).
   * Warns past CRM_BOARD_SLOW_QUERY_MS.
   */
  private logQuery(
    workspaceId: string,
    rows: BoardRow[],
    durationMs: number,
    layout: CrmLayout,
    query: CrmBoardQueryDto,
  ): void {
    const leadCount = layout.columns.reduce((sum, column) => {
      const row = rows.find((candidate) => Number(candidate.stageRank) === column.rank);
      return sum + Number(row?.total ?? 0);
    }, 0);
    const entry = JSON.stringify({
      event: "crm_board_query",
      workspaceId,
      durationMs,
      leadCount,
      columns: layout.columns.length,
      rows: rows.length,
      filtered: Boolean(query.whatsappInstanceId || query.campaignId),
    });
    if (durationMs > CRM_BOARD_SLOW_QUERY_MS) this.logger.warn(entry);
    else this.logger.log(entry);
  }

  /** "Carregar mais" of one column (cursor pagination, design §4). */
  async getColumnPage(
    workspaceId: string,
    stageKey: string,
    query: CrmColumnQueryDto,
    now: Date = new Date(),
  ): Promise<CrmColumnPageDto> {
    const range = resolveCrmRange(query, now);
    const cursor = query.cursor ? decodeCrmCursor(query.cursor) : null;
    if (query.cursor && !cursor)
      throw new BadRequestException("Cursor inválido");
    const ruleOverride = await resolveRuleOverrideReportMode(
      this.prisma,
      workspaceId,
      range,
      this.env,
    );
    const [layout, instances] = await Promise.all([
      this.layout(workspaceId, ruleOverride),
      this.instances(workspaceId),
    ]);
    const column = layout.columns.find((candidate) => candidate.key === stageKey);
    if (!column) throw new NotFoundException("Coluna não encontrada");
    const input = await this.placementInput(
      workspaceId,
      query,
      layout,
      ruleOverride,
      range,
    );
    const rows = input
      ? await this.prisma.$queryRaw<BoardRow[]>(
          crmColumnSql(input, column.rank, cursor, CRM_COLUMN_PAGE_SIZE + 1),
        )
      : [];
    const page = rows.slice(0, CRM_COLUMN_PAGE_SIZE);
    const cards = await this.hydrateCards(
      workspaceId,
      page,
      layout,
      instances,
      ruleOverride,
    );
    const last = page[page.length - 1];
    const afterCursor = Number(rows[0]?.afterCursor ?? 0);
    return {
      key: column.key,
      cards: page.flatMap((row) => {
        const card = cards.get(row.leadId);
        return card ? [card] : [];
      }),
      nextCursor: rows.length > CRM_COLUMN_PAGE_SIZE && last ? encodeCrmCursor(last) : null,
      remaining: Math.max(0, afterCursor - page.length),
    };
  }

  /**
   * Forward-only rule at the API (design §9/§12): a manual conversion with
   * source "kanban" must target a stage of the board after the lead's
   * current column. Uses the same placement query, filtered by the lead.
   */
  async assertKanbanMove(
    workspaceId: string,
    leadId: string,
    eventName: ConversionEventNameDto,
  ): Promise<{ fromRank: number; toRank: number; skipped: number }> {
    const ruleOverride = await resolveRuleOverrideReportMode(
      this.prisma,
      workspaceId,
      null,
      this.env,
    );
    const layout = await this.layout(workspaceId, ruleOverride);
    const target = layout.columns.find(
      (column) => column.kind === "stage" && column.eventName === eventName,
    );
    if (!target)
      throw new ConflictException({
        message: CRM_INVALID_TARGET_MESSAGE,
        code: CRM_MOVE_ERROR_CODES.invalidTarget,
      });
    const rows = await this.prisma.$queryRaw<CrmPlacedRow[]>(
      crmLeadStageSql({
        workspaceId,
        stages: layout.stages,
        ruleOverride,
        range: null,
        leadId,
        ctwaOnly: false,
      }),
    );
    if (!rows[0]) throw new NotFoundException("Lead não encontrado");
    const fromRank = Number(rows[0].stageRank);
    const check = crmMoveCheck({ rank: fromRank }, target);
    if (!check.ok)
      throw new ConflictException({
        message: check.message,
        code:
          check.reason === "backward"
            ? CRM_MOVE_ERROR_CODES.backward
            : check.reason === "same"
              ? CRM_MOVE_ERROR_CODES.sameStage
              : CRM_MOVE_ERROR_CODES.invalidTarget,
      });
    return { fromRank, toRank: target.rank, skipped: check.skipped };
  }

  private async layout(
    workspaceId: string,
    ruleOverride: boolean,
  ): Promise<CrmLayout> {
    const { stages } = await this.funnel.getConfiguration(workspaceId);
    return crmLayoutFromJourney(
      stages.filter(
        (stage) => conversionEventNameSchema.safeParse(stage.eventName).success,
      ),
      ruleOverride,
    );
  }

  /** null: the filters can match nobody (no query issued). */
  private async placementInput(
    workspaceId: string,
    query: CrmBoardQueryDto,
    layout: CrmLayout,
    ruleOverride: boolean,
    range: CrmResolvedRange,
  ): Promise<CrmPlacementInput | null> {
    // Campaign = first-contact attribution, like the Leads page and reports.
    const campaign = query.campaignId
      ? await firstContactScopeCorrections(
          this.prisma,
          workspaceId,
          "campaignId",
          query.campaignId,
          { ruleOverride },
        )
      : null;
    return {
      workspaceId,
      stages: layout.stages,
      ruleOverride,
      range: { gte: range.gte, lte: range.lte },
      whatsappInstanceId: query.whatsappInstanceId ?? null,
      campaign:
        query.campaignId && campaign
          ? {
              campaignId: query.campaignId,
              excludeIds: campaign.movedAway,
              includeIds: campaign.movedIn,
            }
          : null,
      ctwaOnly: true,
    };
  }

  private async instances(
    workspaceId: string,
  ): Promise<Array<{ id: string; name: string; status: string }>> {
    return (await this.prisma.whatsappInstance.findMany({
      where: { workspaceId },
      select: { id: true, name: true, status: true },
      orderBy: { createdAt: "asc" },
    })) as Array<{ id: string; name: string; status: string }>;
  }

  private showWhatsappNumber(instances: Array<{ status: string }>): boolean {
    return instances.filter((instance) => instance.status === "active").length > 1;
  }

  /** Card data of at most (page size + 1) x columns leads. */
  private async hydrateCards(
    workspaceId: string,
    rows: CrmPlacedRow[],
    layout: CrmLayout,
    instances: Array<{ id: string; name: string }>,
    ruleOverride: boolean,
  ): Promise<Map<string, CrmLeadCardDto>> {
    const ids = [...new Set(rows.map((row) => row.leadId))];
    if (ids.length === 0) return new Map();
    const rowLeads = (await this.prisma.lead.findMany({
      where: { workspaceId, id: { in: ids } },
      select: {
        id: true,
        name: true,
        phoneDisplay: true,
        campaignId: true,
        adSetId: true,
        adId: true,
        ctwaThumbnailUrl: true,
        whatsappInstanceId: true,
      },
    })) as CardLeadRow[];
    const leads = await withFirstContactAttribution(
      this.prisma,
      workspaceId,
      rowLeads,
      { ruleOverride },
    );
    const adIds = [
      ...new Set(leads.flatMap((lead) => (lead.adId ? [lead.adId] : []))),
    ];
    const ads = adIds.length
      ? ((await this.prisma.metaAd.findMany({
          where: { workspaceId, adId: { in: adIds } },
          select: {
            adId: true,
            campaignId: true,
            name: true,
            creativeId: true,
            thumbnailUrl: true,
          },
        })) as Array<{
          adId: string;
          campaignId: string;
          name: string | null;
          creativeId: string | null;
          thumbnailUrl: string | null;
        }>)
      : [];
    const adById = new Map(ads.map((ad) => [ad.adId, ad]));
    const campaignIds = [
      ...new Set(
        leads.flatMap((lead) => {
          const id = (lead.adId && adById.get(lead.adId)?.campaignId) || lead.campaignId;
          return id ? [id] : [];
        }),
      ),
    ];
    const campaigns = campaignIds.length
      ? ((await this.prisma.metaCampaign.findMany({
          where: { workspaceId, campaignId: { in: campaignIds } },
          select: { campaignId: true, name: true },
        })) as Array<{ campaignId: string; name: string }>)
      : [];
    const campaignName = new Map(campaigns.map((c) => [c.campaignId, c.name]));
    const instanceById = new Map(instances.map((i) => [i.id, i]));
    const leadById = new Map(leads.map((lead) => [lead.id, lead]));
    const valueRanks = new Set(
      layout.columns.filter((c) => c.requiresValue).map((c) => c.rank),
    );
    const cards = new Map<string, CrmLeadCardDto>();
    for (const row of rows) {
      const lead = leadById.get(row.leadId);
      if (!lead) continue;
      const ad = lead.adId ? adById.get(lead.adId) : undefined;
      const campaignId = ad?.campaignId ?? lead.campaignId;
      const instance = lead.whatsappInstanceId
        ? instanceById.get(lead.whatsappInstanceId)
        : undefined;
      const withValue = valueRanks.has(Number(row.stageRank));
      cards.set(row.leadId, {
        leadId: lead.id,
        name: lead.name?.trim() || null,
        phoneDisplay: lead.phoneDisplay?.trim() || null,
        origin: "ctwa",
        // Empty strings never reach the strict board schema (min(1)): one
        // bad row must not break the whole board.
        campaignId: campaignId || null,
        campaignName: campaignId
          ? campaignName.get(campaignId)?.trim() || null
          : null,
        adId: lead.adId || null,
        adName: ad?.name?.trim() || null,
        creative: {
          thumbnailUrl:
            publicHttpUrl(lead.ctwaThumbnailUrl) ??
            publicHttpUrl(ad?.thumbnailUrl ?? null),
          // nod: no stored creative thumbnails yet (SaaS Fase 6.4).
          thumbnailVersion: null,
        },
        enteredStageAt: new Date(row.enteredAt).toISOString(),
        arrivedAt: new Date(row.arrivedAt).toISOString(),
        valueCents:
          withValue && row.valueCents != null ? Number(row.valueCents) : null,
        currency: withValue && row.valueCents != null ? row.currency : null,
        whatsappInstance:
          instance && instance.name.trim()
            ? { id: instance.id, name: instance.name }
            : null,
      });
    }
    return cards;
  }
}
