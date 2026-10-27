import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import OverviewPage from "../src/app/(app)/overview/page";
import { overviewLeadsHref } from "../src/app/(app)/overview/overview-leads-links";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

function reportMetrics(overrides: Record<string, unknown> = {}) {
  const metrics = {
    spendCents: 10000,
    metaConversationsStarted: 10,
    costPerMetaConversationCents: 1000,
    realConversations: 6,
    costPerRealConversationCents: 1666,
    organicLeads: 2,
    totalReceived: 8,
    trackingRate: 0.75,
    qualifiedLead: 1,
    costPerQualifiedLeadCents: 10000,
    purchases: 1,
    firstPurchases: 1,
    repurchases: 0,
    costPerPurchaseCents: 10000,
    trafficRevenueCents: 30000,
    organicRevenueCents: 5000,
    totalRevenueCents: 35000,
    firstPurchaseRevenueCents: 30000,
    repurchaseRevenueCents: 0,
    roasAcquisition: 3,
    roasWithRepurchase: 3,
    funnelSteps: [
      {
        key: "real_conversations",
        label: "Conversas reais iniciadas",
        value: 6,
        costCents: 1666,
      },
      {
        key: "qualified_lead",
        label: "Lead qualificado",
        value: 1,
        costCents: 10000,
      },
      {
        key: "purchase",
        label: "Compras",
        value: 1,
        costCents: 10000,
      },
      {
        key: "first_purchase",
        label: "Primeira compra",
        value: 1,
      },
    ],
  };

  return { ...metrics, ...overrides };
}

type MetricCard = { label: string; value: string; delta: string };

/** Parses the rendered primary KPI cards in DOM order. */
function metricCards(html: string): MetricCard[] {
  const grid = html.slice(
    html.indexOf("overview-primary-metrics"),
    html.indexOf("overview-funnel-panel"),
  );
  // Cards may carry a hover title, a linked number and a linked delta.
  const pattern =
    /<div class="metric-card[^"]*"(?: title="[^"]*")?><span>(.*?)<\/span><strong>(.*?)<\/strong><small>(.*?)<\/small><\/div>/g;
  const text = (value: string) => value.replace(/<[^>]+>/g, "");
  const cards: MetricCard[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(grid)) !== null) {
    cards.push({
      label: match[1]!,
      value: text(match[2]!),
      delta: text(match[3]!),
    });
  }

  return cards;
}

function overviewResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function renderOverview(body: Record<string, unknown>) {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(overviewResponse(body));
  const element = await OverviewPage({});
  return renderToStaticMarkup(createElement("div", null, element));
}

const leadOnlyMetrics = () =>
  reportMetrics({
    qualifiedLead: 4,
    costPerQualifiedLeadCents: 2500,
    purchases: 0,
    firstPurchases: 0,
    repurchases: 0,
    costPerPurchaseCents: null,
    trafficRevenueCents: 0,
    organicRevenueCents: 0,
    totalRevenueCents: 0,
    firstPurchaseRevenueCents: 0,
    repurchaseRevenueCents: 0,
    roasAcquisition: null,
    roasWithRepurchase: null,
    funnelSteps: [
      {
        key: "real_conversations",
        label: "Conversas reais iniciadas",
        value: 6,
        costCents: 1666,
      },
      {
        key: "event_view_content",
        label: "Pre-qualificado",
        value: 12,
        costCents: 833,
      },
      {
        key: "qualified_lead",
        label: "Lead qualificado",
        value: 4,
        costCents: 2500,
      },
    ],
  });

const salesMetrics = () => reportMetrics();

