import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LeadsPage from "../src/app/(app)/leads/page";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn() }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("leads route", () => {
  it("renders leads returned by the backend", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: "lead_1",
              workspaceId: "workspace_1",
              name: "Mariana Alves",
              phoneDisplay: "+55 11 99999-1020",
              phoneHash: "phone_hash_1",
              status: "qualified",
              source: "uazapi",
              labels: ["Venda fechada", "VIP"],
              campaignId: "cmp_1",
              campaignName: "Black Friday WhatsApp",
              adSetId: "adset_1",
              adId: "ad_1",
              lastEventName: "QualifiedLead",
              firstMessageAt: "2026-07-02T03:00:00.000Z",
              lastMessageAt: "2026-07-02T03:10:00.000Z",
              createdAt: "2026-07-02T03:00:00.000Z",
              updatedAt: "2026-07-02T03:10:00.000Z",
            },
          ],
          pagination: {
            page: 1,
            pageSize: 25,
            totalItems: 1,
            totalPages: 1,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const element = await LeadsPage({
      searchParams: Promise.resolve({
        search: "mariana",
        status: "qualified",
        label: "Venda fechada",
        attribution: "paid",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/leads/page?search=mariana&status=qualified&label=Venda+fechada&attribution=paid&page=1&pageSize=25",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(html).toContain("Mariana Alves");
    expect(html).toContain('href="/leads/lead_1"');
    expect(html).toContain("Black Friday WhatsApp");
    expect(html).toContain("QualifiedLead");
    expect(html).toContain("Etapa atual");
    expect(html).toContain("Lead qualificado");
    expect(html).toContain("Conversas recebidas");
    expect(html).toContain("Filtros avançados");
    expect(html).toContain('name="pageSize"');
    expect(html).toContain("Recebido");
    expect(html).toContain("Última atividade");
    expect(html).toContain('class="lead-mobile-list"');
    expect(html).toContain('aria-label="Abrir Mariana Alves"');
    expect(html).not.toContain("<th>Status</th>");
    expect(html).toContain("Venda fechada");
    expect(html).toContain('name="label"');
    expect(html).toContain('name="attribution"');
    expect(html).toContain('type="date"');
    expect(html).toContain('name="since"');
    expect(html).toContain('name="until"');
    expect(html).toContain("+55 11 99999-1020");
    expect(html).toContain("02/07, 00:10");
  });

  it("auto-applies filters without a visible Aplicar button", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [],
          pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const element = await LeadsPage({
      searchParams: Promise.resolve({ status: "lost" }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).not.toContain("Aplicar");
    expect(html).toContain(
      '<button class="sr-only" type="submit" tabindex="-1">Atualizar leads</button>',
    );
    expect(html).toContain('<option value="lost" selected="">Perdidos</option>');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toMatch(
      /<a class="button ghost" data-lead-filters-clear="true" href="\/leads">.*?Limpar<\/a>/,
    );
  });

  it("hides Limpar when no filter is applied", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [],
          pagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const element = await LeadsPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).not.toContain("data-lead-filters-clear");
    expect(html).not.toContain("Aplicar");
  });

  it("keeps active filters and page size on pagination links", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: "lead_1",
              workspaceId: "workspace_1",
              name: "Mariana Alves",
              phoneDisplay: "+55 11 99999-1020",
              phoneHash: "phone_hash_1",
              status: "lost",
              source: "uazapi",
              labels: [],
              campaignId: "cmp_1",
              campaignName: "Black Friday WhatsApp",
              adSetId: "adset_1",
              adId: "ad_1",
              lastEventName: null,
              firstMessageAt: "2026-07-02T03:00:00.000Z",
              lastMessageAt: "2026-07-02T03:10:00.000Z",
              createdAt: "2026-07-02T03:00:00.000Z",
              updatedAt: "2026-07-02T03:10:00.000Z",
            },
          ],
          pagination: { page: 2, pageSize: 50, totalItems: 160, totalPages: 4 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const element = await LeadsPage({
      searchParams: Promise.resolve({
        search: "mari",
        status: "lost",
        campaignId: "cmp_1",
        since: "2026-07-01",
        page: "2",
        pageSize: "50",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain(
      'href="/leads?search=mari&amp;status=lost&amp;campaignId=cmp_1&amp;since=2026-07-01&amp;page=1&amp;pageSize=50"',
    );
    expect(html).toContain(
      'href="/leads?search=mari&amp;status=lost&amp;campaignId=cmp_1&amp;since=2026-07-01&amp;page=3&amp;pageSize=50"',
    );
    expect(html).toContain('<input type="hidden" name="campaignId" value="cmp_1"/>');
    expect(html).not.toContain('name="adSetId"');
  });

  it("preserves the selected page size in queries and filter controls", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [],
          pagination: {
            page: 2,
            pageSize: 50,
            totalItems: 65,
            totalPages: 2,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const element = await LeadsPage({
      searchParams: Promise.resolve({
        page: "2",
        pageSize: "50",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/leads/page?page=2&pageSize=50",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(html).toContain('<option value="50" selected="">50 leads</option>');
  });

  it("loads the exact conversations without attribution", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [],
          pagination: {
            page: 1,
            pageSize: 25,
            totalItems: 0,
            totalPages: 0,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const element = await LeadsPage({
      searchParams: Promise.resolve({
        attribution: "organic",
        since: "2026-07-06",
        until: "2026-07-12",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/leads/page?attribution=organic&since=2026-07-06&until=2026-07-12&page=1&pageSize=25",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(html).toContain("Leads novos sem anúncio (orgânicos)");
    expect(html).toContain('name="since" value="2026-07-06"');
    expect(html).toContain('name="until" value="2026-07-12"');
  });

  it("passes report drill-down filters to the backend", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [],
          pagination: {
            page: 1,
            pageSize: 25,
            totalItems: 0,
            totalPages: 0,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const element = await LeadsPage({
      searchParams: Promise.resolve({
        campaignId: "cmp_1",
        adSetId: "adset_1",
        adId: "ad_1",
        since: "2026-07-01",
        until: "2026-07-02",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/leads/page?campaignId=cmp_1&adSetId=adset_1&adId=ad_1&since=2026-07-01&until=2026-07-02&page=1&pageSize=25",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(html).toContain("Filtro do relatório aplicado");
    expect(html).toContain('name="campaignId"');
    expect(html).toContain('name="adSetId"');
    expect(html).toContain('name="adId"');
  });

  it("uses a generic label for external MySQL lead sources", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: "lead_external",
              workspaceId: "workspace_1",
              name: "Sofia",
              phoneDisplay: "+55 62 8262-4329",
              phoneHash: "phone_hash_external",
              status: "active",
              source: "external_mysql",
              labels: [],
              campaignId: "cmp_1",
              campaignName: "Campanha WhatsApp",
              adSetId: "adset_1",
              adId: "ad_1",
              lastEventName: "LeadSubmitted",
              firstMessageAt: "2026-07-12T19:54:00.000Z",
              lastMessageAt: "2026-07-12T19:54:00.000Z",
              createdAt: "2026-07-12T19:54:00.000Z",
              updatedAt: "2026-07-12T19:54:00.000Z",
            },
          ],
          pagination: {
            page: 1,
            pageSize: 25,
            totalItems: 1,
            totalPages: 1,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const element = await LeadsPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Integração externa");
    expect(html).not.toContain("external_mysql");
  });

  it("renders an unavailable state without demo leads when the backend fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const element = await LeadsPage({
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("API indisponível");
    expect(html).toContain("Não foi possível carregar leads");
    expect(html).not.toContain("Mariana Alves");
    expect(html).not.toContain("Rafael Costa");
    expect(html).not.toContain("Black Friday WhatsApp");
    expect(html).not.toContain("Remarketing 7 dias");
  });

  it("renders an empty state without demo leads when there are no backend leads", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [],
          pagination: {
            page: 1,
            pageSize: 25,
            totalItems: 0,
            totalPages: 0,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const element = await LeadsPage({
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Nenhum lead encontrado");
    expect(html).not.toContain("Mariana Alves");
    expect(html).not.toContain("Rafael Costa");
    expect(html).not.toContain("Black Friday WhatsApp");
    expect(html).not.toContain("Remarketing 7 dias");
  });
});

describe("leads route base (novos x voltaram)", () => {
  function mockPage(body: Record<string, unknown>) {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [],
          pagination: { page: 1, pageSize: 25, totalItems: 56, totalPages: 3 },
          ...body,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }

  async function render(searchParams: Record<string, string>) {
    const element = await LeadsPage({
      searchParams: Promise.resolve(searchParams),
    });
    return renderToStaticMarkup(createElement("div", null, element));
  }

  it("names the default list as leads novos and shows organic leads as their own count", async () => {
    mockPage({ attributionCounts: { paid: 50, organic: 6 } });

    const html = await render({ since: "2026-10-14", until: "2026-10-14" });

    expect(html).toContain("56 leads novos (1º contato no período)");
    expect(html).toContain("Origem: todas");
    expect(html).toContain(
      'href="/leads?attribution=paid&amp;since=2026-10-14&amp;until=2026-10-14">50 de anúncio</a>',
    );
    expect(html).toContain(
      'href="/leads?attribution=organic&amp;since=2026-10-14&amp;until=2026-10-14">6 orgânicos</a>',
    );
    expect(html).not.toContain("conversas reais");
  });

  it("matches the overview headline when the paid origin is selected", async () => {
    mockPage({ attributionCounts: { paid: 56, organic: 6 } });

    const html = await render({
      attribution: "paid",
      since: "2026-10-14",
      until: "2026-10-14",
    });

    expect(html).toContain("56 leads novos (1º contato no período)");
    expect(html).toContain("Origem: anúncio");
    expect(html).not.toContain("orgânicos</a>");
  });

  it("asks the API for the leads that came back and says so", async () => {
    mockPage({
      pagination: { page: 1, pageSize: 25, totalItems: 6, totalPages: 1 },
    });

    const html = await render({
      attribution: "paid",
      base: "returning",
      since: "2026-10-14",
      until: "2026-10-14",
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/leads/page?attribution=paid&since=2026-10-14&until=2026-10-14&base=returning&page=1&pageSize=25",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(html).toContain("6 leads que voltaram no período");
    expect(html).toContain('<option value="returning" selected="">');
  });

  it("asks the API for the people with more than one conversation and says so", async () => {
    mockPage({
      pagination: { page: 1, pageSize: 25, totalItems: 9, totalPages: 1 },
    });

    const html = await render({
      attribution: "paid",
      base: "repeat",
      since: "2026-10-08",
      until: "2026-10-14",
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/leads/page?attribution=paid&since=2026-10-08&until=2026-10-14&base=repeat&page=1&pageSize=25",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(html).toContain("9 leads com mais de uma conversa no período");
    expect(html).toContain('<option value="repeat" selected="">');
    expect(html).toContain(
      "Leads que iniciaram mais de uma conversa por anúncio",
    );
  });

  it("ignores an unknown base and falls back to leads novos", async () => {
    mockPage({});

    await render({ base: "everything", since: "2026-10-14" });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/leads/page?since=2026-10-14&page=1&pageSize=25",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("offers the spreadsheet export of the applied filters when there are leads", async () => {
    mockPage({
      items: [
        {
          id: "lead_1",
          workspaceId: "workspace_1",
          name: "Mariana Alves",
          phoneDisplay: "+55 11 99999-1020",
          phoneHash: "phone_hash_1",
          status: "active",
          source: "uazapi",
          labels: [],
          campaignId: "cmp_1",
          campaignName: "Black Friday WhatsApp",
          adSetId: "adset_1",
          adId: "ad_1",
          lastEventName: "LeadSubmitted",
          firstMessageAt: "2026-10-14T13:00:00.000Z",
          lastMessageAt: "2026-10-14T13:10:00.000Z",
          createdAt: "2026-10-14T13:00:00.000Z",
          updatedAt: "2026-10-14T13:10:00.000Z",
        },
      ],
      pagination: { page: 1, pageSize: 25, totalItems: 1, totalPages: 1 },
    });

    const html = await render({ since: "2026-10-14", until: "2026-10-14" });

    expect(html).toContain('class="lead-export"');
    expect(html).toContain("Exportar");
    expect(html).toContain("NOD API");
    expect(html).toContain("Conversa iniciada");
  });
});

describe("leads route WhatsApp instance scope", () => {
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const scopedLead = {
    id: "lead_1",
    workspaceId: "workspace_1",
    name: "Mariana Alves",
    phoneDisplay: "+55 11 99999-1020",
    phoneHash: "phone_hash_1",
    status: "lost",
    source: "uazapi",
    labels: [],
    campaignId: null,
    campaignName: null,
    adSetId: null,
    adId: null,
    lastEventName: null,
    firstMessageAt: "2026-07-02T03:00:00.000Z",
    lastMessageAt: "2026-07-02T03:10:00.000Z",
    createdAt: "2026-07-02T03:00:00.000Z",
    updatedAt: "2026-07-02T03:10:00.000Z",
  };
  // nod: o número é a conexão WhatsApp (GET /integrations/whatsapp-connections).
  const instances = [
    {
      id: "wpp_1",
      name: "Vendas Centro",
      displayName: null,
      provider: "uazapi_byo",
      status: "active",
      connectedPhone: null,
      createdAt: "2026-07-02T03:00:00.000Z",
    },
  ];

  function mockApi({
    instancesResponse = () => json(instances),
    leadsPage = { page: 2, pageSize: 50, totalItems: 160, totalPages: 4 },
    items = [scopedLead] as unknown[],
  } = {}) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes("/integrations/whatsapp-connections")) {
        return instancesResponse();
      }

      return json({ items, pagination: leadsPage });
    });
  }

  it("scopes the API query, pagination, hidden field and Limpar to the instance", async () => {
    const fetchMock = mockApi();

    const element = await LeadsPage({
      searchParams: Promise.resolve({
        whatsappInstanceId: "wpp_1",
        status: "lost",
        page: "2",
        pageSize: "50",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3333/leads/page?status=lost&whatsappInstanceId=wpp_1&page=2&pageSize=50",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(html).toContain(
      'href="/leads?status=lost&amp;whatsappInstanceId=wpp_1&amp;page=1&amp;pageSize=50"',
    );
    expect(html).toContain(
      'href="/leads?status=lost&amp;whatsappInstanceId=wpp_1&amp;page=3&amp;pageSize=50"',
    );
    expect(html).toContain(
      '<input type="hidden" name="whatsappInstanceId" value="wpp_1"/>',
    );
    expect(html).toMatch(
      /data-lead-filters-clear="true" href="\/leads\?whatsappInstanceId=wpp_1&amp;pageSize=50"/,
    );
  });

  it("shows an honest, masked instance recorte with a way out", async () => {
    mockApi();

    const element = await LeadsPage({
      searchParams: Promise.resolve({ whatsappInstanceId: "wpp_1" }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Número WhatsApp");
    expect(html).toContain("Exibindo leads associados atualmente a");
    expect(html).toMatch(
      /data-presentation-sensitive="true"><span class="presentation-mask-value">Vendas Centro<\/span><span class="presentation-mask-placeholder">número oculto<\/span>/,
    );
    expect(html).toContain("não o histórico de mensagens");
    expect(html).toMatch(/href="\/leads">Ver todos os números<\/a>/);
    // The scope implies no period: no 24h/7d window is claimed here.
    expect(html).not.toContain("24h");
    expect(html).not.toContain("Periodo das conversas");
    expect(html).not.toContain("provider_instance_1");
    // Only scope applied: Limpar would reload the same list.
    expect(html).not.toContain("data-lead-filters-clear");
  });

  it("keeps the scope when the instance name cannot be loaded", async () => {
    const fetchMock = mockApi({
      instancesResponse: () => json({ message: "unavailable" }, 503),
    });

    const element = await LeadsPage({
      searchParams: Promise.resolve({ whatsappInstanceId: "wpp_1" }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3333/leads/page?whatsappInstanceId=wpp_1&page=1&pageSize=25",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(html).toContain("número selecionado");
    expect(html).toContain("Mariana Alves");
  });

  it("does not offer a no-op Limpar on an empty scoped list", async () => {
    mockApi({
      items: [],
      leadsPage: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 },
    });

    const element = await LeadsPage({
      searchParams: Promise.resolve({ whatsappInstanceId: "wpp_1" }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Nenhum lead encontrado");
    expect(html).not.toContain("Limpar filtros");
    expect(html).toContain("Ver todos os números");
  });

  it("does not look up instances without an instance scope", async () => {
    const fetchMock = mockApi();

    await LeadsPage({ searchParams: Promise.resolve({ status: "lost" }) });

    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/integrations/whatsapp-connections"),
      ),
    ).toBe(false);
  });

  it("keeps the report drill-down on Limpar and offers a separate way out", async () => {
    mockApi();

    const element = await LeadsPage({
      searchParams: Promise.resolve({
        campaignId: "cmp_1",
        whatsappInstanceId: "wpp_1",
        search: "mari",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toMatch(
      /data-lead-filters-clear="true" href="\/leads\?campaignId=cmp_1&amp;whatsappInstanceId=wpp_1"/,
    );
    expect(html).toMatch(
      /href="\/leads\?search=mari&amp;whatsappInstanceId=wpp_1">Remover recorte do relatório<\/a>/,
    );
    expect(html).toMatch(
      /href="\/leads\?search=mari&amp;campaignId=cmp_1">Ver todos os números<\/a>/,
    );
  });
});
