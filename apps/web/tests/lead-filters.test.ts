// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import {
  hasEditableLeadFilter,
  leadFiltersClearHref,
  leadFiltersHref,
  type LeadFilterValues,
} from "../src/app/(app)/leads/lead-filter-params";
import {
  LeadFilters,
  committableLeadFilters,
  leadDateRangeStatus,
} from "../src/app/(app)/leads/lead-filters";

const empty: LeadFilterValues = {
  search: "",
  status: "",
  eventName: "",
  label: "",
  campaignId: "",
  adSetId: "",
  adId: "",
  whatsappInstanceId: "",
  attribution: "",
  since: "",
  until: "",
  base: "",
  pageSize: "25",
};

const applied: LeadFilterValues = {
  ...empty,
  status: "qualified",
  campaignId: "cmp_1",
  adSetId: "adset_1",
  adId: "ad_1",
  attribution: "paid",
  since: "2026-09-01",
  until: "2026-09-24",
  pageSize: "50",
};

const appliedQuery =
  "campaignId=cmp_1&adSetId=adset_1&adId=ad_1&attribution=paid&since=2026-09-01&until=2026-09-24&pageSize=50";

function renderLeadFilters(
  overrides: Partial<LeadFilterValues> = {},
  page = 3,
) {
  const props = (next: Partial<LeadFilterValues> = {}, nextPage = page) => ({
    applied: { ...applied, ...overrides, ...next },
    page: nextPage,
  });
  const view = render(createElement(LeadFilters, props()));
  const field = <T extends Element>(selector: string) =>
    view.container.querySelector<T>(selector)!;
  const navigate = (next: Partial<LeadFilterValues>, nextPage = 1) =>
    view.rerender(createElement(LeadFilters, props(next, nextPage)));

  return { ...view, field, navigate };
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  router.push.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("lead filters href", () => {
  it("keeps canonical order, omits blanks and the default page size, never carries page", () => {
    expect(leadFiltersHref(empty)).toBe("/leads");
    expect(
      leadFiltersHref({ ...applied, search: "  mari  ", label: "   " }),
    ).toBe(`/leads?search=mari&status=qualified&${appliedQuery}`);
    expect(leadFiltersHref({ ...empty, status: "lost", pageSize: "25" })).toBe(
      "/leads?status=lost",
    );
  });

  it("accepts an open period but not a partial or inverted one", () => {
    expect(leadDateRangeStatus("", "")).toBe("valid");
    expect(leadDateRangeStatus("2026-09-01", "")).toBe("valid");
    expect(leadDateRangeStatus("", "2026-09-24")).toBe("valid");
    expect(leadDateRangeStatus("0002-09-01", "")).toBe("incomplete");
    expect(leadDateRangeStatus("2026-09-10", "0002-09-01")).toBe(
      "incomplete",
    );
    expect(leadDateRangeStatus("2026-09-10", "2026-09-01")).toBe("order");
  });

  it("keeps the applied period when the edited one is not committable", () => {
    expect(
      committableLeadFilters(
        { ...applied, until: "2026-08-01", status: "lost" },
        applied,
      ),
    ).toMatchObject({
      since: "2026-09-01",
      until: "2026-09-24",
      status: "lost",
    });
  });
});

describe("lead filters auto-apply", () => {
  it("has no Aplicar button, only a hidden submitter", () => {
    const { container } = renderLeadFilters();

    expect(container.textContent).not.toContain("Aplicar");

    const submitters = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[type="submit"]'),
    );

    expect(submitters).toHaveLength(1);
    expect(submitters[0]).toMatchObject({ className: "sr-only", tabIndex: -1 });
  });

  it("applies a select right away on page 1, keeping scope, origin, period and page size", () => {
    const { field } = renderLeadFilters();

    fireEvent.change(field('select[name="eventName"]'), {
      target: { value: "Purchase" },
    });

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      `/leads?status=qualified&eventName=Purchase&${appliedQuery}`,
      { scroll: false },
    );
  });

  it("applies every select immediately", () => {
    const { field } = renderLeadFilters();

    fireEvent.change(field('select[name="status"]'), {
      target: { value: "" },
    });
    fireEvent.change(field('select[name="attribution"]'), {
      target: { value: "organic" },
    });
    fireEvent.change(field('select[name="pageSize"]'), {
      target: { value: "25" },
    });

    expect(router.push.mock.calls.map(([href]) => href)).toEqual([
      `/leads?${appliedQuery}`,
      `/leads?${appliedQuery.replace("attribution=paid", "attribution=organic")}`,
      "/leads?campaignId=cmp_1&adSetId=adset_1&adId=ad_1&attribution=organic&since=2026-09-01&until=2026-09-24",
    ]);
  });

  it("debounces the search and pushes once", () => {
    vi.useFakeTimers();
    const { field } = renderLeadFilters();
    const search = field<HTMLInputElement>('input[name="search"]');

    fireEvent.change(search, { target: { value: "m" } });
    advance(500);
    fireEvent.change(search, { target: { value: "mar" } });
    advance(799);
    expect(router.push).not.toHaveBeenCalled();

    advance(1);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      `/leads?search=mar&status=qualified&${appliedQuery}`,
      { scroll: false },
    );
  });

  it("debounces the label as text", () => {
    vi.useFakeTimers();
    const { field } = renderLeadFilters();

    fireEvent.change(field('input[name="label"]'), {
      target: { value: "VIP" },
    });
    expect(router.push).not.toHaveBeenCalled();
    advance(800);

    expect(router.push).toHaveBeenCalledWith(
      `/leads?status=qualified&label=VIP&${appliedQuery}`,
      { scroll: false },
    );
  });

  it("flushes the search on blur without a second push later", () => {
    vi.useFakeTimers();
    const { field } = renderLeadFilters();
    const search = field<HTMLInputElement>('input[name="search"]');

    fireEvent.change(search, { target: { value: "mari" } });
    fireEvent.blur(search);
    expect(router.push).toHaveBeenCalledTimes(1);

    advance(2000);
    fireEvent.blur(search);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("does not navigate when a field is blurred without edits", () => {
    const { field } = renderLeadFilters();

    fireEvent.blur(field('input[name="search"]'));
    fireEvent.blur(field('input[name="since"]'));

    expect(router.push).not.toHaveBeenCalled();
  });

  it("applies the search on Enter once", () => {
    vi.useFakeTimers();
    const { field } = renderLeadFilters();
    const search = field<HTMLInputElement>('input[name="search"]');

    fireEvent.change(search, { target: { value: "mari" } });
    fireEvent.submit(field("form"));
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      `/leads?search=mari&status=qualified&${appliedQuery}`,
      { scroll: false },
    );

    fireEvent.submit(field("form"));
    fireEvent.blur(search);
    advance(2000);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("does not push a blank search", () => {
    vi.useFakeTimers();
    const { field } = renderLeadFilters();

    fireEvent.change(field('input[name="search"]'), {
      target: { value: "   " },
    });
    advance(800);

    expect(router.push).not.toHaveBeenCalled();
  });

  it("commits a typed date once, after the debounce", () => {
    vi.useFakeTimers();
    const { field } = renderLeadFilters();
    const since = field<HTMLInputElement>('input[name="since"]');

    fireEvent.change(since, { target: { value: "0002-09-10" } });
    advance(800);
    expect(router.push).not.toHaveBeenCalled();

    fireEvent.change(since, { target: { value: "2026-09-10" } });
    advance(800);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      `/leads?status=qualified&${appliedQuery.replace("2026-09-01", "2026-09-10")}`,
      { scroll: false },
    );
  });

  it("flushes a date on blur and allows clearing one end", () => {
    vi.useFakeTimers();
    const { field } = renderLeadFilters();
    const until = field<HTMLInputElement>('input[name="until"]');

    fireEvent.change(until, { target: { value: "" } });
    fireEvent.blur(until);

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      `/leads?status=qualified&${appliedQuery.replace("&until=2026-09-24", "")}`,
      { scroll: false },
    );
    advance(2000);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("blocks Fim before Inicio with an accessible inline error", () => {
    vi.useFakeTimers();
    const { container, field } = renderLeadFilters();
    const until = field<HTMLInputElement>('input[name="until"]');

    fireEvent.change(until, { target: { value: "2026-08-20" } });
    fireEvent.blur(until);
    advance(2000);

    expect(router.push).not.toHaveBeenCalled();
    expect(until.getAttribute("aria-invalid")).toBe("true");

    const error = container.querySelector(".overview-filter-error")!;

    expect(error.textContent).toBe("Fim antes do início");
    expect(until.getAttribute("aria-describedby")).toBe(error.id);
  });

  it("still applies a select while the typed period is inverted", () => {
    vi.useFakeTimers();
    const { field } = renderLeadFilters();

    fireEvent.change(field('input[name="until"]'), {
      target: { value: "2026-08-20" },
    });
    fireEvent.change(field('select[name="status"]'), {
      target: { value: "lost" },
    });
    advance(2000);

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      `/leads?status=lost&${appliedQuery}`,
      { scroll: false },
    );
  });

  it("folds a pending search into a select change, with no later push", () => {
    vi.useFakeTimers();
    const { field } = renderLeadFilters();

    fireEvent.change(field('input[name="search"]'), {
      target: { value: "mari" },
    });
    fireEvent.change(field('select[name="status"]'), {
      target: { value: "lost" },
    });
    advance(2000);

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      `/leads?search=mari&status=lost&${appliedQuery}`,
      { scroll: false },
    );
  });

  it("keeps the latest of rapid select changes and skips a no-op", () => {
    const { field } = renderLeadFilters();
    const status = field<HTMLSelectElement>('select[name="status"]');

    fireEvent.change(status, { target: { value: "lost" } });
    fireEvent.change(status, { target: { value: "active" } });
    fireEvent.change(status, { target: { value: "active" } });

    expect(router.push.mock.calls.map(([href]) => href)).toEqual([
      `/leads?status=lost&${appliedQuery}`,
      `/leads?status=active&${appliedQuery}`,
    ]);
    expect(status.value).toBe("active");
  });

  it("keeps a newer edit when its own navigation lands late", () => {
    vi.useFakeTimers();
    const { field, navigate } = renderLeadFilters();
    const search = field<HTMLInputElement>('input[name="search"]');

    fireEvent.change(search, { target: { value: "mar" } });
    advance(800);
    fireEvent.change(search, { target: { value: "mari" } });
    navigate({ search: "mar" });

    expect(search.value).toBe("mari");
    advance(800);
    expect(router.push).toHaveBeenLastCalledWith(
      `/leads?search=mari&status=qualified&${appliedQuery}`,
      { scroll: false },
    );
  });

  it("syncs fields and drops a pending edit on back/forward", () => {
    vi.useFakeTimers();
    const { field, navigate } = renderLeadFilters();
    const search = field<HTMLInputElement>('input[name="search"]');

    fireEvent.change(search, { target: { value: "mari" } });
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    navigate({ status: "lost", search: "" });
    advance(2000);

    expect(router.push).not.toHaveBeenCalled();
    expect(search.value).toBe("");
    expect(field<HTMLSelectElement>('select[name="status"]').value).toBe(
      "lost",
    );
  });

  it("drops a pending edit when another navigation lands first", () => {
    vi.useFakeTimers();
    const { field, navigate } = renderLeadFilters();

    fireEvent.change(field('input[name="search"]'), {
      target: { value: "mari" },
    });
    // Pagination with the same filters, e.g. a Proxima click.
    navigate({}, 4);
    advance(2000);

    expect(router.push).not.toHaveBeenCalled();
    expect(field<HTMLInputElement>('input[name="search"]').value).toBe("");
  });

  it("clears pending timers on unmount", () => {
    vi.useFakeTimers();
    const { field, unmount } = renderLeadFilters();

    fireEvent.change(field('input[name="search"]'), {
      target: { value: "mari" },
    });
    unmount();
    advance(2000);

    expect(router.push).not.toHaveBeenCalled();
  });

  it("links Limpar to the kept scope and discards the pending edit", () => {
    vi.useFakeTimers();
    const { field, navigate } = renderLeadFilters();
    const clear = field<HTMLAnchorElement>("[data-lead-filters-clear]");
    const search = field<HTMLInputElement>('input[name="search"]');

    expect(clear.getAttribute("href")).toBe(
      "/leads?campaignId=cmp_1&adSetId=adset_1&adId=ad_1&pageSize=50",
    );
    expect(clear.textContent).toBe("Limpar");

    fireEvent.change(search, { target: { value: "mari" } });
    fireEvent.blur(search, { relatedTarget: clear });
    clear.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(clear);
    advance(2000);
    expect(router.push).not.toHaveBeenCalled();

    navigate({ ...empty });
    expect(search.value).toBe("");
    expect(field<HTMLSelectElement>('select[name="status"]').value).toBe("");
    expect(
      field<HTMLSelectElement>('select[name="pageSize"]').value,
    ).toBe("25");
  });

  it("hides Limpar when nothing is applied", () => {
    const { container } = renderLeadFilters({ ...empty });

    expect(container.querySelector("[data-lead-filters-clear]")).toBeNull();
    expect(container.textContent).not.toContain("Limpar");
  });

  it("hides Limpar when only the scope and page size are applied", () => {
    const { container } = renderLeadFilters({
      ...empty,
      whatsappInstanceId: "wpp_1",
      campaignId: "cmp_1",
      pageSize: "50",
    });

    expect(container.querySelector("[data-lead-filters-clear]")).toBeNull();
  });
});

