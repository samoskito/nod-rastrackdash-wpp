import {
  funnelMetricLabels,
  type CampaignReportRowDto,
  type CurrencyCode,
  type MetaAssetsDto,
  type ReportCurrencyGroupDto,
  type ReportDailyComparisonPointDto,
  type ReportFunnelStepDto,
  type ReportOverviewDto,
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
import { serverApiFetch } from "../../../lib/server-api";
import { OverviewFilters } from "./overview-filters";
import { dailyComparisonSeries } from "./daily-comparison-series";
import {
  OverviewLeadsBlock,
  overviewLeadsCopy,
  type OverviewLeadsBlockItem,
} from "./overview-leads-block";
import { getLeadSubmittedOverrideEnabled } from "../../../lib/lead-submitted-override";
import { overviewLeadsHref } from "./overview-leads-links";

type OverviewSearchParams = Record<string, string | string[] | undefined>;
type OverviewFiltersInput = {
  /** Contas de anúncio juntas por "," (`adAccountId` ou `adAccountIds` na URL). */
  adAccountId?: string;
  businessId?: string;
  since?: string;
  until?: string;
};

type OverviewFetchState = "real" | "empty" | "error";
type OverviewReportResult = {
  report: ReportOverviewDto;
  state: OverviewFetchState;
};

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
  } catch {
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

async function getMetaAssets(): Promise<MetaAssetsDto | null> {
  try {
    return await serverApiFetch<MetaAssetsDto>("/integrations/meta/assets");
  } catch {
    return null;
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

function reportsHref(filters: OverviewFiltersInput): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value && key !== "adAccountId") {
      params.set(key, value);
    }
  }

  setAdAccountParams(params, splitAdAccountIds(filters.adAccountId));

  const query = params.toString();
  return query ? `/reports?${query}` : "/reports";
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
  };
  const [
    { report, state: reportState },
    metaAssets,
    adAccountCurrencies,
    leadSubmittedOverrideEnabled,
  ] = await Promise.all([
    getOverviewReport(filters),
    getMetaAssets(),
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
  const stageCostLabel = (stage: ReportFunnelStepDto): string =>
    mixedCurrency
      ? perCurrencyStageCost(stage, currencyGroups)
      : fmt(stage.costCents ?? null);
  const costPerLeadLabel = mixedCurrency
    ? perCurrencyCost(
        currencyGroups,
        (group) => group.costPerRealConversationCents,
      )
    : campaign.costPerRealConversationCents !== null
      ? fmt(campaign.costPerRealConversationCents)
      : null;
  const dataAvailable = reportState !== "error";
  const trackedRate =
    dataAvailable && campaign.trackingRate !== null
      ? ratePercent(campaign.trackingRate)
      : null;
  const funnelStages: ReportFunnelStepDto[] = [
    {
      key: "meta_conversations",
      label: "Conversas Meta",
      value: campaign.metaConversationsStarted,
      costCents: campaign.costPerMetaConversationCents,
    },
    ...campaign.funnelSteps,
  ];
  const kpiStages = configuredKpiStages(campaign.funnelSteps);
  const selectedBusiness = reportingAccounts.find(
    (account) => account.businessId === filters.businessId,
  );
  const selectedAccount = reportingAccounts.find(
    (account) => account.adAccountId === filters.adAccountId,
  );
  const scopeLabel =
    selectedAccount?.adAccountName ??
    selectedBusiness?.businessName ??
    "Todas as contas";
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
  const funnelSummary = dataAvailable
    ? funnelOutcomeSummary(
        report.rangeLabel,
        campaign.metaConversationsStarted,
        campaign,
      )
    : "A jornada será exibida quando a API concluir a inicialização.";

  return (
    <section className="page-stack page-wide overview-page">
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
          ) : (
            <>
              <span className="tag">{report.rangeLabel}</span>
              <span className="tag">{campaigns.length} campanhas</span>
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
        adAccountIds={selectedAdAccountIds}
        businessId={filters.businessId}
        hasActiveFilter={Object.values(filters).some(Boolean)}
        reportingAccounts={reportingAccounts}
        since={report.since ?? filters.since}
        until={report.until ?? filters.until}
      />

      {dataAvailable ? (
        <MetaSyncCoverageNotice coverage={report.metaSyncCoverage} />
      ) : null}

      <div className="metric-grid overview-primary-metrics">
        <Metric
          label="Investimento"
          value={
            !dataAvailable
              ? "-"
              : mixedCurrency
                ? "Por moeda"
                : fmt(campaign.spendCents)
          }
          delta={
            !dataAvailable
              ? "Aguardando resposta da API"
              : mixedCurrency
                ? "Veja os totais por moeda abaixo"
                : reportState === "empty"
                  ? "Nenhuma campanha sincronizada"
                  : report.rangeLabel
          }
          unavailable={!dataAvailable}
        />
        <Metric
          label="Conversas Meta"
          value={
            dataAvailable ? String(campaign.metaConversationsStarted) : "-"
          }
          delta={
            dataAvailable ? report.rangeLabel : "Aguardando resposta da API"
          }
          unavailable={!dataAvailable}
        />
        <Metric
          label="Leads novos"
          title={leadsCopy.new}
          value={dataAvailable ? String(campaign.realConversations) : "-"}
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
                      : rateGap.exchangeRateMissing
                        ? `ROAS ${exchangeRateMissingLabel}`
                        : `ROAS ${ratioLabel(campaign.roasAcquisition)}`
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
                  : stage.costCents != null
                    ? `${funnelStageCostLabel(stage)} ${stageCostLabel(stage)}`
                    : report.rangeLabel
              }
              unavailable={!dataAvailable}
            />
          ),
        )}
      </div>

      {dataAvailable && mixedCurrency ? (
        <CurrencyKpiGroups groups={currencyGroups.map(currencyKpiGroup)} />
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
        leadEventDeferred={report.dailyComparisonLeadEventDeferred === true}
        points={report.dailyComparison ?? []}
        reportState={reportState}
        scopeLabel={scopeLabel}
      />
    </section>
  );
}

function DailyConversationComparison({
  available,
  detailHref,
  leadEventDeferred,
  points,
  reportState,
  scopeLabel,
}: {
  available: boolean;
  detailHref: string;
  /** The Lead is sent later than the entry in this period (rule override). */
  leadEventDeferred: boolean;
  points: ReportDailyComparisonPointDto[];
  reportState: OverviewFetchState;
  scopeLabel: string;
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
            <PresentationMask placeholder="Conta de anúncios oculta">
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
  unavailable?: boolean;
}) {
  return (
    <div
      className={`metric-card${unavailable ? " unavailable" : ""}`}
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
