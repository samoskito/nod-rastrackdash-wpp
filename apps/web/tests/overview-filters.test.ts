// Fase 6.3b: ported from the SaaS overview-filters suite (#106, #110, #115,
// #116, #118, 2f79c3c7); numbers are the nod WhatsApp connections.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const presentation = vi.hoisted(() => ({ enabled: true }));
const router = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

vi.mock("../src/components/presentation-mode-toggle", () => ({
  usePresentationMode: () => presentation.enabled,
}));

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type {
  CampaignOptionDto,
  MetaReportingAccountDto,
} from "@wpptrack/shared";
import type { WhatsappNumberOption } from "../src/lib/whatsapp-number-options";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  OverviewFilters,
  campaignInScope,
  campaignOptionLabel,
  dateRangeStatus,
  groupCampaignOptions,
  overviewFiltersHref,
} from "../src/app/(app)/overview/overview-filters";

type FiltersProps = ComponentProps<typeof OverviewFilters>;

/** nod: o número é a conexão WhatsApp do workspace (sem billing). */
function instance(
  overrides: Partial<WhatsappNumberOption> = {},
): WhatsappNumberOption {
  return {
    id: "instance_private",
    name: "Chip privado",
    phone: "5511999991234",
    active: true,
    ...overrides,
  };
}

function reportingAccount(
  overrides: Partial<MetaReportingAccountDto> = {},
): MetaReportingAccountDto {
  return {
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
    ...overrides,
  } as MetaReportingAccountDto;
}

function campaignOption(
  overrides: Partial<CampaignOptionDto> = {},
): CampaignOptionDto {
  return {
    id: "cmp_1",
    name: "Promo Setembro",
    status: "active",
    businessId: "business_1",
    adAccountId: "act_1",
    leadsByInstance: {},
    ...overrides,
  };
}

const accounts = [
  reportingAccount(),
  reportingAccount({
    id: "reporting_2",
    businessId: "business_2",
    businessName: "BM Secundario",
    adAccountId: "act_2",
    adAccountName: "Conta Secundaria",
  }),
];

const instances = [
  instance({ id: "instance_a", name: "Loja Centro" }),
  instance({
    id: "instance_b",
    name: "Loja Norte",
    phone: "5511999995678",
  }),
];

const options = [
  campaignOption({
    id: "cmp_centro",
    name: "Promo Centro",
    leadsByInstance: { instance_a: 12 },
  }),
  campaignOption({
    id: "cmp_norte",
    name: "Promo Norte",
    businessId: "business_2",
    adAccountId: "act_2",
    leadsByInstance: { instance_b: 4 },
  }),
  campaignOption({
    id: "cmp_nova",
    name: "Awareness Nova",
    status: "paused",
  }),
];

function filtersProps(overrides: Partial<FiltersProps> = {}): FiltersProps {
  return {
    campaignOptions: options,
    hasActiveFilter: true,
    reportingAccounts: accounts,
    whatsappInstances: instances,
    ...overrides,
  };
}

function renderMarkup(overrides: Partial<FiltersProps> = {}) {
  return renderToStaticMarkup(
    createElement(OverviewFilters, filtersProps(overrides)),
  );
}

