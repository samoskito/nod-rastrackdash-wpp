import {
  funnelMetricLabels,
  type CampaignOptionDto,
  type CampaignOptionsResponseDto,
  type CampaignReportRowDto,
  type CurrencyCode,
  type MetaAssetsDto,
  type ReportCurrencyGroupDto,
  type ReportDailyComparisonPointDto,
  type ReportFunnelStepDto,
  type ReportOverviewDto,
  type WhatsappConnectionDto,
} from "@wpptrack/shared";
import Link from "next/link";
import { Fragment, type CSSProperties, type ReactNode } from "react";
import {
  CurrencyKpiGroups,
  ExchangeRateMissingNote,
} from "../../../components/currency-kpi-groups";
import { MetaSyncCoverageNotice } from "../../../components/meta-sync-coverage-notice";
import { PresentationMask } from "../../../components/presentation-mask";
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
  exchangeRateMissingLabel,
  formatReportMoney,
  mixedCurrencyGroups,
  reportCurrency,
  singleCurrencyRateGap,
} from "../../../lib/report-currency";
import { isApiRequestError, serverApiFetch } from "../../../lib/server-api";
import {
  toWhatsappNumberOptions,
  type WhatsappNumberOption,
} from "../../../lib/whatsapp-number-options";
import {
  parseCampaignIdsParam,
  setCampaignParams,
} from "./overview-campaign-params";
import { OverviewFilters } from "./overview-filters";
import { dailyComparisonSeries } from "./daily-comparison-series";
import {
  OverviewLeadsBlock,
  overviewLeadsCopy,
  type OverviewLeadsBlockItem,
} from "./overview-leads-block";
import { getLeadSubmittedOverrideEnabled } from "../../../lib/lead-submitted-override";
import { overviewLeadsHref } from "./overview-leads-links";
import { OverviewPendingProvider, OverviewResults } from "./overview-pending";
import { instanceLabel } from "./overview-labels";

type OverviewSearchParams = Record<string, string | string[] | undefined>;
type OverviewFiltersInput = {
  /** Contas de anúncio juntas por "," (`adAccountId` ou `adAccountIds` na URL). */
  adAccountId?: string;
  businessId?: string;
  since?: string;
  until?: string;
  whatsappInstanceId?: string;
  /** Selection order: `campaignId` (1) or `campaignIds` (2+) in the URL. */
  campaignIds: string[];
};

/**
 * `invalid_filter`: the API rejected the campaign filter (removed campaign,
 * inactive account, another workspace, or over the limit). Never rendered as
 * zeros.
 */
type OverviewFetchState = "real" | "empty" | "error" | "invalid_filter";
type MetaMetricsScope = NonNullable<ReportOverviewDto["metaMetricsScope"]>;
type OverviewReportResult = {
  report: ReportOverviewDto;
  state: OverviewFetchState;
  /** 404: a campaign was not found; 400: too many campaigns (§5.6). */
  invalidReason?: "not_found" | "limit";
};

const scalarFilterKeys = [
  "since",
  "until",
  "businessId",
  "adAccountId",
  "whatsappInstanceId",
] as const satisfies readonly (keyof OverviewFiltersInput)[];

/** Dinheiro na moeda do recorte (BRL quando todas as contas são em real). */
function money(cents: number | null, currency: CurrencyCode = "BRL") {
  return formatReportMoney(cents, currency);
}

async function getOverviewReport(
  filters: OverviewFiltersInput,
): Promise<OverviewReportResult> {
  try {
    const params = new URLSearchParams({
      includeDaily: "true",
      includeSummary: "true",
    });

    if (filters.since && filters.until) {
      params.set("since", filters.since);
      params.set("until", filters.until);
    }

    if (filters.businessId) {
      params.set("businessId", filters.businessId);
    }

    setAdAccountParams(params, splitAdAccountIds(filters.adAccountId));

    if (filters.whatsappInstanceId) {
      params.set("whatsappInstanceId", filters.whatsappInstanceId);
    }

    setCampaignParams(params, filters.campaignIds);

    const report = await serverApiFetch<ReportOverviewDto>(
      `/reports/campaigns?${params.toString()}`,
    );

    return {
      report,
      state:
        report.campaigns.length > 0 || (report.summary?.totalReceived ?? 0) > 0
          ? "real"
          : "empty",
    };
  } catch (error) {
    const invalidReason =
      filters.campaignIds.length > 0 && isApiRequestError(error)
        ? error.status === 404
          ? ("not_found" as const)
          : error.status === 400
            ? ("limit" as const)
            : undefined
        : undefined;

    return {
      report: {
        workspaceId: "unavailable",
        rangeLabel: invalidReason ? "Filtro inválido" : "API indisponível",
        campaigns: [],
      },
      state: invalidReason ? "invalid_filter" : "error",
      ...(invalidReason ? { invalidReason } : {}),
    };
  }
}

/**
 * Campaign options come from their own endpoint: once `campaignId` is applied,
 * `report.campaigns` shrinks to that row and cannot feed the dropdown.
 * `null` disables the field without blocking the report.
 */
