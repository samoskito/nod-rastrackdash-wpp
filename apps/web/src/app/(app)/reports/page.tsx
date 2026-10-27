import type {
  AdReportOverviewDto,
  AdReportRowDto,
  AdSetReportOverviewDto,
  AdSetReportRowDto,
  CampaignReportRowDto,
  CurrencyCode,
  CurrentWorkspaceDto,
  ReportCurrencyGroupDto,
  UnconvertedRevenueDto,
  MetaAssetsDto,
  MetaStructureReportDto,
  ReportOverviewDto,
  ReportFunnelStepDto,
  ReportPaginationDto,
  ReportSortDto,
  ReportSortKeyDto,
  WhatsappConnectionDto,
} from "@wpptrack/shared";
import { BarChart3, CalendarRange, Download, RefreshCcw } from "lucide-react";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";
import type { BackofficeActionState } from "../../../components/backoffice-action-form";
import {
  CurrencyKpiGroups,
  ExchangeRateMissingNote,
} from "../../../components/currency-kpi-groups";
import { MetaSyncCoverageNotice } from "../../../components/meta-sync-coverage-notice";
import { PresentationMask } from "../../../components/presentation-mask";
import { SubmitButton } from "../../../components/submit-button";
import {
  joinAdAccountIds,
  parseAdAccountIdsParam,
  setAdAccountParams,
  splitAdAccountIds,
} from "../../../lib/ad-account-params";
import {
  adAccountCurrencyMap,
  getAdAccountCurrencies,
} from "../../../lib/currency-settings";
import {
  currencyKpiGroup,
  exchangeRateMissingHint,
  exchangeRateMissingLabel,
  formatReportMoney,
  mixedCurrencyGroups,
  reportCurrency,
  rowCurrency,
  singleCurrencyRateGap,
  unconvertedRevenueLabel,
} from "../../../lib/report-currency";
import { isApiRequestError, serverApiFetch } from "../../../lib/server-api";
import {
  toWhatsappNumberOptions,
  type WhatsappNumberOption,
} from "../../../lib/whatsapp-number-options";
import { getCurrentWorkspace } from "../../../lib/current-workspace";
import { MetaEntityControls } from "./meta-entity-controls";
import { MetaReportFilters } from "./meta-report-filters";
import { ReportFiltersProvider } from "./report-filter-state";
import { ReportPeriodFilter } from "./report-period-filter";
import { logMetaReportingSyncEnqueueFailure } from "./reports-error-logging";
import { ReportAdPreview } from "./report-ad-preview";
import {
  REPORT_INSIGHT_FETCH_SIZE,
  parseReportInsightObjective,
  reportInsightObjectiveKeys,
  reportInsightSorts,
  type ReportInsightMetrics,
  type ReportInsightObjective,
} from "./report-insights";
import {
  ReportInsightsPanel,
  type ReportInsightFetch,
  type ReportInsightRow,
} from "./report-insights-panel";
import {
  ReportSortHeader,
  ReportSortToolbar,
  type ReportSortAction,
} from "./report-sort-controls";
import {
  nextReportSort,
  parseReportSort,
  reportSortColumnKeys,
  reportSortVisibleInMetricGroup,
} from "./report-sort";
import {
  ReportPageSelectionCheckbox,
  ReportSelectionCheckbox,
  ReportSelectionToolbar,
  type ReportSelectionLevel,
} from "./report-selection-controls";
import { WhatsappReviewActions } from "./whatsapp-review-actions";
import {
  resolveWhatsappReviewActionState,
  type WhatsappClassification,
} from "./whatsapp-review-state";

type ReportsSearchParams = Record<string, string | string[] | undefined>;
type ReportView = "campaigns" | "adsets" | "ads";
type ReportMode = "table" | "insights";
type ReportMetricGroup = "overview" | "traffic" | "funnel" | "revenue";
type ReportFetchState = "real" | "empty" | "error";
type CampaignReportsResult = {
  report: ReportOverviewDto;
  state: ReportFetchState;
};
type AdSetReportsResult = {
  report: AdSetReportOverviewDto;
  state: ReportFetchState;
};
type AdReportsResult = {
  report: AdReportOverviewDto;
  state: ReportFetchState;
};
type PerformanceRow = CampaignReportRowDto | AdSetReportRowDto | AdReportRowDto;
type ReportTotals = {
  spendCents: number;
  metaConversationsStarted: number;
  realConversations: number;
  organicLeads: number;
  totalReceived: number;
  trackingRate: number | null;
  qualifiedLead: number;
  purchases: number;
  firstPurchases: number;
  repurchases: number;
  trafficRevenueCents: number;
  organicRevenueCents: number;
  totalRevenueCents: number;
  firstPurchaseRevenueCents: number;
  repurchaseRevenueCents: number;
  roasAcquisition: number | null;
  roasWithRepurchase: number | null;
  funnelSteps: ReportFunnelStepDto[];
};
type MetaStructureSummary = {
  campaigns: number;
  adSets: number;
  ads: number;
  activeAccounts: number;
  lastSyncedAt: string | null;
};
type MetaSyncPeriodState =
  | { kind: "none" | "missing" | "mixed" }
  | { kind: "single"; since: string; until: string };
type ReportEntityCopy = {
  title: string;
  singular: string;
  plural: string;
  activeSingular: string;
  activePlural: string;
  pausedSingular: string;
  pausedPlural: string;
  deletedSingular: string;
  deletedPlural: string;
  unknownSingular: string;
  unknownPlural: string;
};
type StructureNameScope = "campaign" | "adset" | "ad";
type StructureStatusFilter = "all" | "active" | "inactive";
type MetaStructureFilters = {
  nameContains?: string;
  nameScope: StructureNameScope;
  status: StructureStatusFilter;
};
type MetaStructureRow = {
  adId: string | null;
  adName: string;
  adSetId: string;
  adSetName: string;
  campaignName: string;
  campaignObjective: string | null;
  key: string;
  status: string | null | undefined;
};
type ReportNotice = {
  tone: "success" | "warn";
  title: string;
  message: string;
};
type WorkspaceFetchResult = {
  data: CurrentWorkspaceDto | null;
  state: "real" | "error";
};
type ReportFilters = {
  /** Contas de anúncio juntas por "," (`adAccountId` ou `adAccountIds` na URL). */
  adAccountId?: string;
  adId?: string;
  adSetId?: string;
  businessId?: string;
  campaignId?: string;
  compareSince?: string;
  compareUntil?: string;
  delivery?: "all" | "had_delivery";
  nameContains?: string;
  nameScope?: string;
  metrics?: ReportMetricGroup;
  mode?: ReportMode;
  objective?: ReportInsightObjective;
  page?: number;
  pageSize?: number;
  since?: string;
  selectedIds?: string;
  sort?: ReportSortDto;
  status?: string;
  until?: string;
  whatsappClassification?: string;
  whatsappInstanceId?: string;
};
type ReportSortColumn = {
  cost: ReportSortAction;
  count: ReportSortAction;
};

/** Dinheiro na moeda da linha ou do recorte (BRL quando tudo é em real). */
function money(cents: number | null, currency: CurrencyCode = "BRL") {
  return formatReportMoney(cents, currency);
}

type RateGap = {
  exchangeRateMissing: boolean;
  unconvertedRevenue: UnconvertedRevenueDto[];
};

const noRateGap: RateGap = {
  exchangeRateMissing: false,
  unconvertedRevenue: [],
};

/** ROAS, ou "sem cotação" quando parte da receita não pôde ser convertida. */
function roasOrMissing(value: number | null, rateMissing: boolean): ReactNode {
  return rateMissing ? (
    <span className="report-rate-missing" title={exchangeRateMissingHint}>
      {exchangeRateMissingLabel}
    </span>
  ) : (
    roas(value)
  );
}

/** Receita que ficou fora por falta de cotação, na moeda original. */
function UnconvertedRevenueSpan({
  unconverted,
}: {
  unconverted: readonly UnconvertedRevenueDto[] | undefined;
}) {
  const label = unconvertedRevenueLabel(unconverted);

  return label ? (
    <span className="report-unconverted" title={exchangeRateMissingHint}>
      + {label} sem cotação
    </span>
  ) : null;
}

function roas(value: number | null) {
  if (value === null) {
    return "-";
  }

  return `${value.toLocaleString("pt-BR", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  })}x`;
}

const roasText = roas;

function percent(value: number | null) {
  if (value === null) {
    return "-";
  }

  return `${Math.round(value * 100)}%`;
}

function metaStatusLabel(status: string | null | undefined) {
  if (!status) {
    return "Status desconhecido";
  }

  const labels: Record<string, string> = {
    ACTIVE: "Ativo",
    PAUSED: "Pausado",
    DELETED: "Excluído",
    ARCHIVED: "Arquivado",
    IN_PROCESS: "Em processamento",
    WITH_ISSUES: "Com problemas",
    CAMPAIGN_PAUSED: "Campanha pausada",
    ADSET_PAUSED: "Conjunto pausado",
  };

  return labels[status.toUpperCase()] ?? "Status desconhecido";
}

async function getCampaignReports(
  filters: ReportFilters,
): Promise<CampaignReportsResult> {
  try {
    const params = new URLSearchParams(reportQuery(filters));

    if (filters.since && filters.until) {
      params.set("includeDaily", "true");
    }

    const query = params.toString();

    const report = await serverApiFetch<ReportOverviewDto>(
      query ? `/reports/campaigns?${query}` : "/reports/campaigns",
    );

    return {
      report,
      state: report.campaigns.length > 0 ? "real" : "empty",
    };
  } catch (error) {
    // Fase 6.3b: the API now answers 404 for a drill-down campaign outside
    // the current BM/accounts (or of an inactive account). That is an empty
    // cut, as before the campaign check, never "API indisponível".
    if (
      filters.campaignId &&
      isApiRequestError(error) &&
      error.status === 404
    ) {
      return {
        report: {
          workspaceId: "unavailable",
          rangeLabel:
            filters.since && filters.until
              ? periodLabel(filters.since, filters.until)
              : "Período selecionado",
          campaigns: [],
        },
        state: "empty",
      };
    }

    return {
      report: {
        workspaceId: "unavailable",
        rangeLabel: "API indisponível",
        campaigns: [],
      },
      state: "error",
    };
  }
}

async function getAdSetReports(
  filters: ReportFilters,
): Promise<AdSetReportsResult> {
  try {
    const query = reportQuery(filters);
    const report = await serverApiFetch<AdSetReportOverviewDto>(
      query ? `/reports/adsets?${query}` : "/reports/adsets",
    );

    return {
      report,
      state: report.adSets.length > 0 ? "real" : "empty",
    };
  } catch {
    return {
      report: {
        workspaceId: "unavailable",
        rangeLabel: "API indisponível",
        adSets: [],
      },
      state: "error",
    };
  }
}

async function getAdReports(filters: ReportFilters): Promise<AdReportsResult> {
  try {
    const query = reportQuery(filters);
    const report = await serverApiFetch<AdReportOverviewDto>(
      query ? `/reports/ads?${query}` : "/reports/ads",
    );

    return {
      report,
      state: report.ads.length > 0 ? "real" : "empty",
    };
  } catch {
    return {
      report: {
        workspaceId: "unavailable",
        rangeLabel: "API indisponível",
        ads: [],
      },
      state: "error",
    };
  }
}

/**
 * Totais do filtro para os rankings de insights, com a moeda do relatório
 * (`null` quando o filtro mistura moedas: o custo nunca é comparado).
 */
function insightTotals(
  report: Parameters<typeof reportCurrency>[0] & {
    totals?: ReportInsightMetrics;
  },
): ReportInsightMetrics | undefined {
  return report.totals
    ? {
        ...report.totals,
        currency:
          mixedCurrencyGroups(report).length > 0
            ? null
            : reportCurrency(report),
      }
    : undefined;
}

type ReportInsightsResult = {
  cost: ReportInsightFetch;
  report:
    ReportOverviewDto | AdSetReportOverviewDto | AdReportOverviewDto | null;
  volume: ReportInsightFetch;
};

async function getReportInsightRanking(
  view: ReportView,
  filters: ReportFilters,
  sort: ReportSortDto,
): Promise<{
  fetch: ReportInsightFetch;
  report:
    ReportOverviewDto | AdSetReportOverviewDto | AdReportOverviewDto | null;
}> {
  // Rankings read the head of the API ordering, which is applied to the whole
  // filtered population before pagination; the table page is never reused.
  const query = reportQuery({
    ...filters,
    page: 1,
    pageSize: REPORT_INSIGHT_FETCH_SIZE,
    sort,
  });

  try {
    if (view === "adsets") {
      const report = await serverApiFetch<AdSetReportOverviewDto>(
        `/reports/adsets?${query}`,
      );

      return {
        fetch: {
          state: "real",
          pagination: report.pagination,
          rows: report.adSets,
          totals: insightTotals(report),
        },
        report,
      };
    }

    if (view === "ads") {
      const report = await serverApiFetch<AdReportOverviewDto>(
        `/reports/ads?${query}`,
      );

      return {
        fetch: {
          state: "real",
          pagination: report.pagination,
          rows: report.ads,
          totals: insightTotals(report),
        },
        report,
      };
    }

    const report = await serverApiFetch<ReportOverviewDto>(
      `/reports/campaigns?${query}`,
    );

    return {
      fetch: {
        state: "real",
        pagination: report.pagination,
        rows: report.campaigns,
        totals: insightTotals(report),
      },
      report,
    };
  } catch {
    return { fetch: { state: "error" }, report: null };
  }
}

async function getReportInsights(
  view: ReportView,
  filters: ReportFilters,
  objective: ReportInsightObjective,
): Promise<ReportInsightsResult> {
  const sorts = reportInsightSorts(objective);
  const [volume, cost] = await Promise.all([
    getReportInsightRanking(view, filters, sorts.volume),
    getReportInsightRanking(view, filters, sorts.cost),
  ]);

  return {
    cost: cost.fetch,
    report: volume.report ?? cost.report,
    volume: volume.fetch,
  };
}