describe("overview route", () => {
  it("applies period and Meta account filters and renders the daily comparison", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workspaceId: "workspace_1",
            rangeLabel: "2026-07-01 a 2026-07-02",
            since: "2026-07-01",
            until: "2026-07-02",
            campaigns: [
              {
                id: "cmp_1",
                name: "Campanha Real",
                status: "active",
                ...reportMetrics(),
              },
            ],
            dailyComparisonAvailable: true,
            dailyComparison: [
              {
                date: "2026-07-01",
                metaConversationsStarted: 7,
                realConversations: 5,
              },
              {
                date: "2026-07-02",
                metaConversationsStarted: 3,
                realConversations: 1,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workspaceId: "workspace_1",
            status: "connected",
            businesses: [],
            adAccounts: [],
            pixels: [],
            reportingAccounts: [
              {
                id: "reporting_1",
                workspaceId: "workspace_1",
                businessId: "business_1",
                businessName: "BM Principal",
                adAccountId: "act_1",
                adAccountName: "Conta Principal",
                currency: "BRL",
                timezoneName: "America/Sao_Paulo",
                active: true,
                syncStatus: "synced",
                lastSyncedAt: "2026-07-02T12:00:00.000Z",
                lastSyncSince: "2026-07-01",
                lastSyncUntil: "2026-07-02",
                syncError: null,
              },
              {
                id: "reporting_2",
                workspaceId: "workspace_1",
                businessId: "business_2",
                businessName: "BM Secundario",
                adAccountId: "act_2",
                adAccountName: "Conta Secundaria",
                currency: "BRL",
                timezoneName: "America/Sao_Paulo",
                active: true,
                syncStatus: "synced",
                lastSyncedAt: "2026-07-02T12:00:00.000Z",
                lastSyncSince: "2026-07-01",
                lastSyncUntil: "2026-07-02",
                syncError: null,
              },
            ],
            selection: {
              businessId: null,
              adAccountId: null,
              pixelId: null,
            },
            lastSyncedAt: "2026-07-02T12:00:00.000Z",
            syncError: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: "instance_1",
              name: "Comercial",
              displayName: null,
              provider: "uazapi_byo",
              status: "active",
              lastHealthStatus: null,
              lastHealthCheckedAt: null,
              connectedPhone: "5511999991234",
              createdAt: "2026-07-01T12:00:00.000Z",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const element = await OverviewPage({
      searchParams: Promise.resolve({
        since: "2026-07-01",
        until: "2026-07-02",
        businessId: "business_1",
        adAccountId: "act_1",
        whatsappInstanceId: "instance_1",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/reports/campaigns?includeDaily=true&includeSummary=true&since=2026-07-01&until=2026-07-02&businessId=business_1&adAccountId=act_1&whatsappInstanceId=instance_1",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(html).toContain("Período e contas");
    expect(html).toContain("BM Principal");
    expect(html).toContain("Conta Principal");
    expect(html).toContain("Número WhatsApp");
    expect(html).toContain("Comercial - •••• 1234");
    expect(html).toContain(
      "Investimento e Conversas Meta existem por campanha, não por número. Escolha uma campanha para ver o investimento que trouxe conversas para este número.",
    );
    expect(html).toContain("Meta x conversas reais");
    expect(html).toContain("4 conversas a mais na Meta");
    expect(html).toContain("daily-comparison-chart");
    expect(html).toContain("overview-primary-metrics");
    expect(html).not.toContain("overview-summary-grid");

    const metricsPosition = html.indexOf("overview-primary-metrics");
    const funnelPosition = html.indexOf("overview-funnel-panel");
    const dailyPosition = html.indexOf("daily-comparison");

    expect(metricsPosition).toBeGreaterThan(-1);
    expect(funnelPosition).toBeGreaterThan(metricsPosition);
    expect(dailyPosition).toBeGreaterThan(funnelPosition);
  });

  it("renders aggregated campaign metrics returned by the backend", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          workspaceId: "workspace_1",
          rangeLabel: "2026-07-01 a 2026-07-02",
          campaigns: [
            {
              id: "cmp_1",
              name: "Campanha Real",
              status: "active",
              ...reportMetrics(),
            },
            {
              id: "cmp_2",
              name: "Segunda Campanha",
              status: "paused",
              ...reportMetrics({
                spendCents: 5000,
                metaConversationsStarted: 5,
                realConversations: 2,
                costPerRealConversationCents: 2500,
                organicLeads: 1,
                totalReceived: 3,
                trackingRate: 2 / 3,
                qualifiedLead: 0,
                costPerQualifiedLeadCents: null,
                purchases: 0,
                firstPurchases: 0,
                costPerPurchaseCents: null,
                trafficRevenueCents: 0,
                organicRevenueCents: 0,
                totalRevenueCents: 0,
                firstPurchaseRevenueCents: 0,
                roasAcquisition: 0,
                roasWithRepurchase: 0,
                funnelSteps: [
                  {
                    key: "real_conversations",
                    label: "Conversas reais iniciadas",
                    value: 2,
                    costCents: 2500,
                  },
                ],
              }),
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const element = await OverviewPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/reports/campaigns?includeDaily=true&includeSummary=true",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(html).toContain("2026-07-01 a 2026-07-02");
    expect(html).not.toContain("Campanha Real");
    expect(html).not.toContain("Segunda Campanha");
    expect(html).toContain("2 campanhas");
    expect(html.match(/class=\"metric-card/g)).toHaveLength(6);
    expect(html).toContain("Investimento");
    expect(html).not.toContain("Cobertura das conversas");
    expect(html).not.toContain("Conversas organicas");
    expect(html).not.toContain("attribution=organic");
    expect(html).not.toContain("Resumo do workspace");
    expect(html).toContain(">15<");
    expect(html).toContain(">8<");
    expect(html).toContain("Receita tráfego");
    expect(html).toContain("Funil de conversão");
    expect(html).toContain("Base do funil");
    expect(html).toContain("da etapa anterior");
    expect(html).toContain("conversion-funnel-chart");
    expect(html).toContain("Custo por conversa Meta");
    expect(html).toContain("Custo por lead");
    expect(html).toContain("Custo por lead qualificado");
    expect(html).toContain("Custo por compra");
    expect(html).toContain("Custo por primeira compra");
    expect(html).toContain("1 primeira compra");
    expect(html).not.toContain("0 recompra");
    expect(html).toContain(">1<");
    expect(html).not.toContain("LeadSubmitted");
    expect(html).not.toContain("Black Friday WhatsApp");
  });

  it("shows repurchase cost when the period contains repurchases", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          workspaceId: "workspace_1",
          rangeLabel: "Últimos 7 dias",
          campaigns: [
            {
              id: "cmp_1",
              name: "Campanha com recompra",
              status: "active",
              ...reportMetrics({
                purchases: 2,
                firstPurchases: 1,
                repurchases: 1,
                repurchaseRevenueCents: 15000,
                roasWithRepurchase: 4.5,
                funnelSteps: [
                  ...reportMetrics().funnelSteps,
                  {
                    key: "repurchase",
                    label: "Recompra",
                    value: 1,
                    costCents: 10000,
                  },
                ],
              }),
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const element = await OverviewPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("1 primeira compra, 1 recompra");
    expect(html).toContain("Custo por recompra");
    expect(html).not.toContain("ROAS com recompra");
  });

  it("aggregates InitiateCheckout into the overview funnel and primary metrics", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workspaceId: "workspace_1",
            rangeLabel: "Últimos 7 dias",
            campaigns: [
              {
                id: "cmp_1",
                name: "Campanha IC A",
                status: "active",
                ...reportMetrics({
                  spendCents: 20000,
                  funnelSteps: [
                    ...reportMetrics().funnelSteps,
                    {
                      key: "event_initiate_checkout",
                      label: "Checkout iniciado",
                      value: 3,
                      costCents: 6666,
                    },
                  ],
                }),
              },
              {
                id: "cmp_2",
                name: "Campanha IC B",
                status: "active",
                ...reportMetrics({
                  spendCents: 10000,
                  qualifiedLead: 0,
                  purchases: 0,
                  firstPurchases: 0,
                  trafficRevenueCents: 0,
                  totalRevenueCents: 0,
                  firstPurchaseRevenueCents: 0,
                  funnelSteps: [
                    {
                      key: "real_conversations",
                      label: "Conversas reais iniciadas",
                      value: 2,
                      costCents: 5000,
                    },
                    {
                      key: "event_initiate_checkout",
                      label: "Checkout iniciado",
                      value: 2,
                      costCents: 5000,
                    },
                  ],
                }),
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workspaceId: "workspace_1",
            status: "connected",
            businesses: [],
            adAccounts: [],
            pixels: [],
            reportingAccounts: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const element = await OverviewPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Checkout iniciado");
    expect(html).toContain("Custo por checkout iniciado");
    // Aggregated IC value 3+2 across campaigns
    expect(html).toContain(">5<");
    expect(html.match(/class=\"metric-card/g)).toHaveLength(7);
  });

  it("renders an empty overview state without mock campaign data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          workspaceId: "workspace_1",
          rangeLabel: "Últimos 7 dias",
          campaigns: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const element = await OverviewPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Nenhuma campanha sincronizada");
    expect(html).toContain("0 campanhas");
    expect(html).not.toContain("Black Friday WhatsApp");
  });

  it("renders workspace conversations before campaign metadata is resolved", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          workspaceId: "workspace_1",
          rangeLabel: "Últimos 7 dias",
          campaigns: [],
          summary: {
            id: "workspace_summary",
            name: "Resumo do workspace",
            status: "unknown",
            ...reportMetrics({
              spendCents: 0,
              metaConversationsStarted: 0,
              costPerMetaConversationCents: null,
              realConversations: 4,
              costPerRealConversationCents: 0,
              organicLeads: 1,
              totalReceived: 5,
              trackingRate: 0.8,
              qualifiedLead: 0,
              costPerQualifiedLeadCents: null,
              purchases: 0,
              firstPurchases: 0,
              costPerPurchaseCents: null,
              trafficRevenueCents: 0,
              organicRevenueCents: 0,
              totalRevenueCents: 0,
              firstPurchaseRevenueCents: 0,
              roasAcquisition: null,
              roasWithRepurchase: null,
            }),
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const element = await OverviewPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("0 campanhas");
    expect(html).toContain("Conversas reais");
    expect(html).toContain(">4<");
    expect(html).not.toContain("Resumo do workspace");
    expect(html).not.toContain("Conversas organicas");
    expect(html).not.toContain("Aguardando conversas");
  });

  it("renders an unavailable overview state without mock campaign data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("offline", { status: 503 }),
    );

    const element = await OverviewPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("API indisponível");
    expect(html).toContain("Dados temporariamente indisponíveis");
    expect(html).toContain("Aguardando resposta da API");
    expect(html).not.toContain("Resumo do workspace");
    expect(html).not.toContain("Qualidade do rastreamento");
    expect(html).not.toContain("0% conciliadas");
    expect(html).not.toContain("Black Friday WhatsApp");
  });

  it("only offers active WhatsApp instances and marks Meta KPIs unavailable for an instance filter", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        overviewResponse({
          workspaceId: "workspace_1",
          rangeLabel: "Ultimos 7 dias",
          campaigns: [
            {
              id: "cmp_1",
              name: "Campanha Real",
              status: "active",
              ...reportMetrics(),
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        overviewResponse({
          workspaceId: "workspace_1",
          status: "connected",
          businesses: [],
          adAccounts: [],
          pixels: [],
          reportingAccounts: [],
        }),
      )
      .mockResolvedValueOnce(
        overviewResponse([
          {
            id: "instance_active",
            name: "Comercial ativo",
            displayName: null,
            provider: "uazapi_byo",
            status: "active",
            lastHealthStatus: null,
            lastHealthCheckedAt: null,
            connectedPhone: "5511999991234",
            createdAt: "2026-07-01T12:00:00.000Z",
          },
          {
            id: "instance_removed",
            name: "Comercial antigo",
            displayName: null,
            provider: "uazapi_byo",
            status: "suspended",
            lastHealthStatus: null,
            lastHealthCheckedAt: null,
            connectedPhone: "5511999995678",
            createdAt: "2026-06-01T12:00:00.000Z",
          },
        ]),
      );

    const element = await OverviewPage({
      searchParams: Promise.resolve({
        whatsappInstanceId: "instance_active",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));
    const cards = metricCards(html);

    expect(html).toContain("Comercial ativo - •••• 1234");
    expect(html).not.toContain("Comercial antigo");
    expect(cards.find((card) => card.label === "Investimento")).toEqual({
      label: "Investimento",
      value: "-",
      delta: "Conta de anúncios (não filtrável por número)",
    });
    expect(cards.find((card) => card.label === "Conversas Meta")).toEqual({
      label: "Conversas Meta",
      value: "-",
      delta: "Conta de anúncios (não filtrável por número)",
    });
    expect(cards.find((card) => card.label === "Leads novos")?.value).toBe(
      "6",
    );
    expect(cards.find((card) => card.label === "Receita tráfego")).toEqual({
      label: "Receita tráfego",
      value: "R$ 300,00",
      delta: "Receita do número; ROAS indisponível",
    });
  });
});

describe("overview configurable KPI cards", () => {
  it("lead-only workspace: shows configured stages and omits Compras/Receita", async () => {
    const html = await renderOverview({
      workspaceId: "workspace_leads",
      rangeLabel: "Ultimos 7 dias",
      campaigns: [
        {
          id: "cmp_1",
          name: "Campanha Leads",
          status: "active",
          ...leadOnlyMetrics(),
        },
      ],
    });
    const cards = metricCards(html);

    expect(cards.map((card) => card.label)).toEqual([
      "Investimento",
      "Conversas Meta",
      "Leads novos",
      "Pre-qualificado",
      "Lead qualificado",
    ]);
    expect(html).not.toContain("Receita tráfego");
    expect(html).not.toContain(">Compras<");
    expect(html).not.toContain("ROAS");
    expect(html).not.toContain("primeira compra");
    expect(html).not.toContain("primeiras compras");
  });

  it("respects custom stage labels instead of catalog defaults", async () => {
    const html = await renderOverview({
      workspaceId: "workspace_leads",
      rangeLabel: "Ultimos 7 dias",
      campaigns: [
        {
          id: "cmp_1",
          name: "Campanha Leads",
          status: "active",
          ...leadOnlyMetrics(),
        },
      ],
    });
    const cards = metricCards(html);
    const viewContent = cards.find((card) => card.label === "Pre-qualificado");

    expect(viewContent).toBeDefined();
    expect(viewContent?.value).toBe("12");
    expect(viewContent?.delta).toContain("Custo por pre-qualificado");
    expect(viewContent?.delta).toContain("8,33");
    expect(html).not.toContain("Conteudo visualizado");
  });

  it("hides stages excluded from the workspace funnel even when events exist", async () => {
    const html = await renderOverview({
      workspaceId: "workspace_leads",
      rangeLabel: "Ultimos 7 dias",
      campaigns: [
        {
          id: "cmp_1",
          name: "Campanha Leads",
          status: "active",
          // qualifiedLead events happened, but the stage is hidden in the funnel
          // configuration, so the API omits it from funnelSteps.
          ...leadOnlyMetrics(),
          funnelSteps: leadOnlyMetrics().funnelSteps.filter(
            (step) => step.key !== "qualified_lead",
          ),
        },
      ],
    });
    const cards = metricCards(html);

    expect(cards.map((card) => card.label)).toEqual([
      "Investimento",
      "Conversas Meta",
      "Leads novos",
      "Pre-qualificado",
    ]);
    expect(html).not.toContain("Lead qualificado");
    expect(html).not.toContain("Custo por lead qualificado");
  });

  it("sales workspace keeps Compras and Receita trafego after the configured stages", async () => {
    const html = await renderOverview({
      workspaceId: "workspace_sales",
      rangeLabel: "Ultimos 7 dias",
      campaigns: [
        {
          id: "cmp_1",
          name: "Campanha Vendas",
          status: "active",
          ...salesMetrics(),
        },
      ],
    });
    const cards = metricCards(html);

    expect(cards.map((card) => card.label)).toEqual([
      "Investimento",
      "Conversas Meta",
      "Leads novos",
      "Lead qualificado",
      "Compras",
      "Receita tráfego",
    ]);
    expect(cards.find((card) => card.label === "Compras")?.delta).toBe(
      "1 primeira compra",
    );
    expect(cards.find((card) => card.label === "Receita tráfego")?.delta).toBe(
      "ROAS 3.00x",
    );
    // first_purchase is a Purchase breakdown, not a separate KPI card.
    expect(cards.map((card) => card.label)).not.toContain("Primeira compra");
  });

  it("stages without monetary value show a real count and no revenue", async () => {
    const html = await renderOverview({
      workspaceId: "workspace_leads",
      rangeLabel: "Ultimos 7 dias",
      campaigns: [],
      // Summary comes straight from the API (no client-side recomputation):
      // stages without spend or value carry costCents null.
      summary: {
        id: "workspace_summary",
        name: "Resumo do workspace",
        status: "unknown",
        ...leadOnlyMetrics(),
        spendCents: 0,
        funnelSteps: leadOnlyMetrics().funnelSteps.map((step) => ({
          ...step,
          costCents: null,
        })),
      },
    });
    const cards = metricCards(html);
    const viewContent = cards.find((card) => card.label === "Pre-qualificado");

    expect(viewContent?.value).toBe("12");
    expect(viewContent?.delta).toBe("Ultimos 7 dias");
    expect(viewContent?.delta).not.toContain("R$");
    expect(html).not.toContain("Receita tráfego");
    expect(html).not.toContain("ROAS");
  });

  it("derives cards per workspace payload rather than a fixed list", async () => {
    const leadHtml = await renderOverview({
      workspaceId: "workspace_leads",
      rangeLabel: "Ultimos 7 dias",
      campaigns: [],
      summary: {
        id: "workspace_summary",
        name: "Resumo do workspace",
        status: "unknown",
        ...leadOnlyMetrics(),
      },
    });
    vi.restoreAllMocks();
    const salesHtml = await renderOverview({
      workspaceId: "workspace_sales",
      rangeLabel: "Ultimos 7 dias",
      campaigns: [],
      summary: {
        id: "workspace_summary",
        name: "Resumo do workspace",
        status: "unknown",
        ...salesMetrics(),
      },
    });

    expect(metricCards(leadHtml).map((card) => card.label)).toEqual([
      "Investimento",
      "Conversas Meta",
      "Leads novos",
      "Pre-qualificado",
      "Lead qualificado",
    ]);
    expect(metricCards(salesHtml).map((card) => card.label)).toEqual([
      "Investimento",
      "Conversas Meta",
      "Leads novos",
      "Lead qualificado",
      "Compras",
      "Receita tráfego",
    ]);
  });

  it("keeps the base cards when the funnel is empty", async () => {
    const html = await renderOverview({
      workspaceId: "workspace_1",
      rangeLabel: "Ultimos 7 dias",
      campaigns: [],
    });

    expect(metricCards(html).map((card) => card.label)).toEqual([
      "Investimento",
      "Conversas Meta",
      "Leads novos",
    ]);
  });

  it("renamed QualifiedLead: card label and cost caption use the custom label", async () => {
    const metrics = leadOnlyMetrics();
    const html = await renderOverview({
      workspaceId: "workspace_leads",
      rangeLabel: "Ultimos 7 dias",
      campaigns: [
        {
          id: "cmp_1",
          name: "Campanha Leads",
          status: "active",
          ...metrics,
          funnelSteps: metrics.funnelSteps.map((step) =>
            step.key === "qualified_lead"
              ? { ...step, label: "Cliente potencial" }
              : step,
          ),
        },
      ],
    });
    const cards = metricCards(html);
    const qualified = cards.find((card) => card.label === "Cliente potencial");

    expect(qualified).toBeDefined();
    expect(qualified?.value).toBe("4");
    expect(qualified?.delta).toBe("Custo por cliente potencial R$\u00a025,00");
    expect(html).not.toContain("Lead qualificado");
    expect(html).not.toContain("Custo por lead qualificado");
  });

  it("renamed Purchase: card label and funnel cost caption use the custom label", async () => {
    const metrics = salesMetrics();
    const html = await renderOverview({
      workspaceId: "workspace_sales",
      rangeLabel: "Ultimos 7 dias",
      campaigns: [
        {
          id: "cmp_1",
          name: "Campanha Vendas",
          status: "active",
          ...metrics,
          funnelSteps: metrics.funnelSteps.map((step) =>
            step.key === "purchase" ? { ...step, label: "Vendas" } : step,
          ),
        },
      ],
    });
    const cards = metricCards(html);

    expect(cards.map((card) => card.label)).toEqual([
      "Investimento",
      "Conversas Meta",
      "Leads novos",
      "Lead qualificado",
      "Vendas",
      "Receita tráfego",
    ]);
    expect(cards.find((card) => card.label === "Vendas")?.delta).toBe(
      "1 primeira compra",
    );
    expect(html).toContain("Custo por vendas");
    expect(html).not.toContain("Custo por compra<");
    expect(html).not.toContain(">Compras<");
    // Purchase breakdown keeps its own caption.
    expect(html).toContain("Custo por primeira compra");
  });
});

// "Leads no período" (leads novos x leads que voltaram), ported from the SaaS.

type LeadsBlockItem = {
  key: string;
  label: string;
  value: string;
  caption: string;
  href: string | null;
};

/** Parses the "Leads no período" block in DOM order. */
function leadsBlockItems(html: string): LeadsBlockItem[] {
  const block = html.slice(
    html.indexOf("overview-leads-block"),
    html.indexOf("overview-funnel-panel"),
  );
  const pattern =
    /data-leads-block="([^"]+)"><dt><span>(.*?)<\/span>.*?<\/dt><dd><strong>(.*?)<\/strong><small>(.*?)<\/small><\/dd>/g;
  const text = (value: string) => value.replace(/<[^>]+>/g, "");
  const items: LeadsBlockItem[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(block)) !== null) {
    items.push({
      key: match[1]!,
      label: match[2]!,
      value: text(match[3]!),
      caption: text(match[4]!),
      href:
        /href="([^"]+)"/.exec(match[3]!)?.[1]?.replace(/&amp;/g, "&") ?? null,
    });
  }

  return items;
}

async function renderLeadsOverviewWith(
  report: Record<string, unknown>,
  searchParams: Record<string, string>,
) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const body = url.includes("/reports/campaigns")
      ? report
      : {
          workspaceId: "workspace_1",
          status: "connected",
          businesses: [],
          adAccounts: [],
          pixels: [],
          reportingAccounts: [],
        };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const element = await OverviewPage({
    searchParams: Promise.resolve(searchParams),
  });

  return renderToStaticMarkup(createElement("div", null, element));
}

function leadsSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: "workspace_summary",
    name: "Resumo do workspace",
    status: "active",
    ...reportMetrics({
      spendCents: 412000,
      realConversations: 412,
      costPerRealConversationCents: 1000,
      returningLeads: 0,
      repeatConversationLeads: 38,
      adConversationEvents: 570,
      ...overrides,
    }),
  };
}

describe("overview leads no período", () => {
  it("always shows the four readings, zeros included, with the Leads lists behind them", async () => {
    const html = await renderLeadsOverviewWith(
      {
        workspaceId: "workspace_1",
        rangeLabel: "Últimos 7 dias",
        since: "2026-10-08",
        until: "2026-10-14",
        campaigns: [],
        summary: leadsSummary(),
      },
      { since: "2026-10-08", until: "2026-10-14" },
    );
    const period = "attribution=paid&since=2026-10-08&until=2026-10-14";

    expect(html).toContain("Leads no período");
    expect(leadsBlockItems(html)).toEqual([
      {
        key: "new",
        label: "Leads novos",
        value: "412",
        caption: "Custo por lead novo R$ 10,00",
        href: `/leads?${period}`,
      },
      {
        key: "returning",
        label: "Voltaram por anúncio",
        value: "0",
        caption: "Já eram leads antes do período",
        href: `/leads?${period}&base=returning`,
      },
      {
        key: "repeat",
        label: "Conversaram mais de uma vez",
        value: "38",
        caption: "2 ou mais conversas no período",
        href: `/leads?${period}&base=repeat`,
      },
      {
        key: "conversations",
        label: "Conversas por anúncio",
        value: "570",
        caption: "Inclui conversas repetidas",
        href: null,
      },
    ]);
    expect(html).toContain(
      "Já eram leads antes do período e chamaram de novo por anúncio.",
    );
    expect(html).toContain('aria-label="O que é: Conversas por anúncio"');
    // Closed until hovered, focused or tapped (iOS taps toggle it).
    expect(html).toContain('aria-expanded="false"');
    // The KPI card keeps the headline and opens the same Leads list.
    expect(html).toContain(
      `<span>Leads novos</span><strong><a class="kpi-number-link" aria-label="412 - Ver os leads novos na lista de leads" href="/leads?${period.replace(/&/g, "&amp;")}">412</a></strong><small>1º contato no período</small>`,
    );
  });

  it("drops the links the Leads page cannot reproduce", async () => {
    const html = await renderLeadsOverviewWith(
      {
        workspaceId: "workspace_1",
        rangeLabel: "Hoje",
        since: "2026-10-14",
        until: "2026-10-14",
        campaigns: [],
        summary: leadsSummary(),
      },
      { since: "2026-10-14", until: "2026-10-14", adAccountId: "act_1" },
    );

    expect(leadsBlockItems(html).map((item) => item.href)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(html).not.toContain('href="/leads?');
  });

  it("shows a dash for numbers an older API does not send", async () => {
    const html = await renderLeadsOverviewWith(
      {
        workspaceId: "workspace_1",
        rangeLabel: "Hoje",
        since: "2026-10-14",
        until: "2026-10-14",
        campaigns: [],
        summary: {
          id: "workspace_summary",
          name: "Resumo do workspace",
          status: "active",
          ...reportMetrics({ realConversations: 3 }),
        },
      },
      { since: "2026-10-14", until: "2026-10-14" },
    );

    expect(
      leadsBlockItems(html).map((item) => [item.key, item.value, item.href]),
    ).toEqual([
      ["new", "3", "/leads?attribution=paid&since=2026-10-14&until=2026-10-14"],
      // No link on "-": there is no number to reproduce.
      ["returning", "-", null],
      ["repeat", "-", null],
      ["conversations", "-", null],
    ]);
  });

  it("keeps the block visible with dashes when the API is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    const element = await OverviewPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Leads no período");
    expect(leadsBlockItems(html).map((item) => item.value)).toEqual([
      "-",
      "-",
      "-",
      "-",
    ]);
    expect(html).toContain("Aguardando resposta da API");
  });
});

describe("overview daily: Meta x conversas reais", () => {
  it("falls back to leads novos + retornos when the API has no conversation series", async () => {
    const html = await renderLeadsOverviewWith(
      {
        workspaceId: "workspace_1",
        rangeLabel: "Últimos 2 dias",
        since: "2026-10-13",
        until: "2026-10-14",
        campaigns: [],
        summary: {
          id: "workspace_summary",
          name: "Resumo do workspace",
          status: "active",
          ...reportMetrics({ realConversations: 3, returningLeads: 1 }),
        },
        dailyComparisonAvailable: true,
        dailyComparison: [
          {
            date: "2026-10-13",
            metaConversationsStarted: 3,
            realConversations: 2,
            returningLeads: 1,
          },
          {
            date: "2026-10-14",
            metaConversationsStarted: 2,
            realConversations: 1,
            returningLeads: 1,
          },
        ],
      },
      { since: "2026-10-13", until: "2026-10-14" },
    );

    // The block keeps its own numbers (1 person back).
    expect(
      leadsBlockItems(html).find((item) => item.key === "returning")?.value,
    ).toBe("1");
    // API without adConversationsStarted: conversations = novos + retornos.
    expect(html).toContain("Conversas iniciadas pela Meta <strong>5</strong>");
    expect(html).toContain("Conversas iniciadas reais <strong>5</strong>");
    expect(html).toContain("Conversas conciliadas no período");
    expect(html).toContain("13/10 - Conversas iniciadas reais: 3");
    expect(html).not.toContain("daily-bar returning");
    expect(html).not.toContain("Leads (evento Lead enviado)");
  });

  it("normal mode (Lead sent at the entry): only Meta x conversas reais, two bars per day", async () => {
    const html = await renderLeadsOverviewWith(
      {
        workspaceId: "workspace_1",
        rangeLabel: "Últimos 2 dias",
        since: "2026-10-16",
        until: "2026-10-17",
        campaigns: [],
        summary: {
          id: "workspace_summary",
          name: "Resumo do workspace",
          status: "active",
          ...reportMetrics({ realConversations: 120, returningLeads: 4 }),
        },
        dailyComparisonAvailable: true,
        dailyComparisonLeadEventDeferred: false,
        dailyComparison: [
          {
            date: "2026-10-16",
            metaConversationsStarted: 70,
            adConversationsStarted: 66,
            realConversations: 62,
            returningLeads: 2,
          },
          {
            date: "2026-10-17",
            metaConversationsStarted: 62,
            adConversationsStarted: 60,
            realConversations: 58,
            returningLeads: 2,
          },
        ],
      },
      { since: "2026-10-16", until: "2026-10-17" },
    );

    expect(html).toContain("Meta x conversas reais");
    expect(html).toContain(
      "Conversas iniciadas pela Meta <strong>132</strong>",
    );
    expect(html).toContain("Conversas iniciadas reais <strong>126</strong>");
    expect(html).toContain("6 conversas a mais na Meta");
    expect(html.match(/class="daily-bar meta"/g)).toHaveLength(2);
    expect(html.match(/class="daily-bar real"/g)).toHaveLength(2);
    expect(html).not.toContain("daily-bar lead");
    expect(html).not.toContain("Leads (evento Lead enviado)");
    expect(html).not.toContain("pela sua regra");
  });

  it("override mode (Lead sent later by a rule): adds the Lead series and explains the gap", async () => {
    const html = await renderLeadsOverviewWith(
      {
        workspaceId: "workspace_1",
        rangeLabel: "Últimos 2 dias",
        since: "2026-10-20",
        until: "2026-10-21",
        campaigns: [],
        summary: {
          id: "workspace_summary",
          name: "Resumo do workspace",
          status: "active",
          ...reportMetrics({ realConversations: 21, returningLeads: 1 }),
        },
        dailyComparisonAvailable: true,
        dailyComparisonLeadEventDeferred: true,
        dailyComparison: [
          {
            date: "2026-10-20",
            metaConversationsStarted: 61,
            adConversationsStarted: 58,
            realConversations: 10,
            returningLeads: 1,
          },
          {
            date: "2026-10-21",
            metaConversationsStarted: 59,
            adConversationsStarted: 57,
            realConversations: 11,
            returningLeads: 0,
          },
        ],
      },
      { since: "2026-10-20", until: "2026-10-21" },
    );

    // The delta compares conversations with conversations, not with Leads.
    expect(html).toContain("5 conversas a mais na Meta");
    expect(html).toContain("Conversas iniciadas reais <strong>115</strong>");
    expect(html).toContain("Leads (evento Lead enviado) <strong>21</strong>");
    expect(html.match(/class="daily-bar lead"/g)).toHaveLength(2);
    expect(html).toContain("20/10 - Leads (evento Lead enviado): 10");
    expect(html).toContain("21/10 - Conversas iniciadas reais: 57");
    expect(html).toContain("pela sua regra");
  });

  it("keeps the series and legend at zero", async () => {
    const html = await renderLeadsOverviewWith(
      {
        workspaceId: "workspace_1",
        rangeLabel: "Hoje",
        since: "2026-10-14",
        until: "2026-10-14",
        campaigns: [],
        summary: {
          id: "workspace_summary",
          name: "Resumo do workspace",
          status: "active",
          ...reportMetrics({ realConversations: 1, returningLeads: 0 }),
        },
        dailyComparisonAvailable: true,
        dailyComparison: [
          {
            date: "2026-10-14",
            metaConversationsStarted: 2,
            realConversations: 1,
            returningLeads: 0,
          },
        ],
      },
      { since: "2026-10-14", until: "2026-10-14" },
    );

    expect(html).toContain("Conversas iniciadas reais <strong>1</strong>");
    expect(html).toContain("1 conversa a mais na Meta");
  });
});

describe("overviewLeadsHref", () => {
  it("builds the Leads list of each overview number", () => {
    // Fase 6.3b (SaaS #115/#118): the number and the campaign go to Leads.
    const scope = { campaignIds: ["cmp_1"], whatsappInstanceId: "wpp_1" };
    const period = { since: "2026-10-14", until: "2026-10-14" };

    expect(overviewLeadsHref(scope, period, "new")).toBe(
      "/leads?campaignId=cmp_1&whatsappInstanceId=wpp_1&attribution=paid&since=2026-10-14&until=2026-10-14",
    );
    // Returns and repeats count each conversation's campaign; the Leads
    // campaign filter follows the first contact, so no link with a campaign.
    expect(overviewLeadsHref(scope, period, "returning")).toBeNull();
    expect(overviewLeadsHref(scope, period, "repeat")).toBeNull();
    expect(
      overviewLeadsHref(
        { campaignIds: [], whatsappInstanceId: "wpp_1" },
        period,
        "returning",
      ),
    ).toBe(
      "/leads?whatsappInstanceId=wpp_1&attribution=paid&since=2026-10-14&until=2026-10-14&base=returning",
    );
    expect(overviewLeadsHref({ campaignIds: [] }, period, "repeat")).toBe(
      "/leads?attribution=paid&since=2026-10-14&until=2026-10-14&base=repeat",
    );
    expect(
      overviewLeadsHref(
        { campaignIds: [], whatsappInstanceId: "wpp_1" },
        period,
        "repeat",
      ),
    ).toBeNull();
    expect(overviewLeadsHref({ campaignIds: [] }, {}, "returning")).toBeNull();
    expect(overviewLeadsHref({ campaignIds: [] }, {}, "repeat")).toBeNull();
    expect(
      overviewLeadsHref({ campaignIds: ["a", "b"] }, period, "new"),
    ).toBeNull();
    expect(
      overviewLeadsHref({ campaignIds: [], businessId: "bm" }, period, "new"),
    ).toBeNull();
  });
});

type FetchRoutes = {
  report?: Record<string, unknown> | Response;
  metaAssets?: Record<string, unknown>;
  instances?: unknown[];
  campaignOptions?: Record<string, unknown> | Response;
};

/** Routes fetch by path so the parallel page requests stay deterministic. */
function mockOverviewApi(routes: FetchRoutes) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const respond = (body: unknown) =>
      body instanceof Response ? body : overviewResponse(body);

    if (url.includes("/reports/campaign-options")) {
      return routes.campaignOptions
        ? respond(routes.campaignOptions)
        : new Response("offline", { status: 503 });
    }

    if (url.includes("/reports/campaigns")) {
      return respond(routes.report ?? { campaigns: [] });
    }

    if (url.includes("/integrations/meta/assets")) {
      return routes.metaAssets
        ? respond(routes.metaAssets)
        : new Response("offline", { status: 503 });
    }

    if (url.includes("/integrations/whatsapp-connections")) {
      return respond(routes.instances ?? []);
    }

    return new Response("not found", { status: 404 });
  });
}

async function renderOverviewWith(
  routes: FetchRoutes,
  searchParams: Record<string, string> = {},
) {
  mockOverviewApi(routes);
  const element = await OverviewPage({
    searchParams: Promise.resolve(searchParams),
  });
  return renderToStaticMarkup(createElement("div", null, element));
}

const campaignInstances = [
  {
    id: "instance_centro",
    name: "Loja Centro",
    displayName: null,
    provider: "uazapi_byo",
    status: "active",
    lastHealthStatus: null,
    lastHealthCheckedAt: null,
    connectedPhone: "5511999991234",
    createdAt: "2026-07-01T12:00:00.000Z",
  },
  {
    id: "instance_norte",
    name: "Loja Norte",
    displayName: null,
    provider: "uazapi_byo",
    status: "active",
    lastHealthStatus: null,
    lastHealthCheckedAt: null,
    connectedPhone: "5511999995678",
    createdAt: "2026-07-01T12:00:00.000Z",
  },
];

const campaignOptionsBody = {
  campaigns: [
    {
      id: "cmp_promo",
      name: "Promo Setembro",
      status: "active",
      businessId: "business_1",
      adAccountId: "act_1",
      leadsByInstance: { instance_centro: 6 },
    },
    {
      id: "cmp_outra",
      name: "Outra campanha",
      status: "paused",
      businessId: "business_1",
      adAccountId: "act_1",
      leadsByInstance: {},
    },
  ],
};

function campaignReport(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "workspace_1",
    rangeLabel: "Ultimos 7 dias",
    since: "2026-09-17",
    until: "2026-09-24",
    campaigns: [
      {
        id: "cmp_promo",
        name: "Promo Setembro",
        status: "active",
        ...reportMetrics(),
      },
    ],
    summary: {
      id: "workspace_summary",
      name: "Resumo",
      status: "active",
      ...reportMetrics(),
    },
    dailyComparisonAvailable: true,
    dailyComparison: [
      {
        date: "2026-09-24",
        metaConversationsStarted: 10,
        realConversations: 6,
      },
    ],
    filters: { campaignId: "cmp_promo", campaignName: "Promo Setembro" },
    campaignInstanceLeads: [
      { instanceId: "instance_centro", instanceName: "Loja Centro", leads: 6 },
    ],
    metaMetricsScope: "campaign",
    ...overrides,
  };
}