function stubViewport(mobile: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: mobile,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

function renderFilters(overrides: Partial<FiltersProps> = {}) {
  const view = render(createElement(OverviewFilters, filtersProps(overrides)));
  const { container } = view;

  return {
    ...view,
    trigger: () =>
      container.querySelector<HTMLButtonElement>(
        ".overview-campaign-filter .filter-combobox-trigger",
      )!,
    campaignValue: () =>
      container.querySelector<HTMLInputElement>('input[name="campaignId"]')!
        .value,
    openCampaigns: () => {
      fireEvent.click(
        container.querySelector<HTMLButtonElement>(
        ".overview-campaign-filter .filter-combobox-trigger",
      )!,
      );
      return container.querySelector<HTMLInputElement>(
        ".filter-combobox-search",
      )!;
    },
    optionLabels: () =>
      Array.from(
        container.querySelectorAll('[role="option"] strong'),
        (node) => node.textContent,
      ),
    option: (label: string) =>
      Array.from(
        container.querySelectorAll<HTMLElement>('[role="option"]'),
      ).find((node) => node.querySelector("strong")?.textContent === label)!,
    rerender: (next: Partial<FiltersProps>) =>
      view.rerender(createElement(OverviewFilters, filtersProps(next))),
  };
}

/** Label of the listbox group holding an option, or null when ungrouped. */
function groupOf(container: HTMLElement, label: string) {
  const option = Array.from(
    container.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((node) => node.querySelector("strong")?.textContent === label);
  const group = option?.closest(".filter-combobox-group");

  return group
    ? group.querySelector(".filter-combobox-group-label")?.textContent
    : null;
}

beforeEach(() => {
  presentation.enabled = false;
  router.push.mockReset();
  stubViewport(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("overview filters", () => {
  it("preserves the number filter while masking its option in presentation mode", () => {
    presentation.enabled = true;
    const html = renderMarkup({
      campaignOptions: [],
      reportingAccounts: [],
      whatsappInstanceId: "instance_private",
      whatsappInstances: [instance()],
    });

    expect(html).toContain("Número WhatsApp");
    expect(html).toContain("Número oculto");
    expect(html).not.toContain("Instancia");
    expect(html).toContain('name="whatsappInstanceId"');
    expect(html).toContain('value="instance_private"');
    expect(html).not.toContain("Chip privado");
    expect(html).not.toContain("1234");
  });

  it("renames the number field and marks a removed number", () => {
    const html = renderMarkup({ whatsappInstanceId: "instance_gone" });

    expect(html).toContain("Número WhatsApp");
    expect(html).toContain("Todos os números");
    expect(html).toContain(
      '<option value="instance_gone" selected="">Número removido</option>',
    );
    expect(html).toContain("Loja Centro - •••• 1234");
  });

  // §9 test 8
  it("renders Campanhas after Numero WhatsApp in the Numero e campanha group", () => {
    const html = renderMarkup({ campaignIds: ["cmp_centro"] });
    const numberPosition = html.indexOf("<span>Número WhatsApp</span>");
    const campaignPosition = html.search(/<span id="[^"]+">Campanhas<\/span>/);

    expect(html).toContain("Período e contas");
    expect(html).toContain("Número e campanha");
    expect(html.indexOf("Número e campanha")).toBeLessThan(numberPosition);
    expect(numberPosition).toBeGreaterThan(-1);
    expect(campaignPosition).toBeGreaterThan(numberPosition);
    expect(html).toContain(
      '<input type="hidden" name="campaignId" value="cmp_centro"/>',
    );
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain(
      '<span class="filter-combobox-value">Promo Centro</span>',
    );
    expect(html).not.toContain('<select name="campaignId"');
    // Limpar filtros goes back to the bare overview, dropping campaignId too.
    expect(html).toContain(
      'aria-label="Limpar filtros" title="Limpar filtros" href="/overview"',
    );
  });

  it("submits campaignId with the form", () => {
    const { container } = render(
      createElement(
        OverviewFilters,
        filtersProps({ campaignIds: ["cmp_centro"] }),
      ),
    );
    const form = container.querySelector("form")!;
    const data = new FormData(form);

    expect(data.getAll("campaignId")).toEqual(["cmp_centro"]);
  });

  it("renders no campaign names until the campaign list is opened", () => {
    const html = renderMarkup();

    expect(html).toContain("Todas as campanhas");
    expect(html).not.toContain("Promo Centro");
    expect(html).not.toContain('role="listbox"');
  });

  it("lists campaigns flat by name when no number is selected", () => {
    const view = renderFilters();

    view.openCampaigns();

    expect(view.container.querySelector(".filter-combobox-group")).toBeNull();
    // Multi: an empty selection already means all, so there is no "all" row.
    expect(view.optionLabels()).toEqual([
      "Awareness Nova · Pausada",
      "Promo Centro",
      "Promo Norte",
    ]);
  });

  it("groups campaigns by conversations on the selected number", () => {
    const view = renderFilters({ whatsappInstanceId: "instance_a" });

    view.openCampaigns();

    expect(
      Array.from(
        view.container.querySelectorAll(".filter-combobox-group-label"),
        (node) => node.textContent,
      ),
    ).toEqual(["Com conversas neste número", "Outras campanhas"]);
    expect(groupOf(view.container, "Promo Centro")).toBe(
      "Com conversas neste número",
    );
    expect(groupOf(view.container, "Promo Norte")).toBe("Outras campanhas");
    expect(view.option("Promo Centro").textContent).toContain(
      "12 conversas neste número",
    );
  });

  it("sorts the conversations group by leads on the number, then name", () => {
    const grouped = groupCampaignOptions(
      [
        campaignOption({ id: "b", name: "B", leadsByInstance: { n1: 3 } }),
        campaignOption({ id: "a", name: "A", leadsByInstance: { n1: 3 } }),
        campaignOption({ id: "c", name: "C", leadsByInstance: { n1: 9 } }),
        campaignOption({ id: "z", name: "Z", leadsByInstance: { n2: 5 } }),
      ],
      "n1",
    );

    expect(grouped).toEqual({
      kind: "grouped",
      withLeads: [
        expect.objectContaining({ id: "c" }),
        expect.objectContaining({ id: "a" }),
        expect.objectContaining({ id: "b" }),
      ],
      others: [expect.objectContaining({ id: "z" })],
    });
  });

  it("truncates long campaign names in the label only", () => {
    const longName = `[CTWA] ${"Promocao de primavera ".repeat(5)}`.trim();
    const label = campaignOptionLabel(
      campaignOption({ name: longName, status: "paused" }),
    );

    expect(label.endsWith("… · Pausada")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(60 + " · Pausada".length);
    expect(
      renderMarkup({
        campaignIds: ["cmp_1"],
        campaignOptions: [campaignOption({ name: longName })],
      }),
    ).toContain(`title="${longName}"`);
  });

  // §9 test 9
  // §9 test 9 + UX §8 test 7: one navigation for the BM and its cascade.
  it("clears a campaign from another BM when the BM changes", () => {
    const view = renderFilters({
      adAccountId: "act_2",
      campaignIds: ["cmp_norte"],
    });

    expect(view.campaignValue()).toBe("cmp_norte");

    fireEvent.change(
      view.container.querySelector('select[name="businessId"]')!,
      { target: { value: "business_1" } },
    );

    expect(view.campaignValue()).toBe("");
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      "/overview?businessId=business_1",
      {
        scroll: false,
      },
    );

    view.openCampaigns();
    expect(view.optionLabels()).not.toContain("Promo Norte");
  });

  it("keeps a campaign inside the new BM when the BM changes", () => {
    const view = renderFilters({ campaignIds: ["cmp_centro"] });

    fireEvent.change(
      view.container.querySelector('select[name="businessId"]')!,
      { target: { value: "business_1" } },
    );

    expect(view.campaignValue()).toBe("cmp_centro");
    expect(router.push).toHaveBeenCalledWith(
      "/overview?businessId=business_1&campaignId=cmp_centro",
      { scroll: false },
    );
  });

  it("clears a campaign outside the account when the account changes", () => {
    const view = renderFilters({ campaignIds: ["cmp_centro"] });

    fireEvent.click(
      view.container.querySelector(
        ".overview-ad-account-filter .filter-combobox-trigger",
      )!,
    );
    fireEvent.click(
      view.container.querySelector('[role="option"][title^="Conta Secundaria"]')!,
    );
    fireEvent.click(view.container.querySelector(".filter-combobox-done")!);

    expect(view.campaignValue()).toBe("");
    expect(router.push).toHaveBeenCalledWith("/overview?adAccountId=act_2", {
      scroll: false,
    });
  });

  it("selects several ad accounts as adAccountIds with a currency badge", () => {
    const view = renderFilters({
      accountCurrencies: { act_1: "BRL", act_2: "USD" },
    });

    fireEvent.click(
      view.container.querySelector(
        ".overview-ad-account-filter .filter-combobox-trigger",
      )!,
    );
    const badges = Array.from(
      view.container.querySelectorAll(".filter-combobox-badge"),
      (node) => node.textContent,
    );
    expect(badges).toEqual(["BRL", "USD"]);

    fireEvent.click(
      view.container.querySelector('[role="option"][title^="Conta Principal"]')!,
    );
    fireEvent.click(
      view.container.querySelector('[role="option"][title^="Conta Secundaria"]')!,
    );
    fireEvent.click(view.container.querySelector(".filter-combobox-done")!);

    expect(router.push).toHaveBeenCalledWith(
      "/overview?adAccountIds=act_1%2Cact_2",
      { scroll: false },
    );
  });

  it("keeps the campaign when the number changes and moves it between groups", () => {
    const view = renderFilters({
      campaignIds: ["cmp_centro"],
      whatsappInstanceId: "instance_a",
    });

    view.openCampaigns();
    expect(groupOf(view.container, "Promo Centro")).toBe(
      "Com conversas neste número",
    );
    fireEvent.keyDown(
      view.container.querySelector(".filter-combobox-search")!,
      { key: "Escape" },
    );

    fireEvent.change(
      view.container.querySelector('select[name="whatsappInstanceId"]')!,
      { target: { value: "instance_b" } },
    );

    expect(view.campaignValue()).toBe("cmp_centro");
    expect(router.push).toHaveBeenCalledWith(
      "/overview?whatsappInstanceId=instance_b&campaignId=cmp_centro",
      { scroll: false },
    );

    view.openCampaigns();
    expect(groupOf(view.container, "Promo Centro")).toBe("Outras campanhas");
    expect(groupOf(view.container, "Promo Norte")).toBe(
      "Com conversas neste número",
    );
  });

  it("scopes campaign options by BM and account", () => {
    const option = campaignOption();

    expect(campaignInScope(option, "", "")).toBe(true);
    expect(campaignInScope(option, "business_1", "")).toBe(true);
    expect(campaignInScope(option, "business_2", "")).toBe(false);
    expect(campaignInScope(option, "business_1", "act_2")).toBe(false);
    expect(campaignInScope(undefined, "business_1", "")).toBe(false);
  });

  it("keeps an applied campaign missing from the period as a synthetic option", () => {
    const html = renderMarkup({
      campaignIds: ["cmp_old"],
      campaignNames: { cmp_old: "Promo Julho" },
    });

    expect(html).toContain(
      '<span class="filter-combobox-value">Promo Julho (sem dados no período)</span>',
    );
    expect(html).toContain(
      '<input type="hidden" name="campaignId" value="cmp_old"/>',
    );
  });

  // §9 test 10
  it("masks every campaign name in presentation mode and keeps the value", () => {
    presentation.enabled = true;
    const html = renderMarkup({
      campaignIds: ["cmp_centro"],
      campaignNames: { cmp_centro: "Promo Centro" },
      whatsappInstanceId: "instance_a",
    });

    expect(html).toContain("Campanha oculta");
    expect(html).toContain(
      '<input type="hidden" name="campaignId" value="cmp_centro"/>',
    );
    expect(html).not.toContain("Promo Centro");
    expect(html).not.toContain("Promo Norte");
    expect(html).not.toContain("Awareness Nova");
    expect(html.match(/name="campaignId"/g)).toHaveLength(1);
  });

  // §9 test 14
  it("disables the campaign field when the options endpoint fails", () => {
    const html = renderMarkup({ campaignOptions: null });

    expect(html).toMatch(
      /<button class="filter-combobox-trigger" type="button" id="[^"]+" aria-labelledby="[^"]+" disabled=""><span class="filter-combobox-value">Campanhas indisponíveis<\/span><\/button>/,
    );
    expect(html).not.toContain('name="campaignId"');
  });

  it("keeps an applied campaign when the options endpoint fails", () => {
    const html = renderMarkup({
      campaignIds: ["cmp_centro"],
      campaignOptions: null,
    });

    expect(html).toContain(
      '<input type="hidden" name="campaignId" value="cmp_centro"/>',
    );
    expect(html.match(/name="campaignId"/g)).toHaveLength(1);
  });

  it("disables the campaign field when the period has no campaigns", () => {
    const html = renderMarkup({ campaignOptions: [] });

    expect(html).toContain("Nenhuma campanha no período");
    expect(html).toMatch(/aria-labelledby="[^"]+" disabled=""/);
  });

  // §9 test 15
  it("collapses BM/Conta on mobile and keeps number and campaign visible", () => {
    stubViewport(true);
    const { container } = render(
      createElement(OverviewFilters, filtersProps()),
    );
    const details = container.querySelector<HTMLDetailsElement>(
      "details.overview-filter-accounts",
    )!;

    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe(
      "Business Manager",
    );
    expect(details.querySelector('select[name="businessId"]')).not.toBeNull();
    // The ad account filter is prominent: outside the collapsed section.
    expect(details.querySelector(".overview-ad-account-filter")).toBeNull();
    expect(
      container.querySelector(".overview-ad-account-filter"),
    ).not.toBeNull();
    expect(details.querySelector('[name="whatsappInstanceId"]')).toBeNull();
    expect(details.querySelector('[name="campaignId"]')).toBeNull();
    expect(
      container.querySelector(
        ".overview-filter-group-cut select[name='whatsappInstanceId']",
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        ".overview-filter-group-cut input[name='campaignId']",
      ),
    ).not.toBeNull();
  });

  it("opens the mobile accounts section with a count when BM/Conta is active", () => {
    stubViewport(true);
    const { container } = render(
      createElement(
        OverviewFilters,
        filtersProps({ businessId: "business_1", adAccountId: "act_1" }),
      ),
    );
    const details = container.querySelector<HTMLDetailsElement>(
      "details.overview-filter-accounts",
    )!;

    expect(details.open).toBe(true);
    expect(details.querySelector("summary .tag")?.textContent).toBe("1");
  });

  it("keeps the accounts section open on desktop", () => {
    const { container } = render(
      createElement(OverviewFilters, filtersProps()),
    );

    expect(
      container.querySelector<HTMLDetailsElement>(
        "details.overview-filter-accounts",
      )!.open,
    ).toBe(true);
  });

  it("submits exactly one value per filter name", () => {
    const { container } = render(
      createElement(
        OverviewFilters,
        filtersProps({
          adAccountId: "act_1",
          businessId: "business_1",
          campaignIds: ["cmp_centro"],
          since: "2026-09-01",
          until: "2026-09-24",
          whatsappInstanceId: "instance_a",
        }),
      ),
    );
    const data = new FormData(container.querySelector("form")!);

    for (const name of [
      "since",
      "until",
      "businessId",
      "adAccountId",
      "whatsappInstanceId",
      "campaignId",
    ]) {
      expect(data.getAll(name)).toHaveLength(1);
    }
  });

  it("merges both groups into one row when there is a single account", () => {
    const html = renderMarkup({ reportingAccounts: [reportingAccount()] });

    expect(html).toContain('class="overview-filter-bar single-row"');
    expect(html).not.toContain("overview-filter-accounts");
  });
});

describe("overview filters auto-apply", () => {
  const period = { since: "2026-09-01", until: "2026-09-24" };

  it("has no Aplicar button, only a hidden submitter", () => {
    const { container } = renderFilters();
    const buttons = Array.from(container.querySelectorAll("button"));

    expect(buttons.map((button) => button.textContent)).not.toContain(
      "Aplicar",
    );
    expect(container.textContent).not.toContain("Aplicar");
    expect(
      container.querySelector<HTMLButtonElement>('button[type="submit"]'),
    ).toMatchObject({ className: "sr-only", tabIndex: -1 });
  });

  // UX §8 test 4 (multi: 600 ms after the last toggle, no click on Aplicar)
  it("applies a picked campaign after the debounce, keeping the list open", () => {
    vi.useFakeTimers();
    const view = renderFilters({ ...period, whatsappInstanceId: "instance_a" });

    view.openCampaigns();
    fireEvent.click(view.option("Promo Norte"));

    expect(router.push).not.toHaveBeenCalled();
    expect(view.container.querySelector('[role="listbox"]')).not.toBeNull();
    expect(view.trigger().textContent).toBe("Promo Norte");

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      "/overview?since=2026-09-01&until=2026-09-24&whatsappInstanceId=instance_a&campaignId=cmp_norte",
      { scroll: false },
    );
    expect(view.campaignValue()).toBe("cmp_norte");
  });

  it("drops the campaign params when the popover Limpar is used", () => {
    const view = renderFilters({ ...period, campaignIds: ["cmp_centro"] });

    view.openCampaigns();
    fireEvent.click(
      view.container.querySelector<HTMLButtonElement>(
        ".filter-combobox-footer .filter-combobox-clear",
      )!,
    );

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      "/overview?since=2026-09-01&until=2026-09-24",
      { scroll: false },
    );
  });

  // UX §8 test 1
  it("finds campaigns by accent-insensitive name or pasted id", () => {
    const view = renderFilters({
      campaignOptions: [
        ...options,
        campaignOption({ id: "120210000000001", name: "Promocao Primavera" }),
      ],
    });
    const search = view.openCampaigns();

    fireEvent.change(search, { target: { value: "promoção" } });
    expect(view.optionLabels()).toEqual(["Promocao Primavera"]);
    expect(
      view.container.querySelector(".filter-combobox-count")?.textContent,
    ).toBe("1 de 4 campanhas");

    fireEvent.change(search, { target: { value: "promo" } });
    expect(view.optionLabels()).toEqual([
      "Promo Centro",
      "Promo Norte",
      "Promocao Primavera",
    ]);

    fireEvent.change(search, { target: { value: "120210000000001" } });
    expect(view.optionLabels()).toEqual(["Promocao Primavera"]);
  });

  // UX §8 test 2
  it("keeps the number groups while searching and hides empty ones", () => {
    const view = renderFilters({ whatsappInstanceId: "instance_a" });
    const search = view.openCampaigns();

    fireEvent.change(search, { target: { value: "centro" } });

    expect(view.optionLabels()).toEqual(["Promo Centro"]);
    expect(
      Array.from(
        view.container.querySelectorAll(".filter-combobox-group-label"),
        (node) => node.textContent,
      ),
    ).toEqual(["Com conversas neste número"]);
  });

  it("does not navigate while typing a search", () => {
    const view = renderFilters({ campaignIds: ["cmp_centro"] });
    const search = view.openCampaigns();

    fireEvent.change(search, { target: { value: "nor" } });

    expect(router.push).not.toHaveBeenCalled();
    expect(view.campaignValue()).toBe("cmp_centro");
  });

  it("does not navigate when a toggle is undone before it applies", () => {
    vi.useFakeTimers();
    const view = renderFilters({ ...period, campaignIds: ["cmp_centro"] });

    view.openCampaigns();
    fireEvent.click(view.option("Promo Centro"));
    fireEvent.click(view.option("Promo Centro"));
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    fireEvent.keyDown(
      view.container.querySelector(".filter-combobox-search")!,
      { key: "Escape" },
    );

    expect(router.push).not.toHaveBeenCalled();
  });

  // UX §8 test 6
  it("commits a typed date once, after the debounce", () => {
    vi.useFakeTimers();
    const { container } = renderFilters(period);
    const since = container.querySelector<HTMLInputElement>(
      'input[name="since"]',
    )!;

    fireEvent.change(since, { target: { value: "0002-09-10" } });
    fireEvent.change(since, { target: { value: "0020-09-10" } });
    fireEvent.change(since, { target: { value: "2026-09-10" } });
    expect(router.push).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(800);
    });

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      "/overview?since=2026-09-10&until=2026-09-24",
      { scroll: false },
    );
  });

  it("never commits a half-typed year", () => {
    vi.useFakeTimers();
    const { container } = renderFilters(period);
    const since = container.querySelector<HTMLInputElement>(
      'input[name="since"]',
    )!;

    fireEvent.change(since, { target: { value: "0202-09-10" } });
    fireEvent.blur(since);
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(router.push).not.toHaveBeenCalled();
  });

  it("flushes a pending date on blur", () => {
    vi.useFakeTimers();
    const { container } = renderFilters(period);
    const until = container.querySelector<HTMLInputElement>(
      'input[name="until"]',
    )!;

    fireEvent.change(until, { target: { value: "2026-09-20" } });
    fireEvent.blur(until);

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      "/overview?since=2026-09-01&until=2026-09-20",
      { scroll: false },
    );

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("blocks Fim before Inicio with an inline error", () => {
    vi.useFakeTimers();
    const { container } = renderFilters(period);
    const until = container.querySelector<HTMLInputElement>(
      'input[name="until"]',
    )!;

    fireEvent.change(until, { target: { value: "2026-08-20" } });
    fireEvent.blur(until);
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(router.push).not.toHaveBeenCalled();
    expect(until.getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelector(".overview-filter-error")?.textContent).toBe(
      "Fim antes do início",
    );

    fireEvent.change(until, { target: { value: "2026-09-20" } });
    expect(until.getAttribute("aria-invalid")).toBeNull();
    expect(container.querySelector(".overview-filter-error")).toBeNull();
  });

  it("keeps the applied period when another filter changes mid-edit", () => {
    const { container } = renderFilters(period);

    fireEvent.change(
      container.querySelector<HTMLInputElement>('input[name="until"]')!,
      { target: { value: "" } },
    );
    fireEvent.change(
      container.querySelector('select[name="whatsappInstanceId"]')!,
      { target: { value: "instance_b" } },
    );

    expect(router.push).toHaveBeenCalledWith(
      "/overview?since=2026-09-01&until=2026-09-24&whatsappInstanceId=instance_b",
      { scroll: false },
    );
  });

  // UX §8 test 11
  it("commits immediately on Enter (form submit)", () => {
    vi.useFakeTimers();
    const { container } = renderFilters(period);

    fireEvent.change(
      container.querySelector<HTMLInputElement>('input[name="since"]')!,
      { target: { value: "2026-09-05" } },
    );
    fireEvent.submit(container.querySelector("form")!);

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      "/overview?since=2026-09-05&until=2026-09-24",
      { scroll: false },
    );

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  // UX §8 test 9
  it("carries both of two quick changes into the final URL", () => {
    const view = renderFilters(period);

    fireEvent.change(
      view.container.querySelector('select[name="whatsappInstanceId"]')!,
      { target: { value: "instance_a" } },
    );
    view.openCampaigns();
    fireEvent.click(view.option("Promo Centro"));
    fireEvent.keyDown(
      view.container.querySelector(".filter-combobox-search")!,
      { key: "Escape" },
    );

    expect(router.push).toHaveBeenLastCalledWith(
      "/overview?since=2026-09-01&until=2026-09-24&whatsappInstanceId=instance_a&campaignId=cmp_centro",
      { scroll: false },
    );
  });

  it("does not reset a newer local edit when an older navigation lands", () => {
    vi.useFakeTimers();
    const view = renderFilters(period);
    const since = () =>
      view.container.querySelector<HTMLInputElement>('input[name="since"]')!;

    fireEvent.change(
      view.container.querySelector('select[name="whatsappInstanceId"]')!,
      { target: { value: "instance_a" } },
    );
    // A date is being typed while the number navigation is in flight.
    fireEvent.change(since(), { target: { value: "2026-09-10" } });
    view.rerender({ ...period, whatsappInstanceId: "instance_a" });

    expect(since().value).toBe("2026-09-10");
    expect(
      view.container.querySelector<HTMLSelectElement>(
        'select[name="whatsappInstanceId"]',
      )!.value,
    ).toBe("instance_a");
  });

  // UX §8 test 8
  it("reflects Back/Forward navigation in the controls", () => {
    const view = renderFilters({ ...period, campaignIds: ["cmp_centro"] });

    view.rerender({
      since: "2026-08-01",
      until: "2026-08-31",
      campaignIds: ["cmp_norte"],
    });

    expect(view.campaignValue()).toBe("cmp_norte");
    expect(view.trigger().textContent).toBe("Promo Norte");
    expect(
      view.container.querySelector<HTMLInputElement>('input[name="since"]')!
        .value,
    ).toBe("2026-08-01");
    expect(router.push).not.toHaveBeenCalled();

    // The restored state is the applied one: closing without changes is a no-op.
    view.openCampaigns();
    fireEvent.click(
      view.container.querySelector<HTMLButtonElement>(".filter-combobox-done")!,
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  // UX §8 test 10
  it("keeps the campaign hidden and non-interactive in presentation mode", () => {
    presentation.enabled = true;
    const view = renderFilters({ campaignIds: ["cmp_centro"] });

    expect(view.container.querySelector(".filter-combobox-trigger")).toBeNull();
    expect(view.container.textContent).toContain("Campanha oculta");
    expect(view.container.textContent).not.toContain("Promo");
    expect(view.campaignValue()).toBe("cmp_centro");
  });

  it("shows Todas as campanhas in presentation mode without a selection", () => {
    presentation.enabled = true;
    const html = renderMarkup();

    expect(html).toContain(
      '<span class="presentation-filter-placeholder">Todas as campanhas</span>',
    );
    expect(html).not.toContain("Promo");
  });

  it("builds canonical hrefs and validates periods", () => {
    expect(
      overviewFiltersHref({
        campaignIds: ["cmp_1"],
        whatsappInstanceId: "",
        adAccountId: "act_1",
        businessId: "",
        until: "2026-09-24",
        since: "2026-09-01",
      }),
    ).toBe(
      "/overview?since=2026-09-01&until=2026-09-24&adAccountId=act_1&campaignId=cmp_1",
    );
    expect(
      overviewFiltersHref({
        since: "",
        until: "",
        businessId: "",
        adAccountId: "",
        whatsappInstanceId: "",
        campaignIds: [],
      }),
    ).toBe("/overview");
    expect(dateRangeStatus("2026-09-01", "2026-09-24")).toBe("valid");
    expect(dateRangeStatus("2026-09-01", "2026-09-01")).toBe("valid");
    expect(dateRangeStatus("2026-09-24", "2026-09-01")).toBe("order");
    expect(dateRangeStatus("0202-09-01", "2026-09-24")).toBe("incomplete");
    expect(dateRangeStatus("", "2026-09-24")).toBe("incomplete");
  });
});

describe("overview filters multi campaigns", () => {
  const period = { since: "2026-09-01", until: "2026-09-24" };
  const many = Array.from({ length: 11 }, (_, index) =>
    campaignOption({ id: `cmp_${index + 1}`, name: `Campanha ${index + 1}` }),
  );

  function chipLabels(container: HTMLElement) {
    return Array.from(
      container.querySelectorAll(".overview-campaign-chip-label"),
      (node) => node.textContent,
    );
  }

  // UX §8 test 20
  it("applies three quick toggles as one campaignIds navigation in selection order", () => {
    vi.useFakeTimers();
    const view = renderFilters(period);

    view.openCampaigns();
    fireEvent.click(view.option("Promo Norte"));
    fireEvent.click(view.option("Awareness Nova · Pausada"));
    fireEvent.click(view.option("Promo Centro"));
    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      "/overview?since=2026-09-01&until=2026-09-24&campaignIds=cmp_norte%2Ccmp_nova%2Ccmp_centro",
      { scroll: false },
    );
    expect(view.trigger().textContent).toBe("3 campanhas");
    expect(chipLabels(view.container)).toEqual([
      "Promo Norte",
      "Awareness Nova",
      "Promo Centro",
    ]);
    expect(
      view.container.querySelector<HTMLInputElement>(
        'input[name="campaignIds"]',
      )!.value,
    ).toBe("cmp_norte,cmp_nova,cmp_centro");
    expect(view.container.querySelector('input[name="campaignId"]')).toBeNull();
  });

  it("flushes toggles as soon as the popover closes", () => {
    vi.useFakeTimers();
    const view = renderFilters(period);

    view.openCampaigns();
    fireEvent.click(view.option("Promo Norte"));
    fireEvent.click(view.option("Promo Centro"));
    fireEvent.click(view.container.querySelector(".filter-combobox-done")!);

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      "/overview?since=2026-09-01&until=2026-09-24&campaignIds=cmp_norte%2Ccmp_centro",
      { scroll: false },
    );
    expect(view.container.querySelector('[role="listbox"]')).toBeNull();
  });

  // UX §8 test 22
  it("removes a chip immediately and writes campaignId when one is left", () => {
    const view = renderFilters({
      ...period,
      campaignIds: ["cmp_centro", "cmp_norte"],
    });

    fireEvent.click(
      view.container.querySelector('[aria-label="Remover Promo Centro"]')!,
    );

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      "/overview?since=2026-09-01&until=2026-09-24&campaignId=cmp_norte",
      { scroll: false },
    );
    expect(chipLabels(view.container)).toEqual(["Promo Norte"]);
    expect(view.campaignValue()).toBe("cmp_norte");
  });

  it("clears every campaign from Limpar campanhas", () => {
    const view = renderFilters({
      ...period,
      campaignIds: ["cmp_centro", "cmp_norte"],
    });
    const clear = Array.from(view.container.querySelectorAll("button")).find(
      (button) => button.textContent === "Limpar campanhas",
    )!;

    fireEvent.click(clear);

    expect(router.push).toHaveBeenCalledWith(
      "/overview?since=2026-09-01&until=2026-09-24",
      { scroll: false },
    );
    expect(view.container.querySelector(".overview-campaign-strip")).toBeNull();
  });

  // UX §8 test 21
  it("blocks an eleventh campaign and shows the limit", () => {
    vi.useFakeTimers();
    const ten = many.slice(0, 10).map((option) => option.id);
    const view = renderFilters({ campaignOptions: many, campaignIds: ten });

    view.openCampaigns();

    expect(view.option("Campanha 11").getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(view.option("Campanha 1").getAttribute("aria-disabled")).toBeNull();
    expect(
      view.container.querySelector(".filter-combobox-limit")?.textContent,
    ).toBe("Limite de 10 campanhas");

    fireEvent.click(view.option("Campanha 11"));
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(router.push).not.toHaveBeenCalled();
  });

  it("collapses chips after six into +k that opens the list", () => {
    const view = renderFilters({
      campaignOptions: many,
      campaignIds: many.slice(0, 8).map((option) => option.id),
    });
    const more = view.container.querySelector<HTMLButtonElement>(
      '[aria-label="Ver mais 2 campanhas"]',
    )!;

    expect(chipLabels(view.container)).toHaveLength(6);
    expect(more.textContent).toBe("+2");
    // Mobile keeps one chip and "+k" for the rest (CSS picks the button).
    expect(
      view.container.querySelector('[aria-label="Ver mais 7 campanhas"]')
        ?.textContent,
    ).toBe("+7");

    fireEvent.click(more);
    expect(view.container.querySelector('[role="listbox"]')).not.toBeNull();
  });

  it("truncates chip labels and keeps the full name in the title", () => {
    const longName = "[CTWA] Promocao de primavera para clientes antigos";
    const html = renderMarkup({
      campaignIds: ["cmp_long"],
      campaignOptions: [campaignOption({ id: "cmp_long", name: longName })],
    });

    expect(html).toContain(`title="${longName}"`);
    expect(html).toContain(
      '<span class="overview-campaign-chip-label">[CTWA] Promocao de primavera pa…</span>',
    );
  });

  it("keeps selected campaigns missing from the period as chips", () => {
    const html = renderMarkup({
      campaignIds: ["cmp_centro", "cmp_old"],
      campaignNames: { cmp_old: "Promo Julho" },
    });

    expect(html).toContain('title="Promo Julho (sem dados no período)"');
  });

  it("drops only the campaigns outside a new BM, in the same navigation", () => {
    const view = renderFilters({
      campaignIds: ["cmp_norte", "cmp_centro", "cmp_nova"],
    });

    fireEvent.change(
      view.container.querySelector('select[name="businessId"]')!,
      { target: { value: "business_1" } },
    );

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      "/overview?businessId=business_1&campaignIds=cmp_centro%2Ccmp_nova",
      { scroll: false },
    );
  });

  it("keeps the selection when the number changes", () => {
    const view = renderFilters({ campaignIds: ["cmp_centro", "cmp_norte"] });

    fireEvent.change(
      view.container.querySelector('select[name="whatsappInstanceId"]')!,
      { target: { value: "instance_b" } },
    );

    expect(router.push).toHaveBeenCalledWith(
      "/overview?whatsappInstanceId=instance_b&campaignIds=cmp_centro%2Ccmp_norte",
      { scroll: false },
    );
  });

  // UX §8 test 25
  it("hides chips and names in presentation mode", () => {
    presentation.enabled = true;
    const html = renderMarkup({
      campaignIds: ["cmp_centro", "cmp_norte", "cmp_nova"],
    });

    expect(html).toContain(
      '<span class="presentation-filter-placeholder">3 campanhas ocultas</span>',
    );
    expect(html).toContain(
      '<input type="hidden" name="campaignIds" value="cmp_centro,cmp_norte,cmp_nova"/>',
    );
    expect(html).not.toContain("overview-campaign-strip");
    expect(html).not.toContain("Promo");
  });

  it("syncs a Back navigation to a multi selection", () => {
    const view = renderFilters({ campaignIds: ["cmp_centro"] });

    view.rerender({ campaignIds: ["cmp_norte", "cmp_centro"] });

    expect(view.trigger().textContent).toBe("2 campanhas");
    expect(chipLabels(view.container)).toEqual(["Promo Norte", "Promo Centro"]);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("builds campaignId for one and campaignIds for several", () => {
    const base = {
      since: "",
      until: "",
      businessId: "",
      adAccountId: "",
      whatsappInstanceId: "",
    };

    expect(overviewFiltersHref({ ...base, campaignIds: ["a"] })).toBe(
      "/overview?campaignId=a",
    );
    expect(overviewFiltersHref({ ...base, campaignIds: ["b", "a"] })).toBe(
      "/overview?campaignIds=b%2Ca",
    );
  });
});