async function getMetaStructureReport(): Promise<MetaStructureReportDto | null> {
  try {
    return await serverApiFetch<MetaStructureReportDto>(
      "/reports/meta/structure",
    );
  } catch {
    return null;
  }
}

async function getCurrentWorkspaceResource(): Promise<WorkspaceFetchResult> {
  try {
    return {
      data: await getCurrentWorkspace(),
      state: "real",
    };
  } catch {
    return {
      data: null,
      state: "error",
    };
  }
}

async function getMetaAssets(): Promise<MetaAssetsDto | null> {
  try {
    return await serverApiFetch<MetaAssetsDto>("/integrations/meta/assets");
  } catch {
    return null;
  }
}

/**
 * Números WhatsApp ativos do workspace (as conexões do nod). Uma conexão
 * removida sai da lista, mas a URL com o id dela continua valendo.
 */
async function getWhatsappInstances(): Promise<WhatsappNumberOption[]> {
  try {
    const connections = await serverApiFetch<WhatsappConnectionDto[]>(
      "/integrations/whatsapp-connections",
    );

    return toWhatsappNumberOptions(connections).filter(
      (number) => number.active,
    );
  } catch {
    return [];
  }
}

function reportQuery(
  filters: ReportFilters,
  includeComparison = false,
  includePagination = true,
) {
  const params = new URLSearchParams();

  if (filters.since) {
    params.set("since", filters.since);
  }

  if (filters.until) {
    params.set("until", filters.until);
  }

  if (includeComparison && filters.compareSince) {
    params.set("compareSince", filters.compareSince);
  }

  if (includeComparison && filters.compareUntil) {
    params.set("compareUntil", filters.compareUntil);
  }

  if (filters.businessId) {
    params.set("businessId", filters.businessId);
  }

  setAdAccountParams(params, splitAdAccountIds(filters.adAccountId));

  if (filters.whatsappInstanceId) {
    params.set("whatsappInstanceId", filters.whatsappInstanceId);
  }

  if (filters.campaignId) {
    params.set("campaignId", filters.campaignId);
  }

  if (filters.adSetId) {
    params.set("adSetId", filters.adSetId);
  }

  if (filters.adId) {
    params.set("adId", filters.adId);
  }

  if (filters.nameContains) {
    params.set("nameContains", filters.nameContains);
    params.set("nameScope", filters.nameScope ?? "campaign");
  }

  if (filters.status) {
    params.set("status", filters.status);
  }

  if (filters.delivery && filters.delivery !== "all") {
    params.set("delivery", filters.delivery);
  }

  if (filters.selectedIds) {
    params.set("selectedIds", filters.selectedIds);
  }

  if (filters.whatsappClassification) {
    params.set("whatsappClassification", filters.whatsappClassification);
  }

  if (includePagination && filters.page) {
    params.set("page", String(filters.page));
  }

  if (includePagination && filters.pageSize) {
    params.set("pageSize", String(filters.pageSize));
  }

  if (includePagination && filters.sort) {
    params.set("sort", filters.sort.key);
    params.set("dir", filters.sort.direction);
  }

  return params.toString();
}

async function syncMetaReports(formData: FormData) {
  "use server";

  const since = formText(formData, "since");
  const until = formText(formData, "until");
  const redirectParams = new URLSearchParams();

  for (const key of [
    "since",
    "until",
    "compareSince",
    "compareUntil",
    "businessId",
    "campaignId",
    "adSetId",
    "adId",
    "nameScope",
    "nameContains",
    "status",
    "delivery",
    "selectedIds",
    "whatsappClassification",
    "whatsappInstanceId",
    "view",
    "metrics",
    "mode",
    "objective",
    "pageSize",
    "sort",
    "dir",
  ]) {
    const value = formText(formData, key);

    if (value) {
      redirectParams.set(key, value);
    }
  }

  setAdAccountParams(
    redirectParams,
    parseAdAccountIdsParam(
      formText(formData, "adAccountId"),
      formText(formData, "adAccountIds"),
    ),
  );

  try {
    const params = new URLSearchParams();

    if (since) {
      params.set("since", since);
    }

    if (until) {
      params.set("until", until);
    }

    const query = params.toString();

    await serverApiFetch(
      query ? `/reports/meta/sync?${query}` : "/reports/meta/sync",
      {
        method: "POST",
      },
    );
    revalidatePath("/reports");
    redirectParams.set("notice", "meta-sync-queued");
  } catch (error) {
    // Keep operational context without serializing the error or form values.
    logMetaReportingSyncEnqueueFailure(error);
    redirectParams.set("notice", "meta-sync-error");
  }

  redirect(`/reports?${redirectParams.toString()}`);
}

async function saveWhatsappClassification(
  _previousState: BackofficeActionState,
  formData: FormData,
): Promise<BackofficeActionState> {
  "use server";

  const nonce = Date.now();
  const level = String(formData.get("level") ?? "");
  const id = String(formData.get("id") ?? "");
  const overrideValue = String(formData.get("override") ?? "");
  const override =
    overrideValue === "manual_include" || overrideValue === "manual_exclude"
      ? overrideValue
      : null;

  if (!["campaign", "adset", "ad"].includes(level) || !id) {
    return {
      status: "error",
      message: "Item do relatório não identificado.",
      nonce,
    };
  }

  try {
    const result = await serverApiFetch<{
      ok: true;
      whatsappClassification?: WhatsappClassification;
    }>("/reports/meta/whatsapp-classification", {
      method: "PUT",
      body: JSON.stringify({ level, id, override }),
    });
    revalidatePath("/reports");
    return {
      status: "success",
      message:
        override === "manual_include"
          ? "Item incluído nos relatórios de WhatsApp."
          : override === "manual_exclude"
            ? "Item marcado como excluído. Ele continua disponível no filtro Excluídas."
            : "Classificação automática restaurada.",
      nonce,
      ...resolveWhatsappReviewActionState(
        override,
        result.whatsappClassification,
      ),
    };
  } catch {
    return {
      status: "error",
      message: "Não foi possível salvar a revisão. Tente novamente.",
      nonce,
    };
  }
}

async function updateMetaEntity(
  _previousState: BackofficeActionState,
  formData: FormData,
): Promise<BackofficeActionState> {
  "use server";

  const nonce = Date.now();
  const intent = formText(formData, "intent");
  const level = formText(formData, "level");
  const id = formText(formData, "id");

  if (!id || !["campaign", "adset", "ad"].includes(level)) {
    return {
      status: "error",
      message: "Item Meta não identificado.",
      nonce,
    };
  }

  try {
    if (intent === "status") {
      const expectedStatus = formText(formData, "expectedStatus");
      const targetStatus = formText(formData, "targetStatus");

      if (
        !["ACTIVE", "PAUSED"].includes(expectedStatus) ||
        !["ACTIVE", "PAUSED"].includes(targetStatus)
      ) {
        return {
          status: "error",
          message: "Status Meta inválido.",
          nonce,
        };
      }

      await serverApiFetch("/reports/meta/entity-status", {
        method: "PUT",
        body: JSON.stringify({ level, id, expectedStatus, targetStatus }),
      });
      revalidatePath("/reports");

      return {
        status: "success",
        message:
          targetStatus === "ACTIVE"
            ? "Item ativado na Meta."
            : "Item pausado na Meta.",
        nonce,
      };
    }

    if (intent === "budget" && ["campaign", "adset"].includes(level)) {
      const budgetType = formText(formData, "budgetType");
      const expectedBudgetCents = Number(
        formText(formData, "expectedBudgetCents"),
      );
      const budgetAmount = Number(formText(formData, "budgetAmount"));
      const budgetCents = Math.round(budgetAmount * 100);

      if (
        !["daily", "lifetime"].includes(budgetType) ||
        !Number.isInteger(expectedBudgetCents) ||
        !Number.isFinite(budgetAmount) ||
        budgetCents < 1
      ) {
        return {
          status: "error",
          message: "Informe um orçamento válido.",
          nonce,
        };
      }

      await serverApiFetch("/reports/meta/budget", {
        method: "PUT",
        body: JSON.stringify({
          level,
          id,
          budgetType,
          expectedBudgetCents,
          budgetCents,
        }),
      });
      revalidatePath("/reports");

      return {
        status: "success",
        message: "Orçamento atualizado na Meta.",
        nonce,
      };
    }

    return {
      status: "error",
      message: "Alteração Meta inválida.",
      nonce,
    };
  } catch (error) {
    return {
      status: "error",
      message: isApiRequestError(error)
        ? error.message
        : "Não foi possível concluir a alteração na Meta.",
      nonce,
    };
  }
}

function asStringParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function reportView(value?: string): ReportView {
  return value === "adsets" || value === "ads" ? value : "campaigns";
}

function reportMode(value?: string): ReportMode {
  return value === "insights" ? value : "table";
}

function reportMetricGroup(value?: string): ReportMetricGroup {
  return value === "traffic" || value === "funnel" || value === "revenue"
    ? value
    : "overview";
}

function reportDeliveryFilter(value?: string): "all" | "had_delivery" {
  return value === "had_delivery" ? value : "all";
}

function selectedIdsParam(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const ids = Array.from(
    new Set(
      value
        .split(",")
        .map((id) => id.trim())
        .filter((id) => /^[A-Za-z0-9_.:-]{1,200}$/.test(id)),
    ),
  ).slice(0, 200);

  return ids.length > 0 ? ids.join(",") : undefined;
}

function reportSelectionLevel(view: ReportView): ReportSelectionLevel {
  if (view === "adsets") {
    return "adset";
  }

  return view === "ads" ? "ad" : "campaign";
}