function funnelCosts(html: string): string[] {
  const grid = html.slice(
    html.indexOf("conversion-funnel-stage-grid"),
    html.indexOf("conversion-funnel-chart"),
  );

  return Array.from(
    grid.matchAll(
      /<div class="conversion-funnel-stage-cost"><span>(.*?)<\/span><strong>(.*?)<\/strong>/g,
    ),
    (match) => `${match[1]}: ${match[2]}`,
  );
}

describe("overview campaign x WhatsApp number cross-filter", () => {
  // §9 test 8
  it("sends campaignId to the report and scopes the option list to the period and account", async () => {
    const fetchSpy = mockOverviewApi({
      report: campaignReport(),
      campaignOptions: campaignOptionsBody,
      instances: campaignInstances,
    });
    const element = await OverviewPage({
      searchParams: Promise.resolve({
        since: "2026-09-17",
        until: "2026-09-24",
        adAccountId: "act_1",
        campaignId: "cmp_promo",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));
    const urls = fetchSpy.mock.calls.map(([input]) => String(input));

    expect(urls).toContain(
      "http://localhost:3333/reports/campaigns?includeDaily=true&includeSummary=true&since=2026-09-17&until=2026-09-24&adAccountId=act_1&campaignId=cmp_promo",
    );
    expect(urls).toContain(
      "http://localhost:3333/reports/campaign-options?since=2026-09-17&until=2026-09-24&adAccountId=act_1",
    );
    expect(html).toContain(
      '<input type="hidden" name="campaignId" value="cmp_promo"/>',
    );
    expect(html).toContain(
      '<span class="filter-combobox-value">Promo Setembro</span>',
    );
    expect(html).not.toContain('<select name="campaignId"');
    expect(html).not.toContain("Aplicar");
    // Results sit in the pending wrapper; idle, nothing is marked busy and
    // the route skeleton is never part of the page.
    expect(html).toContain('<div class="overview-results">');
    expect(html).not.toContain("aria-busy");
    expect(html).not.toContain("route-loading");
    expect(html).toContain('<span class="tag">1 campanha</span>');
    expect(html).not.toContain("1 campanhas");
  });

  it("carries campaignId into Abrir relatorios", async () => {
    const html = await renderOverviewWith(
      {
        report: campaignReport({ dailyComparisonAvailable: false }),
        campaignOptions: campaignOptionsBody,
      },
      { campaignId: "cmp_promo", whatsappInstanceId: "instance_centro" },
    );

    expect(html).toContain(
      'href="/reports?whatsappInstanceId=instance_centro&amp;campaignId=cmp_promo">Abrir relatórios',
    );
  });

  // §9 test 11 (S4)
  it("S4: exclusive campaign on the number renders real Meta metrics, costs and ROAS", async () => {
    const html = await renderOverviewWith(
      {
        report: campaignReport(),
        campaignOptions: campaignOptionsBody,
        instances: campaignInstances,
      },
      { campaignId: "cmp_promo", whatsappInstanceId: "instance_centro" },
    );
    const cards = metricCards(html);

    expect(cards.find((card) => card.label === "Investimento")).toEqual({
      label: "Investimento",
      value: "R$\u00a0100,00",
      delta: "Ultimos 7 dias",
    });
    expect(cards.find((card) => card.label === "Conversas Meta")).toEqual({
      label: "Conversas Meta",
      value: "10",
      delta: "Custo por conversa Meta R$\u00a010,00",
    });
    expect(cards.find((card) => card.label === "Receita tráfego")?.delta).toBe(
      "ROAS 3.00x",
    );
    expect(cards.find((card) => card.label === "Lead qualificado")?.delta).toBe(
      "Custo por lead qualificado R$\u00a0100,00",
    );
    expect(html).not.toContain("metric-card partial");
    expect(html).not.toContain('role="note"');
    expect(funnelCosts(html)[0]).toBe("Custo por conversa Meta: R$\u00a010,00");
    expect(html).toContain("10 conversas registradas pela Meta");
  });

  // §9 test 11 (S5)
  it("S5: shared campaign renders partial Meta cards without ROAS or funnel costs", async () => {
    const html = await renderOverviewWith(
      {
        report: campaignReport({
          metaMetricsScope: "campaign_shared",
          campaignInstanceLeads: [
            {
              instanceId: "instance_centro",
              instanceName: "Loja Centro",
              leads: 6,
            },
            {
              instanceId: "instance_norte",
              instanceName: "Loja Norte",
              leads: 2,
            },
          ],
        }),
        campaignOptions: campaignOptionsBody,
        instances: campaignInstances,
      },
      { campaignId: "cmp_promo", whatsappInstanceId: "instance_centro" },
    );
    const cards = metricCards(html);

    expect(html).toContain(
      '<div class="metric-card partial"><span>Investimento</span><strong>R$\u00a0100,00</strong><small>Campanha inteira · inclui outro número</small></div>',
    );
    expect(html).toContain(
      '<div class="metric-card partial"><span>Conversas Meta</span><strong>10</strong><small>Campanha inteira · inclui outro número</small></div>',
    );
    expect(cards.find((card) => card.label === "Receita tráfego")?.delta).toBe(
      "Receita do número; ROAS indisponível",
    );
    expect(cards.find((card) => card.label === "Lead qualificado")?.delta).toBe(
      "Ultimos 7 dias",
    );
    expect(html).not.toContain("ROAS 3.00x");
    expect(html).not.toContain("metric-card partial unavailable");
    const costs = funnelCosts(html);
    expect(costs[0]).toBe("Custo por conversa Meta: -");
    expect(costs.every((cost) => cost.endsWith(": -"))).toBe(true);
    expect(html).toContain(
      "Esta campanha também gerou conversas em outro número. Investimento e Conversas Meta mostram a campanha inteira; custos por etapa e ROAS ficam ocultos para não distorcer o resultado.",
    );
    expect(html).toContain(
      "Ultimos 7 dias: 6 leads novos neste número vindas da campanha selecionada.",
    );
  });

  it("S6: campaign with no conversations on the number shows the S6 note", async () => {
    const html = await renderOverviewWith(
      {
        report: campaignReport({
          metaMetricsScope: "campaign_shared",
          summary: {
            id: "workspace_summary",
            name: "Resumo",
            status: "active",
            ...reportMetrics({ realConversations: 0 }),
          },
          campaignInstanceLeads: [
            {
              instanceId: "instance_norte",
              instanceName: "Loja Norte",
              leads: 2,
            },
          ],
        }),
        campaignOptions: campaignOptionsBody,
        instances: campaignInstances,
      },
      { campaignId: "cmp_promo", whatsappInstanceId: "instance_centro" },
    );
    const cards = metricCards(html);

    expect(html).toContain(
      "Esta campanha não gerou conversas neste número no período. Investimento e Conversas Meta mostram a campanha inteira.",
    );
    expect(cards.find((card) => card.label === "Investimento")?.delta).toBe(
      "Campanha inteira · nenhuma conversa neste número",
    );
    expect(html).toContain("metric-card partial");
  });

  it("S7: campaign without delivery shows a real zero and no ROAS", async () => {
    const html = await renderOverviewWith(
      {
        report: campaignReport({
          summary: {
            id: "workspace_summary",
            name: "Resumo",
            status: "active",
            ...reportMetrics({
              spendCents: 0,
              metaConversationsStarted: 0,
              costPerMetaConversationCents: null,
              roasAcquisition: null,
            }),
          },
        }),
        campaignOptions: campaignOptionsBody,
      },
      { campaignId: "cmp_promo" },
    );
    const cards = metricCards(html);

    expect(cards.find((card) => card.label === "Investimento")).toEqual({
      label: "Investimento",
      value: "R$\u00a00,00",
      delta: "Sem veiculação no período",
    });
    expect(cards.find((card) => card.label === "Receita tráfego")?.delta).toBe(
      "ROAS indisponível",
    );
  });

  it("S8: unsynced campaign keeps Meta metrics unavailable", async () => {
    const html = await renderOverviewWith(
      {
        report: campaignReport({ metaMetricsScope: "campaign_unsynced" }),
        campaignOptions: campaignOptionsBody,
      },
      { campaignId: "cmp_promo" },
    );
    const cards = metricCards(html);

    expect(cards.find((card) => card.label === "Investimento")).toEqual({
      label: "Investimento",
      value: "-",
      delta: "Aguardando sincronização da Meta",
    });
    expect(cards.find((card) => card.label === "Conversas Meta")?.delta).toBe(
      "Aguardando sincronização da Meta",
    );
    expect(cards.find((card) => card.label === "Receita tráfego")?.delta).toBe(
      "ROAS indisponível",
    );
    expect(funnelCosts(html)[0]).not.toContain("Custo por conversa Meta");
  });

  // §9 test 12
  it("S2: number without campaign keeps #110 dashes and points to the campaign filter", async () => {
    const html = await renderOverviewWith(
      {
        report: campaignReport({
          filters: { whatsappInstanceId: "instance_centro" },
          campaignInstanceLeads: undefined,
          metaMetricsScope: "ad_account",
        }),
        campaignOptions: campaignOptionsBody,
        instances: campaignInstances,
      },
      { whatsappInstanceId: "instance_centro" },
    );
    const cards = metricCards(html);

    expect(cards.find((card) => card.label === "Investimento")).toEqual({
      label: "Investimento",
      value: "-",
      delta: "Conta de anúncios (não filtrável por número)",
    });
    expect(html).toContain(
      '<p class="muted" role="note">Investimento e Conversas Meta existem por campanha, não por número. Escolha uma campanha para ver o investimento que trouxe conversas para este número.</p>',
    );
    expect(html).not.toContain("sao da conta de anuncios e nao podem");
    expect(html).toContain(
      '<span class="filter-combobox-value">Todas as campanhas</span>',
    );
  });

  it("hints the campaign's only number with a one-click filter link", async () => {
    const html = await renderOverviewWith(
      {
        report: campaignReport(),
        campaignOptions: campaignOptionsBody,
        instances: campaignInstances,
      },
      { campaignId: "cmp_promo", adAccountId: "act_1" },
    );

    expect(html).toContain("Esta campanha leva conversas para ");
    expect(html).toContain(
      '<span class="presentation-mask-value">Loja Centro - •••• 1234</span><span class="presentation-mask-placeholder">Número oculto</span>',
    );
    expect(html).toContain(
      'href="/overview?adAccountId=act_1&amp;whatsappInstanceId=instance_centro&amp;campaignId=cmp_promo">Filtrar este número</a>',
    );
  });

  it("hints when the campaign spreads across several numbers", async () => {
    const html = await renderOverviewWith(
      {
        report: campaignReport({
          campaignInstanceLeads: [
            {
              instanceId: "instance_centro",
              instanceName: "Loja Centro",
              leads: 6,
            },
            {
              instanceId: "instance_norte",
              instanceName: "Loja Norte",
              leads: 3,
            },
            {
              instanceId: "instance_zero",
              instanceName: "Sem leads",
              leads: 0,
            },
          ],
        }),
        campaignOptions: campaignOptionsBody,
      },
      { campaignId: "cmp_promo" },
    );

    expect(html).toContain(
      "Esta campanha gerou conversas em 2 números. Selecione um número para ver o resultado de cada um.",
    );
    expect(html).not.toContain("Filtrar este número");
  });

  it("shows no hint when the campaign has no conversations", async () => {
    const html = await renderOverviewWith(
      {
        report: campaignReport({ campaignInstanceLeads: [] }),
        campaignOptions: campaignOptionsBody,
      },
      { campaignId: "cmp_promo" },
    );

    expect(html).not.toContain('role="note"');
  });

  // §9 test 10 (page side)
  it("masks the campaign name in the daily comparison scope", async () => {
    const html = await renderOverviewWith(
      {
        report: campaignReport(),
        campaignOptions: campaignOptionsBody,
      },
      { campaignId: "cmp_promo" },
    );
    const header = html.slice(0, html.indexOf("overview-filter-bar"));

    expect(html).toContain(
      '<span class="presentation-mask-value">Promo Setembro</span><span class="presentation-mask-placeholder">Campanha oculta</span>',
    );
    expect(header).not.toContain("Promo Setembro");
    // Outside the campaign trigger, the name only appears inside a mask.
    // The trigger and the chip strip are the filter's own UI; presentation
    // mode replaces both on the client.
    const withoutSelect = html
      .replace(/<button class="filter-combobox-trigger".*?<\/button>/, "")
      .replace(
        /<div class="overview-campaign-strip".*?Limpar campanhas<\/button><\/div>/,
        "",
      );
    expect(
      withoutSelect.replaceAll(
        '<span class="presentation-mask-value">Promo Setembro</span>',
        "",
      ),
    ).not.toContain("Promo Setembro");
  });

  // §9 test 13
  it("renders the invalid-filter state for a 404 campaign", async () => {
    const html = await renderOverviewWith(
      {
        report: new Response(
          JSON.stringify({ message: "Campanha não encontrada" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        ),
        campaignOptions: campaignOptionsBody,
      },
      {
        since: "2026-09-17",
        until: "2026-09-24",
        whatsappInstanceId: "instance_centro",
        campaignId: "cmp_foreign",
      },
    );

    expect(html).toContain("Campanha não encontrada");
    expect(html).toContain(
      "Ela pode ter sido removida ou pertencer a outra conta de anúncio.",
    );
    expect(html).toContain(
      '<a class="button ghost" href="/overview?since=2026-09-17&amp;until=2026-09-24&amp;whatsappInstanceId=instance_centro">Limpar campanha</a>',
    );
    expect(html).not.toContain("overview-primary-metrics");
    expect(html).not.toContain("overview-funnel-panel");
    expect(html).not.toContain("daily-comparison");
    expect(html).not.toContain("API indisponível");
    expect(html).not.toContain("R$\u00a00,00");
  });

  it("keeps a 404 without campaignId as the generic error state", async () => {
    const html = await renderOverviewWith({
      report: new Response("missing", { status: 404 }),
    });

    expect(html).toContain("API indisponível");
    expect(html).not.toContain("Limpar campanha");
  });

  // §9 test 14
  it("still renders the report when the campaign options endpoint fails", async () => {
    const html = await renderOverviewWith({
      report: {
        workspaceId: "workspace_1",
        rangeLabel: "Ultimos 7 dias",
        campaigns: [
          {
            id: "cmp_1",
            name: "Campanha Real",
            status: "active",
            ...reportMetrics(),
          },
        ],
      },
      campaignOptions: new Response("offline", { status: 503 }),
    });
    const cards = metricCards(html);

    expect(html).toMatch(
      /disabled=""><span class="filter-combobox-value">Campanhas indisponíveis<\/span><\/button>/,
    );
    expect(cards.find((card) => card.label === "Investimento")?.value).toBe(
      "R$\u00a0100,00",
    );
  });
});

describe("overview multi campaigns", () => {
  const multiFilters = {
    campaignIds: ["cmp_promo", "cmp_outra"],
    campaignNames: ["Promo Setembro", "Outra campanha"],
  };

  function multiReport(overrides: Record<string, unknown> = {}) {
    return campaignReport({ filters: multiFilters, ...overrides });
  }

  it("sends campaignIds to the report and labels the header with the count", async () => {
    const fetchSpy = mockOverviewApi({
      report: multiReport(),
      campaignOptions: campaignOptionsBody,
    });
    const element = await OverviewPage({
      searchParams: Promise.resolve({
        since: "2026-09-17",
        until: "2026-09-24",
        campaignIds: "cmp_promo,cmp_outra",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));
    const urls = fetchSpy.mock.calls.map(([input]) => String(input));

    expect(urls).toContain(
      "http://localhost:3333/reports/campaigns?includeDaily=true&includeSummary=true&since=2026-09-17&until=2026-09-24&campaignIds=cmp_promo%2Ccmp_outra",
    );
    expect(html).toContain('<span class="tag">2 campanhas</span>');
    expect(html).toContain(
      '<input type="hidden" name="campaignIds" value="cmp_promo,cmp_outra"/>',
    );
    expect(html).toContain(
      '<span class="filter-combobox-value">2 campanhas</span>',
    );
    expect(html).toContain('title="Outra campanha"');
  });

  it("merges a legacy campaignId with campaignIds and dedupes", async () => {
    const fetchSpy = mockOverviewApi({
      report: multiReport(),
      campaignOptions: campaignOptionsBody,
    });
    await OverviewPage({
      searchParams: Promise.resolve({
        campaignId: "cmp_promo",
        campaignIds: "cmp_outra, cmp_promo,,",
      }),
    });
    const urls = fetchSpy.mock.calls.map(([input]) => String(input));

    expect(urls).toContain(
      "http://localhost:3333/reports/campaigns?includeDaily=true&includeSummary=true&campaignIds=cmp_promo%2Ccmp_outra",
    );
  });

  it("treats a one-item campaignIds exactly as campaignId", async () => {
    const fetchSpy = mockOverviewApi({
      report: campaignReport(),
      campaignOptions: campaignOptionsBody,
    });
    const element = await OverviewPage({
      searchParams: Promise.resolve({ campaignIds: "cmp_promo" }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));
    const urls = fetchSpy.mock.calls.map(([input]) => String(input));

    expect(urls).toContain(
      "http://localhost:3333/reports/campaigns?includeDaily=true&includeSummary=true&campaignId=cmp_promo",
    );
    expect(html).toContain('<span class="tag">1 campanha</span>');
  });

  it("drops the campaigns from Abrir relatorios and shows a count scope", async () => {
    const html = await renderOverviewWith(
      {
        report: multiReport({ dailyComparisonAvailable: false }),
        campaignOptions: campaignOptionsBody,
      },
      {
        whatsappInstanceId: "instance_centro",
        campaignIds: "cmp_promo,cmp_outra",
      },
    );

    expect(html).toContain(
      'href="/reports?whatsappInstanceId=instance_centro">Abrir relatórios',
    );
    expect(html).toContain(
      '<span class="presentation-mask-value">2 campanhas selecionadas</span><span class="presentation-mask-placeholder">2 campanhas selecionadas</span>',
    );
  });

  // UX §8 test 23 (M5)
  it("M5: shared set renders summed partial cards without ROAS or costs", async () => {
    const html = await renderOverviewWith(
      {
        report: multiReport({
          metaMetricsScope: "campaign_shared",
          campaignInstanceLeads: [
            {
              instanceId: "instance_centro",
              instanceName: "Loja Centro",
              leads: 6,
            },
            {
              instanceId: "instance_norte",
              instanceName: "Loja Norte",
              leads: 2,
            },
          ],
        }),
        campaignOptions: campaignOptionsBody,
        instances: campaignInstances,
      },
      {
        whatsappInstanceId: "instance_centro",
        campaignIds: "cmp_promo,cmp_outra",
      },
    );
    const cards = metricCards(html);

    expect(html).toContain(
      '<div class="metric-card partial"><span>Investimento</span><strong>R$ 100,00</strong><small>Soma das campanhas inteiras · inclui outro número</small></div>',
    );
    expect(cards.find((card) => card.label === "Receita tráfego")?.delta).toBe(
      "Receita do número; ROAS indisponível",
    );
    expect(funnelCosts(html).every((cost) => cost.endsWith(": -"))).toBe(true);
    expect(html).toContain(
      "Uma ou mais campanhas selecionadas também geraram conversas em outro número. Investimento e Conversas Meta somam as campanhas inteiras; custos por etapa e ROAS ficam ocultos para não distorcer o resultado.",
    );
    expect(html).toContain(
      "Ultimos 7 dias: 6 leads novos neste número vindas das campanhas selecionadas.",
    );
  });

  it("M6: set with no conversations on the number shows the M6 note", async () => {
    const html = await renderOverviewWith(
      {
        report: multiReport({
          metaMetricsScope: "campaign_shared",
          campaignInstanceLeads: [
            {
              instanceId: "instance_norte",
              instanceName: "Loja Norte",
              leads: 2,
            },
          ],
        }),
        campaignOptions: campaignOptionsBody,
        instances: campaignInstances,
      },
      {
        whatsappInstanceId: "instance_centro",
        campaignIds: "cmp_promo,cmp_outra",
      },
    );

    expect(html).toContain(
      "Nenhuma das campanhas selecionadas gerou conversas neste número no período. Investimento e Conversas Meta mostram as campanhas inteiras.",
    );
    expect(html).toContain(
      "Soma das campanhas inteiras · nenhuma conversa neste número",
    );
  });

  it("M8: unsynced set keeps Meta metrics unavailable", async () => {
    const html = await renderOverviewWith(
      {
        report: multiReport({ metaMetricsScope: "campaign_unsynced" }),
        campaignOptions: campaignOptionsBody,
      },
      { campaignIds: "cmp_promo,cmp_outra" },
    );

    expect(
      metricCards(html).find((card) => card.label === "Investimento"),
    ).toEqual({
      label: "Investimento",
      value: "-",
      delta: "Aguardando sincronização da Meta",
    });
  });

  it("hints the set's only number with a one-click link that keeps campaignIds", async () => {
    const html = await renderOverviewWith(
      {
        report: multiReport(),
        campaignOptions: campaignOptionsBody,
        instances: campaignInstances,
      },
      { campaignIds: "cmp_promo,cmp_outra" },
    );

    expect(html).toContain("Estas campanhas levam conversas para ");
    expect(html).toContain(
      'href="/overview?whatsappInstanceId=instance_centro&amp;campaignIds=cmp_promo%2Ccmp_outra">Filtrar este número</a>',
    );
  });

  it("shows no hint when the set spreads across several numbers", async () => {
    const html = await renderOverviewWith(
      {
        report: multiReport({
          campaignInstanceLeads: [
            {
              instanceId: "instance_centro",
              instanceName: "Loja Centro",
              leads: 6,
            },
            {
              instanceId: "instance_norte",
              instanceName: "Loja Norte",
              leads: 3,
            },
          ],
        }),
        campaignOptions: campaignOptionsBody,
      },
      { campaignIds: "cmp_promo,cmp_outra" },
    );

    expect(html).not.toContain('role="note"');
  });

  it("renders the invalid-set state for a 404 and clears every campaign", async () => {
    const html = await renderOverviewWith(
      {
        report: new Response(
          JSON.stringify({ message: "Campanha não encontrada" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        ),
        campaignOptions: campaignOptionsBody,
      },
      {
        since: "2026-09-17",
        until: "2026-09-24",
        campaignIds: "cmp_promo,cmp_foreign",
      },
    );

    expect(html).toContain("Campanhas não encontradas");
    expect(html).toContain(
      '<a class="button ghost" href="/overview?since=2026-09-17&amp;until=2026-09-24">Limpar campanhas</a>',
    );
    expect(html).not.toContain("overview-primary-metrics");
  });

  it("renders the limit state for a 400 over ten campaigns", async () => {
    const ids = Array.from({ length: 11 }, (_, index) => `cmp_${index}`);
    const html = await renderOverviewWith(
      {
        report: new Response(
          JSON.stringify({
            message: "No máximo 10 campanhas podem ser selecionadas",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
        campaignOptions: campaignOptionsBody,
      },
      { campaignIds: ids.join(",") },
    );

    expect(html).toContain("Filtro de campanha inválido");
    expect(html).toContain("Selecione até 10 campanhas.");
    expect(html).toContain(
      '<span class="status-chip warn">Filtro inválido</span>',
    );
    expect(html).not.toContain("API indisponível");
  });
});