async function getCampaignOptions(
  filters: OverviewFiltersInput,
): Promise<CampaignOptionDto[] | null> {
  const params = new URLSearchParams();

  if (filters.since && filters.until) {
    params.set("since", filters.since);
    params.set("until", filters.until);
  }

  if (filters.businessId) {
    params.set("businessId", filters.businessId);
  }

  setAdAccountParams(params, splitAdAccountIds(filters.adAccountId));

  const query = params.toString();

  try {
    const response = await serverApiFetch<CampaignOptionsResponseDto>(
      query
        ? `/reports/campaign-options?${query}`
        : "/reports/campaign-options",
    );

    return Array.isArray(response?.campaigns) ? response.campaigns : null;
  } catch {
    return null;
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
 * Números WhatsApp do workspace (as conexões do nod). Uma conexão removida
 * sai da lista do filtro (o componente mostra só as ativas), mas a URL com o
 * id dela continua valendo para o histórico.
 */
async function getWhatsappInstances(): Promise<WhatsappNumberOption[]> {
  try {
    return toWhatsappNumberOptions(
      await serverApiFetch<WhatsappConnectionDto[]>(
        "/integrations/whatsapp-connections",
      ),
    );
  } catch {
    return [];
  }
}

function asStringParam(value: string | string[] | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sumCampaigns(campaigns: CampaignReportRowDto[]): CampaignReportRowDto {
  const spendCents = campaigns.reduce(
    (total, campaign) => total + campaign.spendCents,
    0,
  );
  const metaConversationsStarted = campaigns.reduce(
    (total, campaign) => total + campaign.metaConversationsStarted,
    0,
  );
  const realConversations = campaigns.reduce(
    (total, campaign) => total + campaign.realConversations,
    0,
  );
  const organicLeads = campaigns.reduce(
    (total, campaign) => total + campaign.organicLeads,
    0,
  );
  const totalReceived = campaigns.reduce(
    (total, campaign) => total + campaign.totalReceived,
    0,
  );
  const qualifiedLead = campaigns.reduce(
    (total, campaign) => total + campaign.qualifiedLead,
    0,
  );
  const purchases = campaigns.reduce(
    (total, campaign) => total + campaign.purchases,
    0,
  );
  const firstPurchases = campaigns.reduce(
    (total, campaign) => total + campaign.firstPurchases,
    0,
  );
  const repurchases = campaigns.reduce(
    (total, campaign) => total + campaign.repurchases,
    0,
  );
  const trafficRevenueCents = campaigns.reduce(
    (total, campaign) => total + campaign.trafficRevenueCents,
    0,
  );
  const organicRevenueCents = campaigns.reduce(
    (total, campaign) => total + campaign.organicRevenueCents,
    0,
  );
  const totalRevenueCents = trafficRevenueCents + organicRevenueCents;
  const firstPurchaseRevenueCents = campaigns.reduce(
    (total, campaign) => total + campaign.firstPurchaseRevenueCents,
    0,
  );
  const repurchaseRevenueCents = campaigns.reduce(
    (total, campaign) => total + campaign.repurchaseRevenueCents,
    0,
  );
  const estimatedRevenueCents = campaigns.reduce(
    (total, campaign) => total + campaign.estimatedRevenueCents,
    0,
  );

  return {
    id: "all_campaigns",
    name:
      campaigns.length === 0
        ? "Nenhuma campanha sincronizada"
        : campaigns.length === 1
          ? (campaigns[0]?.name ?? "Campanha")
          : "Todas as campanhas",
    status: campaigns.some((campaign) => campaign.status === "active")
      ? "active"
      : "unknown",
    spendCents,
    metaConversationsStarted,
    costPerMetaConversationCents: costPer(spendCents, metaConversationsStarted),
    realConversations,
    costPerRealConversationCents: costPer(spendCents, realConversations),
    organicLeads,
    totalReceived,
    trackingRate: ratio(realConversations, totalReceived),
    qualifiedLead,
    costPerQualifiedLeadCents: costPer(spendCents, qualifiedLead),
    purchases,
    firstPurchases,
    repurchases,
    costPerPurchaseCents: costPer(spendCents, purchases),
    trafficRevenueCents,
    organicRevenueCents,
    totalRevenueCents,
    firstPurchaseRevenueCents,
    repurchaseRevenueCents,
    estimatedRevenueCents,
    hasEstimatedRevenue: estimatedRevenueCents > 0,
    roasAcquisition: weightedRoas(
      campaigns,
      (campaign) => campaign.roasAcquisition,
    ),
    roasWithRepurchase: weightedRoas(
      campaigns,
      (campaign) => campaign.roasWithRepurchase,
    ),
    // R1: preserve every configured funnel stage from the API (IC, AddToCart,
    // custom events). Hardcoding QL/Purchase dropped InitiateCheckout when the
    // overview fell back to client-side aggregation.
    funnelSteps: aggregateFunnelSteps(campaigns, spendCents),
  };
}

function aggregateFunnelSteps(
  campaigns: CampaignReportRowDto[],
  spendCents: number,
): ReportFunnelStepDto[] {
  const steps = new Map<string, ReportFunnelStepDto>();
  const order: string[] = [];

  for (const campaign of campaigns) {
    // Merge estavel: a API ja manda as etapas na ordem do funil, mas linhas sem
    // compra omitem first_purchase/repurchase. Anexar no fim jogaria uma etapa
    // do meio do funil para o final; inserimos logo apos a etapa anterior desta
    // mesma linha.
    let insertAt = 0;

    for (const step of campaign.funnelSteps) {
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
      costCents: costPer(spendCents, step.value),
    };
  });
}

/** "R$ 5,00 · US$ 1,00": um custo por moeda, na ordem dos blocos. */
function perCurrencyCost(
  groups: ReportCurrencyGroupDto[],
  select: (group: ReportCurrencyGroupDto) => number | null | undefined,
): string | null {
  const parts = groups.flatMap((group) => {
    const cents = select(group);

    return typeof cents === "number" ? [money(cents, group.currency)] : [];
  });

  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Custo de uma etapa do funil em cada moeda (os grupos têm o próprio funil). */
function perCurrencyStageCost(
  stage: ReportFunnelStepDto,
  groups: ReportCurrencyGroupDto[],
): string {
  return (
    perCurrencyCost(groups, (group) =>
      stage.key === "meta_conversations"
        ? group.costPerMetaConversationCents
        : group.funnelSteps.find((step) => step.key === stage.key)?.costCents,
    ) ?? "-"
  );
}

function costPer(spendCents: number, count: number): number | null {
  return count > 0 ? Math.floor(spendCents / count) : null;
}

function ratio(part: number, total: number): number | null {
  return total > 0 ? part / total : null;
}

function weightedRoas(
  campaigns: CampaignReportRowDto[],
  selectRoas: (campaign: CampaignReportRowDto) => number | null,
): number | null {
  const weighted = campaigns.reduce(
    (total, campaign) => {
      const value = selectRoas(campaign);

      if (value === null || campaign.spendCents === 0) {
        return total;
      }

      return {
        revenueBasis: total.revenueBasis + value * campaign.spendCents,
        spendCents: total.spendCents + campaign.spendCents,
      };
    },
    { revenueBasis: 0, spendCents: 0 },
  );

  return weighted.spendCents > 0
    ? weighted.revenueBasis / weighted.spendCents
    : null;
}

function ratePercent(rate: number | null): number {
  return rate === null ? 0 : Math.round(rate * 100);
}

function ratioLabel(value: number | null): string {
  return value === null ? "-" : `${value.toFixed(2)}x`;
}

function purchaseBreakdownLabel(
  firstPurchases: number,
  repurchases: number,
): string {
  if (firstPurchases === 0 && repurchases === 0) {
    return "Nenhuma compra no período";
  }

  const firstPurchaseLabel = `${firstPurchases} ${firstPurchases === 1 ? "primeira compra" : "primeiras compras"}`;

  if (repurchases === 0) {
    return firstPurchaseLabel;
  }

  return `${firstPurchaseLabel}, ${repurchases} ${repurchases === 1 ? "recompra" : "recompras"}`;
}

/**
 * Curated cost captions apply only while a stage still carries its catalog
 * label. Once the workspace renames a stage (QualifiedLead -> "Cliente
 * potencial", Purchase -> "Vendas"...), the caption follows the configured
 * label so cards and funnel rows never contradict the stage name.
 */
const defaultStageCostCaptions: Record<
  string,
  { label: string; caption: string }
> = {
  meta_conversations: {
    label: "Conversas Meta",
    caption: "Custo por conversa Meta",
  },
  real_conversations: {
    label: funnelMetricLabels.real_conversations,
    caption: "Custo por lead novo",
  },
  qualified_lead: {
    label: funnelMetricLabels.qualified_lead,
    caption: "Custo por lead qualificado",
  },
  purchase: {
    label: funnelMetricLabels.purchase,
    caption: "Custo por compra",
  },
  first_purchase: {
    label: funnelMetricLabels.first_purchase,
    caption: "Custo por primeira compra",
  },
  repurchase: {
    label: funnelMetricLabels.repurchase,
    caption: "Custo por recompra",
  },
  event_initiate_checkout: {
    label: "Checkout iniciado",
    caption: "Custo por checkout iniciado",
  },
  event_add_to_cart: {
    label: "Adicionou ao carrinho",
    caption: "Custo por adição ao carrinho",
  },
};

function funnelStageCostLabel(stage: ReportFunnelStepDto): string {
  const normalized = stage.label.trim().toLocaleLowerCase("pt-BR");
  const curated = defaultStageCostCaptions[stage.key];

  if (
    curated &&
    (normalized.length === 0 ||
      normalized === curated.label.toLocaleLowerCase("pt-BR"))
  ) {
    return curated.caption;
  }

  return normalized.length > 0 ? `Custo por ${normalized}` : "Custo por etapa";
}

/**
 * Funnel steps that are Purchase breakdowns rather than configurable stages.
 * They stay inside the "Compras" card delta (first purchase / repurchase).
 */
const purchaseBreakdownKeys = new Set(["first_purchase", "repurchase"]);

/**
 * KPI cards derive from the workspace funnel configuration that the API already
 * applies to `funnelSteps` (visible stages, custom labels, position). Nothing
 * here is hardcoded per event:
 * - `real_conversations` (LeadSubmitted) is skipped because the base card
 *   "Leads novos" already shows it together with the leads that came back.
 * - Purchase breakdowns are folded into the "Compras" card.
 * - Everything else (QualifiedLead, ViewContent, InitiateCheckout, custom
 *   events...) becomes a count card in funnel order with its configured label.
 */
function configuredKpiStages(
  funnelSteps: ReportFunnelStepDto[],
): ReportFunnelStepDto[] {
  return funnelSteps.filter(
    (step) =>
      step.key !== "real_conversations" && !purchaseBreakdownKeys.has(step.key),
  );
}

/**
 * "Receita tráfego" depends on Purchase: revenue only exists when the workspace
 * tracks purchases, so the card is rendered right after the "Compras" card and
 * only when the `purchase` stage is part of the configured funnel. Lead-only
 * workspaces never see a revenue KPI. Used by the funnel summary sentence.
 */
function hasPurchaseStage(funnelSteps: ReportFunnelStepDto[]): boolean {
  return funnelSteps.some((step) => step.key === "purchase");
}

function funnelOutcomeSummary(
  rangeLabel: string,
  metaConversationsStarted: number,
  campaign: CampaignReportRowDto,
): string {
  const intro = `${rangeLabel}: ${metaConversationsStarted} conversas registradas pela Meta`;

  if (hasPurchaseStage(campaign.funnelSteps)) {
    return `${intro} chegaram a ${campaign.firstPurchases} ${campaign.firstPurchases === 1 ? "primeira compra" : "primeiras compras"}.`;
  }

  const lastStage = configuredKpiStages(campaign.funnelSteps).at(-1);

  if (lastStage) {
    return `${intro} chegaram a ${lastStage.value} em ${lastStage.label}.`;
  }

  return `${intro} no período.`;
}

/** Optional API counts: absent on older payloads, shown as "-". */
function optionalCount(value: number | undefined): number | null {
  return typeof value === "number" ? value : null;
}

function filtersQuery(filters: OverviewFiltersInput): string {
  const params = new URLSearchParams();

  for (const key of scalarFilterKeys) {
    const value = filters[key];

    if (key === "adAccountId") {
      setAdAccountParams(params, splitAdAccountIds(value));
    } else if (value) {
      params.set(key, value);
    }
  }

  setCampaignParams(params, filters.campaignIds);

  return params.toString();
}

/**
 * `/reports` only understands a single `campaignId`; a multi selection keeps
 * period/BM/Conta/Número and drops the campaigns (§3.6).
 */
function reportsHref(filters: OverviewFiltersInput): string {
  const query = filtersQuery(
    filters.campaignIds.length > 1 ? { ...filters, campaignIds: [] } : filters,
  );
  return query ? `/reports?${query}` : "/reports";
}

function overviewHref(filters: OverviewFiltersInput): string {
  const query = filtersQuery(filters);
  return query ? `/overview?${query}` : "/overview";
}

/**
 * Names for the selected campaigns: the report's resolved names first (they
 * cover campaigns with no data in the period), then the period's options.
 */
function selectedCampaignNames(
  campaignIds: string[],
  report: ReportOverviewDto,
  campaignOptions: CampaignOptionDto[] | null,
): Record<string, string> {
  const names: Record<string, string> = {};
  const reported = report.filters?.campaignIds ?? [];

  reported.forEach((id, index) => {
    const name = report.filters?.campaignNames?.[index];

    if (name) {
      names[id] = name;
    }
  });

  if (report.filters?.campaignId && report.filters.campaignName) {
    names[report.filters.campaignId] = report.filters.campaignName;
  }

  for (const id of campaignIds) {
    const option = campaignOptions?.find((candidate) => candidate.id === id);

    if (!names[id] && option) {
      names[id] = option.name;
    }
  }

  return names;
}

function conversationCount(count: number): string {
  return `${count} ${count === 1 ? "lead novo" : "leads novos"}`;
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams?: Promise<OverviewSearchParams>;
}) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const filters: OverviewFiltersInput = {
    since: asStringParam(resolvedSearchParams.since),
    until: asStringParam(resolvedSearchParams.until),
    businessId: asStringParam(resolvedSearchParams.businessId),
    adAccountId:
      joinAdAccountIds(
        parseAdAccountIdsParam(
          resolvedSearchParams.adAccountId,
          resolvedSearchParams.adAccountIds,
        ),
      ) || undefined,
    whatsappInstanceId: asStringParam(resolvedSearchParams.whatsappInstanceId),
    campaignIds: parseCampaignIdsParam(
      resolvedSearchParams.campaignId,
      resolvedSearchParams.campaignIds,
    ),
  };
  const [
    { report, state: reportState, invalidReason },
    metaAssets,
    whatsappInstances,
    campaignOptions,
    adAccountCurrencies,
    leadSubmittedOverrideEnabled,
  ] = await Promise.all([
    getOverviewReport(filters),
    getMetaAssets(),
    getWhatsappInstances(),
    getCampaignOptions(filters),
    getAdAccountCurrencies(),
    getLeadSubmittedOverrideEnabled(),
  ]);
  const leadsCopy = overviewLeadsCopy(leadSubmittedOverrideEnabled);
  const reportingAccounts = (metaAssets?.reportingAccounts ?? []).filter(
    (account) => account.active,
  );
  const accountCurrencies = adAccountCurrencyMap(
    reportingAccounts,
    adAccountCurrencies,
  );
  const selectedAdAccountIds = splitAdAccountIds(filters.adAccountId);
  const campaigns = report.campaigns;
  const campaign = report.summary ?? sumCampaigns(campaigns);
  // Uma moeda só: tudo igual a antes (em real, sem rótulo novo). Duas ou mais
  // com movimento: um bloco por moeda, sem somar valores de moedas diferentes.
  const currencyGroups = mixedCurrencyGroups(report, "summary");
  const mixedCurrency = currencyGroups.length > 0;
  const reportMoneyCurrency = reportCurrency(report, "summary");
  const rateGap = mixedCurrency
    ? { exchangeRateMissing: false, unconvertedRevenue: [] }
    : singleCurrencyRateGap(report, "summary");
  const fmt = (cents: number | null) => money(cents, reportMoneyCurrency);
  const invalidFilter = reportState === "invalid_filter";
  const dataAvailable = reportState !== "error" && !invalidFilter;
  const hasWhatsappInstanceFilter = Boolean(filters.whatsappInstanceId);
  const campaignCount = filters.campaignIds.length;
  const hasCampaignFilter = campaignCount > 0;
  const multiCampaign = campaignCount > 1;
  // The API decides how honest Meta metrics can be for this cut (D8). Older
  // payloads without the field keep the #110 rule for an instance filter.
  const metaScope: MetaMetricsScope | undefined =
    report.metaMetricsScope ??
    (hasWhatsappInstanceFilter ? "ad_account" : undefined);
  // S2: Meta spend exists per account/campaign, never per number.
  const metaByAccount =
    metaScope === "ad_account" || metaScope === "instance_unavailable";
  // S8: campaign selected but Meta insights not synced for the period.
  const metaUnsynced = metaScope === "campaign_unsynced";
  // S5/S6: whole-campaign Meta values next to one number's outcomes.
  const metaPartial = metaScope === "campaign_shared";
  const metaHidden = metaByAccount || metaUnsynced;
  // nod: várias moedas mostram o custo por moeda (não escondem o custo).
  const costsHidden = metaHidden || metaPartial;
  const stageCostLabel = (stage: ReportFunnelStepDto): string =>
    costsHidden
      ? "-"
      : mixedCurrency
        ? perCurrencyStageCost(stage, currencyGroups)
        : fmt(stage.costCents ?? null);
  const costPerLeadLabel = costsHidden
    ? null
    : mixedCurrency
      ? perCurrencyCost(
          currencyGroups,
          (group) => group.costPerRealConversationCents,
        )
      : campaign.costPerRealConversationCents !== null
        ? fmt(campaign.costPerRealConversationCents)
        : null;
  const campaignInstanceLeads = (report.campaignInstanceLeads ?? []).filter(
    (entry) => entry.leads > 0,
  );
  const noLeadsOnSelectedNumber =
    metaPartial &&
    !campaignInstanceLeads.some(
      (entry) => entry.instanceId === filters.whatsappInstanceId,
    );
  // S7: a real zero, not "-", but there is no spend base for ROAS.
  const campaignWithoutDelivery =
    metaScope === "campaign" && campaign.spendCents === 0;
  const campaignNames = selectedCampaignNames(
    filters.campaignIds,
    report,
    campaignOptions,
  );
  const campaignName = multiCampaign
    ? undefined
    : campaignNames[filters.campaignIds[0] ?? ""];
  const trackedRate =
    dataAvailable && campaign.trackingRate !== null
      ? ratePercent(campaign.trackingRate)
      : null;
  const metaConversationStage: ReportFunnelStepDto = {
    key: "meta_conversations",
    label: "Conversas Meta",
    value: campaign.metaConversationsStarted,
    costCents: costsHidden ? null : campaign.costPerMetaConversationCents,
  };
  const scopedFunnelSteps = costsHidden
    ? campaign.funnelSteps.map((stage) => ({ ...stage, costCents: null }))
    : campaign.funnelSteps;
  const funnelStages: ReportFunnelStepDto[] = metaHidden
    ? scopedFunnelSteps
    : [metaConversationStage, ...scopedFunnelSteps];
  const kpiStages = configuredKpiStages(campaign.funnelSteps);
  const selectedBusiness = reportingAccounts.find(
    (account) => account.businessId === filters.businessId,
  );
  const selectedAccount =
    selectedAdAccountIds.length === 1
      ? reportingAccounts.find(
          (account) => account.adAccountId === selectedAdAccountIds[0],
        )
      : undefined;
  // n campaigns: a count, no names, so nothing to mask (§5.4).
  const multiScopeLabel = `${campaignCount} campanhas selecionadas`;
  const scopeLabel = multiCampaign
    ? multiScopeLabel
    : hasCampaignFilter && campaignName
      ? campaignName
      : (selectedAccount?.adAccountName ??
        (selectedAdAccountIds.length > 1
          ? `${selectedAdAccountIds.length} contas de anúncio`
          : undefined) ??
        selectedBusiness?.businessName ??
        "Todas as contas");
  const scopePlaceholder = multiCampaign
    ? multiScopeLabel
    : hasCampaignFilter && campaignName
      ? "Campanha oculta"
      : "Conta de anúncios oculta";
  const detailHref = reportsHref(filters);
  const leadsPeriod = {
    since: report.since ?? filters.since,
    until: report.until ?? filters.until,
  };
  const newLeadsHref = overviewLeadsHref(filters, leadsPeriod, "new");
  const leadsBlockItems: OverviewLeadsBlockItem[] = [
    {
      key: "new",
      label: "Leads novos",
      value: campaign.realConversations,
      caption:
        costPerLeadLabel !== null
          ? `Custo por lead novo ${costPerLeadLabel}`
          : leadsCopy.newCaption,
      hint: leadsCopy.new,
      href: newLeadsHref,
      hrefLabel: "Ver os leads novos na lista de leads",
    },
    {
      key: "returning",
      label: "Voltaram por anúncio",
      value: optionalCount(campaign.returningLeads),
      caption: "Já eram leads antes do período",
      hint: leadsCopy.returning,
      href: overviewLeadsHref(filters, leadsPeriod, "returning"),
      hrefLabel: "Ver quem voltou por anúncio na lista de leads",
    },
    {
      key: "repeat",
      label: "Conversaram mais de uma vez",
      value: optionalCount(campaign.repeatConversationLeads),
      caption: "2 ou mais conversas no período",
      hint: leadsCopy.repeat,
      href: overviewLeadsHref(filters, leadsPeriod, "repeat"),
      hrefLabel: "Ver quem conversou mais de uma vez na lista de leads",
    },
    {
      key: "conversations",
      label: "Conversas por anúncio",
      value: optionalCount(campaign.adConversationEvents),
      caption: "Inclui conversas repetidas",
      hint: leadsCopy.conversations,
    },
  ];
  const clearCampaignHref = overviewHref({ ...filters, campaignIds: [] });
  const fromSelection = multiCampaign
    ? "das campanhas selecionadas"
    : "da campanha selecionada";
  const funnelSummary = dataAvailable
    ? metaPartial
      ? `${report.rangeLabel}: ${conversationCount(campaign.realConversations)} neste número vindas ${fromSelection}.`
      : metaByAccount
        ? `${report.rangeLabel}: ${conversationCount(campaign.realConversations)} no número selecionado.`
        : metaUnsynced
          ? `${report.rangeLabel}: ${conversationCount(campaign.realConversations)} vindas ${fromSelection}.`
          : funnelOutcomeSummary(
              report.rangeLabel,
              campaign.metaConversationsStarted,
              campaign,
            )
    : "A jornada será exibida quando a API concluir a inicialização.";
  const metaDelta = (fallback: string) =>
    !dataAvailable
      ? "Aguardando resposta da API"
      : metaByAccount
        ? "Conta de anúncios (não filtrável por número)"
        : metaUnsynced
          ? "Aguardando sincronização da Meta"
          : metaPartial
            ? `${multiCampaign ? "Soma das campanhas inteiras" : "Campanha inteira"} · ${
                noLeadsOnSelectedNumber
                  ? "nenhuma conversa neste número"
                  : "inclui outro número"
              }`
            : campaignWithoutDelivery
              ? "Sem veiculação no período"
              : fallback;
  const revenueDelta = !dataAvailable
    ? "Aguardando resposta da API"
    : metaByAccount
      ? "Receita do número; ROAS indisponível"
      : metaPartial
        ? "Receita do número; ROAS indisponível"
        : metaUnsynced || campaignWithoutDelivery
          ? "ROAS indisponível"
          : `ROAS ${ratioLabel(campaign.roasAcquisition)}`;

  return (
    <section className="page-stack page-wide overview-page">
      <OverviewPendingProvider>
        <header className="page-header">
          <div>
            <span className="eyebrow">Visão geral</span>
            <h1>Cockpit da operação</h1>
            <p>
              {report.rangeLabel} cruzando investimento, leads novos e eventos
              enviados ao Pixel.
            </p>
          </div>
          <div className="header-actions" aria-label="Filtros ativos">
            {reportState === "error" ? (
              <span className="status-chip warn">API indisponível</span>
            ) : invalidFilter ? (
              <span className="status-chip warn">Filtro inválido</span>
            ) : (
              <>
                <span className="tag">{report.rangeLabel}</span>
                <span className="tag">
                  {campaignCount === 1
                    ? "1 campanha"
                    : `${hasCampaignFilter ? campaignCount : campaigns.length} campanhas`}
                </span>
                <span className="tag">
                  {trackedRate === null
                    ? "Aguardando conversas"
                    : `${trackedRate}% rastreadas`}
                </span>
              </>
            )}
          </div>
        </header>

        <OverviewFilters
          accountCurrencies={accountCurrencies}
          adAccountId={filters.adAccountId}
          businessId={filters.businessId}
          campaignIds={filters.campaignIds}
          campaignNames={campaignNames}
          campaignOptions={campaignOptions}
          hasActiveFilter={
            hasCampaignFilter ||
            scalarFilterKeys.some((key) => Boolean(filters[key]))
          }
          reportingAccounts={reportingAccounts}
          since={report.since ?? filters.since}
          until={report.until ?? filters.until}
          whatsappInstanceId={filters.whatsappInstanceId}
          whatsappInstances={whatsappInstances}
        />

        {dataAvailable ? (
          <MetaSyncCoverageNotice coverage={report.metaSyncCoverage} />
        ) : null}

        {/* Previous numbers stay visible, marked as updating, while filters apply. */}
        <OverviewResults>
          {invalidFilter ? (
            <div
              className="overview-unavailable overview-invalid-filter"
              role="status"
            >
              <span className="status-dot" aria-hidden="true" />
              <div>
                <strong>
                  {invalidReason === "limit"
                    ? "Filtro de campanha inválido"
                    : multiCampaign
                      ? "Campanhas não encontradas"
                      : "Campanha não encontrada"}
                </strong>
                <span>
                  {invalidReason === "limit"
                    ? "Selecione até 10 campanhas."
                    : multiCampaign
                      ? "Uma ou mais campanhas podem ter sido removidas ou pertencer a outra conta de anúncio."
                      : "Ela pode ter sido removida ou pertencer a outra conta de anúncio."}
                </span>
              </div>
              <Link className="button ghost" href={clearCampaignHref}>
                {multiCampaign ? "Limpar campanhas" : "Limpar campanha"}
              </Link>
            </div>
          ) : (
            <>
              {dataAvailable ? (
                <OverviewScopeNote
                  campaignInstanceLeads={campaignInstanceLeads}
                  filters={filters}
                  metaByAccount={metaByAccount}
                  multiCampaign={multiCampaign}
                  metaPartial={metaPartial}
                  noLeadsOnSelectedNumber={noLeadsOnSelectedNumber}
                  whatsappInstances={whatsappInstances}
                />
              ) : null}

              <div className="metric-grid overview-primary-metrics">
                <Metric
                  label="Investimento"
                  value={
                    !dataAvailable || metaHidden
                      ? "-"
                      : mixedCurrency
                        ? "Por moeda"
                        : fmt(campaign.spendCents)
                  }
                  delta={metaDelta(
                    mixedCurrency
                      ? "Veja os totais por moeda abaixo"
                      : reportState === "empty" && !hasCampaignFilter
                        ? "Nenhuma campanha sincronizada"
                        : report.rangeLabel,
                  )}
                  partial={dataAvailable && metaPartial}
                  unavailable={!dataAvailable || metaHidden}
                />
                <Metric
                  label="Conversas Meta"
                  value={
                    dataAvailable && !metaHidden
                      ? String(campaign.metaConversationsStarted)
                      : "-"
                  }
                  delta={metaDelta(
                    metaScope === "campaign" &&
                      !mixedCurrency &&
                      metaConversationStage.costCents != null
                      ? `${funnelStageCostLabel(metaConversationStage)} ${stageCostLabel(metaConversationStage)}`
                      : report.rangeLabel,
                  )}
                  partial={dataAvailable && metaPartial}
                  unavailable={!dataAvailable || metaHidden}
                />
                <Metric
                  label="Leads novos"
                  title={leadsCopy.new}
                  value={
                    dataAvailable ? String(campaign.realConversations) : "-"
                  }
                  href={dataAvailable ? newLeadsHref : null}
                  hrefLabel="Ver os leads novos na lista de leads"
                  delta={
                    dataAvailable
                      ? leadsCopy.newCaption
                      : "Aguardando resposta da API"
                  }
                  unavailable={!dataAvailable}
                />
                {kpiStages.map((stage) =>
                  stage.key === "purchase" ? (
                    <Fragment key={stage.key}>
                      <Metric
                        label={stage.label}
                        value={dataAvailable ? String(stage.value) : "-"}
                        delta={
                          dataAvailable
                            ? purchaseBreakdownLabel(
                                campaign.firstPurchases,
                                campaign.repurchases,
                              )
                            : "Aguardando resposta da API"
                        }
                        unavailable={!dataAvailable}
                      />
                      <Metric
                        label="Receita tráfego"
                        value={
                          !dataAvailable
                            ? "-"
                            : mixedCurrency
                              ? "Por moeda"
                              : fmt(campaign.trafficRevenueCents)
                        }
                        delta={
                          !dataAvailable
                            ? "Aguardando resposta da API"
                            : mixedCurrency
                              ? "ROAS em cada moeda, abaixo"
                              : metaByAccount ||
                                  metaPartial ||
                                  metaUnsynced ||
                                  campaignWithoutDelivery ||
                                  !rateGap.exchangeRateMissing
                                ? revenueDelta
                                : `ROAS ${exchangeRateMissingLabel}`
                        }
                        unavailable={!dataAvailable}
                      />
                    </Fragment>
                  ) : (
                    <Metric
                      key={stage.key}
                      label={stage.label}
                      value={dataAvailable ? String(stage.value) : "-"}
                      delta={
                        !dataAvailable
                          ? "Aguardando resposta da API"
                          : metaByAccount
                            ? "Eventos do número selecionado"
                            : costsHidden
                              ? report.rangeLabel
                              : stage.costCents != null
                                ? `${funnelStageCostLabel(stage)} ${stageCostLabel(stage)}`
                                : report.rangeLabel
                      }
                      unavailable={!dataAvailable}
                    />
                  ),
                )}
              </div>

              {dataAvailable && mixedCurrency && !metaHidden ? (
                <CurrencyKpiGroups
                  groups={currencyGroups.map(currencyKpiGroup)}
                  hideCosts={metaPartial}
                />
              ) : null}

              {dataAvailable && rateGap.exchangeRateMissing ? (
                <ExchangeRateMissingNote
                  unconvertedRevenue={rateGap.unconvertedRevenue}
                />
              ) : null}

              <OverviewLeadsBlock
                available={dataAvailable}
                items={leadsBlockItems}
                rangeLabel={report.rangeLabel}
              />

              <section
                className="surface-panel overview-funnel-panel"
                aria-label="Funil integrado"
              >
                {dataAvailable ? (
                  <ConversionFunnel
                    description={funnelSummary}
                    stageCost={stageCostLabel}
                    stages={funnelStages}
                  />
                ) : (
                  <>
                    <div className="overview-section-heading">
                      <div>
                        <span className="eyebrow">Funil integrado</span>
                        <h2>Conversão por etapas</h2>
                        <p>{funnelSummary}</p>
                      </div>
                    </div>
                    <div className="overview-unavailable" role="status">
                      <span className="status-dot" aria-hidden="true" />
                      <div>
                        <strong>Dados temporariamente indisponíveis</strong>
                        <span>
                          Tente novamente quando a API concluir a inicialização.
                        </span>
                      </div>
                    </div>
                  </>
                )}
              </section>

              <DailyConversationComparison
                available={report.dailyComparisonAvailable === true}
                detailHref={detailHref}
                leadEventDeferred={
                  report.dailyComparisonLeadEventDeferred === true
                }
                points={report.dailyComparison ?? []}
                reportState={reportState}
                scopeLabel={scopeLabel}
                scopePlaceholder={scopePlaceholder}
              />
            </>
          )}
        </OverviewResults>
      </OverviewPendingProvider>
    </section>
  );
}

/**
 * One `role="note"` line under the filter bar (§6.2). Campaign -> number is a
 * hint with a one-click link, never an automatic filter (D4).
 */
function OverviewScopeNote({
  campaignInstanceLeads,
  filters,
  metaByAccount,
  metaPartial,
  multiCampaign,
  noLeadsOnSelectedNumber,
  whatsappInstances,
}: {
  campaignInstanceLeads: NonNullable<
    ReportOverviewDto["campaignInstanceLeads"]
  >;
  filters: OverviewFiltersInput;
  metaByAccount: boolean;
  metaPartial: boolean;
  multiCampaign: boolean;
  noLeadsOnSelectedNumber: boolean;
  whatsappInstances: WhatsappNumberOption[];
}) {
  if (metaByAccount) {
    return (
      <p className="muted" role="note">
        Investimento e Conversas Meta existem por campanha, não por número.
        Escolha uma campanha para ver o investimento que trouxe conversas para
        este número.
      </p>
    );
  }

  if (metaPartial) {
    // M5/M6: one leaking member taints the whole set (§6).
    return (
      <p className="muted" role="note">
        {multiCampaign
          ? noLeadsOnSelectedNumber
            ? "Nenhuma das campanhas selecionadas gerou conversas neste número no período. Investimento e Conversas Meta mostram as campanhas inteiras."
            : "Uma ou mais campanhas selecionadas também geraram conversas em outro número. Investimento e Conversas Meta somam as campanhas inteiras; custos por etapa e ROAS ficam ocultos para não distorcer o resultado."
          : noLeadsOnSelectedNumber
            ? "Esta campanha não gerou conversas neste número no período. Investimento e Conversas Meta mostram a campanha inteira."
            : "Esta campanha também gerou conversas em outro número. Investimento e Conversas Meta mostram a campanha inteira; custos por etapa e ROAS ficam ocultos para não distorcer o resultado."}
      </p>
    );
  }

  if (
    filters.campaignIds.length === 0 ||
    filters.whatsappInstanceId ||
    campaignInstanceLeads.length === 0
  ) {
    return null;
  }

  if (campaignInstanceLeads.length > 1) {
    // A set spread across numbers is too noisy to hint (§5.5).
    if (multiCampaign) {
      return null;
    }

    return (
      <p className="muted" role="note">
        Esta campanha gerou conversas em {campaignInstanceLeads.length} números.
        Selecione um número para ver o resultado de cada um.
      </p>
    );
  }

  const [entry] = campaignInstanceLeads;
  const instance = whatsappInstances.find(
    (candidate) => candidate.id === entry!.instanceId,
  );

  return (
    <p className="muted overview-scope-hint" role="note">
      {multiCampaign
        ? "Estas campanhas levam conversas para"
        : "Esta campanha leva conversas para"}{" "}
      <PresentationMask placeholder="Número oculto">
        {instance ? instanceLabel(instance) : entry!.instanceName}
      </PresentationMask>
      .{" "}
      <Link
        href={overviewHref({
          ...filters,
          whatsappInstanceId: entry!.instanceId,
        })}
      >
        Filtrar este número
      </Link>
    </p>
  );
}

function DailyConversationComparison({
  available,
  detailHref,
  leadEventDeferred,
  points,
  reportState,
  scopeLabel,
  scopePlaceholder,
}: {
  available: boolean;
  detailHref: string;
  /** The Lead is sent later than the entry in this period (rule override). */
  leadEventDeferred: boolean;
  points: ReportDailyComparisonPointDto[];
  reportState: OverviewFetchState;
  scopeLabel: string;
  scopePlaceholder: string;
}) {
  const {
    rows,
    showLeads,
    metaTotal,
    conversationsTotal,
    leadsTotal,
    difference,
  } = dailyComparisonSeries(points, leadEventDeferred);
  const barsPerDay = showLeads ? 3 : 2;
  const maximum = Math.max(
    1,
    ...rows.flatMap((row) =>
      showLeads
        ? [row.meta, row.conversations, row.leads]
        : [row.meta, row.conversations],
    ),
  );
  const viewWidth = Math.max(760, rows.length * 54 + 92);
  const viewHeight = 286;
  const plotTop = 22;
  const plotBottom = 226;
  const plotHeight = plotBottom - plotTop;
  const plotLeft = 48;
  const plotRight = viewWidth - 24;
  const plotWidth = plotRight - plotLeft;
  const groupWidth = plotWidth / Math.max(rows.length, 1);
  const barWidth = Math.min(
    showLeads ? 13 : 16,
    Math.max(5, groupWidth * (showLeads ? 0.22 : 0.3)),
  );
  const barGap = 2;
  const labelEvery = Math.max(1, Math.ceil(rows.length / 10));
  const barHeight = (value: number) => (value / maximum) * plotHeight;
  const formatDate = (date: string) => {
    const [, month, day] = date.split("-");
    return `${day}/${month}`;
  };
  const differenceLabel =
    difference === 0
      ? "Conversas conciliadas no período"
      : difference > 0
        ? `${difference} ${difference === 1 ? "conversa" : "conversas"} a mais na Meta`
        : `${Math.abs(difference)} ${Math.abs(difference) === 1 ? "conversa real" : "conversas reais"} a mais`;
  const seriesSummary = showLeads
    ? `Conversas iniciadas pela Meta ${metaTotal}, conversas iniciadas reais ${conversationsTotal}, leads (evento Lead enviado) ${leadsTotal}`
    : `Conversas iniciadas pela Meta ${metaTotal}, conversas iniciadas reais ${conversationsTotal}`;

  return (
    <section
      className="surface-panel daily-comparison"
      aria-labelledby="daily-comparison-title"
    >
      <div className="daily-comparison-header">
        <div>
          <span className="eyebrow">Conciliação diária</span>
          <h2 id="daily-comparison-title">Meta x conversas reais</h2>
          <p>
            A Meta conta cada conversa iniciada a partir dos anúncios. Conversas
            iniciadas reais são as conversas de anúncio que chegaram aqui no
            mesmo dia, contadas do mesmo jeito: cada nova conversa conta,
            inclusive de quem já era lead (mesma regra de “Conversas por
            anúncio”).
            {showLeads ? (
              <>
                {" "}
                Leads (evento Lead enviado) são os leads novos no dia em que o
                evento Lead foi enviado à Meta. Neste período, parte das
                conversas tem o Lead enviado depois, pela sua regra; por isso
                essa barra fica abaixo das conversas, o que é esperado. Nos dias
                em que o Lead foi enviado na entrada, ela acompanha o primeiro
                contato.
              </>
            ) : null}
          </p>
        </div>
        <div
          className="daily-comparison-summary"
          aria-label="Resumo do comparativo"
        >
          <span>
            <PresentationMask placeholder={scopePlaceholder}>
              {scopeLabel}
            </PresentationMask>
          </span>
          <strong>{differenceLabel}</strong>
        </div>
      </div>

      {reportState === "error" ? (
        <div className="daily-comparison-empty" role="status">
          <strong>Comparativo indisponível</strong>
          <span>A API precisa responder para montar a serie diária.</span>
        </div>
      ) : !available ? (
        <div className="daily-comparison-empty" role="status">
          <strong>Sincronize este período para ver a comparação diária</strong>
          <span>
            A serie histórica da Meta será registrada na próxima sincronização.
          </span>
          <Link className="button ghost" href={detailHref}>
            Abrir relatórios
          </Link>
        </div>
      ) : (
        <>
          <div className="daily-comparison-legend" aria-label="Legenda">
            <span title="Conversas iniciadas informadas pela Meta para os anúncios do filtro.">
              <i className="meta" aria-hidden="true" />
              Conversas iniciadas pela Meta <strong>{metaTotal}</strong>
            </span>
            <span title="Cada conversa de anúncio que chegou, no dia em que começou. A soma é igual a “Conversas por anúncio”.">
              <i className="real" aria-hidden="true" />
              Conversas iniciadas reais <strong>{conversationsTotal}</strong>
            </span>
            {showLeads ? (
              <span title="Leads novos no dia em que o evento Lead foi enviado à Meta (na entrada ou pela sua regra). Cada pessoa conta uma vez.">
                <i className="lead" aria-hidden="true" />
                Leads (evento Lead enviado) <strong>{leadsTotal}</strong>
              </span>
            ) : null}
          </div>
          <div className="daily-comparison-scroll">
            <svg
              className="daily-comparison-chart"
              viewBox={`0 0 ${viewWidth} ${viewHeight}`}
              style={{ minWidth: `${viewWidth}px` }}
              role="img"
              aria-label={`Comparação diária. ${seriesSummary}.`}
            >
              <title>
                {showLeads
                  ? "Conversas iniciadas pela Meta, conversas iniciadas reais e leads por dia"
                  : "Conversas iniciadas pela Meta e conversas iniciadas reais por dia"}
              </title>
              {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                const y = plotBottom - ratio * plotHeight;
                const value = Math.round(maximum * ratio);

                return (
                  <g key={ratio}>
                    <line x1={plotLeft} x2={plotRight} y1={y} y2={y} />
                    <text x={plotLeft - 10} y={y + 4} textAnchor="end">
                      {value}
                    </text>
                  </g>
                );
              })}
              {rows.map((row, index) => {
                const center = plotLeft + groupWidth * index + groupWidth / 2;
                const metaHeight = barHeight(row.meta);
                const conversationsHeight = barHeight(row.conversations);
                const leadsHeight = barHeight(row.leads);
                const groupStart =
                  center -
                  (barWidth * barsPerDay + barGap * (barsPerDay - 1)) / 2;
                const showLabel =
                  index % labelEvery === 0 || index === rows.length - 1;

                return (
                  <g key={row.date}>
                    <rect
                      className="daily-bar meta"
                      x={groupStart}
                      y={plotBottom - metaHeight}
                      width={barWidth}
                      height={metaHeight}
                      rx="3"
                    >
                      <title>{`${formatDate(row.date)} - Conversas iniciadas pela Meta: ${row.meta}`}</title>
                    </rect>
                    <rect
                      className="daily-bar real"
                      x={groupStart + barWidth + barGap}
                      y={plotBottom - conversationsHeight}
                      width={barWidth}
                      height={conversationsHeight}
                      rx="3"
                    >
                      <title>{`${formatDate(row.date)} - Conversas iniciadas reais: ${row.conversations}`}</title>
                    </rect>
                    {showLeads ? (
                      <rect
                        className="daily-bar lead"
                        x={groupStart + (barWidth + barGap) * 2}
                        y={plotBottom - leadsHeight}
                        width={barWidth}
                        height={leadsHeight}
                        rx="3"
                      >
                        <title>{`${formatDate(row.date)} - Leads (evento Lead enviado): ${row.leads}`}</title>
                      </rect>
                    ) : null}
                    {showLabel ? (
                      <text
                        className="daily-date-label"
                        x={center}
                        y={plotBottom + 26}
                        textAnchor="middle"
                      >
                        {formatDate(row.date)}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </svg>
          </div>
        </>
      )}
    </section>
  );
}

function Metric({
  label,
  value,
  delta,
  href = null,
  hrefLabel,
  title,
  partial = false,
  unavailable = false,
}: {
  label: string;
  value: string;
  delta: ReactNode;
  /** The exact list behind the number (Leads page), when one exists. */
  href?: string | null;
  hrefLabel?: string;
  /** Plain-language explanation shown on hover. */
  title?: string;
  /** Real value with a wider scope than the page (whole campaign). */
  partial?: boolean;
  unavailable?: boolean;
}) {
  return (
    <div
      className={`metric-card${unavailable ? " unavailable" : ""}${partial ? " partial" : ""}`}
      title={title}
    >
      <span>{label}</span>
      <strong>
        {href ? (
          <Link
            className="kpi-number-link"
            href={href}
            aria-label={hrefLabel ? `${value} - ${hrefLabel}` : undefined}
          >
            {value}
          </Link>
        ) : (
          value
        )}
      </strong>
      <small>{delta}</small>
    </div>
  );
}

function ConversionFunnel({
  description,
  stageCost,
  stages,
}: {
  description: string;
  /** Custo da etapa já formatado, na moeda (ou moedas) do recorte. */
  stageCost: (stage: ReportFunnelStepDto) => string;
  stages: ReportFunnelStepDto[];
}) {
  const palette = [
    "var(--mint)",
    "var(--teal)",
    "var(--cyan)",
    "var(--blue)",
    "var(--amber)",
    "var(--coral)",
  ];
  const viewWidth = 1000;
  const viewHeight = 176;
  const centerY = viewHeight / 2;
  const maximumHalfHeight = centerY - 14;
  const minimumHalfHeight = 10;
  const firstValue = stages[0]?.value ?? 0;
  const visualBase = Math.max(firstValue, 1);
  const segmentWidth = viewWidth / Math.max(stages.length, 1);
  const halfHeight = (value: number) =>
    Math.max(
      minimumHalfHeight,
      Math.round(Math.min(value / visualBase, 1) * maximumHalfHeight),
    );
  const boundaries = stages.map((stage) => halfHeight(stage.value));
  const lastBoundary = boundaries[boundaries.length - 1] ?? minimumHalfHeight;
  boundaries.push(Math.max(6, Math.round(lastBoundary * 0.52)));
  const segmentPath = (index: number) => {
    const startX = index * segmentWidth;
    const endX = (index + 1) * segmentWidth;
    const middleX = startX + segmentWidth / 2;
    const leftHeight = boundaries[index] ?? minimumHalfHeight;
    const rightHeight = boundaries[index + 1] ?? minimumHalfHeight;

    return [
      `M ${startX} ${centerY - leftHeight}`,
      `C ${middleX} ${centerY - leftHeight} ${middleX} ${centerY - rightHeight} ${endX} ${centerY - rightHeight}`,
      `L ${endX} ${centerY + rightHeight}`,
      `C ${middleX} ${centerY + rightHeight} ${middleX} ${centerY + leftHeight} ${startX} ${centerY + leftHeight}`,
      "Z",
    ].join(" ");
  };
  const rateFromPrevious = (index: number) => {
    if (index === 0) {
      return null;
    }

    const previousValue = stages[index - 1]?.value ?? 0;
    return previousValue > 0
      ? Math.round(((stages[index]?.value ?? 0) / previousValue) * 100)
      : null;
  };
  const mobileWidth = (value: number) => {
    if (firstValue === 0 || value === 0) {
      return "0%";
    }

    return `${Math.max(18, Math.min(100, Math.round((value / firstValue) * 100)))}%`;
  };
  const funnelLabel = stages
    .map((stage) => `${stage.label}: ${stage.value}`)
    .join(", ");

  return (
    <section
      className="conversion-funnel"
      aria-label={`Funil de conversão. ${funnelLabel}`}
    >
      <div className="conversion-funnel-heading">
        <div>
          <span className="micro-label">Funil integrado</span>
          <h2>Conversão por etapas</h2>
          <p>{description}</p>
        </div>
        <span className="conversion-funnel-stage-count">
          {stages.length} {stages.length === 1 ? "etapa" : "etapas"}
        </span>
      </div>

      <div
        className="conversion-funnel-stage-grid"
        style={{ "--funnel-stage-count": stages.length } as CSSProperties}
      >
        {stages.map((stage, index) => {
          const rate = rateFromPrevious(index);
          const color = palette[index % palette.length];

          return (
            <div
              className="conversion-funnel-stage"
              key={`${stage.key}-${index}`}
              style={{ "--funnel-stage-color": color } as CSSProperties}
            >
              <div className="conversion-funnel-stage-label">
                <span>{index + 1}</span>
                <strong>{stage.label}</strong>
              </div>
              <b>{stage.value}</b>
              <small>
                {index === 0
                  ? "Base do funil"
                  : rate === null
                    ? "Sem base anterior"
                    : `${rate}% da etapa anterior`}
              </small>
              <div className="conversion-funnel-stage-cost">
                <span>{funnelStageCostLabel(stage)}</span>
                <strong>{stageCost(stage)}</strong>
              </div>
            </div>
          );
        })}
      </div>

      <svg
        className="conversion-funnel-chart"
        viewBox={`0 0 ${viewWidth} ${viewHeight}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={funnelLabel}
      >
        {stages.map((stage, index) => (
          <path
            d={segmentPath(index)}
            fill={palette[index % palette.length]}
            key={`${stage.key}-${index}`}
          />
        ))}
      </svg>

      <div className="conversion-funnel-mobile">
        {stages.map((stage, index) => {
          const rate = rateFromPrevious(index);
          const color = palette[index % palette.length];

          return (
            <div
              className="conversion-funnel-mobile-stage"
              key={`${stage.key}-${index}`}
            >
              <div className="conversion-funnel-mobile-main">
                <span
                  className="conversion-funnel-mobile-index"
                  style={{ backgroundColor: color }}
                >
                  {index + 1}
                </span>
                <strong>{stage.label}</strong>
                <b>{stage.value}</b>
              </div>
              <small>
                {index === 0
                  ? "Base do funil"
                  : rate === null
                    ? "Sem base anterior"
                    : `${rate}% da etapa anterior`}
              </small>
              <div className="conversion-funnel-mobile-cost">
                <span>{funnelStageCostLabel(stage)}</span>
                <strong>{stageCost(stage)}</strong>
              </div>
              <span
                className="conversion-funnel-mobile-band"
                style={
                  {
                    "--funnel-stage-color": color,
                    "--funnel-mobile-width": mobileWidth(stage.value),
                  } as CSSProperties
                }
                aria-hidden="true"
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
