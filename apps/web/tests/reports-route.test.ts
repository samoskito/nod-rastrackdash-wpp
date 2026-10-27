import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// Sort headers are client buttons that navigate with the app router, which is
// always mounted in the real route but not in static markup rendering.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn() }),
}));

import ReportsPage from "../src/app/(app)/reports/page";
import { logMetaReportingSyncEnqueueFailure } from "../src/app/(app)/reports/reports-error-logging";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn() }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

function reportMetrics(overrides: Record<string, unknown> = {}) {
  return {
    spendCents: 120000,
    metaConversationsStarted: 176,
    costPerMetaConversationCents: 681,
    realConversations: 2,
    costPerRealConversationCents: 60000,
    organicLeads: 0,
    totalReceived: 2,
    trackingRate: 1,
    qualifiedLead: 1,
    costPerQualifiedLeadCents: 120000,
    purchases: 1,
    firstPurchases: 1,
    repurchases: 0,
    costPerPurchaseCents: 120000,
    trafficRevenueCents: 360000,
    organicRevenueCents: 0,
    totalRevenueCents: 360000,
    firstPurchaseRevenueCents: 360000,
    repurchaseRevenueCents: 0,
    roasAcquisition: 3,
    roasWithRepurchase: 3,
    funnelSteps: [
      {
        key: "real_conversations",
        label: "Conversas reais",
        value: 2,
        costCents: 60000,
      },
      {
        key: "qualified_lead",
        label: "Oportunidades",
        value: 1,
        costCents: 120000,
      },
      {
        key: "purchase",
        label: "Vendas",
        value: 1,
        costCents: 120000,
      },
      {
        key: "first_purchase",
        label: "Primeira compra",
        value: 1,
        costCents: 120000,
      },
    ],
    ...overrides,
  };
}

const campaignReport = {
  workspaceId: "workspace_1",
  rangeLabel: "Últimos 7 dias",
  since: "2026-07-06",
  until: "2026-07-12",
  campaigns: [
    {
      id: "cmp_1",
      name: "Black Friday WhatsApp",
      status: "active",
      configuredStatus: "ACTIVE",
      effectiveStatus: "ACTIVE",
      whatsappClassification: "manual_include",
      budget: {
        owner: "campaign",
        type: "daily",
        amountCents: 49500,
        editable: true,
      },
      ...reportMetrics(),
    },
  ],
  totals: reportMetrics({ spendCents: 355205 }),
  pagination: {
    page: 1,
    pageSize: 10,
    totalItems: 21,
    totalPages: 3,
  },
};

const adSetReport = {
  workspaceId: "workspace_1",
  rangeLabel: "Últimos 7 dias",
  since: "2026-07-06",
  until: "2026-07-12",
  adSets: [
    {
      id: "adset_1",
      campaignId: "cmp_1",
      campaignName: "Black Friday WhatsApp",
      name: "Publico quente",
      status: "active",
      configuredStatus: "ACTIVE",
      effectiveStatus: "ACTIVE",
      budget: {
        owner: "campaign",
        type: "daily",
        amountCents: 49500,
        editable: false,
      },
      ...reportMetrics(),
    },
  ],
  totals: reportMetrics({ spendCents: 355205 }),
  pagination: {
    page: 1,
    pageSize: 10,
    totalItems: 1,
    totalPages: 1,
  },
};

const adReport = {
  workspaceId: "workspace_1",
  rangeLabel: "Últimos 7 dias",
  since: "2026-07-06",
  until: "2026-07-12",
  ads: [
    {
      id: "ad_1",
      campaignId: "cmp_1",
      campaignName: "Black Friday WhatsApp",
      adSetId: "adset_1",
      adSetName: "Publico quente",
      name: "Criativo WhatsApp",
      status: "active",
      configuredStatus: "ACTIVE",
      effectiveStatus: "ACTIVE",
      thumbnailUrl: "https://cdn.example.test/ad-1.jpg",
      previewUrl: "https://cdn.example.test/ad-1-large.jpg",
      ...reportMetrics(),
    },
  ],
  totals: reportMetrics({ spendCents: 355205 }),
  pagination: {
    page: 1,
    pageSize: 10,
    totalItems: 1,
    totalPages: 1,
  },
};