function positiveIntegerParam(value: string | undefined, fallback: number) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function formText(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function structureNameScope(value?: string): StructureNameScope {
  return value === "adset" || value === "ad" ? value : "campaign";
}

function structureStatusFilter(value?: string): StructureStatusFilter {
  return value === "active" || value === "inactive" ? value : "all";
}

function reportsNotice(notice?: string): ReportNotice | null {
  const notices: Record<string, ReportNotice> = {
    "meta-sync-queued": {
      tone: "success",
      title: "Sincronização iniciada",
      message:
        "A leitura dos dados Meta foi enviada para a fila. Atualize em alguns segundos para ver as campanhas.",
    },
    "meta-sync-error": {
      tone: "warn",
      title: "Sincronização não iniciada",
      message:
        "Não foi possível iniciar a leitura dos dados Meta agora. Confira as contas ativas e os diagnósticos.",
    },
  };

  return notice ? (notices[notice] ?? null) : null;
}

function leadsHref(filters: {
  adAccountId?: string;
  campaignId?: string | null;
  businessId?: string;
  compareSince?: string;
  compareUntil?: string;
  adSetId?: string | null;
  adId?: string | null;
  since?: string;
  until?: string;
  whatsappClassification?: string;
  whatsappInstanceId?: string;
}): string {
  const params = new URLSearchParams();

  if (filters.campaignId) {
    params.set("campaignId", filters.campaignId);
  }

  if (filters.adSetId) {
    params.set("adSetId", filters.adSetId);
  }

  if (filters.adId) {
    params.set("adId", filters.adId);
  }

  if (filters.since) {
    params.set("since", filters.since);
  }

  if (filters.until) {
    params.set("until", filters.until);
  }

  if (filters.compareSince) {
    params.set("compareSince", filters.compareSince);
  }

  if (filters.compareUntil) {
    params.set("compareUntil", filters.compareUntil);
  }

  if (filters.businessId) {
    params.set("businessId", filters.businessId);
  }

  setAdAccountParams(params, splitAdAccountIds(filters.adAccountId));

  if (filters.whatsappClassification) {
    params.set("whatsappClassification", filters.whatsappClassification);
  }

  if (filters.whatsappInstanceId) {
    params.set("whatsappInstanceId", filters.whatsappInstanceId);
  }

  const query = params.toString();

  return query ? `/leads?${query}` : "/leads";
}

function reportExportHref(filters: ReportFilters, view: ReportView): string {
  const query = reportQuery(
    view === "campaigns"
      ? filters
      : { ...filters, delivery: undefined, selectedIds: undefined },
    true,
    false,
  );

  return query ? `/reports/export?${query}` : "/reports/export";
}

function applyReportUiParams(
  params: URLSearchParams,
  filters: ReportFilters,
): URLSearchParams {
  if (filters.metrics && filters.metrics !== "overview") {
    params.set("metrics", filters.metrics);
  }

  if (filters.mode === "insights") {
    params.set("mode", filters.mode);

    if (filters.objective && filters.objective !== "real_conversations") {
      params.set("objective", filters.objective);
    }
  }

  return params;
}

function reportViewHref(view: ReportView, filters: ReportFilters): string {
  const params = applyReportUiParams(
    new URLSearchParams(reportQuery({ ...filters, page: 1 }, true)),
    filters,
  );
  params.set("view", view);

  return `/reports?${params.toString()}`;
}

function reportPageHref(
  view: ReportView,
  filters: ReportFilters,
  page: number,
): string {
  const params = applyReportUiParams(
    new URLSearchParams(reportQuery({ ...filters, page }, true)),
    filters,
  );
  params.set("view", view);

  return `/reports?${params.toString()}`;
}

function reportMetricGroupHref(
  metrics: ReportMetricGroup,
  view: ReportView,
  filters: ReportFilters,
): string {
  const sort =
    filters.sort && reportSortVisibleInMetricGroup(filters.sort.key, metrics)
      ? filters.sort
      : undefined;
  const params = new URLSearchParams(
    reportQuery({ ...filters, page: 1, sort }, true),
  );

  params.set("view", view);

  if (metrics !== "overview") {
    params.set("metrics", metrics);
  }

  return `/reports?${params.toString()}`;
}

function reportSortAction(
  view: ReportView,
  filters: ReportFilters,
  key: ReportSortKeyDto,
  label: string,
): ReportSortAction {
  const active = filters.sort?.key === key;

  return {
    active,
    direction: active && filters.sort ? filters.sort.direction : "desc",
    href: reportPageHref(
      view,
      { ...filters, sort: nextReportSort(filters.sort, key) },
      1,
    ),
    label,
  };
}

function reportSortColumn(
  view: ReportView,
  filters: ReportFilters,
  step: ReportFunnelStepDto,
): ReportSortColumn | null {
  const keys = reportSortColumnKeys(step.key);

  if (!keys) {
    return null;
  }

  return {
    count: reportSortAction(view, filters, keys.count, step.label),
    cost: reportSortAction(view, filters, keys.cost, `Custo por ${step.label}`),
  };
}

/**
 * Contas de anúncio num formulário: `adAccountId` com uma conta,
 * `adAccountIds` com duas ou mais (mesmo formato da URL).
 */
function AdAccountHiddenInput({ value }: { value?: string }) {
  const ids = splitAdAccountIds(value);

  return (
    <input
      type="hidden"
      name={ids.length > 1 ? "adAccountIds" : "adAccountId"}
      value={ids.join(",")}
    />
  );
}

function ReportSortHiddenInputs({ sort }: { sort?: ReportSortDto }) {
  if (!sort) {
    return null;
  }

  return (
    <>
      <input type="hidden" name="sort" value={sort.key} />
      <input type="hidden" name="dir" value={sort.direction} />
    </>
  );
}

function ReportModeHiddenInputs({
  mode,
  objective,
}: {
  mode: ReportMode;
  objective: ReportInsightObjective;
}) {
  if (mode !== "insights") {
    return null;
  }

  return (
    <>
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="objective" value={objective} />
    </>
  );
}

function reportInsightTableHref(
  view: ReportView,
  filters: ReportFilters,
  sort: ReportSortDto,
): string {
  const metrics =
    filters.metrics && reportSortVisibleInMetricGroup(sort.key, filters.metrics)
      ? filters.metrics
      : "overview";

  return reportPageHref(
    view,
    { ...filters, metrics, mode: undefined, objective: undefined, sort },
    1,
  );
}

const campaignSummaryCopy: ReportEntityCopy = {
  title: "Resumo campanhas",
  singular: "campanha",
  plural: "campanhas",
  activeSingular: "ativa",
  activePlural: "ativas",
  pausedSingular: "pausada",
  pausedPlural: "pausadas",
  deletedSingular: "excluída",
  deletedPlural: "excluídas",
  unknownSingular: "sem status",
  unknownPlural: "sem status",
};

const adSetSummaryCopy: ReportEntityCopy = {
  title: "Resumo conjuntos",
  singular: "conjunto",
  plural: "conjuntos",
  activeSingular: "ativo",
  activePlural: "ativos",
  pausedSingular: "pausado",
  pausedPlural: "pausados",
  deletedSingular: "excluído",
  deletedPlural: "excluídos",
  unknownSingular: "sem status",
  unknownPlural: "sem status",
};

const adSummaryCopy: ReportEntityCopy = {
  title: "Resumo anúncios",
  singular: "anúncio",
  plural: "anúncios",
  activeSingular: "ativo",
  activePlural: "ativos",
  pausedSingular: "pausado",
  pausedPlural: "pausados",
  deletedSingular: "excluído",
  deletedPlural: "excluídos",
  unknownSingular: "sem status",
  unknownPlural: "sem status",
};

function PerformanceMetricsCells({
  currency: reportCurrencyCode,
  funnelSteps,
  metricGroup,
  row,
  realConversationsHref,
}: {
  /** Moeda do relatório, para linhas que não trazem a própria. */
  currency: CurrencyCode;
  funnelSteps: ReportFunnelStepDto[];
  metricGroup: ReportMetricGroup;
  row: PerformanceRow;
  realConversationsHref: string;
}) {
  // Cada linha mostra o dinheiro na moeda da própria conta de anúncio.
  const currency = rowCurrency(row, reportCurrencyCode);
  const money = (cents: number | null) => formatReportMoney(cents, currency);
  const rateMissing = row.exchangeRateMissing === true;
  const rowSteps = new Map(row.funnelSteps.map((step) => [step.key, step]));
  const showOverview = metricGroup === "overview";
  const showTraffic = metricGroup === "traffic";
  const showFunnel = metricGroup === "funnel";
  const showRevenue = metricGroup === "revenue";
  const visibleFunnelSteps = showTraffic
    ? funnelSteps.filter((step) => step.key === "real_conversations")
    : showOverview || showFunnel
      ? funnelSteps
      : [];

  return (
    <>
      {showOverview || showTraffic || showFunnel || showRevenue ? (
        <td data-label="Investimento">{money(row.spendCents)}</td>
      ) : null}
      {showOverview || showTraffic ? (
        <td data-label="Conversas Meta">
          {row.metaConversationsStarted}
          <span>{money(row.costPerMetaConversationCents)}</span>
        </td>
      ) : null}
      {visibleFunnelSteps.map((column) => {
        const step = rowSteps.get(column.key);
        const value = step?.value ?? 0;

        return (
          <td data-label={column.label} key={column.key}>
            {column.key === "real_conversations" ? (
              <Link className="report-metric-link" href={realConversationsHref}>
                {value}
              </Link>
            ) : (
              value
            )}
            <span>{money(step?.costCents ?? null)}</span>
          </td>
        );
      })}
      {showTraffic ? (
        <td data-label="Total recebido">
          {row.totalReceived}
          <span>{percent(row.trackingRate)}</span>
        </td>
      ) : null}
      {showOverview || showRevenue ? (
        <td data-label="Receita de tráfego">
          {money(row.trafficRevenueCents)}
          <UnconvertedRevenueSpan unconverted={row.unconvertedRevenue} />
        </td>
      ) : null}
      {showRevenue ? (
        <>
          <td data-label="Receita da primeira compra">
            {money(row.firstPurchaseRevenueCents)}
          </td>
          <td data-label="Receita de recompra">
            {money(row.repurchaseRevenueCents)}
          </td>
          <td data-label="Receita total">
            {money(row.totalRevenueCents)}
            <UnconvertedRevenueSpan unconverted={row.unconvertedRevenue} />
          </td>
        </>
      ) : null}
      {showOverview || showRevenue ? (
        <td data-label="ROAS de aquisição">
          {roasOrMissing(row.roasAcquisition, rateMissing)}
        </td>
      ) : null}
      {showRevenue ? (
        <td data-label="ROAS com recompra">
          {roasOrMissing(row.roasWithRepurchase, rateMissing)}
        </td>
      ) : null}
    </>
  );
}

function EmptyPerformanceCells({
  currency,
  funnelSteps,
  metricGroup,
}: {
  currency: CurrencyCode;
  funnelSteps: ReportFunnelStepDto[];
  metricGroup: ReportMetricGroup;
}) {
  const money = (cents: number) => formatReportMoney(cents, currency);
  const showOverview = metricGroup === "overview";
  const showTraffic = metricGroup === "traffic";
  const showFunnel = metricGroup === "funnel";
  const showRevenue = metricGroup === "revenue";
  const visibleFunnelSteps = showTraffic
    ? funnelSteps.filter((step) => step.key === "real_conversations")
    : showOverview || showFunnel
      ? funnelSteps
      : [];

  return (
    <>
      <td data-label="Investimento">{money(0)}</td>
      {showOverview || showTraffic ? (
        <td data-label="Conversas Meta">
          0<span>-</span>
        </td>
      ) : null}
      {visibleFunnelSteps.map((step) => (
        <td data-label={step.label} key={step.key}>
          0<span>-</span>
        </td>
      ))}
      {showTraffic ? (
        <td data-label="Total recebido">
          0<span>-</span>
        </td>
      ) : null}
      {showOverview || showRevenue ? (
        <td data-label="Receita de tráfego">{money(0)}</td>
      ) : null}
      {showRevenue ? (
        <>
          <td data-label="Receita da primeira compra">{money(0)}</td>
          <td data-label="Receita de recompra">{money(0)}</td>
          <td data-label="Receita total">{money(0)}</td>
        </>
      ) : null}
      {showOverview || showRevenue ? (
        <td data-label="ROAS de aquisição">-</td>
      ) : null}
      {showRevenue ? <td data-label="ROAS com recompra">-</td> : null}
    </>
  );
}

function weightedRoas(
  rows: PerformanceRow[],
  selectRoas: (row: PerformanceRow) => number | null,
): number | null {
  const weighted = rows.reduce(
    (total, row) => {
      const value = selectRoas(row);

      if (value === null || row.spendCents === 0) {
        return total;
      }

      return {
        spendCents: total.spendCents + row.spendCents,
        revenueBasis: total.revenueBasis + value * row.spendCents,
      };
    },
    { revenueBasis: 0, spendCents: 0 },
  );

  return weighted.spendCents > 0
    ? weighted.revenueBasis / weighted.spendCents
    : null;
}

function aggregateFunnelSteps(
  rows: PerformanceRow[],
  spendCents: number,
): ReportFunnelStepDto[] {
  const steps = new Map<string, ReportFunnelStepDto>();
  const order: string[] = [];

  for (const row of rows) {
    // Merge estavel: a API ja manda as etapas na ordem do funil, mas linhas sem
    // compra omitem first_purchase/repurchase. Anexar no fim jogaria uma etapa
    // do meio do funil para o final; inserimos logo apos a etapa anterior desta
    // mesma linha.
    let insertAt = 0;

    for (const step of row.funnelSteps) {
      const current = steps.get(step.key);
      const known = order.indexOf(step.key);

      if (known >= 0) {
        insertAt = known + 1;
      } else {
        order.splice(insertAt, 0, step.key);
        insertAt += 1;
      }

      steps.set(step.key, {
        key: step.key,
        label: current?.label ?? step.label,
        value: (current?.value ?? 0) + step.value,
        costCents: null,
      });
    }
  }

  return order.map((key) => {
    const step = steps.get(key)!;

    return {
      ...step,
      costCents: step.value > 0 ? Math.floor(spendCents / step.value) : null,
    };
  });
}

function reportTotals(rows: PerformanceRow[]): ReportTotals {
  const totals = rows.reduce<ReportTotals>(
    (totals, row) => ({
      spendCents: totals.spendCents + (row.spendCents ?? 0),
      metaConversationsStarted:
        totals.metaConversationsStarted + row.metaConversationsStarted,
      realConversations: totals.realConversations + row.realConversations,
      organicLeads: totals.organicLeads + row.organicLeads,
      totalReceived: totals.totalReceived + row.totalReceived,
      trackingRate: null,
      qualifiedLead: totals.qualifiedLead + row.qualifiedLead,
      purchases: totals.purchases + row.purchases,
      firstPurchases: totals.firstPurchases + row.firstPurchases,
      repurchases: totals.repurchases + row.repurchases,
      trafficRevenueCents: totals.trafficRevenueCents + row.trafficRevenueCents,
      organicRevenueCents: totals.organicRevenueCents + row.organicRevenueCents,
      totalRevenueCents: totals.totalRevenueCents + row.totalRevenueCents,
      firstPurchaseRevenueCents:
        totals.firstPurchaseRevenueCents + row.firstPurchaseRevenueCents,
      repurchaseRevenueCents:
        totals.repurchaseRevenueCents + row.repurchaseRevenueCents,
      roasAcquisition: null,
      roasWithRepurchase: null,
      funnelSteps: totals.funnelSteps,
    }),
    {
      spendCents: 0,
      metaConversationsStarted: 0,
      realConversations: 0,
      organicLeads: 0,
      totalReceived: 0,
      trackingRate: null,
      qualifiedLead: 0,
      purchases: 0,
      firstPurchases: 0,
      repurchases: 0,
      trafficRevenueCents: 0,
      organicRevenueCents: 0,
      totalRevenueCents: 0,
      firstPurchaseRevenueCents: 0,
      repurchaseRevenueCents: 0,
      roasAcquisition: null,
      roasWithRepurchase: null,
      funnelSteps: rows[0]?.funnelSteps ?? [],
    },
  );

  return {
    ...totals,
    funnelSteps: aggregateFunnelSteps(rows, totals.spendCents),
    trackingRate:
      totals.totalReceived > 0
        ? totals.realConversations / totals.totalReceived
        : null,
    roasAcquisition: weightedRoas(rows, (row) => row.roasAcquisition),
    roasWithRepurchase: weightedRoas(rows, (row) => row.roasWithRepurchase),
  };
}

function metaStructureSummary(
  metaStructure: MetaStructureReportDto | null,
  metaAssets: MetaAssetsDto | null,
): MetaStructureSummary {
  const campaigns = metaStructure?.campaigns ?? [];

  return {
    campaigns: campaigns.length,
    adSets: campaigns.reduce(
      (total, campaign) => total + campaign.adSets.length,
      0,
    ),
    ads: campaigns.reduce(
      (total, campaign) =>
        total +
        campaign.adSets.reduce(
          (adTotal, adSet) => adTotal + adSet.ads.length,
          0,
        ),
      0,
    ),
    activeAccounts: (metaAssets?.reportingAccounts ?? []).filter(
      (account) => account.active,
    ).length,
    lastSyncedAt: metaAssets?.lastSyncedAt ?? null,
  };
}

function metaSyncPeriodState(
  metaAssets: MetaAssetsDto | null,
): MetaSyncPeriodState {
  const accounts = (metaAssets?.reportingAccounts ?? []).filter(
    (account) => account.active,
  );

  if (accounts.length === 0) {
    return { kind: "none" };
  }

  const ranges = accounts
    .map((account) =>
      // Only a completed or currently running import can use its persisted
      // range. Unknown, pending, and error statuses remain fail-closed.
      (account.syncStatus === "synced" || account.syncStatus === "syncing") &&
      account.lastSyncSince &&
      account.lastSyncUntil
        ? `${account.lastSyncSince}|${account.lastSyncUntil}`
        : null,
    )
    .filter((value): value is string => Boolean(value));

  if (ranges.length === 0) {
    return { kind: "missing" };
  }

  const uniqueRanges = [...new Set(ranges)];

  if (ranges.length !== accounts.length || uniqueRanges.length !== 1) {
    return { kind: "mixed" };
  }

  const [since, until] = uniqueRanges[0].split("|");

  return since && until
    ? { kind: "single", since, until }
    : { kind: "missing" };
}

function metaSyncCoversPeriod(
  metaAssets: MetaAssetsDto | null,
  since?: string,
  until?: string,
): boolean {
  if (!since || !until) {
    return false;
  }

  const accounts = (metaAssets?.reportingAccounts ?? []).filter(
    (account) => account.active,
  );

  return (
    accounts.length > 0 &&
    accounts.every(
      (account) =>
        (account.syncStatus === "synced" || account.syncStatus === "syncing") &&
        Boolean(account.lastSyncSince) &&
        Boolean(account.lastSyncUntil) &&
        account.lastSyncSince! <= since &&
        account.lastSyncUntil! >= until,
    )
  );
}

function dateOnlyLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

function periodLabel(since: string, until: string): string {
  return `${dateOnlyLabel(since)} a ${dateOnlyLabel(until)}`;
}

function metaStructureRows(
  metaStructure: MetaStructureReportDto | null,
): MetaStructureRow[] {
  const rows: MetaStructureRow[] = [];

  for (const campaign of metaStructure?.campaigns ?? []) {
    for (const adSet of campaign.adSets) {
      if (adSet.ads.length) {
        for (const ad of adSet.ads) {
          rows.push({
            adId: ad.id,
            adName: ad.name,
            adSetId: adSet.id,
            adSetName: adSet.name,
            campaignName: campaign.name,
            campaignObjective: campaign.objective,
            key: `${campaign.id}:${adSet.id}:${ad.id}`,
            status: ad.effectiveStatus ?? ad.status,
          });
        }

        continue;
      }

      rows.push({
        adId: null,
        adName: "Sem anúncios sincronizados",
        adSetId: adSet.id,
        adSetName: adSet.name,
        campaignName: campaign.name,
        campaignObjective: campaign.objective,
        key: `${campaign.id}:${adSet.id}:empty`,
        status: adSet.effectiveStatus ?? adSet.status,
      });
    }
  }

  return rows;
}

function normalizedSearch(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function metaStructureRowIsActive(row: MetaStructureRow): boolean {
  return row.status?.toUpperCase() === "ACTIVE";
}

function filterMetaStructureRows(
  rows: MetaStructureRow[],
  filters: MetaStructureFilters,
): MetaStructureRow[] {
  const query = normalizedSearch(filters.nameContains);

  return rows.filter((row) => {
    const nameTarget = {
      ad: row.adName,
      adset: row.adSetName,
      campaign: row.campaignName,
    }[filters.nameScope];

    if (query && !normalizedSearch(nameTarget).includes(query)) {
      return false;
    }

    if (filters.status === "active") {
      return metaStructureRowIsActive(row);
    }

    if (filters.status === "inactive") {
      return !metaStructureRowIsActive(row);
    }

    return true;
  });
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function syncedCountLabel(
  count: number,
  singular: string,
  plural: string,
): string {
  return countLabel(count, singular, plural);
}

function syncDateLabel(value: string | null): string {
  if (!value) {
    return "sem registro";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "data indisponível";
  }

  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(date);
}

function statusCountLabel(
  count: number,
  singular: string,
  plural: string,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function reportEntitySummary(
  rows: PerformanceRow[],
  copy: ReportEntityCopy,
): string {
  const total = rows.length;

  if (total === 0) {
    return countLabel(0, copy.singular, copy.plural);
  }

  const statusCounts = {
    active: rows.filter((row) => row.status === "active").length,
    paused: rows.filter((row) => row.status === "paused").length,
    deleted: rows.filter((row) => row.status === "deleted").length,
    unknown: rows.filter((row) => row.status === "unknown").length,
  };
  const parts = [
    statusCounts.active
      ? statusCountLabel(
          statusCounts.active,
          copy.activeSingular,
          copy.activePlural,
        )
      : null,
    statusCounts.paused
      ? statusCountLabel(
          statusCounts.paused,
          copy.pausedSingular,
          copy.pausedPlural,
        )
      : null,
    statusCounts.deleted
      ? statusCountLabel(
          statusCounts.deleted,
          copy.deletedSingular,
          copy.deletedPlural,
        )
      : null,
    statusCounts.unknown
      ? statusCountLabel(
          statusCounts.unknown,
          copy.unknownSingular,
          copy.unknownPlural,
        )
      : null,
  ].filter(Boolean);

  if (parts.length === 1) {
    return `${countLabel(total, copy.singular, copy.plural)} ${String(parts[0]).replace(/^\d+\s+/, "")}`;
  }

  return `${countLabel(total, copy.singular, copy.plural)}: ${parts.join(", ")}`;
}

function SummaryMetricsCells({
  currency,
  metricGroup,
  rateGap = noRateGap,
  totals,
}: {
  currency: CurrencyCode;
  metricGroup: ReportMetricGroup;
  /** Receita que ficou fora do total por falta de cotação (se houve). */
  rateGap?: RateGap;
  totals: ReportTotals;
}) {
  const money = (cents: number | null) => formatReportMoney(cents, currency);
  const showOverview = metricGroup === "overview";
  const showTraffic = metricGroup === "traffic";
  const showFunnel = metricGroup === "funnel";
  const showRevenue = metricGroup === "revenue";
  const visibleFunnelSteps = showTraffic
    ? totals.funnelSteps.filter((step) => step.key === "real_conversations")
    : showOverview || showFunnel
      ? totals.funnelSteps
      : [];

  return (
    <>
      <td data-label="Investimento">{money(totals.spendCents)}</td>
      {showOverview || showTraffic ? (
        <td data-label="Conversas Meta">{totals.metaConversationsStarted}</td>
      ) : null}
      {visibleFunnelSteps.map((step) => (
        <td data-label={step.label} key={step.key}>
          {step.value}
        </td>
      ))}
      {showTraffic ? (
        <td data-label="Total recebido">
          {totals.totalReceived}
          <span>{percent(totals.trackingRate)}</span>
        </td>
      ) : null}
      {showOverview || showRevenue ? (
        <td data-label="Receita de tráfego">
          {money(totals.trafficRevenueCents)}
          <UnconvertedRevenueSpan unconverted={rateGap.unconvertedRevenue} />
        </td>
      ) : null}
      {showRevenue ? (
        <>
          <td data-label="Receita da primeira compra">
            {money(totals.firstPurchaseRevenueCents)}
          </td>
          <td data-label="Receita de recompra">
            {money(totals.repurchaseRevenueCents)}
          </td>
          <td data-label="Receita total">
            {money(totals.totalRevenueCents)}
            <UnconvertedRevenueSpan unconverted={rateGap.unconvertedRevenue} />
          </td>
        </>
      ) : null}
      {showOverview || showRevenue ? (
        <td data-label="ROAS de aquisição">
          {roasOrMissing(totals.roasAcquisition, rateGap.exchangeRateMissing)}
        </td>
      ) : null}
      {showRevenue ? (
        <td data-label="ROAS com recompra">
          {roasOrMissing(
            totals.roasWithRepurchase,
            rateGap.exchangeRateMissing,
          )}
        </td>
      ) : null}
    </>
  );
}

function visibleReportFunnelSteps(
  funnelSteps: ReportFunnelStepDto[],
  metricGroup: ReportMetricGroup,
): ReportFunnelStepDto[] {
  if (metricGroup === "traffic") {
    return funnelSteps.filter((step) => step.key === "real_conversations");
  }

  return metricGroup === "overview" || metricGroup === "funnel"
    ? funnelSteps
    : [];
}

function PerformanceMetricHeaders({
  funnelSteps,
  metricGroup,
  sortColumn,
}: {
  funnelSteps: ReportFunnelStepDto[];
  metricGroup: ReportMetricGroup;
  sortColumn: (step: ReportFunnelStepDto) => ReportSortColumn | null;
}) {
  const showOverview = metricGroup === "overview";
  const showTraffic = metricGroup === "traffic";
  const showFunnel = metricGroup === "funnel";
  const showRevenue = metricGroup === "revenue";
  const visibleFunnelSteps = showTraffic
    ? funnelSteps.filter((step) => step.key === "real_conversations")
    : showOverview || showFunnel
      ? funnelSteps
      : [];

  return (
    <>
      <th>Investimento</th>
      {showOverview || showTraffic ? <th>Conversas Meta</th> : null}
      {visibleFunnelSteps.map((step) => {
        const column = sortColumn(step);

        return column ? (
          <ReportSortHeader
            cost={column.cost}
            count={column.count}
            key={step.key}
            label={step.label}
          />
        ) : (
          <th key={step.key}>{step.label}</th>
        );
      })}
      {showTraffic ? <th>Total recebido</th> : null}
      {showOverview || showRevenue ? <th>Receita tráfego</th> : null}
      {showRevenue ? (
        <>
          <th>Receita primeira compra</th>
          <th>Receita recompra</th>
          <th>Receita total</th>
        </>
      ) : null}
      {showOverview || showRevenue ? <th>ROAS aquisição</th> : null}
      {showRevenue ? <th>ROAS com recompra</th> : null}
    </>
  );
}

/**
 * Linhas da página agrupadas por moeda (subtotal quando a API não mandou
 * totais): dinheiro de moedas diferentes nunca é somado.
 */
function rowsByCurrency(
  rows: PerformanceRow[],
  fallback: CurrencyCode,
): Array<{ currency: CurrencyCode; rows: PerformanceRow[] }> {
  const groups = new Map<CurrencyCode, PerformanceRow[]>();

  for (const row of rows) {
    const currency = rowCurrency(row, fallback);
    groups.set(currency, [...(groups.get(currency) ?? []), row]);
  }

  return [...groups].map(([currency, groupRows]) => ({
    currency,
    rows: groupRows,
  }));
}

function PerformanceSummaryFooter({
  copy,
  currency,
  currencyGroups = [],
  metricGroup,
  pagination,
  rateGap = noRateGap,
  rows,
  totals,
}: {
  copy: ReportEntityCopy;
  /** Moeda do relatório (recorte de uma moeda só). */
  currency: CurrencyCode;
  /** Um total por moeda quando o filtro mistura moedas. */
  currencyGroups?: ReportCurrencyGroupDto[];
  metricGroup: ReportMetricGroup;
  pagination?: ReportPaginationDto;
  /** Cotação que faltou no recorte de uma moeda só. */
  rateGap?: RateGap;
  rows: PerformanceRow[];
  totals?: ReportTotals;
}) {
  const hasFilteredTotals = Boolean(totals);
  const pageGroups = totals ? [] : rowsByCurrency(rows, currency);
  const lines: Array<{
    currency: CurrencyCode;
    rateGap: RateGap;
    totals: ReportTotals;
  }> =
    currencyGroups.length > 0
      ? currencyGroups.map((group) => ({
          currency: group.currency,
          rateGap: {
            exchangeRateMissing: group.exchangeRateMissing,
            unconvertedRevenue: group.unconvertedRevenue,
          },
          totals: group,
        }))
      : pageGroups.length > 1
        ? pageGroups.map((group) => ({
            currency: group.currency,
            rateGap: noRateGap,
            totals: reportTotals(group.rows),
          }))
        : [{ currency, rateGap, totals: totals ?? reportTotals(rows) }];
  const perCurrency = lines.length > 1;

  return (
    <tfoot className="report-summary">
      {lines.map((line, index) => (
        <tr
          data-currency={perCurrency ? line.currency : undefined}
          key={line.currency}
          style={
            perCurrency
              ? ({
                  "--summary-after": lines.length - 1 - index,
                } as CSSProperties)
              : undefined
          }
        >
          <td
            className="performance-name-cell summary-name"
            data-label="Resumo"
          >
            <strong>
              {hasFilteredTotals
                ? "Total do filtro"
                : pagination
                  ? `Subtotal da página ${pagination.page}`
                  : copy.title}
              {perCurrency ? ` · ${line.currency}` : ""}
            </strong>
            <span>
              {perCurrency
                ? "Contas nesta moeda; moedas diferentes não são somadas"
                : pagination
                  ? `${rows.length} nesta página de ${countLabel(pagination.totalItems, copy.singular, copy.plural)} no filtro`
                  : reportEntitySummary(rows, copy)}
            </span>
          </td>
          <SummaryMetricsCells
            currency={line.currency}
            metricGroup={metricGroup}
            rateGap={line.rateGap}
            totals={line.totals}
          />
          <td className="performance-review-cell" data-label="Revisão WhatsApp">
            <span className="tag">{perCurrency ? line.currency : "Total"}</span>
          </td>
        </tr>
      ))}
    </tfoot>
  );
}

function ReportPagination({
  copy,
  filters,
  pagination,
  view,
}: {
  copy: ReportEntityCopy;
  filters: ReportFilters;
  pagination?: ReportPaginationDto;
  view: ReportView;
}) {
  if (!pagination) {
    return null;
  }

  return (
    <nav
      className="report-pagination"
      aria-label={`Paginação de ${copy.plural}`}
    >
      <span>
        Página {pagination.page} de {Math.max(pagination.totalPages, 1)} -{" "}
        {pagination.totalItems} {copy.plural}
      </span>
      <div>
        {pagination.page > 1 ? (
          <Link
            className="button ghost"
            href={reportPageHref(view, filters, pagination.page - 1)}
          >
            Anterior
          </Link>
        ) : (
          <span className="button ghost disabled" aria-disabled="true">
            Anterior
          </span>
        )}
        {pagination.page < pagination.totalPages ? (
          <Link
            className="button ghost"
            href={reportPageHref(view, filters, pagination.page + 1)}
          >
            Próxima
          </Link>
        ) : (
          <span className="button ghost disabled" aria-disabled="true">
            Próxima
          </span>
        )}
      </div>
    </nav>
  );
}

function deltaLabel(current: number, previous: number): string {
  if (previous === 0) {
    return current === 0 ? "0%" : "sem base";
  }

  const delta = ((current - previous) / previous) * 100;
  const sign = delta > 0 ? "+" : "";

  return `${sign}${Math.round(delta)}%`;
}

function comparisonDeltaLabel(
  current: number | null,
  previous: number | null,
): string {
  if (current === null || previous === null) {
    return "-";
  }

  return deltaLabel(current, previous);
}

function ComparisonMetric({
  label,
  current,
  previous,
  format = String,
}: {
  label: string;
  current: number | null;
  previous: number | null;
  format?: (value: number) => string;
}) {
  const currentValue = current === null ? "-" : format(current);
  const previousValue = previous === null ? "-" : format(previous);

  return (
    <div className="metric-card">
      <span className="micro-label">{label}</span>
      <strong>{currentValue}</strong>
      <span>
        Período comparado {previousValue} /{" "}
        {comparisonDeltaLabel(current, previous)}
      </span>
    </div>
  );
}

function ReportComparisonMetrics({
  currency,
  current: currentTotals,
  metricGroup,
  mixedCurrency = false,
  previous: previousTotals,
}: {
  currency: CurrencyCode;
  current: ReportTotals;
  metricGroup: ReportMetricGroup;
  /** Um dos períodos mistura moedas: a comparação em dinheiro não aparece. */
  mixedCurrency?: boolean;
  previous: ReportTotals;
}) {
  const money = (cents: number) => formatReportMoney(cents, currency);
  const hideMoney = (totals: ReportTotals): ReportTotals =>
    mixedCurrency
      ? ({
          ...totals,
          spendCents: null,
          trafficRevenueCents: null,
          firstPurchaseRevenueCents: null,
          repurchaseRevenueCents: null,
          roasAcquisition: null,
        } as unknown as ReportTotals)
      : totals;
  const current = hideMoney(currentTotals);
  const previous = hideMoney(previousTotals);

  if (metricGroup === "traffic") {
    return (
      <>
        <ComparisonMetric
          label="Investimento"
          current={current.spendCents}
          previous={previous.spendCents}
          format={money}
        />
        <ComparisonMetric
          label="Conversas Meta"
          current={current.metaConversationsStarted}
          previous={previous.metaConversationsStarted}
        />
        <ComparisonMetric
          label="Leads novos"
          current={current.realConversations}
          previous={previous.realConversations}
        />
        <ComparisonMetric
          label="Cobertura"
          current={current.trackingRate}
          previous={previous.trackingRate}
          format={percent}
        />
      </>
    );
  }

  if (metricGroup === "funnel") {
    return (
      <>
        <ComparisonMetric
          label="Leads novos"
          current={current.realConversations}
          previous={previous.realConversations}
        />
        <ComparisonMetric
          label="Lead qualificado"
          current={current.qualifiedLead}
          previous={previous.qualifiedLead}
        />
        <ComparisonMetric
          label="Compras"
          current={current.purchases}
          previous={previous.purchases}
        />
        <ComparisonMetric
          label="Primeira compra"
          current={current.firstPurchases}
          previous={previous.firstPurchases}
        />
        <ComparisonMetric
          label="Recompra"
          current={current.repurchases}
          previous={previous.repurchases}
        />
      </>
    );
  }

  if (metricGroup === "revenue") {
    return (
      <>
        <ComparisonMetric
          label="Investimento"
          current={current.spendCents}
          previous={previous.spendCents}
          format={money}
        />
        <ComparisonMetric
          label="Receita tráfego"
          current={current.trafficRevenueCents}
          previous={previous.trafficRevenueCents}
          format={money}
        />
        <ComparisonMetric
          label="Receita primeira compra"
          current={current.firstPurchaseRevenueCents}
          previous={previous.firstPurchaseRevenueCents}
          format={money}
        />
        <ComparisonMetric
          label="Receita recompra"
          current={current.repurchaseRevenueCents}
          previous={previous.repurchaseRevenueCents}
          format={money}
        />
        <ComparisonMetric
          label="ROAS aquisição"
          current={current.roasAcquisition}
          previous={previous.roasAcquisition}
          format={roas}
        />
      </>
    );
  }

  return (
    <>
      <ComparisonMetric
        label="Investimento"
        current={current.spendCents}
        previous={previous.spendCents}
        format={money}
      />
      <ComparisonMetric
        label="Conversas Meta"
        current={current.metaConversationsStarted}
        previous={previous.metaConversationsStarted}
      />
      <ComparisonMetric
        label="Leads novos"
        current={current.realConversations}
        previous={previous.realConversations}
      />
      <ComparisonMetric
        label="Receita tráfego"
        current={current.trafficRevenueCents}
        previous={previous.trafficRevenueCents}
        format={money}
      />
      <ComparisonMetric
        label="ROAS aquisição"
        current={current.roasAcquisition}
        previous={previous.roasAcquisition}
        format={roas}
      />
    </>
  );
}

function reportSummaryMetrics(
  metricGroup: ReportMetricGroup,
  totals: ReportTotals,
  currency: CurrencyCode = "BRL",
  mixedCurrency = false,
  rateMissing = false,
): Array<{ detail: string; label: string; value: string }> {
  // Moedas misturadas: dinheiro e ROAS ficam nos blocos por moeda, abaixo.
  const money = (cents: number) =>
    mixedCurrency ? "Por moeda" : formatReportMoney(cents, currency);
  const roas = (value: number | null) =>
    mixedCurrency
      ? "Por moeda"
      : rateMissing
        ? exchangeRateMissingLabel
        : roasText(value);

  if (metricGroup === "traffic") {
    return [
      {
        detail: "Período filtrado",
        label: "Investimento",
        value: money(totals.spendCents),
      },
      {
        detail: "Registradas pela Meta",
        label: "Conversas Meta",
        value: String(totals.metaConversationsStarted),
      },
      {
        detail: "1º contato no período",
        label: "Leads novos",
        value: String(totals.realConversations),
      },
      {
        detail: `${totals.totalReceived} recebidas`,
        label: "Cobertura",
        value: percent(totals.trackingRate),
      },
    ];
  }

  if (metricGroup === "funnel") {
    return [
      {
        detail: "1º contato no período",
        label: "Leads novos",
        value: String(totals.realConversations),
      },
      {
        detail: "Avançaram no funil",
        label: "Leads qualificados",
        value: String(totals.qualifiedLead),
      },
      {
        detail: "Conversões registradas",
        label: "Compras",
        value: String(totals.purchases),
      },
      {
        detail: `${totals.repurchases} recompra(s)`,
        label: "Primeiras compras",
        value: String(totals.firstPurchases),
      },
    ];
  }

  if (metricGroup === "revenue") {
    return [
      {
        detail: "Mídia no período",
        label: "Investimento",
        value: money(totals.spendCents),
      },
      {
        detail: "Atribuída ao tráfego",
        label: "Receita",
        value: money(totals.trafficRevenueCents),
      },
      {
        detail: "Receita de aquisição",
        label: "Primeira compra",
        value: money(totals.firstPurchaseRevenueCents),
      },
      {
        detail: "Retorno de aquisição",
        label: "ROAS",
        value: roas(totals.roasAcquisition),
      },
    ];
  }

  return [
    {
      detail: "Período filtrado",
      label: "Investimento",
      value: money(totals.spendCents),
    },
    {
      detail: "Registradas pela Meta",
      label: "Conversas Meta",
      value: String(totals.metaConversationsStarted),
    },
    {
      detail: "1º contato no período",
      label: "Leads novos",
      value: String(totals.realConversations),
    },
    {
      detail: "Retorno de aquisição",
      label: "ROAS",
      value: roas(totals.roasAcquisition),
    },
  ];
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams?: Promise<ReportsSearchParams>;
}) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const requestedSince = asStringParam(resolvedSearchParams.since);
  const requestedUntil = asStringParam(resolvedSearchParams.until);
  const compareSince = asStringParam(resolvedSearchParams.compareSince);
  const compareUntil = asStringParam(resolvedSearchParams.compareUntil);
  const businessId = asStringParam(resolvedSearchParams.businessId);
  const adAccountId =
    joinAdAccountIds(
      parseAdAccountIdsParam(
        resolvedSearchParams.adAccountId,
        resolvedSearchParams.adAccountIds,
      ),
    ) || undefined;
  const whatsappInstanceId = asStringParam(
    resolvedSearchParams.whatsappInstanceId,
  );
  const campaignId = asStringParam(resolvedSearchParams.campaignId);
  const adSetId = asStringParam(resolvedSearchParams.adSetId);
  const adId = asStringParam(resolvedSearchParams.adId);
  const nameScope = asStringParam(resolvedSearchParams.nameScope);
  const nameContains = asStringParam(resolvedSearchParams.nameContains);
  const status = asStringParam(resolvedSearchParams.status);
  const delivery = reportDeliveryFilter(
    asStringParam(resolvedSearchParams.delivery),
  );
  const selectedIds = selectedIdsParam(
    asStringParam(resolvedSearchParams.selectedIds),
  );
  const activeView = reportView(asStringParam(resolvedSearchParams.view));
  const activeMode = reportMode(asStringParam(resolvedSearchParams.mode));
  const insightObjective = parseReportInsightObjective(
    asStringParam(resolvedSearchParams.objective),
  );
  const showTable = activeMode === "table";
  const activeMetricGroup = reportMetricGroup(
    asStringParam(resolvedSearchParams.metrics),
  );
  const page = positiveIntegerParam(
    asStringParam(resolvedSearchParams.page),
    1,
  );
  const sort = parseReportSort(
    asStringParam(resolvedSearchParams.sort),
    asStringParam(resolvedSearchParams.dir),
    activeMetricGroup,
  );
  const pageSize = Math.min(
    positiveIntegerParam(asStringParam(resolvedSearchParams.pageSize), 10),
    100,
  );
  const structureNameContains = asStringParam(
    resolvedSearchParams.structureNameContains,
  );
  const structureNameScopeValue = structureNameScope(
    asStringParam(resolvedSearchParams.structureNameScope),
  );
  const structureStatusValue = structureStatusFilter(
    asStringParam(resolvedSearchParams.structureStatus),
  );
  const whatsappClassification = asStringParam(
    resolvedSearchParams.whatsappClassification,
  );
  const notice = asStringParam(resolvedSearchParams.notice);
  const diagnosticRequested =
    asStringParam(resolvedSearchParams.diagnostic) === "open";
  const pageNotice = reportsNotice(notice);
  const requestedReportFilters = {
    since: requestedSince,
    until: requestedUntil,
    compareSince,
    compareUntil,
    businessId,
    adAccountId,
    whatsappInstanceId,
    campaignId,
    adSetId,
    adId,
    nameScope,
    nameContains,
    page,
    pageSize,
    status,
    delivery,
    selectedIds,
    sort,
    whatsappClassification,
    metrics: activeMetricGroup,
    mode: activeMode,
    objective: insightObjective,
  };
  const structureFilters: MetaStructureFilters = {
    nameContains: structureNameContains,
    nameScope: structureNameScopeValue,
    status: structureStatusValue,
  };
  const structureFiltersApplied = Boolean(
    structureNameContains || structureStatusValue !== "all",
  );
  const shouldLoadMetaStructure =
    diagnosticRequested || structureFiltersApplied;
  const hasComparison = Boolean(
    showTable && activeView === "campaigns" && compareSince && compareUntil,
  );
  const [
    campaignReports,
    adSetReports,
    adReports,
    insightReports,
    currentWorkspaceResult,
    comparisonReports,
    metaAssets,
    whatsappInstances,
    metaStructure,
    adAccountCurrencies,
  ] = await Promise.all([
    showTable && activeView === "campaigns"
      ? getCampaignReports(requestedReportFilters)
      : Promise.resolve(null),
    showTable && activeView === "adsets"
      ? getAdSetReports(requestedReportFilters)
      : Promise.resolve(null),
    showTable && activeView === "ads"
      ? getAdReports(requestedReportFilters)
      : Promise.resolve(null),
    showTable
      ? Promise.resolve(null)
      : getReportInsights(activeView, requestedReportFilters, insightObjective),
    getCurrentWorkspaceResource(),
    hasComparison
      ? getCampaignReports({
          ...requestedReportFilters,
          since: compareSince,
          until: compareUntil,
          page: undefined,
          pageSize: undefined,
          sort: undefined,
        })
      : Promise.resolve(null),
    getMetaAssets(),
    getWhatsappInstances(),
    shouldLoadMetaStructure ? getMetaStructureReport() : Promise.resolve(null),
    getAdAccountCurrencies(),
  ]);
  const accountCurrencies = adAccountCurrencyMap(
    (metaAssets?.reportingAccounts ?? []).filter((account) => account.active),
    adAccountCurrencies,
  );
  const loadedReport =
    campaignReports?.report ??
    adSetReports?.report ??
    adReports?.report ??
    insightReports?.report ??
    undefined;
  const since = requestedSince ?? loadedReport?.since ?? undefined;
  const until = requestedUntil ?? loadedReport?.until ?? undefined;
  const reportFilters = {
    ...requestedReportFilters,
    since,
    until,
  };
  const hasWhatsappInstanceFilter = Boolean(whatsappInstanceId);
  const appliedFilterValues = {
    since: since ?? "",
    until: until ?? "",
    compareSince: compareSince ?? "",
    compareUntil: compareUntil ?? "",
    businessId: businessId ?? "",
    adAccountId: adAccountId ?? "",
    whatsappInstanceId: whatsappInstanceId ?? "",
    campaignId: campaignId ?? "",
    adSetId: adSetId ?? "",
    adId: adId ?? "",
    nameContains: nameContains ?? "",
    nameScope: nameScope ?? "",
    status: status ?? "",
    delivery,
    selectedIds: selectedIds ?? "",
    whatsappClassification: whatsappClassification ?? "",
    pageSize: String(pageSize),
    metrics: activeMetricGroup,
    view: activeView,
    mode: activeMode === "insights" ? activeMode : "",
    objective: activeMode === "insights" ? insightObjective : "",
    sort: sort?.key ?? "",
    dir: sort?.direction ?? "",
  };
  const metaMetricsAreCampaignExclusive =
    campaignReports?.report.metaMetricsScope === "campaign";
  const rows = campaignReports?.report.campaigns ?? [];
  const adSetRows = adSetReports?.report.adSets ?? [];
  const adRows = adReports?.report.ads ?? [];
  const selectedCampaignName =
    rows.find((row) => row.id === campaignId)?.name ??
    adSetRows.find((row) => row.campaignId === campaignId)?.campaignName ??
    adRows.find((row) => row.campaignId === campaignId)?.campaignName ??
    campaignId;
  const selectedAdSetName =
    adSetRows.find((row) => row.id === adSetId)?.name ??
    adRows.find((row) => row.adSetId === adSetId)?.adSetName ??
    adSetId;
  const selectedAdName = adRows.find((row) => row.id === adId)?.name ?? adId;
  const hierarchySelection = [
    selectedCampaignName
      ? { label: "Campanha", value: selectedCampaignName }
      : null,
    selectedAdSetName ? { label: "Conjunto", value: selectedAdSetName } : null,
    selectedAdName ? { label: "Anúncio", value: selectedAdName } : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item));
  const clearHierarchyHref = reportViewHref("campaigns", {
    ...reportFilters,
    campaignId: undefined,
    adSetId: undefined,
    adId: undefined,
    selectedIds: undefined,
    page: 1,
  });
  const activeRows: PerformanceRow[] =
    activeView === "campaigns"
      ? rows
      : activeView === "adsets"
        ? adSetRows
        : adRows;
  const activeSelectedIds = selectedIds?.split(",") ?? [];
  const activeSelectionLevel = reportSelectionLevel(activeView);
  const reportState =
    campaignReports?.state ??
    adSetReports?.state ??
    adReports?.state ??
    (insightReports?.report ? "real" : "error");
  const rangeLabel =
    campaignReports?.report.rangeLabel ??
    adSetReports?.report.rangeLabel ??
    adReports?.report.rangeLabel ??
    insightReports?.report?.rangeLabel ??
    "API indisponível";
  const pagination: ReportPaginationDto | undefined =
    campaignReports?.report.pagination ??
    adSetReports?.report.pagination ??
    adReports?.report.pagination ??
    insightReports?.report?.pagination;
  const currentTotals: ReportTotals =
    campaignReports?.report.totals ??
    adSetReports?.report.totals ??
    adReports?.report.totals ??
    insightReports?.report?.totals ??
    reportTotals(activeRows);
  // Uma moeda no filtro (tudo igual a antes) ou um grupo por moeda, nunca
  // somados. As linhas sempre trazem a moeda da própria conta de anúncio.
  const activeCurrency = reportCurrency(loadedReport);
  const activeCurrencyGroups = mixedCurrencyGroups(loadedReport);
  const mixedCurrency = activeCurrencyGroups.length > 0;
  const activeRateGap = mixedCurrency
    ? noRateGap
    : singleCurrencyRateGap(loadedReport);
  const summaryMetrics = reportSummaryMetrics(
    activeMetricGroup,
    currentTotals,
    activeCurrency,
    mixedCurrency,
    activeRateGap.exchangeRateMissing,
  );
  const metaSummary = metaStructureSummary(metaStructure, metaAssets);
  const metaSyncPeriod = metaSyncPeriodState(metaAssets);
  const requestedPeriodLabel =
    since && until ? periodLabel(since, until) : rangeLabel;
  const metaPeriodMatchesReport =
    metaSyncPeriod.kind === "single" &&
    metaSyncPeriod.since === since &&
    metaSyncPeriod.until === until;
  const metaPeriodCoversReport = metaSyncCoversPeriod(metaAssets, since, until);
  const metaPeriodProvidesReport =
    activeView === "campaigns"
      ? metaPeriodCoversReport
      : metaPeriodMatchesReport;
  const rawMetaStructureRows = metaStructureRows(metaStructure);
  const filteredMetaStructureRows = filterMetaStructureRows(
    rawMetaStructureRows,
    structureFilters,
  );
  const comparisonTotals = comparisonReports
    ? (comparisonReports.report.totals ??
      reportTotals(comparisonReports.report.campaigns))
    : null;
  const canSyncMetaReports = Boolean(
    currentWorkspaceResult.data?.permissions?.canManageIntegrations,
  );
  const workspacePermissionsUnavailable =
    currentWorkspaceResult.state === "error";
  const currentWorkspaceId =
    currentWorkspaceResult.data?.id ?? loadedReport?.workspaceId ?? "unknown";
  const syncCampaignHint = canSyncMetaReports
    ? "Use Sincronizar Meta para carregar campanhas reais."
    : workspacePermissionsUnavailable
      ? "Não foi possível confirmar as permissões agora."
      : "A sincronização Meta depende de owner ou admin.";
  const syncAdSetHint = canSyncMetaReports
    ? "Use Sincronizar Meta para carregar conjuntos reais."
    : workspacePermissionsUnavailable
      ? "Não foi possível confirmar as permissões agora."
      : "A sincronização Meta depende de owner ou admin.";
  const syncAdHint = canSyncMetaReports
    ? "Use Sincronizar Meta para carregar anúncios reais."
    : workspacePermissionsUnavailable
      ? "Não foi possível confirmar as permissões agora."
      : "A sincronização Meta depende de owner ou admin.";
  const syncStructureHint = canSyncMetaReports
    ? "Use o botão Sincronizar Meta para enfileirar a leitura."
    : workspacePermissionsUnavailable
      ? "Não foi possível confirmar as permissões agora."
      : "A leitura da estrutura Meta depende de owner ou admin.";
  const emptyStructureTitle = rawMetaStructureRows.length
    ? "Nenhuma estrutura encontrada"
    : "Nenhuma estrutura Meta sincronizada";
  const emptyStructureHint = rawMetaStructureRows.length
    ? "Ajuste os filtros da estrutura técnica para ver outros itens sincronizados."
    : syncStructureHint;
  const clearStructureParams = applyReportUiParams(
    new URLSearchParams(reportQuery(reportFilters, true)),
    reportFilters,
  );
  clearStructureParams.set("view", activeView);
  clearStructureParams.set("diagnostic", "open");
  const clearStructureHref = `/reports?${clearStructureParams.toString()}`;
  const diagnosticHref = clearStructureHref;
  const noReviewPermission = workspacePermissionsUnavailable
    ? "Permissões indisponíveis"
    : "Sem permissão para revisar";
  const reportTitle = (
    showTable
      ? {
          ads: "Performance por anúncio",
          adsets: "Performance por conjunto",
          campaigns: "Performance por campanha",
        }
      : {
          ads: "Insights por anúncio",
          adsets: "Insights por conjunto",
          campaigns: "Insights por campanha",
        }
  )[activeView];
  const insightSorts = reportInsightSorts(insightObjective);
  const insightObjectiveLinks = reportInsightObjectiveKeys.map((objective) => ({
    href: reportViewHref(activeView, { ...reportFilters, objective }),
    objective,
  }));
  const insightEntityHref = (row: ReportInsightRow) => {
    if (activeView === "campaigns") {
      return reportViewHref("adsets", {
        ...reportFilters,
        campaignId: row.id,
        adSetId: undefined,
        adId: undefined,
        page: 1,
        selectedIds: undefined,
      });
    }

    if (activeView === "adsets") {
      return reportViewHref("ads", {
        ...reportFilters,
        campaignId: row.campaignId,
        adSetId: row.id,
        adId: undefined,
        page: 1,
        selectedIds: undefined,
      });
    }

    return undefined;
  };
  const activeCopy = {
    ads: adSummaryCopy,
    adsets: adSetSummaryCopy,
    campaigns: campaignSummaryCopy,
  }[activeView];
  const sortColumn = (step: ReportFunnelStepDto) =>
    reportSortColumn(activeView, reportFilters, step);
  const mobileSortActions = visibleReportFunnelSteps(
    currentTotals.funnelSteps,
    activeMetricGroup,
  ).flatMap((step) => {
    const column = sortColumn(step);

    return column ? [column.count, column.cost] : [];
  });
  const activeMetricLabel = {
    funnel: "Funil",
    overview: "Visão geral",
    revenue: "Receita",
    traffic: "Tráfego",
  }[activeMetricGroup];
  const metaPeriodWarning: ReportNotice | null =
    metaSyncPeriod.kind === "none" || metaPeriodProvidesReport
      ? null
      : metaSyncPeriod.kind === "single"
        ? {
            tone: "warn",
            title: "Período Meta diferente do relatório",
            message: `O relatório está em ${requestedPeriodLabel}, mas o investimento salvo veio de ${periodLabel(metaSyncPeriod.since, metaSyncPeriod.until)}. Sincronize a Meta para alinhar os valores.`,
          }
        : metaSyncPeriod.kind === "mixed"
          ? {
              tone: "warn",
              title: "Contas Meta com períodos diferentes",
              message:
                "Sincronize a Meta neste período para alinhar todas as contas antes de comparar os totais.",
            }
          : {
              tone: "warn",
              title: "Período da última sincronização ainda não registrado",
              message: `Sincronize a Meta para confirmar o investimento de ${requestedPeriodLabel}.`,
            };

  return (
    <section className="page-stack page-wide reports-page">
      <header className="page-header reports-page-header">
        <span className="eyebrow">Relatórios</span>
        <h1>{reportTitle}</h1>
        <p>
          Métricas Meta Ads combinadas com leads reais e eventos de conversão.
        </p>
        <nav
          aria-label="Modo do relatório"
          className="report-view-tabs report-mode-tabs"
        >
          {(
            [
              ["table", "Tabela"],
              ["insights", "Insights"],
            ] as const
          ).map(([mode, label]) => (
            <Link
              aria-current={activeMode === mode ? "page" : undefined}
              className={activeMode === mode ? "active" : ""}
              href={reportViewHref(activeView, { ...reportFilters, mode })}
              key={mode}
            >
              {label}
            </Link>
          ))}
        </nav>
      </header>

      <section
        className="surface-panel report-control-center"
        aria-label="Controles do relatório"
      >
        <ReportFiltersProvider applied={appliedFilterValues}>
          <div className="report-toolbar">
            <div
              className="report-toolbar-group report-toolbar-period"
              role="group"
              aria-label="Período"
            >
              <span className="micro-label report-group-label">Período</span>
              <ReportPeriodFilter periodLabel={requestedPeriodLabel} />
            </div>

            <div
              className="report-toolbar-group report-toolbar-scope"
              role="group"
              aria-label="Escopo"
            >
              <div className="report-analysis-switcher">
                <span className="micro-label report-group-label">Escopo</span>
                <nav
                  className="report-view-tabs"
                  aria-label="Nível do relatório"
                >
                  {(
                    [
                      ["campaigns", "Campanhas"],
                      ["adsets", "Conjuntos"],
                      ["ads", "Anúncios"],
                    ] as const
                  ).map(([view, label]) => (
                    <Link
                      aria-current={activeView === view ? "page" : undefined}
                      className={activeView === view ? "active" : ""}
                      href={reportViewHref(view, {
                        ...reportFilters,
                        selectedIds:
                          view === activeView
                            ? reportFilters.selectedIds
                            : undefined,
                      })}
                      key={view}
                    >
                      {label}
                    </Link>
                  ))}
                </nav>
                <span className="tag report-scope-count">
                  {pagination?.totalItems ?? activeRows.length}{" "}
                  {activeCopy.plural}
                </span>
                <div className="report-analysis-meta">
                  <ReportSelectionToolbar
                    activeSelectedIds={activeSelectedIds}
                    filterActive={Boolean(selectedIds)}
                    level={activeSelectionLevel}
                    workspaceId={currentWorkspaceId}
                  />
                </div>
              </div>

              <MetaReportFilters
                accountCurrencies={accountCurrencies}
                assets={metaAssets}
                whatsappInstances={whatsappInstances}
              />
            </div>

            <div
              className="report-toolbar-group report-toolbar-actions"
              role="group"
              aria-label="Ações"
            >
              <span className="micro-label report-group-label">Ações</span>
              <div className="report-command-actions">
                {reportState === "error" ? (
                  <span className="tag">API indisponível</span>
                ) : null}
                {/* Plain <a>: the target is a route handler (a CSV download),
                    so a Next <Link> would prefetch it as a page and 404. */}
                <a
                  className="button ghost"
                  href={reportExportHref(reportFilters, activeView)}
                >
                  <Download aria-hidden="true" size={16} />
                  Exportar CSV
                </a>
                <div className="report-sync-action">
                  {canSyncMetaReports ? (
                    <form action={syncMetaReports}>
                      <input type="hidden" name="view" value={activeView} />
                      <input
                        type="hidden"
                        name="metrics"
                        value={activeMetricGroup}
                      />
                      <input type="hidden" name="pageSize" value={pageSize} />
                      <input type="hidden" name="since" value={since ?? ""} />
                      <input type="hidden" name="until" value={until ?? ""} />
                      <input
                        type="hidden"
                        name="compareSince"
                        value={compareSince ?? ""}
                      />
                      <input
                        type="hidden"
                        name="compareUntil"
                        value={compareUntil ?? ""}
                      />
                      <input
                        type="hidden"
                        name="businessId"
                        value={businessId ?? ""}
                      />
                      <AdAccountHiddenInput value={adAccountId} />
                      <input
                        type="hidden"
                        name="whatsappInstanceId"
                        value={whatsappInstanceId ?? ""}
                      />
                      <input
                        type="hidden"
                        name="campaignId"
                        value={campaignId ?? ""}
                      />
                      <input
                        type="hidden"
                        name="adSetId"
                        value={adSetId ?? ""}
                      />
                      <input type="hidden" name="adId" value={adId ?? ""} />
                      <input
                        type="hidden"
                        name="nameScope"
                        value={nameScope ?? ""}
                      />
                      <input
                        type="hidden"
                        name="nameContains"
                        value={nameContains ?? ""}
                      />
                      <input type="hidden" name="status" value={status ?? ""} />
                      <input type="hidden" name="delivery" value={delivery} />
                      <input
                        type="hidden"
                        name="selectedIds"
                        value={selectedIds ?? ""}
                      />
                      <input
                        type="hidden"
                        name="whatsappClassification"
                        value={whatsappClassification ?? ""}
                      />
                      <ReportSortHiddenInputs sort={sort} />
                      <ReportModeHiddenInputs
                        mode={activeMode}
                        objective={insightObjective}
                      />
                      <SubmitButton
                        className="button ghost"
                        pendingLabel="Sincronizando..."
                        statusText="Enfileirando leitura dos dados Meta."
                      >
                        <RefreshCcw aria-hidden="true" size={16} />
                        Sincronizar Meta
                      </SubmitButton>
                    </form>
                  ) : (
                    <span className="tag">
                      {workspacePermissionsUnavailable
                        ? "Permissões indisponíveis"
                        : "Sem permissão para sincronizar Meta"}
                    </span>
                  )}
                  {metaSyncPeriod.kind === "single" ? (
                    <small
                      className="report-sync-hint"
                      title={`Janela já sincronizada da Meta: ${periodLabel(metaSyncPeriod.since, metaSyncPeriod.until)}`}
                    >
                      Meta:{" "}
                      {periodLabel(metaSyncPeriod.since, metaSyncPeriod.until)}
                    </small>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </ReportFiltersProvider>
      </section>

      {pageNotice ? (
        <div className={`feedback-banner ${pageNotice.tone}`} role="status">
          <strong>{pageNotice.title}</strong>
          <span>{pageNotice.message}</span>
        </div>
      ) : null}

      {hasWhatsappInstanceFilter ? (
        <div className="feedback-banner warn" role="status">
          <strong>Escopo do número WhatsApp</strong>
          <span>
            {metaMetricsAreCampaignExclusive
              ? "Leads, conversas e métricas Meta correspondem ao número selecionado: a API confirmou campanha exclusiva."
              : "Leads e conversas reais estão filtrados por este número. Investimento, impressões e demais métricas Meta continuam no escopo da campanha ou conta, não por número."}
          </span>
        </div>
      ) : null}

      {metaPeriodWarning ? (
        <div
          className={`feedback-banner ${metaPeriodWarning.tone}`}
          role="status"
        >
          <strong>{metaPeriodWarning.title}</strong>
          <span>{metaPeriodWarning.message}</span>
        </div>
      ) : null}

      {reportState !== "error" ? (
        <MetaSyncCoverageNotice
          action={canSyncMetaReports ? "Use Sincronizar Meta acima." : undefined}
          coverage={loadedReport?.metaSyncCoverage}
        />
      ) : null}

      {hierarchySelection.length > 0 ? (
        <div className="report-scope-bar" aria-label="Hierarquia selecionada">
          <div>
            <span className="micro-label">Seleção atual</span>
            {hierarchySelection.map((item) => (
              <span className="report-scope-item" key={item.label}>
                <small>{item.label}</small>
                <strong>
                  <PresentationMask
                    placeholder={
                      item.label === "Campanha"
                        ? "Campanha oculta"
                        : item.label === "Conjunto"
                          ? "Conjunto oculto"
                          : "Anúncio oculto"
                    }
                  >
                    {item.value}
                  </PresentationMask>
                </strong>
              </span>
            ))}
          </div>
          <Link className="button ghost" href={clearHierarchyHref}>
            Limpar seleção
          </Link>
        </div>
      ) : null}

      {insightReports ? (
        <ReportInsightsPanel
          cost={insightReports.cost}
          costTableHref={reportInsightTableHref(
            activeView,
            reportFilters,
            insightSorts.cost,
          )}
          entityHref={insightEntityHref}
          level={activeView}
          objective={insightObjective}
          objectiveLinks={insightObjectiveLinks}
          periodLabel={requestedPeriodLabel}
          volume={insightReports.volume}
          volumeTableHref={reportInsightTableHref(
            activeView,
            reportFilters,
            insightSorts.volume,
          )}
        />
      ) : null}

      {showTable ? (
        <section
          className="report-results-overview"
          aria-label="Resumo dos resultados filtrados"
        >
          <div className="report-results-heading">
            <div className="report-results-title">
              <BarChart3 aria-hidden="true" size={20} />
              <div>
                <span className="eyebrow">Resultados</span>
                <h2>{activeMetricLabel}</h2>
              </div>
            </div>
            <nav className="report-metric-tabs" aria-label="Grupo de métricas">
              {(
                [
                  ["overview", "Visão geral"],
                  ["traffic", "Tráfego"],
                  ["funnel", "Funil"],
                  ["revenue", "Receita"],
                ] as const
              ).map(([metricGroup, label]) => (
                <Link
                  aria-current={
                    activeMetricGroup === metricGroup ? "page" : undefined
                  }
                  className={activeMetricGroup === metricGroup ? "active" : ""}
                  href={reportMetricGroupHref(
                    metricGroup,
                    activeView,
                    reportFilters,
                  )}
                  key={metricGroup}
                >
                  {label}
                </Link>
              ))}
            </nav>
          </div>

          <div className="report-summary-strip">
            {summaryMetrics.map((metric) => (
              <article key={metric.label}>
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
                <small>{metric.detail}</small>
              </article>
            ))}
          </div>

          {mixedCurrency ? (
            <CurrencyKpiGroups
              groups={activeCurrencyGroups.map(currencyKpiGroup)}
            />
          ) : activeRateGap.exchangeRateMissing ? (
            <ExchangeRateMissingNote
              unconvertedRevenue={activeRateGap.unconvertedRevenue}
            />
          ) : null}
        </section>
      ) : null}

      {comparisonReports && comparisonTotals ? (
        <details className="surface-panel report-comparison-panel">
          <summary>
            <span>
              <span className="eyebrow">Comparação entre períodos</span>
              <strong>
                Período atual vs. {comparisonReports.report.rangeLabel}
              </strong>
            </span>
            <span className="tag">Abrir comparação</span>
          </summary>
          <div className="metric-grid compact report-comparison-grid">
            <ReportComparisonMetrics
              currency={activeCurrency}
              current={currentTotals}
              metricGroup={activeMetricGroup}
              mixedCurrency={
                mixedCurrency ||
                mixedCurrencyGroups(comparisonReports.report).length > 0
              }
              previous={comparisonTotals}
            />
          </div>
        </details>
      ) : null}

      {activeRows.length > 0 ? (
        <ReportSortToolbar actions={mobileSortActions} />
      ) : null}

      {showTable && activeView === "campaigns" ? (
        <div className="table-wrap report-table-scroll">
          <table
            className="performance-table"
            data-metric-group={activeMetricGroup}
          >
            <thead>
              <tr>
                <th>
                  <span className="performance-entity-heading">
                    <ReportPageSelectionCheckbox
                      activeSelectedIds={activeSelectedIds}
                      entityIds={rows.map((row) => row.id)}
                      entityLabel="campanhas"
                      filterActive={Boolean(selectedIds)}
                      level="campaign"
                      workspaceId={currentWorkspaceId}
                    />
                    Campanha
                  </span>
                </th>
                <PerformanceMetricHeaders
                  funnelSteps={currentTotals.funnelSteps}
                  metricGroup={activeMetricGroup}
                  sortColumn={sortColumn}
                />
                <th className="performance-review-column">Revisão WhatsApp</th>
              </tr>
            </thead>
            <tbody>
              {rows.length > 0 ? (
                rows.map((row) => (
                  <tr
                    className={
                      campaignId === row.id ? "is-selected" : undefined
                    }
                    key={row.id}
                  >
                    <td className="performance-name-cell" data-label="Campanha">
                      <div className="performance-entity-heading">
                        <ReportSelectionCheckbox
                          activeSelectedIds={activeSelectedIds}
                          entityId={row.id}
                          entityLabel={row.name}
                          filterActive={Boolean(selectedIds)}
                          level="campaign"
                          workspaceId={currentWorkspaceId}
                        />
                        <strong>
                          <Link
                            href={reportViewHref("adsets", {
                              ...reportFilters,
                              campaignId: row.id,
                              adSetId: undefined,
                              adId: undefined,
                              page: 1,
                              selectedIds: undefined,
                            })}
                          >
                            <PresentationMask placeholder="Campanha oculta">
                              {row.name}
                            </PresentationMask>
                          </Link>
                        </strong>
                      </div>
                      <MetaEntityControls
                        currency={rowCurrency(row, activeCurrency)}
                        action={updateMetaEntity}
                        budget={row.budget}
                        canManage={canSyncMetaReports}
                        configuredStatus={row.configuredStatus}
                        effectiveStatus={row.effectiveStatus}
                        id={row.id}
                        level="campaign"
                        name={row.name}
                      />
                    </td>
                    <PerformanceMetricsCells
                      currency={activeCurrency}
                      funnelSteps={currentTotals.funnelSteps}
                      metricGroup={activeMetricGroup}
                      row={row}
                      realConversationsHref={leadsHref({
                        campaignId: row.id,
                        since,
                        until,
                        compareSince,
                        compareUntil,
                        businessId,
                        adAccountId,
                        whatsappClassification,
                      })}
                    />
                    <td
                      className="performance-review-cell"
                      data-label="Revisão WhatsApp"
                    >
                      {canSyncMetaReports ? (
                        <WhatsappReviewActions
                          action={saveWhatsappClassification}
                          classification={row.whatsappClassification}
                          level="campaign"
                          id={row.id}
                        />
                      ) : (
                        <span className="tag">{noReviewPermission}</span>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="performance-name-cell" data-label="Campanha">
                    <strong>
                      {reportState === "error"
                        ? "Não foi possível carregar campanhas"
                        : "Nenhuma campanha sincronizada"}
                    </strong>
                    <span>
                      {reportState === "error"
                        ? "Confira a API antes de analisar performance."
                        : syncCampaignHint}
                    </span>
                  </td>
                  <EmptyPerformanceCells
                    currency={activeCurrency}
                    funnelSteps={currentTotals.funnelSteps}
                    metricGroup={activeMetricGroup}
                  />
                  <td
                    className="performance-review-cell"
                    data-label="Revisão WhatsApp"
                  >
                    -
                  </td>
                </tr>
              )}
            </tbody>
            <PerformanceSummaryFooter
              currency={activeCurrency}
              currencyGroups={activeCurrencyGroups}
              rateGap={activeRateGap}
              copy={campaignSummaryCopy}
              metricGroup={activeMetricGroup}
              pagination={pagination}
              rows={rows}
              totals={campaignReports?.report.totals}
            />
          </table>
        </div>
      ) : null}

      {showTable && activeView === "adsets" ? (
        <div className="table-wrap report-table-scroll">
          <table
            className="performance-table"
            data-metric-group={activeMetricGroup}
          >
            <thead>
              <tr>
                <th>
                  <span className="performance-entity-heading">
                    <ReportPageSelectionCheckbox
                      activeSelectedIds={activeSelectedIds}
                      entityIds={adSetRows.map((row) => row.id)}
                      entityLabel="conjuntos"
                      filterActive={Boolean(selectedIds)}
                      level="adset"
                      workspaceId={currentWorkspaceId}
                    />
                    Conjunto
                  </span>
                </th>
                <PerformanceMetricHeaders
                  funnelSteps={currentTotals.funnelSteps}
                  metricGroup={activeMetricGroup}
                  sortColumn={sortColumn}
                />
                <th className="performance-review-column">Revisão WhatsApp</th>
              </tr>
            </thead>
            <tbody>
              {adSetRows.length > 0 ? (
                adSetRows.map((row) => (
                  <tr
                    className={adSetId === row.id ? "is-selected" : undefined}
                    key={row.id}
                  >
                    <td className="performance-name-cell" data-label="Conjunto">
                      <div className="performance-entity-heading">
                        <ReportSelectionCheckbox
                          activeSelectedIds={activeSelectedIds}
                          entityId={row.id}
                          entityLabel={row.name}
                          filterActive={Boolean(selectedIds)}
                          level="adset"
                          workspaceId={currentWorkspaceId}
                        />
                        <strong>
                          <Link
                            href={reportViewHref("ads", {
                              ...reportFilters,
                              campaignId: row.campaignId,
                              adSetId: row.id,
                              adId: undefined,
                              page: 1,
                              selectedIds: undefined,
                            })}
                          >
                            <PresentationMask placeholder="Conjunto oculto">
                              {row.name}
                            </PresentationMask>
                          </Link>
                        </strong>
                      </div>
                      <span>
                        <PresentationMask placeholder="Campanha oculta">
                          {row.campaignName}
                        </PresentationMask>
                      </span>
                      <MetaEntityControls
                        currency={rowCurrency(row, activeCurrency)}
                        action={updateMetaEntity}
                        budget={row.budget}
                        canManage={canSyncMetaReports}
                        configuredStatus={row.configuredStatus}
                        effectiveStatus={row.effectiveStatus}
                        id={row.id}
                        level="adset"
                        name={row.name}
                      />
                    </td>
                    <PerformanceMetricsCells
                      currency={activeCurrency}
                      funnelSteps={currentTotals.funnelSteps}
                      metricGroup={activeMetricGroup}
                      row={row}
                      realConversationsHref={leadsHref({
                        campaignId: row.campaignId,
                        adSetId: row.id,
                        since,
                        until,
                        compareSince,
                        compareUntil,
                        businessId,
                        adAccountId,
                        whatsappClassification,
                      })}
                    />
                    <td
                      className="performance-review-cell"
                      data-label="Revisão WhatsApp"
                    >
                      {canSyncMetaReports ? (
                        <WhatsappReviewActions
                          action={saveWhatsappClassification}
                          classification={row.whatsappClassification}
                          level="adset"
                          id={row.id}
                        />
                      ) : (
                        <span className="tag">{noReviewPermission}</span>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="performance-name-cell" data-label="Conjunto">
                    <strong>
                      {adSetReports?.state === "error"
                        ? "Não foi possível carregar conjuntos"
                        : "Nenhum conjunto sincronizado"}
                    </strong>
                    <span>
                      {adSetReports?.state === "error"
                        ? "Confira a API antes de analisar conjuntos."
                        : syncAdSetHint}
                    </span>
                  </td>
                  <EmptyPerformanceCells
                    currency={activeCurrency}
                    funnelSteps={currentTotals.funnelSteps}
                    metricGroup={activeMetricGroup}
                  />
                  <td
                    className="performance-review-cell"
                    data-label="Revisão WhatsApp"
                  >
                    -
                  </td>
                </tr>
              )}
            </tbody>
            <PerformanceSummaryFooter
              currency={activeCurrency}
              currencyGroups={activeCurrencyGroups}
              rateGap={activeRateGap}
              copy={adSetSummaryCopy}
              metricGroup={activeMetricGroup}
              pagination={pagination}
              rows={adSetRows}
              totals={adSetReports?.report.totals}
            />
          </table>
        </div>
      ) : null}

      {showTable && activeView === "ads" ? (
        <div className="table-wrap report-table-scroll">
          <table
            className="performance-table"
            data-metric-group={activeMetricGroup}
          >
            <thead>
              <tr>
                <th>
                  <span className="performance-entity-heading">
                    <ReportPageSelectionCheckbox
                      activeSelectedIds={activeSelectedIds}
                      entityIds={adRows.map((row) => row.id)}
                      entityLabel="anúncios"
                      filterActive={Boolean(selectedIds)}
                      level="ad"
                      workspaceId={currentWorkspaceId}
                    />
                    Anúncio
                  </span>
                </th>
                <PerformanceMetricHeaders
                  funnelSteps={currentTotals.funnelSteps}
                  metricGroup={activeMetricGroup}
                  sortColumn={sortColumn}
                />
                <th className="performance-review-column">Revisão WhatsApp</th>
              </tr>
            </thead>
            <tbody>
              {adRows.length > 0 ? (
                adRows.map((row) => (
                  <tr
                    className={adId === row.id ? "is-selected" : undefined}
                    key={row.id}
                  >
                    <td className="performance-name-cell" data-label="Anúncio">
                      <div className="report-ad-entity">
                        <ReportSelectionCheckbox
                          activeSelectedIds={activeSelectedIds}
                          entityId={row.id}
                          entityLabel={row.name}
                          filterActive={Boolean(selectedIds)}
                          level="ad"
                          workspaceId={currentWorkspaceId}
                        />
                        <ReportAdPreview
                          adName={row.name}
                          previewUrl={row.previewUrl}
                          thumbnailUrl={row.thumbnailUrl}
                        />
                        <div className="report-entity-copy">
                          <strong>
                            <Link
                              href={reportViewHref("ads", {
                                ...reportFilters,
                                campaignId: row.campaignId,
                                adSetId: row.adSetId,
                                adId: row.id,
                                page: 1,
                                selectedIds: undefined,
                              })}
                            >
                              <PresentationMask placeholder="Anúncio oculto">
                                {row.name}
                              </PresentationMask>
                            </Link>
                          </strong>
                          <span>
                            <PresentationMask placeholder="Campanha oculta / Conjunto oculto">
                              {row.campaignName} / {row.adSetName}
                            </PresentationMask>
                          </span>
                        </div>
                      </div>
                      <MetaEntityControls
                        currency={rowCurrency(row, activeCurrency)}
                        action={updateMetaEntity}
                        canManage={canSyncMetaReports}
                        configuredStatus={row.configuredStatus}
                        effectiveStatus={row.effectiveStatus}
                        id={row.id}
                        level="ad"
                        name={row.name}
                      />
                    </td>
                    <PerformanceMetricsCells
                      currency={activeCurrency}
                      funnelSteps={currentTotals.funnelSteps}
                      metricGroup={activeMetricGroup}
                      row={row}
                      realConversationsHref={leadsHref({
                        campaignId: row.campaignId,
                        adSetId: row.adSetId,
                        adId: row.id,
                        since,
                        until,
                        compareSince,
                        compareUntil,
                        businessId,
                        adAccountId,
                        whatsappClassification,
                      })}
                    />
                    <td
                      className="performance-review-cell"
                      data-label="Revisão WhatsApp"
                    >
                      {canSyncMetaReports ? (
                        <WhatsappReviewActions
                          action={saveWhatsappClassification}
                          classification={row.whatsappClassification}
                          level="ad"
                          id={row.id}
                        />
                      ) : (
                        <span className="tag">{noReviewPermission}</span>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="performance-name-cell" data-label="Anúncio">
                    <strong>
                      {adReports?.state === "error"
                        ? "Não foi possível carregar anúncios"
                        : "Nenhum anúncio sincronizado"}
                    </strong>
                    <span>
                      {adReports?.state === "error"
                        ? "Confira a API antes de analisar anúncios."
                        : syncAdHint}
                    </span>
                  </td>
                  <EmptyPerformanceCells
                    currency={activeCurrency}
                    funnelSteps={currentTotals.funnelSteps}
                    metricGroup={activeMetricGroup}
                  />
                  <td
                    className="performance-review-cell"
                    data-label="Revisão WhatsApp"
                  >
                    -
                  </td>
                </tr>
              )}
            </tbody>
            <PerformanceSummaryFooter
              currency={activeCurrency}
              currencyGroups={activeCurrencyGroups}
              rateGap={activeRateGap}
              copy={adSummaryCopy}
              metricGroup={activeMetricGroup}
              pagination={pagination}
              rows={adRows}
              totals={adReports?.report.totals}
            />
          </table>
        </div>
      ) : null}

      {showTable ? (
        <ReportPagination
          copy={activeCopy}
          filters={reportFilters}
          pagination={pagination}
          view={activeView}
        />
      ) : null}

      {shouldLoadMetaStructure ? (
        <details className="surface-panel meta-diagnostic-panel" open>
          <summary className="meta-diagnostic-summary">
            <span className="meta-diagnostic-copy">
              <span className="eyebrow">Diagnóstico da sincronização Meta</span>
              <strong>Estrutura técnica recolhida</strong>
              <span>
                A hierarquia bruta da Meta fica aqui para conferência técnica.
                Os relatórios principais acima continuam sendo a fonte de
                análise.
              </span>
            </span>
            <span className="button ghost meta-diagnostic-action">
              Ver estrutura técnica
            </span>
          </summary>

          <div
            className="meta-diagnostic-stats"
            aria-label="Resumo da estrutura Meta sincronizada"
          >
            <span>
              <strong>{metaSummary.campaigns}</strong>
              <small>
                {syncedCountLabel(
                  metaSummary.campaigns,
                  "campanha sincronizada",
                  "campanhas sincronizadas",
                )}
              </small>
            </span>
            <span>
              <strong>{metaSummary.adSets}</strong>
              <small>
                {syncedCountLabel(
                  metaSummary.adSets,
                  "conjunto sincronizado",
                  "conjuntos sincronizados",
                )}
              </small>
            </span>
            <span>
              <strong>{metaSummary.ads}</strong>
              <small>
                {syncedCountLabel(
                  metaSummary.ads,
                  "anúncio sincronizado",
                  "anúncios sincronizados",
                )}
              </small>
            </span>
            <span>
              <strong>{metaSummary.activeAccounts}</strong>
              <small>
                {syncedCountLabel(
                  metaSummary.activeAccounts,
                  "conta ativa",
                  "contas ativas",
                )}
              </small>
            </span>
            <span>
              <strong>{syncDateLabel(metaSummary.lastSyncedAt)}</strong>
              <small>última sincronização</small>
            </span>
          </div>

          <form
            className="filter-bar meta-structure-filters"
            aria-label="Filtros da estrutura técnica Meta"
            action="/reports"
          >
            <input type="hidden" name="since" value={since ?? ""} />
            <input type="hidden" name="until" value={until ?? ""} />
            <input type="hidden" name="view" value={activeView} />
            <input type="hidden" name="metrics" value={activeMetricGroup} />
            <input type="hidden" name="pageSize" value={pageSize} />
            <input type="hidden" name="diagnostic" value="open" />
            <input
              type="hidden"
              name="compareSince"
              value={compareSince ?? ""}
            />
            <input
              type="hidden"
              name="compareUntil"
              value={compareUntil ?? ""}
            />
            <input type="hidden" name="businessId" value={businessId ?? ""} />
            <AdAccountHiddenInput value={adAccountId} />
            <input type="hidden" name="campaignId" value={campaignId ?? ""} />
            <input type="hidden" name="adSetId" value={adSetId ?? ""} />
            <input type="hidden" name="adId" value={adId ?? ""} />
            <input type="hidden" name="nameScope" value={nameScope ?? ""} />
            <input
              type="hidden"
              name="nameContains"
              value={nameContains ?? ""}
            />
            <input type="hidden" name="status" value={status ?? ""} />
            <input
              type="hidden"
              name="whatsappClassification"
              value={whatsappClassification ?? ""}
            />
            <ReportSortHiddenInputs sort={sort} />
            <ReportModeHiddenInputs
              mode={activeMode}
              objective={insightObjective}
            />
            <select
              className="filter-control"
              name="structureNameScope"
              aria-label="Tipo de filtro da estrutura técnica"
              defaultValue={structureFilters.nameScope}
            >
              <option value="campaign">Campanha contém</option>
              <option value="adset">Conjunto contém</option>
              <option value="ad">Anúncio contém</option>
            </select>
            <input
              className="filter-control"
              placeholder="Filtrar estrutura por nome"
              aria-label="Texto contido no nome da estrutura"
              name="structureNameContains"
              defaultValue={structureFilters.nameContains ?? ""}
            />
            <select
              className="filter-control"
              name="structureStatus"
              aria-label="Filtrar status da estrutura técnica"
              defaultValue={structureFilters.status}
            >
              <option value="all">Todos os status</option>
              <option value="active">Ativos</option>
              <option value="inactive">Inativos</option>
            </select>
            <button className="button" type="submit">
              Filtrar estrutura
            </button>
            {structureFiltersApplied ? (
              <Link className="button ghost" href={clearStructureHref}>
                Limpar filtros
              </Link>
            ) : null}
          </form>

          <div className="table-wrap report-table-scroll meta-structure-scroll">
            <table className="meta-structure-table">
              <thead>
                <tr>
                  <th>Campanha</th>
                  <th>Conjunto</th>
                  <th>Anúncio</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredMetaStructureRows.length ? (
                  filteredMetaStructureRows.map((row) => (
                    <tr key={row.key}>
                      <td>
                        <strong>
                          <PresentationMask placeholder="Campanha oculta">
                            {row.campaignName}
                          </PresentationMask>
                        </strong>
                        <span>{row.campaignObjective ?? "sem objetivo"}</span>
                      </td>
                      <td>
                        <strong>
                          <PresentationMask placeholder="Conjunto oculto">
                            {row.adSetName}
                          </PresentationMask>
                        </strong>
                        <span>
                          <PresentationMask placeholder="ID oculto">
                            {row.adSetId}
                          </PresentationMask>
                        </span>
                      </td>
                      <td>
                        <strong>
                          <PresentationMask placeholder="Anúncio oculto">
                            {row.adName}
                          </PresentationMask>
                        </strong>
                        <span>
                          <PresentationMask placeholder="ID oculto">
                            {row.adId ?? "sem anúncio"}
                          </PresentationMask>
                        </span>
                      </td>
                      <td>
                        <span
                          className={`event-chip${
                            metaStructureRowIsActive(row) ? "" : " warn"
                          }`}
                        >
                          {metaStatusLabel(row.status)}
                        </span>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td>
                      <strong>{emptyStructureTitle}</strong>
                      <span>{emptyStructureHint}</span>
                    </td>
                    <td>sem conjunto</td>
                    <td>sem anúncio</td>
                    <td>
                      <span className="event-chip warn">aguardando sync</span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </details>
      ) : (
        <section className="surface-panel meta-diagnostic-collapsed">
          <div className="meta-diagnostic-copy">
            <span className="eyebrow">Diagnóstico da sincronização Meta</span>
            <strong>Estrutura técnica sob demanda</strong>
            <span>
              Carregue a hierarquia bruta somente quando precisar auditar a
              sincronização. Ela não bloqueia mais a abertura dos relatórios.
            </span>
          </div>
          <Link className="button ghost" href={diagnosticHref}>
            Carregar diagnóstico
          </Link>
        </section>
      )}
    </section>
  );
}