describe("lead filters WhatsApp instance scope", () => {
  const scoped: Partial<LeadFilterValues> = {
    whatsappInstanceId: "wpp_1",
    campaignId: "",
    adSetId: "",
    adId: "",
  };
  const scopedQuery =
    "whatsappInstanceId=wpp_1&attribution=paid&since=2026-09-01&until=2026-09-24&pageSize=50";

  it("places the instance in the canonical href after the report scope", () => {
    expect(
      leadFiltersHref({ ...applied, whatsappInstanceId: "wpp_1" }),
    ).toBe(
      "/leads?status=qualified&campaignId=cmp_1&adSetId=adset_1&adId=ad_1&whatsappInstanceId=wpp_1&attribution=paid&since=2026-09-01&until=2026-09-24&pageSize=50",
    );
    expect(leadFiltersHref({ ...empty, whatsappInstanceId: "wpp_1" })).toBe(
      "/leads?whatsappInstanceId=wpp_1",
    );
  });

  it("keeps the instance on select, debounced text and Enter commits", () => {
    vi.useFakeTimers();
    const { field } = renderLeadFilters(scoped);

    fireEvent.change(field('select[name="status"]'), {
      target: { value: "lost" },
    });
    fireEvent.change(field('input[name="search"]'), {
      target: { value: "mari" },
    });
    advance(800);
    fireEvent.change(field('input[name="label"]'), {
      target: { value: "VIP" },
    });
    fireEvent.submit(field("form"));

    expect(router.push.mock.calls.map(([href]) => href)).toEqual([
      `/leads?status=lost&${scopedQuery}`,
      `/leads?search=mari&status=lost&${scopedQuery}`,
      `/leads?search=mari&status=lost&label=VIP&${scopedQuery}`,
    ]);
  });

  it("carries the instance as a hidden GET field", () => {
    const { field } = renderLeadFilters(scoped);
    const data = new FormData(field<HTMLFormElement>("form"));

    expect(data.get("whatsappInstanceId")).toBe("wpp_1");
    expect(
      field('input[type="hidden"][name="whatsappInstanceId"]'),
    ).not.toBeNull();
  });

  it("Limpar drops editable filters but keeps the instance and page size", () => {
    const { field } = renderLeadFilters({
      ...scoped,
      search: "mari",
      label: "VIP",
      eventName: "Purchase",
    });

    expect(
      field<HTMLAnchorElement>("[data-lead-filters-clear]").getAttribute(
        "href",
      ),
    ).toBe("/leads?whatsappInstanceId=wpp_1&pageSize=50");
    expect(
      leadFiltersClearHref({
        ...applied,
        whatsappInstanceId: "wpp_1",
        search: "mari",
      }),
    ).toBe(
      "/leads?campaignId=cmp_1&adSetId=adset_1&adId=ad_1&whatsappInstanceId=wpp_1&pageSize=50",
    );
    expect(hasEditableLeadFilter({ ...empty, whatsappInstanceId: "wpp_1" })).toBe(
      false,
    );
    expect(
      hasEditableLeadFilter({ ...empty, whatsappInstanceId: "wpp_1", status: "lost" }),
    ).toBe(true);
  });

  it("does not count the instance as an advanced filter", () => {
    const { container, field } = renderLeadFilters({
      ...empty,
      whatsappInstanceId: "wpp_1",
    });

    expect(field<HTMLDetailsElement>("details").open).toBe(false);
    expect(container.querySelector(".lead-active-filter-count")).toBeNull();
  });

  it("keeps the advanced panel open while its filters change", () => {
    const { field, navigate } = renderLeadFilters({ ...empty }, 1);
    const details = field<HTMLDetailsElement>("details");

    expect(details.open).toBe(false);
    act(() => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    fireEvent.change(field('select[name="attribution"]'), {
      target: { value: "organic" },
    });
    navigate({ ...empty, attribution: "organic" });
    navigate({ ...empty }, 1);

    expect(details.open).toBe(true);
  });

  it("keeps the search and label masked in presentation mode and the scope in the form", () => {
    const { field } = renderLeadFilters();

    for (const name of ["search", "label"]) {
      expect(
        field(`input[name="${name}"]`).getAttribute(
          "data-presentation-sensitive-field",
        ),
      ).toBe("true");
    }

    const data = new FormData(field<HTMLFormElement>("form"));

    expect(data.get("campaignId")).toBe("cmp_1");
    expect(data.get("adSetId")).toBe("adset_1");
    expect(data.get("adId")).toBe("ad_1");
    expect(data.get("pageSize")).toBe("50");
    expect(data.get("page")).toBeNull();
  });
});