const workspace = {
  id: "workspace_1",
  name: "Workspace",
  slug: "workspace",
  role: "owner",
  operationalStatus: "active",
  permissions: {
    canInviteMembers: true,
    canManageBilling: true,
    canManageIntegrations: true,
    canViewReports: true,
  },
};

const metaAssets = {
  workspaceId: "workspace_1",
  status: "connected",
  businesses: [],
  adAccounts: [],
  pixels: [],
  pages: [],
  reportingAccounts: [
    {
      id: "reporting_1",
      workspaceId: "workspace_1",
      businessId: "business_1",
      businessName: "BM 1",
      adAccountId: "act_123",
      adAccountName: "Conta 1",
      currency: "BRL",
      timezoneName: "America/Sao_Paulo",
      active: true,
      syncStatus: "synced",
      lastSyncedAt: "2026-07-12T10:00:00.000Z",
      lastSyncSince: "2026-07-06",
      lastSyncUntil: "2026-07-12",
      syncError: null,
    },
  ],
  selection: {
    businessId: null,
    adAccountId: null,
    pixelId: null,
  },
  conversionDestination: null,
  lastSyncedAt: "2026-07-10T10:00:00.000Z",
  syncError: null,
};

function metaAssetsWithSyncRange(
  since: string,
  until: string,
): typeof metaAssets {
  return {
    ...metaAssets,
    reportingAccounts: metaAssets.reportingAccounts.map((account) => ({
      ...account,
      lastSyncSince: since,
      lastSyncUntil: until,
    })),
  };
}

const metaStructure = {
  workspaceId: "workspace_1",
  campaigns: [
    {
      id: "cmp_1",
      name: "Black Friday WhatsApp",
      status: "PAUSED",
      effectiveStatus: "PAUSED",
      objective: "OUTCOME_SALES",
      adSets: [
        {
          id: "adset_1",
          name: "Publico quente",
          status: "PAUSED",
          effectiveStatus: "PAUSED",
          ads: [
            {
              id: "ad_1",
              name: "Criativo WhatsApp",
              status: "RATE_LIMITED",
              effectiveStatus: "RATE_LIMITED",
            },
          ],
        },
      ],
    },
  ],
};

// nod: os números são as conexões WhatsApp (GET /integrations/whatsapp-connections).
const whatsappInstances = [
  {
    id: "instance_active",
    name: "Central vendas",
    displayName: null,
    provider: "uazapi_byo",
    status: "active",
    connectedPhone: "551199998888",
  },
  {
    id: "instance_removed",
    name: "Número removido",
    displayName: null,
    provider: "uazapi_byo",
    status: "suspended",
    connectedPhone: "551188887777",
  },
];

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockReportsApi(
  options: {
    campaign?: typeof campaignReport;
    fail?: boolean;
    member?: boolean;
    comparison?: typeof campaignReport;
    assets?: typeof metaAssets;
  } = {},
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);

    if (options.fail) {
      return json({ message: "unavailable" }, 503);
    }

    if (url.includes("/workspaces/current")) {
      return json(
        options.member
          ? {
              ...workspace,
              role: "member",
              permissions: {
                ...workspace.permissions,
                canManageIntegrations: false,
              },
            }
          : workspace,
      );
    }

    if (url.includes("/integrations/meta/assets")) {
      return json(options.assets ?? metaAssets);
    }

    if (url.includes("/integrations/whatsapp-connections")) {
      return json(whatsappInstances);
    }

    if (url.includes("/reports/meta/structure")) {
      return json(metaStructure);
    }

    if (url.includes("/reports/adsets")) {
      return json(adSetReport);
    }

    if (url.includes("/reports/ads")) {
      return json(adReport);
    }

    if (url.includes("/reports/campaigns")) {
      return json(
        url.includes("since=2026-07-01") && options.comparison
          ? options.comparison
          : (options.campaign ?? campaignReport),
      );
    }

    return json({ message: "not found" }, 404);
  });
}

async function renderReports(searchParams: Record<string, string> = {}) {
  const element = await ReportsPage({
    searchParams: Promise.resolve(searchParams),
  });

  return renderToStaticMarkup(createElement("div", null, element));
}

