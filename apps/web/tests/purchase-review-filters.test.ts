// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import {
  PurchaseReviewFilters,
  committablePurchaseReviewFilters,
  purchaseReviewFiltersHref,
  type PurchaseReviewFilterValues,
} from "../src/app/(app)/events/purchase-reviews/purchase-review-filters";

const applied: PurchaseReviewFilterValues = {
  since: "2026-09-01",
  until: "2026-09-24",
  view: "actionable",
  status: "",
  providerRuleId: "rule_1",
};

const base = "/events/purchase-reviews";
const period = "since=2026-09-01&until=2026-09-24";

const ruleOptions = [
  { id: "rule_1", label: "Compra confirmada" },
  { id: "rule_2", label: "Compra com valor medio" },
];

function renderFilters(
  overrides: Partial<PurchaseReviewFilterValues> = {},
  page = 3,
) {
  const props = (
    next: Partial<PurchaseReviewFilterValues> = {},
    nextPage = page,
    options = ruleOptions,
  ) => ({
    applied: { ...applied, ...overrides, ...next },
    page: nextPage,
    ruleOptions: options,
    totalItems: 42,
  });
  const view = render(createElement(PurchaseReviewFilters, props()));
  const field = <T extends Element>(selector: string) =>
    view.container.querySelector<T>(selector)!;
  const navigate = (
    next: Partial<PurchaseReviewFilterValues>,
    nextPage = 1,
    options = ruleOptions,
  ) =>
    view.rerender(
      createElement(PurchaseReviewFilters, props(next, nextPage, options)),
    );

  return { ...view, field, navigate };
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function pushedHrefs() {
  return router.push.mock.calls.map(([href]) => href);
}

beforeEach(() => {
  router.push.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("purchase review filters href", () => {
  it("follows the pagination order, always carries period and view, never page", () => {
    expect(purchaseReviewFiltersHref(applied)).toBe(
      `${base}?${period}&view=actionable&providerRuleId=rule_1`,
    );
    expect(
      purchaseReviewFiltersHref({
        ...applied,
        view: "history",
        status: "sent",
        providerRuleId: "",
      }),
    ).toBe(`${base}?${period}&view=history&status=sent`);
  });

  it("keeps the applied period unless both ends are complete and ordered", () => {
    for (const draft of [
      { since: "", until: "2026-09-24" },
      { since: "2026-09-01", until: "" },
      { since: "0002-09-01", until: "2026-09-24" },
      { since: "2026-09-10", until: "2026-09-01" },
    ]) {
      expect(
        committablePurchaseReviewFilters(
          { ...applied, ...draft, status: "failed" },
          applied,
        ),
      ).toMatchObject({
        since: "2026-09-01",
        until: "2026-09-24",
        status: "failed",
      });
    }

    expect(
      committablePurchaseReviewFilters(
        { ...applied, since: "2026-09-05", until: "2026-09-05" },
        applied,
      ),
    ).toMatchObject({ since: "2026-09-05", until: "2026-09-05" });
  });
});

describe("purchase review filters auto-apply", () => {
  it("has no Aplicar button, only a hidden submitter for Enter and no-JS GET", () => {
    const { container, field } = renderFilters();
    const form = field<HTMLFormElement>("form");

    expect(container.textContent).not.toContain("Aplicar");
    expect(form.getAttribute("action")).toBe(base);
    expect(form.getAttribute("method")).toBeNull();
    expect(form.className).toBe("purchase-review-filter-form");
    expect(container.textContent).toContain("42 compra(s) no período");

    const submitters = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[type="submit"]'),
    );

    expect(submitters).toHaveLength(1);
    expect(submitters[0]).toMatchObject({ className: "sr-only", tabIndex: -1 });

    const data = new FormData(form);

    expect(Object.fromEntries(data)).toEqual({
      since: "2026-09-01",
      until: "2026-09-24",
      view: "actionable",
      status: "",
      providerRuleId: "rule_1",
    });
    expect(data.get("page")).toBeNull();
  });

  it("applies view, status and rule right away on page 1, keeping the period", () => {
    const { field } = renderFilters();

    fireEvent.change(field('select[name="view"]'), {
      target: { value: "history" },
    });
    fireEvent.change(field('select[name="status"]'), {
      target: { value: "sent" },
    });
    fireEvent.change(field('select[name="providerRuleId"]'), {
      target: { value: "rule_2" },
    });
    fireEvent.change(field('select[name="providerRuleId"]'), {
      target: { value: "" },
    });

    expect(pushedHrefs()).toEqual([
      `${base}?${period}&view=history&providerRuleId=rule_1`,
      `${base}?${period}&view=history&status=sent&providerRuleId=rule_1`,
      `${base}?${period}&view=history&status=sent&providerRuleId=rule_2`,
      `${base}?${period}&view=history&status=sent`,
    ]);
    expect(router.push).toHaveBeenLastCalledWith(expect.any(String), {
      scroll: false,
    });
  });

  it("keeps the latest of rapid select changes and skips a no-op", () => {
    const { field } = renderFilters();
    const status = field<HTMLSelectElement>('select[name="status"]');

    fireEvent.change(status, { target: { value: "failed" } });
    fireEvent.change(status, { target: { value: "rejected" } });
    fireEvent.change(status, { target: { value: "rejected" } });

    expect(pushedHrefs()).toEqual([
      `${base}?${period}&view=actionable&status=failed&providerRuleId=rule_1`,
      `${base}?${period}&view=actionable&status=rejected&providerRuleId=rule_1`,
    ]);
    expect(status.value).toBe("rejected");
  });

  it("debounces a typed date for 800ms and pushes once", () => {
    vi.useFakeTimers();
    const { field } = renderFilters();
    const since = field<HTMLInputElement>('input[name="since"]');

    fireEvent.change(since, { target: { value: "2026-09-05" } });
    advance(500);
    fireEvent.change(since, { target: { value: "2026-09-10" } });
    advance(799);
    expect(router.push).not.toHaveBeenCalled();

    advance(1);
    expect(pushedHrefs()).toEqual([
      `${base}?since=2026-09-10&until=2026-09-24&view=actionable&providerRuleId=rule_1`,
    ]);
  });

  it("flushes a date on blur without a second push later", () => {
    vi.useFakeTimers();
    const { field } = renderFilters();
    const until = field<HTMLInputElement>('input[name="until"]');

    fireEvent.change(until, { target: { value: "2026-09-20" } });
    fireEvent.blur(until);
    expect(pushedHrefs()).toEqual([
      `${base}?since=2026-09-01&until=2026-09-20&view=actionable&providerRuleId=rule_1`,
    ]);

    advance(2000);
    fireEvent.blur(until);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("applies a date on Enter once", () => {
    vi.useFakeTimers();
    const { field } = renderFilters();
    const since = field<HTMLInputElement>('input[name="since"]');

    fireEvent.change(since, { target: { value: "2026-09-10" } });
    fireEvent.submit(field("form"));
    expect(router.push).toHaveBeenCalledTimes(1);

    fireEvent.submit(field("form"));
    fireEvent.blur(since);
    advance(2000);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("does not navigate when a date is blurred or Enter is pressed without edits", () => {
    const { field } = renderFilters();

    fireEvent.blur(field('input[name="since"]'));
    fireEvent.blur(field('input[name="until"]'));
    fireEvent.submit(field("form"));

    expect(router.push).not.toHaveBeenCalled();
  });

  it("never navigates with a half-typed or cleared date", () => {
    vi.useFakeTimers();
    const { field } = renderFilters();
    const since = field<HTMLInputElement>('input[name="since"]');
    const until = field<HTMLInputElement>('input[name="until"]');

    fireEvent.change(since, { target: { value: "0002-09-10" } });
    advance(800);
    fireEvent.change(until, { target: { value: "" } });
    fireEvent.blur(until);
    fireEvent.submit(field("form"));
    advance(2000);

    expect(router.push).not.toHaveBeenCalled();
    expect(since.value).toBe("0002-09-10");
  });

  it("blocks Fim before Inicio with an accessible inline error", () => {
    vi.useFakeTimers();
    const { container, field } = renderFilters();
    const until = field<HTMLInputElement>('input[name="until"]');

    fireEvent.change(until, { target: { value: "2026-08-20" } });
    fireEvent.blur(until);
    fireEvent.submit(field("form"));
    advance(2000);

    expect(router.push).not.toHaveBeenCalled();
    expect(until.getAttribute("aria-invalid")).toBe("true");

    const error = container.querySelector(".overview-filter-error")!;

    expect(error.textContent).toBe("Fim antes do início");
    expect(until.getAttribute("aria-describedby")).toBe(error.id);

    fireEvent.change(until, { target: { value: "2026-09-20" } });
    expect(until.getAttribute("aria-invalid")).toBeNull();
    expect(container.querySelector(".overview-filter-error")).toBeNull();
  });

  it("applies a select with the current valid period while a date draft is invalid", () => {
    vi.useFakeTimers();
    const { field, navigate } = renderFilters();
    const until = field<HTMLInputElement>('input[name="until"]');

    fireEvent.change(until, { target: { value: "2026-08-20" } });
    fireEvent.change(field('select[name="view"]'), {
      target: { value: "all" },
    });
    advance(2000);

    expect(pushedHrefs()).toEqual([
      `${base}?${period}&view=all&providerRuleId=rule_1`,
    ]);

    // The landing keeps the draft the user is still fixing.
    navigate({ view: "all" });
    expect(until.value).toBe("2026-08-20");
    expect(until.getAttribute("aria-invalid")).toBe("true");
  });

  it("folds a pending date into a select change, with no later push", () => {
    vi.useFakeTimers();
    const { field } = renderFilters();

    fireEvent.change(field('input[name="since"]'), {
      target: { value: "2026-09-10" },
    });
    fireEvent.change(field('select[name="status"]'), {
      target: { value: "review_required" },
    });
    advance(2000);

    expect(pushedHrefs()).toEqual([
      `${base}?since=2026-09-10&until=2026-09-24&view=actionable&status=review_required&providerRuleId=rule_1`,
    ]);
  });

  it("keeps a newer date draft when its own navigation lands late", () => {
    vi.useFakeTimers();
    const { field, navigate } = renderFilters();
    const since = field<HTMLInputElement>('input[name="since"]');

    fireEvent.change(since, { target: { value: "2026-09-05" } });
    advance(800);
    fireEvent.change(since, { target: { value: "2026-09-10" } });
    navigate({ since: "2026-09-05" });

    expect(since.value).toBe("2026-09-10");
    advance(800);
    expect(pushedHrefs()).toEqual([
      `${base}?since=2026-09-05&until=2026-09-24&view=actionable&providerRuleId=rule_1`,
      `${base}?since=2026-09-10&until=2026-09-24&view=actionable&providerRuleId=rule_1`,
    ]);
  });

  it("does not let an older own navigation undo a newer select", () => {
    const { field, navigate } = renderFilters();
    const status = field<HTMLSelectElement>('select[name="status"]');
    const rule = field<HTMLSelectElement>('select[name="providerRuleId"]');

    fireEvent.change(status, { target: { value: "failed" } });
    fireEvent.change(rule, { target: { value: "rule_2" } });
    // The first push lands, then the second.
    navigate({ status: "failed" });
    expect(rule.value).toBe("rule_2");
    navigate({ status: "failed", providerRuleId: "rule_2" });

    expect(status.value).toBe("failed");
    expect(rule.value).toBe("rule_2");
    expect(router.push).toHaveBeenCalledTimes(2);
  });

  it("syncs fields and drops a pending date on back/forward", () => {
    vi.useFakeTimers();
    const { field, navigate } = renderFilters();
    const since = field<HTMLInputElement>('input[name="since"]');

    fireEvent.change(since, { target: { value: "2026-09-10" } });
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    navigate({ since: "2026-08-01", view: "history", status: "sent" });
    advance(2000);

    expect(router.push).not.toHaveBeenCalled();
    expect(since.value).toBe("2026-08-01");
    expect(field<HTMLSelectElement>('select[name="view"]').value).toBe(
      "history",
    );
    expect(field<HTMLSelectElement>('select[name="status"]').value).toBe(
      "sent",
    );
  });

  it("syncs fields and drops a pending date on an external navigation", () => {
    vi.useFakeTimers();
    const { field, navigate } = renderFilters({}, 1);
    const until = field<HTMLInputElement>('input[name="until"]');

    fireEvent.change(until, { target: { value: "2026-09-20" } });
    // A link elsewhere in the app lands on page 1 with other filters.
    navigate({ providerRuleId: "", status: "review_required" });
    advance(2000);

    expect(router.push).not.toHaveBeenCalled();
    expect(until.value).toBe("2026-09-24");
    expect(field<HTMLSelectElement>('select[name="providerRuleId"]').value).toBe(
      "",
    );
    expect(field<HTMLSelectElement>('select[name="status"]').value).toBe(
      "review_required",
    );
  });

  it("drops a pending date when pagination lands first, even on page 1", () => {
    vi.useFakeTimers();
    const { field, navigate } = renderFilters({}, 2);
    const since = field<HTMLInputElement>('input[name="since"]');

    fireEvent.change(since, { target: { value: "2026-09-10" } });
    // Anterior with the same filters, back to page 1.
    navigate({}, 1);
    advance(2000);

    expect(router.push).not.toHaveBeenCalled();
    expect(since.value).toBe("2026-09-01");
  });

  it("clears pending timers on unmount", () => {
    vi.useFakeTimers();
    const { field, unmount } = renderFilters();

    fireEvent.change(field('input[name="since"]'), {
      target: { value: "2026-09-10" },
    });
    unmount();
    advance(2000);

    expect(router.push).not.toHaveBeenCalled();
  });

  it("keeps the selected rule exactly as the page passes it", () => {
    const { field, navigate } = renderFilters();
    const rule = field<HTMLSelectElement>('select[name="providerRuleId"]');

    // The page always appends the applied rule to the options it passes.
    navigate({ since: "2026-08-01" }, 1, [
      { id: "rule_2", label: "Compra com valor medio" },
      { id: "rule_1", label: "Regra indisponivel" },
    ]);

    expect(rule.value).toBe("rule_1");
    expect(
      Array.from(rule.options).map((option) => [option.value, option.text]),
    ).toEqual([
      ["", "Todas as regras"],
      ["rule_2", "Compra com valor medio"],
      ["rule_1", "Regra indisponivel"],
    ]);
  });

  it("shows the updating status region where Aplicar was", () => {
    const { container } = renderFilters();
    const status = container.querySelector('[role="status"]')!;

    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("");
    expect(
      container
        .querySelector(".overview-filter-status")!
        .getAttribute("data-pending"),
    ).toBeNull();
  });
});