describe("reports route", () => {
  it("sanitizes secrets before reporting a Meta sync enqueue failure", () => {
    const secret = "EAA-secret-access-token";
    const basicSecret = "basic-user:basic-password";
    const cookieSecrets = ["session-one", "session-two"];
    const payloadSecret = "arbitrary-payload-content";
    const error = new Error(
      `POST /reports/sync?access_token=${secret} https://graph.facebook.com/sync?access_token=${secret} Authorization: Basic ${basicSecret}; Cookie: first=${cookieSecrets[0]}; second=${cookieSecrets[1]} payload={"anything":"${payloadSecret}","access_token":"${secret}"}`,
    );
    error.name = `ApiRequestError-${secret}-${payloadSecret}`;
    const logger = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    logMetaReportingSyncEnqueueFailure(error);

    expect(logger).toHaveBeenCalledWith("Meta reporting sync enqueue failed", {
      type: "Error",
      name: "UnknownError",
      message: "Error message redacted",
    });
    const logged = JSON.stringify(logger.mock.calls);

    for (const value of [secret, basicSecret, ...cookieSecrets, payloadSecret]) {
      expect(logged).not.toContain(value);
    }
    expect(logged).not.toContain("/reports/sync?");
    expect(logged).not.toContain("https://graph.facebook.com/sync?");
    expect(logged).not.toContain("Authorization:");
    expect(logged).not.toContain("Cookie:");
    expect(logged).not.toContain("payload=");
  });

  it("loads only campaigns in the default report view", async () => {
    const fetchMock = mockReportsApi();
    const html = await renderReports();
    const urls = fetchMock.mock.calls.map(([input]) => String(input));

    expect(html).toContain("Black Friday WhatsApp");
    expect(html).toContain("Total do filtro");
    expect(html).toContain("21 campanhas");
    expect(html).toContain("Período de análise");
    expect(html).toContain("06/07/2026 a 12/07/2026");
    expect(html).toContain("Meta: 06/07/2026 a 12/07/2026");
    expect(html).toContain("Próxima");
    expect(
      urls.some((url) => url.includes("/reports/campaigns?page=1&pageSize=10")),
    ).toBe(true);
    expect(urls.some((url) => url.includes("/reports/adsets"))).toBe(false);
    expect(urls.some((url) => /\/reports\/ads(?:\?|$)/.test(url))).toBe(false);
    expect(urls.some((url) => url.includes("/reports/meta/structure"))).toBe(
      false,
    );
  });

  it("filters every report level by active WhatsApp instance and keeps Meta scope honest", async () => {
    const fetchMock = mockReportsApi();

    const campaignHtml = await renderReports({
      whatsappInstanceId: "instance_active",
    });
    await renderReports({
      view: "adsets",
      whatsappInstanceId: "instance_active",
    });
    await renderReports({ view: "ads", whatsappInstanceId: "instance_active" });
    const urls = fetchMock.mock.calls.map(([input]) => String(input));

    for (const endpoint of ["campaigns", "adsets", "ads"]) {
      expect(
        urls.some(
          (url) =>
            url.includes(`/reports/${endpoint}`) &&
            url.includes("whatsappInstanceId=instance_active"),
        ),
      ).toBe(true);
    }
    expect(campaignHtml).toContain("Número WhatsApp");
    expect(campaignHtml).toContain("Todos os números");
    expect(campaignHtml).toContain("Central vendas - •••• 8888");
    expect(campaignHtml).not.toContain('value="instance_removed"');
    expect(campaignHtml).toContain("Escopo do número WhatsApp");
    expect(campaignHtml).toContain(
      "Investimento, impressões e demais métricas Meta continuam no escopo da campanha ou conta, não por número.",
    );
    expect(campaignHtml).toContain('name="whatsappInstanceId"');
    expect(campaignHtml).toContain("whatsappInstanceId=instance_active");
  });

  it("accepts a broader Meta sync period that covers the report", async () => {
    const fetchMock = mockReportsApi({
      assets: metaAssetsWithSyncRange("2026-05-01", "2026-07-12"),
    });

    const html = await renderReports({
      since: "2026-07-06",
      until: "2026-07-12",
    });
    const urls = fetchMock.mock.calls.map(([input]) => String(input));

    expect(html).toContain("Meta: 01/05/2026 a 12/07/2026");
    expect(html).not.toContain("Período Meta diferente do relatório");
    expect(
      urls.some(
        (url) =>
          url.includes("/reports/campaigns") &&
          url.includes("includeDaily=true"),
      ),
    ).toBe(true);
  });

  it("keeps the warning for ad sets when only a broader aggregate exists", async () => {
    mockReportsApi({
      assets: metaAssetsWithSyncRange("2026-05-01", "2026-07-12"),
    });

    const html = await renderReports({ view: "adsets" });

    expect(html).toContain("Período Meta diferente do relatório");
  });

  it("keeps the warning when any active Meta account lacks coverage", async () => {
    const coveredAssets = metaAssetsWithSyncRange("2026-05-01", "2026-07-12");
    mockReportsApi({
      assets: {
        ...coveredAssets,
        reportingAccounts: [
          ...coveredAssets.reportingAccounts,
          {
            ...coveredAssets.reportingAccounts[0],
            id: "reporting_2",
            adAccountId: "act_456",
            adAccountName: "Conta 2",
            syncStatus: "error",
          },
        ],
      },
    });

    const html = await renderReports({
      since: "2026-07-06",
      until: "2026-07-12",
    });

    expect(html).toContain("Contas Meta com períodos diferentes");
  });

  it("does not mark matching persisted periods as mixed while account sync jobs are running", async () => {
    const synchronizedAssets = metaAssetsWithSyncRange(
      "2026-08-26",
      "2026-09-01",
    );
    mockReportsApi({
      assets: {
        ...synchronizedAssets,
        reportingAccounts: Array.from({ length: 3 }, (_, index) => ({
          ...synchronizedAssets.reportingAccounts[0],
          id: `reporting_${index + 1}`,
          adAccountId: `act_${index + 1}`,
          adAccountName: `Conta ${index + 1}`,
          // This is a current queue state. The saved period remains the last
          // completed import and must still be comparable by Reports.
          syncStatus: "syncing" as const,
        })),
      },
    });

    const html = await renderReports({
      since: "2026-08-26",
      until: "2026-09-01",
    });

    expect(html).toContain("Meta: 26/08/2026 a 01/09/2026");
    expect(html).not.toContain("Contas Meta com períodos diferentes");
    expect(html).not.toContain("Período Meta diferente do relatório");
  });

  it("loads only the selected ad set view", async () => {
    const fetchMock = mockReportsApi();
    const html = await renderReports({ view: "adsets" });
    const urls = fetchMock.mock.calls.map(([input]) => String(input));

    expect(html).toContain("Performance por conjunto");
    expect(html).toContain("Publico quente");
    expect(
      urls.some((url) => url.includes("/reports/adsets?page=1&pageSize=10")),
    ).toBe(true);
    expect(urls.some((url) => url.includes("/reports/campaigns"))).toBe(false);
    expect(urls.some((url) => /\/reports\/ads(?:\?|$)/.test(url))).toBe(false);
  });

  it("navigates the hierarchy by names and opens Leads only from real conversations", async () => {
    mockReportsApi();
    const campaignHtml = await renderReports();
    const adSetHtml = await renderReports({
      view: "adsets",
      campaignId: "cmp_1",
    });
    const adHtml = await renderReports({
      view: "ads",
      campaignId: "cmp_1",
      adSetId: "adset_1",
    });

    expect(campaignHtml).toContain(
      "campaignId=cmp_1&amp;page=1&amp;pageSize=10&amp;view=adsets",
    );
    expect(campaignHtml).toContain(
      'class="report-metric-link" href="/leads?campaignId=cmp_1',
    );
    expect(adSetHtml).toContain("Seleção atual");
    expect(adSetHtml).toContain("Black Friday WhatsApp");
    expect(adSetHtml).toContain(
      "campaignId=cmp_1&amp;adSetId=adset_1&amp;page=1&amp;pageSize=10&amp;view=ads",
    );
    expect(adHtml).toContain(
      "campaignId=cmp_1&amp;adSetId=adset_1&amp;adId=ad_1&amp;page=1&amp;pageSize=10&amp;view=ads",
    );
  });

  it("renders ad thumbnails, selection and controlled Meta actions", async () => {
    mockReportsApi();
    const campaignHtml = await renderReports();
    const adHtml = await renderReports({
      view: "ads",
      campaignId: "cmp_1",
      adSetId: "adset_1",
      adId: "ad_1",
    });

    expect(campaignHtml).toContain(
      'aria-label="Alterar orçamento da campanha Black Friday WhatsApp"',
    );
    expect(campaignHtml).toContain(
      'aria-label="Pausar campanha Black Friday WhatsApp"',
    );
    expect(adHtml).toContain("https://cdn.example.test/ad-1.jpg");
    expect(adHtml).toContain("https://cdn.example.test/ad-1-large.jpg");
    expect(adHtml).toContain(
      'aria-label="Ampliar criativo do anúncio Criativo WhatsApp"',
    );
    expect(adHtml).toContain('class="is-selected"');
    expect(adHtml).toContain('name="adId" value="ad_1"');
  });

  it("shows the current WhatsApp review state in the action column", async () => {
    mockReportsApi();
    const html = await renderReports();

    expect(html).toContain("Incluído manualmente");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('class="review-actions"');
  });

  it("keeps the WhatsApp review cell in the final column when a row has missing funnel steps", async () => {
    const campaignWithMissingSteps = {
      ...campaignReport,
      campaigns: [
        {
          ...campaignReport.campaigns[0],
          funnelSteps: campaignReport.campaigns[0].funnelSteps.slice(0, 1),
        },
      ],
    };
    mockReportsApi({ campaign: campaignWithMissingSteps });
    const html = await renderReports();
    const table = html.match(
      /<table class="performance-table"[^>]*>([\s\S]*?)<\/table>/,
    )?.[1];
    const header = table?.match(/<thead><tr>([\s\S]*?)<\/tr><\/thead>/)?.[1];
    const row = table?.match(/<tbody><tr[^>]*>([\s\S]*?)<\/tr>/)?.[1];
    const headerCells = header?.match(/<th(?:\s|>)/g) ?? [];
    const rowCells = row?.match(/<td(?:\s|>)/g) ?? [];

    expect(headerCells.length).toBeGreaterThan(0);
    expect(rowCells).toHaveLength(headerCells.length);
    expect(row).toContain('class="performance-review-cell"');
  });

  it("keeps report controls compact and gives the results table visual priority", async () => {
    mockReportsApi();
    const html = await renderReports();
    const controlsIndex = html.indexOf(
      'class="surface-panel report-control-center"',
    );
    const resultsIndex = html.indexOf('class="report-results-overview"');
    const tableIndex = html.indexOf('class="performance-table"');

    expect(controlsIndex).toBeGreaterThan(-1);
    expect(resultsIndex).toBeGreaterThan(controlsIndex);
    expect(tableIndex).toBeGreaterThan(resultsIndex);
    expect(html).toContain('class="report-analysis-switcher"');
    expect(html).toContain('class="report-period-context"');
    expect(html).toContain('aria-label="Período"');
    expect(html).toContain('aria-label="Escopo"');
    expect(html).toContain('aria-label="Ações"');
    // Periodo comes before escopo, which comes before acoes.
    expect(html.indexOf('aria-label="Período"')).toBeLessThan(
      html.indexOf('aria-label="Escopo"'),
    );
    expect(html.indexOf('aria-label="Escopo"')).toBeLessThan(
      html.indexOf('aria-label="Ações"'),
    );
    // The Meta sync window is a hint on the sync action, not a floating tag.
    expect(html).toContain('class="report-sync-hint"');
    expect(html).toContain("Janela já sincronizada da Meta:");
    expect(html).not.toContain("Estrutura e filtros");
    expect(html).toContain('aria-label="Grupo de métricas"');
    expect(html).toContain('aria-label="Filtros avançados"');
    expect(html).toContain('name="compareSince"');
    expect(html).toContain('name="compareUntil"');
    expect(html).toContain('data-label="Conversas reais"');
    expect(html).not.toContain("<th>Leads orgânicos</th>");
    expect(html).not.toContain("<th>Receita organica</th>");
  });

  it("sends delivery and selected entity filters while rendering table selection controls", async () => {
    const fetchMock = mockReportsApi();
    const html = await renderReports({
      delivery: "had_delivery",
      selectedIds: "cmp_1,cmp_2,cmp_1",
    });
    const campaignCall = fetchMock.mock.calls
      .map(([input]) => String(input))
      .find((url) => url.includes("/reports/campaigns"));

    expect(campaignCall).toContain("delivery=had_delivery");
    expect(campaignCall).toContain("selectedIds=cmp_1%2Ccmp_2");
    expect(html).toContain("Teve veiculação no período");
    expect(html).toContain("Filtrar por seleção");
    expect(html).toContain("2 selecionados");
    expect(html).toContain('aria-label="Selecionar campanhas desta página"');
    expect(html).toMatch(
      /aria-label="Selecionar Black Friday WhatsApp"[^>]*checked=""/,
    );
  });

  it("groups the toolbar into periodo, escopo and acoes with advanced filters on demand", () => {
    const css = readFileSync(
      join(process.cwd(), "src/styles/layout-system.css"),
      "utf8",
    );

    expect(css).toMatch(
      /\.report-toolbar\s*{[^}]*grid-template-areas:\s*"period actions"\s*"scope scope"/s,
    );
    expect(css).toMatch(/\.report-toolbar-period\s*{[^}]*grid-area:\s*period/s);
    expect(css).toMatch(/\.report-toolbar-scope\s*{[^}]*grid-area:\s*scope/s);
    expect(css).toMatch(
      /\.report-toolbar-actions\s*{[^}]*grid-area:\s*actions[^}]*justify-content:\s*flex-end/s,
    );
    // Narrow viewports must still read periodo -> escopo -> acoes.
    expect(css).toMatch(
      /@media \(max-width: 1280px\)\s*{\s*\.report-toolbar\s*{[^}]*grid-template-areas:\s*"period"\s*"scope"\s*"actions"/s,
    );
    expect(css).toMatch(
      /\.report-period-range\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(126px,\s*168px\)\)/s,
    );
    expect(css).toMatch(
      /\.report-filter-primary\s*{[^}]*grid-template-columns:[^}]*auto\s*auto[^}]*padding:\s*10px 14px/s,
    );
    expect(css).toMatch(
      /\.report-advanced-filters\[open\]\s*{[^}]*grid-column:\s*1\s*\/\s*-1/s,
    );
    expect(css).toMatch(
      /\.report-period-form input\[type="date"\]\s*{[^}]*rgba\(5,\s*8,\s*7,\s*0\.92\)[^}]*color-scheme:\s*dark/s,
    );
  });

  it("renders and preserves the selected metric group without changing the API query", async () => {
    const fetchMock = mockReportsApi();
    const html = await renderReports({ metrics: "revenue" });
    const campaignCall = fetchMock.mock.calls
      .map(([input]) => String(input))
      .find((url) => url.includes("/reports/campaigns"));

    expect(html).toContain('data-metric-group="revenue"');
    expect(html).toContain('aria-current="page" class="active"');
    expect(html).toContain("<th>Receita primeira compra</th>");
    expect(html).toContain("<th>ROAS com recompra</th>");
    expect(html).toContain("metrics=revenue");
    expect(campaignCall).not.toContain("metrics=");
  });

  it("renders an excluded WhatsApp item with a persistent selected state", async () => {
    const excludedCampaign = {
      ...campaignReport,
      campaigns: [
        {
          ...campaignReport.campaigns[0],
          whatsappClassification: "manual_exclude",
        },
      ],
    };
    mockReportsApi({ campaign: excludedCampaign });
    const html = await renderReports({ whatsappClassification: "excluded" });

    expect(html).toContain("Excluído manualmente");
    expect(html).toContain('class="review-state excluded"');
    expect(html).toMatch(
      /<button[^>]*aria-pressed="true"[^>]*value="manual_exclude"[^>]*>Excluir<\/button>/,
    );
  });

  it("sends hierarchy selection to the selected report endpoint", async () => {
    const fetchMock = mockReportsApi();

    await renderReports({
      view: "ads",
      campaignId: "cmp_1",
      adSetId: "adset_1",
    });
    const urls = fetchMock.mock.calls.map(([input]) => String(input));

    expect(
      urls.some((url) =>
        url.includes(
          "/reports/ads?campaignId=cmp_1&adSetId=adset_1&page=1&pageSize=10",
        ),
      ),
    ).toBe(true);
  });

  it("preserves filters when navigating report pages", async () => {
    mockReportsApi();
    const html = await renderReports({
      businessId: "business_1",
      nameContains: "Black",
      page: "1",
    });

    expect(html).toContain(
      "businessId=business_1&amp;nameContains=Black&amp;nameScope=campaign&amp;page=2&amp;pageSize=10&amp;view=campaigns",
    );
  });

  it("loads campaign comparison only when it is requested", async () => {
    const comparison = {
      ...campaignReport,
      rangeLabel: "2026-07-01 a 2026-07-07",
      campaigns: [
        {
          ...campaignReport.campaigns[0],
          spendCents: 60000,
          metaConversationsStarted: 80,
        },
      ],
    };
    const fetchMock = mockReportsApi({ comparison });
    const html = await renderReports({
      since: "2026-07-08",
      until: "2026-07-14",
      compareSince: "2026-07-01",
      compareUntil: "2026-07-07",
    });
    const campaignCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("/reports/campaigns"),
    );

    expect(campaignCalls).toHaveLength(2);
    expect(html).toContain("Comparação entre períodos");
    expect(html).toContain("2026-07-01 a 2026-07-07");
  });

  it("loads the Meta technical structure only on demand", async () => {
    const fetchMock = mockReportsApi();
    const html = await renderReports({ diagnostic: "open" });
    const urls = fetchMock.mock.calls.map(([input]) => String(input));

    expect(urls.some((url) => url.includes("/reports/meta/structure"))).toBe(
      true,
    );
    expect(html).toContain("Estrutura técnica recolhida");
    expect(html).toContain("Status desconhecido");
  });

  it("filters the technical structure without loading other report levels", async () => {
    const fetchMock = mockReportsApi();
    const html = await renderReports({
      structureNameContains: "Criativo",
      structureNameScope: "ad",
      structureStatus: "inactive",
    });
    const urls = fetchMock.mock.calls.map(([input]) => String(input));

    expect(html).toContain("Criativo WhatsApp");
    expect(urls.some((url) => url.includes("/reports/meta/structure"))).toBe(
      true,
    );
    expect(urls.some((url) => url.includes("/reports/adsets"))).toBe(false);
    expect(urls.some((url) => url.includes("/reports/ads"))).toBe(false);
  });

  it("renders API failure without pretending other report levels were loaded", async () => {
    mockReportsApi({ fail: true });
    const html = await renderReports();

    expect(html).toContain("API indisponível");
    expect(html).toContain("Não foi possível carregar campanhas");
    expect(html).not.toContain("Não foi possível carregar conjuntos");
    expect(html).not.toContain("Não foi possível carregar anúncios");
  });

  it("6.3b: a drill-down campaign outside the cut is an empty table, not API indisponível", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes("/workspaces/current")) return json(workspace);
      if (url.includes("/integrations/meta/assets")) return json(metaAssets);
      if (url.includes("/integrations/whatsapp-connections")) {
        return json(whatsappInstances);
      }
      if (url.includes("/reports/campaigns")) {
        return json({ message: "Campanha não encontrada" }, 404);
      }

      return json({ message: "not found" }, 404);
    });
    const html = await renderReports({
      campaignId: "cmp_other_account",
      businessId: "business_1",
    });

    expect(html).not.toContain("API indisponível");
    expect(html).not.toContain("Não foi possível carregar campanhas");
  });

  it("hides Meta synchronization from workspace members", async () => {
    mockReportsApi({ member: true });
    const html = await renderReports();

    expect(html).toContain("Sem permissão para sincronizar Meta");
    expect(html).not.toContain("Enfileirando leitura dos dados Meta");
  });
});
